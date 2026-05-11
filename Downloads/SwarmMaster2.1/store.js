/**
 * store.js — Phase 2 hardened
 * - HNSW semantic search replaces linear TF-IDF scan
 * - int8 quantization (4x memory reduction)
 * - EMA score merging unchanged
 * - LRU eviction unchanged
 * - CVE-1: path jail on file operations
 */

import { randomBytes }                              from 'crypto';
import { writeFileSync, readFileSync, mkdirSync }   from 'fs';
import { dirname }                                   from 'path';
import { HNSWIndex }                                from '../memory/hnsw.js';
import { assertSafePath }                           from '../utils/security.js';

const EMA_ALPHA = 0.3;

// Minimal tokeniser for building query vectors
function tokenise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function buildVec(text, vocab) {
  const words = tokenise(text);
  const tf    = new Map();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
  const vec = new Array(vocab.length).fill(0);
  for (const [w, count] of tf) {
    const idx = vocab.indexOf(w);
    if (idx >= 0) vec[idx] = count / words.length;
  }
  return vec;
}

// int8 quantization helpers (4x memory reduction)
function quantize(vec) {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++)
    out[i] = Math.round(Math.max(-127, Math.min(127, vec[i] * 127)));
  return out;
}
function dequantize(int8arr) {
  return Array.from(int8arr).map(v => v / 127);
}

export class SkillStore {
  constructor({ path, maxSize = 1000, maxAge = 30, minScore = 0.3, quantize: useQuantize = true } = {}) {
    this._path       = path ? assertSafePath(path) : null;  // CVE-1
    this._maxSize    = maxSize;
    this._maxAge     = maxAge * 86_400_000;
    this._minScore   = minScore;
    this._useQuantize = useQuantize;

    this._skills     = new Map();    // id → skill
    this._vocab      = [];           // TF-IDF vocabulary
    this._hnsw       = new HNSWIndex({ M: 16, efConstruction: 100, ef: 30 });
    this._order      = [];           // insertion order for LRU
  }

  async load() {
    if (!this._path) return;
    try {
      const raw  = readFileSync(this._path, 'utf8');
      const data = JSON.parse(raw);
      this._vocab = data.vocab ?? [];
      if (data.hnsw) this._hnsw = HNSWIndex.fromJSON(data.hnsw);
      for (const s of data.skills ?? []) {
        this._skills.set(s.id, { ...s, vec: s.vec ? new Int8Array(s.vec) : undefined });
      }
      this._order = data.order ?? [...this._skills.keys()];
    } catch {}
  }

  async save() {
    if (!this._path) return;
    mkdirSync(dirname(this._path), { recursive: true });
    writeFileSync(this._path, JSON.stringify({
      vocab:  this._vocab,
      hnsw:   this._hnsw.toJSON(),
      order:  this._order,
      skills: [...this._skills.values()].map(s => ({
        ...s,
        vec: s.vec ? Array.from(s.vec) : undefined,
      })),
    }));
  }

  add(skill) {
    if (typeof skill.score !== 'number' || skill.score < this._minScore) return;

    // EMA merge if same type+agent+content already exists
    const existing = [...this._skills.values()].find(
      s => s.type === skill.type && s.agentId === skill.agentId && s.content === skill.content
    );
    if (existing) {
      existing.score     = existing.score * (1 - EMA_ALPHA) + skill.score * EMA_ALPHA;
      existing.uses      = (existing.uses ?? 0) + 1;
      existing.updatedAt = Date.now();
      return;
    }

    const id = randomBytes(8).toString('hex');

    // Update vocabulary & build TF-IDF vector
    const words = tokenise(skill.content ?? '');
    for (const w of words) if (!this._vocab.includes(w)) this._vocab.push(w);
    const floatVec = buildVec(skill.content ?? '', this._vocab);
    const stored   = this._useQuantize ? quantize(floatVec) : floatVec;

    this._skills.set(id, {
      id, ...skill,
      uses: 1, addedAt: Date.now(), updatedAt: Date.now(),
      vec: stored,
    });

    // Index in HNSW — always use float for the index itself
    this._hnsw.insert(id, this._useQuantize ? dequantize(stored) : floatVec);

    this._order.push(id);
    if (this._skills.size > this._maxSize) {
      const evict = this._order.shift();
      this._skills.delete(evict);
      this._hnsw.delete(evict);
    }
  }

  /**
   * Semantic search — O(log n) via HNSW instead of O(n) linear scan.
   */
  search(query, { agentId, type, limit = 20 } = {}) {
    if (this._hnsw.size === 0 || !query) return [];

    const qVec = buildVec(query, this._vocab);
    const hits  = this._hnsw.search(qVec, Math.min(limit * 3, 200)); // over-fetch then filter

    return hits
      .map(h => this._skills.get(h.id))
      .filter(Boolean)
      .filter(s => (!agentId || s.agentId === agentId) && (!type || s.type === type))
      .slice(0, limit)
      .map(s => ({ ...s, vec: undefined })); // strip vec from output
  }

  list({ agentId, type, limit = 20 } = {}) {
    return [...this._skills.values()]
      .filter(s => (!agentId || s.agentId === agentId) && (!type || s.type === type))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => ({ ...s, vec: undefined }));
  }

  prune() {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this._skills) {
      if (now - (s.updatedAt ?? s.addedAt) > this._maxAge || s.score < this._minScore) {
        this._skills.delete(id);
        this._hnsw.delete(id);
        this._order = this._order.filter(x => x !== id);
        removed++;
      }
    }
    return removed;
  }

  clear() {
    this._skills.clear();
    this._hnsw    = new HNSWIndex({ M: 16, efConstruction: 100, ef: 30 });
    this._order   = [];
    this._vocab   = [];
  }

  get size() { return this._skills.size; }
}
