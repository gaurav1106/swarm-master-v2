/**
 * a2a.js — Phase 3: Byzantine fault-tolerant A2A bus
 *
 * Additions over v1:
 *   - Heartbeat liveness tracking per agent
 *   - Auto-de-registration of dead agents
 *   - In-flight handoff re-routing to healthy alternatives
 *   - Agent health queries: isAlive(), healthReport()
 *   - CVE-3: message content redacted before NDJSON logging
 */

import { EventEmitter }               from 'events';
import { appendFileSync, mkdirSync }  from 'fs';
import { dirname }                    from 'path';
import { redact }                     from '../utils/security.js';

const DEFAULT_HEARTBEAT_INTERVAL = 10_000; // ms
const DEFAULT_DEAD_THRESHOLD     = 30_000; // ms without heartbeat = dead

export class A2ABus extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.logPath]            NDJSON log file (optional)
   * @param {number} [opts.heartbeatInterval]  How often agents should beat (ms)
   * @param {number} [opts.deadThreshold]      ms without heartbeat = dead
   */
  constructor({
    logPath           = null,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL,
    deadThreshold     = DEFAULT_DEAD_THRESHOLD,
  } = {}) {
    super();
    this._logPath          = logPath;
    this._heartbeatInterval = heartbeatInterval;
    this._deadThreshold     = deadThreshold;

    this._agents    = new Map(); // id → { id, lastSeen, tier?, meta }
    this._handlers  = new Map(); // id → async (msg) => void
    this._history   = [];
    this._inflight  = new Map(); // msgId → { msg, targetId, ts }
  }

  // ── Agent lifecycle ────────────────────────────────────────────────────────

  /**
   * Register an agent on the bus.
   * @param {string}   id        Agent id
   * @param {Function} [handler] Message handler for direct messages
   * @param {object}   [meta]    Extra metadata (tier, model, etc.)
   */
  register(id, handler, meta = {}) {
    this._agents.set(id, { id, lastSeen: Date.now(), meta });
    if (typeof handler === 'function') this._handlers.set(id, handler);
    this.emit('agent:joined', { id, meta });
  }

  /**
   * Unregister an agent from the bus.
   */
  unregister(id) {
    this._agents.delete(id);
    this._handlers.delete(id);
    this.emit('agent:left', { id });
  }

  /**
   * Record a heartbeat for an agent. Should be called periodically by live agents.
   */
  heartbeat(id) {
    const agent = this._agents.get(id);
    if (agent) {
      agent.lastSeen = Date.now();
      this.emit('agent:heartbeat', { id });
    }
  }

  /** Returns true if agent has been seen within the dead threshold */
  isAlive(id) {
    const agent = this._agents.get(id);
    if (!agent) return false;
    return (Date.now() - agent.lastSeen) < this._deadThreshold;
  }

  /** Returns a health report for all registered agents */
  healthReport() {
    const now = Date.now();
    return [...this._agents.values()].map(a => ({
      id:         a.id,
      alive:      (now - a.lastSeen) < this._deadThreshold,
      lastSeenMs: now - a.lastSeen,
      meta:       a.meta,
    }));
  }

  /**
   * Returns the list of agents that are currently alive.
   */
  knownAgents() { return [...this._agents.keys()]; }
  aliveAgents()  { return this.knownAgents().filter(id => this.isAlive(id)); }

  // ── Message types ──────────────────────────────────────────────────────────

  async ask({ from, to, content, timeout = 30_000 }) {
    _assertRegistered(this, from);
    this.heartbeat(from);

    const msg = this._log('ask', { from, to, content });

    const handler = this._handlers.get(to);
    if (!handler) return null;

    return Promise.race([
      handler(msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`ask() timed out after ${timeout}ms`)), timeout)),
    ]).catch(err => {
      // If target is dead, emit an event but don't throw
      if (!this.isAlive(to)) {
        this.emit('agent:dead', { id: to, cause: 'ask-timeout' });
        this._rerouteInflight(to);
      }
      return null;
    });
  }

  async reply({ from, to, content, inReplyTo }) {
    this.heartbeat(from);
    return this._log('reply', { from, to, content, inReplyTo });
  }

  /**
   * Handoff a task from one agent to another.
   * Phase 3: if target is dead, automatically route to the next healthy agent.
   */
  async handoff({ from, to, task, context = {} }) {
    _assertRegistered(this, from);
    this.heartbeat(from);

    // Byzantine: if target is dead, find a healthy alternative
    const resolvedTo = this.isAlive(to)
      ? to
      : this._findAlternative(to, from);

    if (!resolvedTo) throw new Error(`A2ABus: handoff failed — no healthy agents available (target "${to}" is dead)`);
    if (resolvedTo !== to) {
      this.emit('agent:rerouted', { from, original: to, actual: resolvedTo });
    }

    const msg     = this._log('handoff', { from, to: resolvedTo, task, context: redact(context) });
    const handler = this._handlers.get(resolvedTo);
    if (handler) await handler(msg).catch(() => {});
    return msg;
  }

  async broadcast({ from, content, exclude = [] }) {
    if (from) this.heartbeat(from);
    const msg = this._log('broadcast', { from, content, to: '*' });
    const targets = this.aliveAgents().filter(id => id !== from && !exclude.includes(id));
    await Promise.allSettled(
      targets.map(id => {
        const handler = this._handlers.get(id);
        return handler ? handler(msg) : Promise.resolve();
      })
    );
    return msg;
  }

  async history({ limit = 30, type } = {}) {
    let msgs = [...this._history];
    if (type) msgs = msgs.filter(m => m.type === type);
    return msgs.slice(-limit);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _log(type, payload) {
    const msg = { type, ts: Date.now(), id: _msgId(), ...redact(payload) }; // CVE-3
    this._history.push(msg);
    if (this._history.length > 10_000) this._history.shift();

    if (this._logPath) {
      try {
        mkdirSync(dirname(this._logPath), { recursive: true });
        appendFileSync(this._logPath, JSON.stringify(msg) + '\n');
      } catch {}
    }

    this.emit('message', msg);
    return msg;
  }

  _findAlternative(deadId, excludeId) {
    const tier    = this._agents.get(deadId)?.meta?.tier;
    const alive   = this.aliveAgents().filter(id => id !== excludeId && id !== deadId);
    // Prefer same tier first
    const sameTier = tier ? alive.filter(id => this._agents.get(id)?.meta?.tier === tier) : [];
    return sameTier[0] ?? alive[0] ?? null;
  }

  _rerouteInflight(deadId) {
    for (const [msgId, entry] of this._inflight) {
      if (entry.targetId === deadId) {
        const alt = this._findAlternative(deadId, entry.msg.from);
        if (alt) {
          this.emit('message:rerouted', { msgId, from: deadId, to: alt });
          const handler = this._handlers.get(alt);
          if (handler) handler({ ...entry.msg, to: alt }).catch(() => {});
        }
        this._inflight.delete(msgId);
      }
    }
  }

  /**
   * Start a background watchdog that periodically de-registers dead agents.
   * Call stop() to clear the interval.
   */
  startWatchdog(intervalMs = 15_000) {
    this._watchdog = setInterval(() => {
      for (const id of this._agents.keys()) {
        if (!this.isAlive(id)) {
          this.emit('agent:dead', { id, cause: 'watchdog' });
          this.unregister(id);
        }
      }
    }, intervalMs).unref();
  }

  stopWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }
}

function _assertRegistered(bus, id) {
  if (!bus._agents.has(id)) throw new Error(`A2ABus: agent "${id}" is not registered. Call bus.register() first.`);
}

let _msgCounter = 0;
function _msgId() { return `msg_${Date.now()}_${(_msgCounter++).toString(36)}`; }
