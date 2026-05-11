/**
 * harness.js — Phase 2: real parallel concurrency via p-limit
 * Benchmarks now run in true parallel workers bounded by --concurrency
 */

import { EventEmitter }  from 'events';
import pLimit            from 'p-limit';
import { BENCHMARKS }   from './benchmarks.js';
import { scoreResult, aggregateResults } from './scorer.js';
import { validate, SCHEMAS } from '../utils/security.js';

export class EvalHarness extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.runner       async (prompt, { agentId, benchmarkId }) => { output }
   * @param {number}   [opts.concurrency]  Max parallel benchmark calls (default 4)
   * @param {string}   [opts.agentId]
   */
  constructor({ runner, concurrency = 4, agentId } = {}) {
    super();
    this._runner      = runner;
    this._concurrency = Math.max(1, Math.min(concurrency, 32));
    this._agentId     = agentId;
  }

  /**
   * Run benchmarks in parallel using p-limit.
   * @param {string} suite  'quick' | 'full' | benchmarkId
   */
  async run(suite = 'quick') {
    // Validate suite arg — CVE: reject arbitrary strings
    const validSuiteArg = typeof suite === 'string' && suite.length < 64 ? suite : 'quick';

    const QUICK = ['fizzbuzz', 'syllogism', 'palindrome', 'bigO', 'summarize'];
    let benchmarks = BENCHMARKS;
    if (validSuiteArg === 'quick')      benchmarks = BENCHMARKS.filter(b => QUICK.includes(b.id));
    else if (validSuiteArg !== 'full')  benchmarks = BENCHMARKS.filter(b => b.id === validSuiteArg);

    this.emit('start', { total: benchmarks.length, concurrency: this._concurrency });

    // p-limit gives us true bounded parallelism
    const limit   = pLimit(this._concurrency);
    const results = await Promise.all(
      benchmarks.map(b => limit(async () => {
        this.emit('benchmark:start', { id: b.id });
        const t0 = Date.now();
        let output = '';
        try {
          const r = await this._runner(b.prompt, { agentId: this._agentId, benchmarkId: b.id });
          output  = r?.output ?? String(r);
        } catch (err) {
          output = '';
        }
        const latencyMs = Date.now() - t0;
        const score     = scoreResult({ output, judge: b.judge, latencyMs });
        const result    = { benchmarkId: b.id, agentId: this._agentId ?? 'unknown', output, score, latencyMs };
        this.emit('benchmark:done', { id: b.id, score, latencyMs });
        return result;
      }))
    );

    const agg = aggregateResults(results);
    this.emit('done', agg);
    return agg;
  }
}

export function makeMockAgentRunner() {
  const responses = {
    fizzbuzz:    '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n16\n17\nFizz\n19\nBuzz',
    syllogism:   'Yes. All humans are mortal, Socrates is human, therefore Socrates is mortal.',
    palindrome:  'Yes, racecar is a palindrome because it reads the same forwards and backwards.',
    bigO:        'The time complexity is O(n^2) because the nested loops each iterate n times.',
    codeSmells:  '- Long method: methods with too many lines\n- Duplicated code: repeated logic\n- Magic numbers: unexplained numeric literals',
    summarize:   'Mitochondria are eukaryotic organelles that generate ATP via oxidative phosphorylation.',
    tsBullets:   '- Static typing\n- Interfaces and generics\n- Compiles to JavaScript',
    idempotency: 'Idempotency means applying an operation multiple times produces the same result. Example: HTTP PUT.',
    apiAcronym:  'API stands for Application Programming Interface. REST (Representational State Transfer) is an architectural style.',
    unitConvert: '(72 - 32) x 5/9 = 22.2 degrees Celsius',
  };
  return async (prompt, opts = {}) => {
    const key = opts.benchmarkId && responses[opts.benchmarkId]
      ? opts.benchmarkId
      : Object.keys(responses).find(k => prompt.toLowerCase().includes(k.toLowerCase()));
    return { output: responses[key] ?? "I don't know." };
  };
}
