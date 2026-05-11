/**
 * checkpoint.js — Phase 1 hardened + Phase 3 event sourcing
 * CVE-1: all paths jail-checked
 * CVE-3: state is redacted before logging
 */

import { randomBytes }                                            from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync,
         appendFileSync, existsSync }                             from 'fs';
import { join, dirname }                                          from 'path';
import { assertSafePath, redact, validate, SCHEMAS }              from './security.js';

export class CheckpointManager {
  constructor({ dir = '.swarm/checkpoints' } = {}) {
    this.dir     = assertSafePath(dir);  // CVE-1
    this._timers = new Map();
  }

  _ensure() { mkdirSync(this.dir, { recursive: true }); }

  _filePath(runId)  { return join(this.dir, `${_safeId(runId)}.json`); }
  _eventLog(runId)  { return join(this.dir, `${_safeId(runId)}.events.ndjson`); }

  // ── Event sourcing: append an immutable event ──────────────────────────────

  _emit(runId, type, payload = {}) {
    this._ensure();
    const event = { type, ts: Date.now(), runId, ...redact(payload) }; // CVE-3
    appendFileSync(this._eventLog(runId), JSON.stringify(event) + '\n');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(data = {}) {
    this._ensure();
    const runId = randomBytes(6).toString('hex');
    const state = { runId, status: 'running', savedAt: Date.now(), retries: 0, ...data };
    writeFileSync(this._filePath(runId), JSON.stringify(redact(state), null, 2)); // CVE-3
    this._emit(runId, 'task.started', { task: data.task });
    this._startHeartbeat(runId);
    return runId;
  }

  heartbeat(runId, data = {}) {
    this._ensure();
    const path = this._filePath(runId);
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify(redact({ ...existing, ...data, savedAt: Date.now() }), null, 2));
    } catch {}
    this._emit(runId, 'checkpoint.saved', data);
  }

  complete(runId, result = {}) {
    this._stopHeartbeat(runId);
    this.heartbeat(runId, { status: 'complete', result: redact(result) });
    this._emit(runId, 'task.complete', { result: redact(result) });
  }

  fail(runId, error) {
    this._stopHeartbeat(runId);
    const msg = error instanceof Error ? error.message : String(error);
    this.heartbeat(runId, { status: 'failed', error: msg });
    this._emit(runId, 'task.failed', { error: msg });
  }

  async load(runId) {
    return JSON.parse(readFileSync(this._filePath(runId), 'utf8'));
  }

  /** Replay event log to reconstruct state at any point in time */
  async replayEvents(runId) {
    const logPath = this._eventLog(runId);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  async list() {
    this._ensure();
    return readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(join(this.dir, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  _startHeartbeat(runId, intervalMs = 5_000) {
    const timer = setInterval(() => {
      this.heartbeat(runId, { heartbeat: Date.now() });
    }, intervalMs).unref(); // unref so the process can exit normally
    this._timers.set(runId, timer);
  }

  _stopHeartbeat(runId) {
    const t = this._timers.get(runId);
    if (t) { clearInterval(t); this._timers.delete(runId); }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Reject run IDs containing path separators or dots */
function _safeId(id) {
  if (!id || typeof id !== 'string' || !/^[a-f0-9]{6,32}$/.test(id)) {
    throw new Error(`Invalid run ID: "${id}"`);
  }
  return id;
}
