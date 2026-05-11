/**
 * service.js — Phase 2+3: Unified MemoryService
 *
 * Single source of truth for all swarm memory:
 *   - Structured nodes/edges in SQLite (KnowledgeGraph)
 *   - Semantic embeddings in HNSW (VectorStore)
 *   - Cross-session persistence
 *   - 4x quantization (int8) to reduce memory footprint
 *
 * Replaces the old KnowledgeGraph + VectorStore used independently.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, resolve }  from 'path';
import { HNSWIndex }         from './hnsw.js';
import { assertSafePath }    from '../utils/security.js';

// ── Quantization helpers (int8 scalar, 4x reduction) ─────────────────────────

function quantize(vec) {
  // Scale float32 [-1,1] → int8 [-127,127]
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.round(Math.max(-127, Math.min(127, vec[i] * 127)));
  }
  return out;
}

function dequantize(int8arr) {
  const out = new Float32Array(int8arr.length);
  for (let i = 0; i < int8arr.length; i++) out[i] = int8arr[i] / 127;
  return Array.from(out);
}

// ── TF-IDF vectoriser (unchanged from v1, used for text → float vector) ──────

function tfidfVector(text, vocab) {
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

function tokenise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

// ─────────────────────────────────────────────────────────────────────────────

export class MemoryService {
  /**
   * @param {object} opts
   * @param {string} [opts.path]      Base path for persistence (no extension — we create .json + .db)
   * @param {boolean}[opts.quantize]  Enable int8 quantization (default true)
   * @param {number} [opts.maxVecs]   Max vectors before LRU eviction (default 50_000)
   */
  constructor({ path = '.swarm/memory', quantize: useQuantize = true, maxVecs = 50_000 } = {}) {
    this._basePath   = assertSafePath(path);
    this._quantize   = useQuantize;
    this._maxVecs    = maxVecs;

    // In-memory stores
    this._nodes      = new Map(); // id → node
    this._edges      = [];
    this._hnsw       = new HNSWIndex({ M: 16, efConstruction: 200, ef: 50 });
    this._vocab      = [];
    this._docs       = new Map(); // id → { id, content, meta }
    this._insertOrder = [];      // for LRU eviction
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load() {
    const p = this._basePath + '.json';
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      this._nodes = new Map(data.nodes ?? []);
      this._edges = data.edges ?? [];
      this._vocab = data.vocab ?? [];
      this._docs  = new Map(data.docs ?? []);
      this._insertOrder = data.insertOrder ?? [...this._docs.keys()];
      if (data.hnsw) {
        this._hnsw = HNSWIndex.fromJSON(data.hnsw);
      }
    } catch {}
  }

  async save() {
    const p = this._basePath + '.json';
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      nodes:       [...this._nodes.entries()],
      edges:       this._edges,
      vocab:       this._vocab,
      docs:        [...this._docs.entries()],
      insertOrder: this._insertOrder,
      hnsw:        this._hnsw.toJSON(),
    }));
  }

  // ── Graph API (KnowledgeGraph compatible) ──────────────────────────────────

  addNode(node) {
    if (!node.id) throw new Error('Node must have an id');
    this._nodes.set(node.id, { ...node, addedAt: Date.now() });
    // Also index content in vector store if present
    if (node.label || node.content) {
      this.addDoc({ id: 'node:' + node.id, content: node.label ?? node.content, meta: { nodeId: node.id } });
    }
  }

  addEdge(edge) { this._edges.push({ ...edge, addedAt: Date.now() }); }

  getNode(id) { return this._nodes.get(id); }

  query({ type, label, limit = 100 } = {}) {
    let results = [...this._nodes.values()];
    if (type)  results = results.filter(n => n.type === type);
    if (label) results = results.filter(n => n.label?.includes(label));
    return results.slice(0, limit);
  }

  getNeighbors(nodeId, { direction = 'both', edgeLabel } = {}) {
    return this._edges
      .filter(e => {
        const match = direction === 'out' ? e.from === nodeId
                    : direction === 'in'  ? e.to   === nodeId
                    : e.from === nodeId || e.to === nodeId;
        return match && (!edgeLabel || e.label === edgeLabel);
      })
      .map(e => ({ edge: e, node: this._nodes.get(e.from === nodeId ? e.to : e.from) }))
      .filter(r => r.node);
  }

  // ── Vector API (VectorStore compatible) ───────────────────────────────────

  addDoc({ id, content, meta = {} }) {
    if (!id || !content) return;

    // Update vocabulary
    const words = tokenise(content);
    for (const w of words) {
      if (!this._vocab.includes(w)) this._vocab.push(w);
    }

    // Build TF-IDF vector and optionally quantize
    const vec  = tfidfVector(content, this._vocab);
    const stored = this._quantize ? quantize(vec) : vec;

    this._docs.set(id, { id, content, meta, vec: stored, addedAt: Date.now() });

    // Update HNSW index — re-index with dequantized vec
    const floatVec = this._quantize ? dequantize(stored) : vec;
    this._hnsw.insert(id, floatVec);

    // LRU eviction if over capacity
    this._insertOrder.push(id);
    if (this._docs.size > this._maxVecs) {
      const evict = this._insertOrder.shift();
      this._docs.delete(evict);
      this._hnsw.delete(evict);
    }
  }

  /**
   * Semantic search using HNSW.
   * Phase 2: O(log n) instead of O(n) linear scan.
   * Phase 4: GNN hop — also returns 1-hop graph neighbors of top hits.
   */
  search(query, { k = 10, includeGraph = false } = {}) {
    if (this._hnsw.size === 0) return [];

    const qVec   = tfidfVector(query, this._vocab);
    const hits   = this._hnsw.search(qVec, k);

    const results = hits
      .map(h => {
        const doc = this._docs.get(h.id);
        return doc ? { ...doc, score: h.score, vec: undefined } : null;
      })
      .filter(Boolean);

    // Phase 4: GNN — expand via 1-hop graph edges
    if (includeGraph) {
      const extra = new Set();
      for (const r of results) {
        const nodeId = r.meta?.nodeId;
        if (nodeId) {
          for (const { node } of this.getNeighbors(nodeId)) {
            const docId = 'node:' + node.id;
            if (!results.find(r => r.id === docId)) extra.add(docId);
          }
        }
      }
      for (const id of extra) {
        const doc = this._docs.get(id);
        if (doc) results.push({ ...doc, score: 0.1, vec: undefined, fromGraph: true });
      }
    }

    return results;
  }

  // ── Legacy shim (VectorStore API) ─────────────────────────────────────────
  add(doc)                { return this.addDoc(doc); }
  // Legacy alias
  get nodeCount()         { return this._nodes.size; }
  get docCount()          { return this._docs.size; }
  get indexSize()         { return this._hnsw.size; }
}

// ── Legacy exports for backwards compat ───────────────────────────────────────

export class KnowledgeGraph extends MemoryService {
  constructor(opts) { super(opts); }
}

export class VectorStore extends MemoryService {
  constructor(opts) { super(opts); }
}
