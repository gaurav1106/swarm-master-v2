/**
 * router.js — Phase 4: SONA adaptive routing (calibrated signals)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { assertSafePath } from './security.js';

const TIERS     = ['haiku', 'sonnet', 'opus'];
const EMA_ALPHA = 0.2;

function extractSignals(task) {
  const t = String(task);
  return {
    length:       t.length,
    isShort:      t.length < 120,
    isMedium:     t.length >= 120 && t.length < 1200,
    isLong:       t.length >= 1200,
    hasCode:      /```|def |function |class |import |const |let |var |refactor|implement|module/.test(t),
    hasMath:      /\b(equation|formula|calculate|integral|derivative|matrix|proof|prove|hypothesis|theorem|derivation)\b/i.test(t),
    hasReasoning: /\b(why|explain|analyse|analyze|compare|evaluate|reason|argue|debate|advanced|complex)\b/i.test(t),
    hasCreative:  /\b(write|draft|compose|story|poem|creative|narrative|blog|essay)\b/i.test(t),
    hasFactual:   /\b(what is|define|list|summarise|summarize|describe|facts)\b/i.test(t),
    hasMultiStep: /\b(step|first|then|next|finally|sequence|workflow|plan|oauth|pkce|flow)\b/i.test(t),
    questionCount:(t.match(/\?/g) ?? []).length,
  };
}

function scoreSignals(signals, weights) {
  let score = 0;
  for (const [k, v] of Object.entries(signals)) {
    if (typeof v === 'boolean') score += v ? (weights[k] ?? 0) : 0;
    else if (typeof v === 'number') score += v * (weights[k] ?? 0);
  }
  return score;
}

export class ModelRouter {
  constructor({ agents = [], weightsPath = null } = {}) {
    this._agents      = agents;
    this._weightsPath = weightsPath ? assertSafePath(weightsPath) : null;
    this._weights = {
      haiku:  { isShort: 1.5, hasFactual: 1.5, questionCount: -0.3, hasCode: -1.5, hasMath: -2.0, hasReasoning: -1.5, hasMultiStep: -1.0, isLong: -3.0, isMedium: -1.0 },
      sonnet: { isMedium: 1.0, hasCode: 2.0, hasReasoning: 0.8, hasMultiStep: 1.5, isShort: -0.8, isLong: -0.5, hasMath: 0.5 },
      opus:   { isLong: 3.0, hasMath: 3.0, hasReasoning: 2.5, hasMultiStep: 0.5, hasCode: 0.8, isMedium: -0.5, isShort: -2.0 },
    };
    this._history = [];
    this._loaded  = false;
  }

  async load() {
    if (this._loaded || !this._weightsPath) return;
    this._loaded = true;
    if (!existsSync(this._weightsPath)) return;
    try {
      const data = JSON.parse(readFileSync(this._weightsPath, 'utf8'));
      if (data.weights) this._weights = data.weights;
      if (data.history) this._history = data.history.slice(-1000);
    } catch {}
  }

  async save() {
    if (!this._weightsPath) return;
    mkdirSync(dirname(this._weightsPath), { recursive: true });
    writeFileSync(this._weightsPath, JSON.stringify({ weights: this._weights, history: this._history.slice(-1000), savedAt: new Date().toISOString() }));
  }

  route(task, { forceTier, budget = 'auto' } = {}) {
    if (forceTier && TIERS.includes(forceTier)) return this._resolve(forceTier, task, 'forced', 1.0);
    const signals    = extractSignals(task);
    const availTiers = budget === 'low' ? ['haiku', 'sonnet'] : budget === 'high' ? ['sonnet', 'opus'] : TIERS;
    const scores     = availTiers.map(tier => ({ tier, score: scoreSignals(signals, this._weights[tier]) }));
    scores.sort((a, b) => b.score - a.score);
    const best       = scores[0];
    const second     = scores[1]?.score ?? 0;
    const confidence = Math.min(1, (best.score - second) / (Math.abs(best.score) + 1));
    return this._resolve(best.tier, task, `adaptive(score=${best.score.toFixed(2)})`, confidence);
  }

  async learn({ task, tier, score, latencyMs, costUsd = 0 }) {
    if (!TIERS.includes(tier)) return;
    const signals     = extractSignals(task);
    const reward      = _reward(score, latencyMs, costUsd, tier);
    const tierWeights = this._weights[tier];
    for (const [signal, value] of Object.entries(signals)) {
      if (typeof value === 'boolean' && value)
        tierWeights[signal] = (tierWeights[signal] ?? 0) * (1 - EMA_ALPHA) + reward * EMA_ALPHA;
    }
    this._history.push({ task: task.slice(0, 80), tier, score, latencyMs, costUsd, ts: Date.now() });
    if (this._history.length > 1000) this._history.shift();
    await this.save();
  }

  stats() {
    const byTier = {};
    for (const r of this._history) {
      const t = byTier[r.tier] ??= { count: 0, totalScore: 0, totalLatency: 0 };
      t.count++; t.totalScore += r.score; t.totalLatency += r.latencyMs;
    }
    return Object.fromEntries(Object.entries(byTier).map(([tier, t]) => [tier, {
      count: t.count, avgScore: t.count ? t.totalScore / t.count : 0, avgLatency: t.count ? t.totalLatency / t.count : 0,
    }]));
  }

  _resolve(tier, task, rationale, confidence) {
    const agent = this._agents.find(a => a.tier === tier) ?? this._agents[0];
    return { tier, agentId: agent?.id ?? tier, rationale, confidence };
  }
}

function _reward(score, latencyMs, costUsd, tier) {
  const q = (score - 0.5) * 2;
  const l = -Math.min(1, latencyMs / 30_000);
  const c = -Math.min(1, costUsd / 0.01);
  const t = tier === 'haiku' ? 0.1 : tier === 'sonnet' ? 0 : -0.1;
  return q + l * 0.2 + c * 0.1 + t;
}
