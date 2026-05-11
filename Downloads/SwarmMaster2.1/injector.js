/**
 * injector.js — Phase 4: GNN-enhanced context injection
 *
 * buildSkillContext now does 2-hop graph expansion:
 *   1. Semantic HNSW search → top-k skills
 *   2. Graph hop → skills linked to the same benchmark category
 *   3. Merge, dedup, rank by score × relevance
 *
 * Also integrates ReasoningBank.seed() on first call (cold-start fix).
 */

import { SkillStore }     from './store.js';
import { SkillExtractor } from './extractor.js';
import { ReasoningBank }  from './reasoning-bank.js';

const _store = new SkillStore({ path: '.swarm/skills.json' });
const _ext   = new SkillExtractor();
let _loaded  = false;

async function ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  await _store.load();
  // Phase 4: seed if cold start
  if (_store.size === 0) {
    const n = await ReasoningBank.seed(_store, { suite: 'quick', agentId: 'system' });
    if (n > 0) console.log(`[Skills] Cold-start: seeded ${n} skills from ReasoningBank`);
  }
}

/**
 * Build a context string for injection into a system prompt.
 * Phase 4: includes 1-hop "related category" skills via graph expansion.
 *
 * @param {string} task      The current task
 * @param {string} agentId   The agent that will receive this context
 * @returns {string}         Context block to prepend to the system prompt
 */
export async function buildSkillContext(task, agentId) {
  await ensureLoaded();

  // Primary semantic search
  const directHits = _store.search(task, { agentId, limit: 5 });

  // GNN hop: find skills in the same category as top hits
  const expandedIds = new Set(directHits.map(h => h.id));
  const graphHits   = [];

  for (const hit of directHits.slice(0, 3)) {
    const category = hit.metadata?.category ?? hit.metadata?.benchmarkCategory;
    if (!category) continue;
    // Find other skills tagged with the same category
    const related = _store.list({ limit: 50 }).filter(s =>
      !expandedIds.has(s.id) &&
      (s.metadata?.category === category || s.metadata?.benchmarkCategory === category)
    );
    for (const r of related.slice(0, 2)) {
      expandedIds.add(r.id);
      graphHits.push({ ...r, _fromGraph: true });
    }
  }

  const all = [
    ...directHits.map(h => ({ ...h, _priority: 1.0 })),
    ...graphHits.map(h =>  ({ ...h, _priority: 0.6 })),
  ].sort((a, b) => (b.score * b._priority) - (a.score * a._priority));

  if (!all.length) return '';

  const lines = all.map(h => {
    const tag = h._fromGraph ? `[${h.type}/related]` : `[${h.type}]`;
    return `${tag} ${String(h.content).slice(0, 300)}`;
  });

  return [
    '### Relevant past skills ###',
    ...lines,
    '###',
    '',
  ].join('\n');
}

export async function learnFromRun(data) {
  await ensureLoaded();
  const skills = _ext.extract(data);
  for (const s of skills) _store.add(s);
  await _store.save();
}

export function withSkills(agentId, fn) {
  return async (task, opts = {}) => {
    const ctx = await buildSkillContext(task, agentId);
    const systemPrompt = [ctx, opts.systemPrompt].filter(Boolean).join('\n');
    const result = await fn(task, { ...opts, systemPrompt });
    await learnFromRun({
      task, agentId,
      output:      result?.output ?? String(result),
      score:       result?.score  ?? 0.5,
      tier:        result?.tier,
      mcpCalls:    result?.mcpCalls    ?? [],
      a2aMessages: result?.a2aMessages ?? [],
    }).catch(() => {});
    return result;
  };
}
