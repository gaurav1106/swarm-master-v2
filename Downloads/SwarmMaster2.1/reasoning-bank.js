/**
 * reasoning-bank.js — Phase 4: ReasoningBank
 *
 * Solves the cold-start problem: on first deploy there are no learned skills,
 * so skill injection has nothing to inject.
 *
 * Solution: run the eval suite immediately after install, collect all
 * passing outputs, and seed them as high-confidence RAG skills.
 * Every subsequent run builds on this baseline.
 *
 * Usage
 *   import { ReasoningBank } from './reasoning-bank.js'
 *   await ReasoningBank.seed(store, { runner, suite: 'full' })
 *   // store now has baseline skills for every benchmark category
 */

import { EvalHarness, makeMockAgentRunner } from '../eval/harness.js';
import { BENCHMARKS }                       from '../eval/benchmarks.js';

// Category → system-level skill type mapping
const CATEGORY_TYPE = {
  logic:     'rag',
  reasoning: 'rag',
  code:      'rag',
  language:  'rag',
  knowledge: 'rag',
};

export class ReasoningBank {
  /**
   * Seed a SkillStore from the eval harness.
   *
   * @param {SkillStore} store       The store to seed
   * @param {object}     opts
   * @param {Function}   [opts.runner]     Agent runner (defaults to mock)
   * @param {string}     [opts.suite]      'quick' | 'full' (default 'full')
   * @param {string}     [opts.agentId]    Tag skills with this agent id
   * @param {number}     [opts.minScore]   Minimum score to seed (default 0.7)
   * @param {boolean}    [opts.force]      Re-seed even if store already has skills
   * @returns {number}  Number of skills seeded
   */
  static async seed(store, {
    runner   = makeMockAgentRunner(),
    suite    = 'full',
    agentId  = 'system',
    minScore = 0.7,
    force    = false,
  } = {}) {
    // Skip if already seeded and not forced
    if (!force && store.size > 0) return 0;

    const harness = new EvalHarness({ runner, concurrency: 4, agentId });
    const results = await harness.run(suite);

    let seeded = 0;
    for (const result of results.results ?? []) {
      if (result.score < minScore) continue;
      if (!result.output || result.output.length < 30) continue;

      const benchmark = BENCHMARKS.find(b => b.id === result.benchmarkId);
      if (!benchmark) continue;

      // Seed the output as a RAG skill
      store.add({
        type:    CATEGORY_TYPE[benchmark.category] ?? 'rag',
        agentId,
        content: result.output,
        score:   result.score,
        metadata: {
          source:      'reasoning-bank',
          benchmarkId: result.benchmarkId,
          category:    benchmark.category,
          prompt:      benchmark.prompt,
          seededAt:    new Date().toISOString(),
        },
      });
      seeded++;

      // Also seed a routing hint: this category → which tier was fastest
      store.add({
        type:    'routing',
        agentId,
        content: JSON.stringify({
          category:    benchmark.category,
          benchmarkId: result.benchmarkId,
          tier:        result.tier ?? 'unknown',
          avgLatency:  result.latencyMs,
        }),
        score: result.score,
        metadata: { source: 'reasoning-bank', seededAt: new Date().toISOString() },
      });
      seeded++;
    }

    await store.save();
    return seeded;
  }

  /**
   * Check if a store has been seeded.
   * A seeded store has at least one skill from the reasoning-bank source.
   */
  static isSeeded(store) {
    return store.list({ limit: 200 }).some(s => s.metadata?.source === 'reasoning-bank');
  }

  /**
   * Print a summary of seeded skills by category.
   */
  static summary(store) {
    const skills = store.list({ limit: 1000 }).filter(s => s.metadata?.source === 'reasoning-bank');
    const byCategory = {};
    for (const s of skills) {
      const cat = s.metadata?.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }
    return { total: skills.length, byCategory };
  }
}
