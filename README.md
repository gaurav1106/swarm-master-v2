# swarm-master-v2

[![npm version](https://img.shields.io/npm/v/swarm-master-v2?color=crimson&logo=npm)](https://www.npmjs.com/package/swarm-master-v2)
[![CI](https://img.shields.io/github/actions/workflow/status/swarm-master/swarm-master-v2/ci.yml?label=tests&logo=github)](https://github.com/swarm-master/swarm-master-v2/actions)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/swarm-master/swarm-master-v2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blueviolet)](https://github.com/swarm-master/swarm-master-v2/pulls)

**Multi-agent AI orchestration with prompt caching, OTel telemetry, A2A messaging, MCP tool bus, tiered model routing, crash recovery, vector RAG, a scored eval harness, and auto-skill learning — all in one package.**

---

## Table of Contents

- [Why swarm-master-v2?](#why-swarm-master-v2)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [CLI reference](#cli-reference)
  - [run](#swarm-run-task)
  - [eval](#swarm-eval-suite)
  - [skills](#swarm-skills)
  - [cost](#swarm-cost)
  - [traces](#swarm-traces)
  - [resume](#swarm-resume-runid)
  - [a2a](#swarm-a2a)
  - [mcp](#swarm-mcp)
  - [viz](#swarm-viz)
- [API reference](#api-reference)
  - [MasterAgent](#masteragent)
  - [Agents](#agents)
  - [KnowledgeGraph](#knowledgegraph)
  - [VectorStore](#vectorstore)
  - [A2ABus](#a2abus)
  - [MCPBus](#mcpbus)
  - [CostMeter](#costmeter)
  - [Telemetry](#telemetry)
  - [WorktreeManager](#worktreemanager)
  - [ModelRouter](#modelrouter)
  - [CheckpointManager](#checkpointmanager)
  - [EvalHarness](#evalharness)
  - [SkillStore](#skillstore)
  - [Skills injector](#skills-injector)
- [Configuration](#configuration)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

---

## Why swarm-master-v2?

Most multi-agent frameworks make you choose: a good DX **or** production features. swarm-master-v2 ships both:

| Problem | Solution |
|---|---|
| API costs spiral as agents repeat work | Prompt-cache prefix logic + cost meter |
| Debugging swarm behaviour is opaque | OpenTelemetry spans → Jaeger in one flag |
| Agents clobber each other's file edits | Git-worktree isolation per task |
| No standard way for agents to talk | A2A message bus (ask/reply/handoff/broadcast) |
| Big tasks waste money on powerful models | Tiered routing: Haiku → Sonnet → Opus |
| Crashes lose all progress | Heartbeat checkpoints + `swarm resume` |
| Agents never improve from experience | TF-IDF skill store, auto-extracted and injected |
| Hard to know if the swarm is actually working | 10-benchmark eval harness with CI gate |

---

## Installation

```bash
# Global (recommended for CLI)
npm install -g swarm-master-v2

# Local (for programmatic use)
npm install swarm-master-v2
```

Requires **Node.js ≥ 18**.

---

## Quick start

### CLI

```bash
# Run a task through the swarm
swarm run "Refactor the auth module to use OAuth 2.0"

# Score benchmarks against the default mock agent
swarm eval quick

# Inspect what the swarm has learned
swarm skills --list

# Show running costs
swarm cost
```

### Programmatic

```js
import { MasterAgent } from 'swarm-master-v2';

const master = new MasterAgent({
  agents:     [{ id: 'claude', type: 'claude', model: 'claude-sonnet-4-5' }],
  useSkills:  true,
  useCache:   true,
  checkpoint: '.swarm/checkpoints',
});

const result = await master.run('Summarise the Q3 financials and flag anomalies');
console.log(result.output);
console.log(`Cost: $${result.cost.totalUsd.toFixed(6)}`);
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        CLI / API                         │
└──────────────────────┬───────────────────────────────────┘
                       │
             ┌─────────▼─────────┐
             │   MasterAgent v2  │  ← orchestrates everything
             └──┬──────┬──────┬──┘
                │      │      │
       ┌────────▼─┐  ┌─▼──┐  ┌▼──────────┐
       │  Router  │  │A2A │  │Checkpoint │
       │(tier sel)│  │Bus │  │+ heartbeat│
       └────┬─────┘  └────┘  └───────────┘
            │
    ┌───────▼────────────────────────────────┐
    │          Agent Pool                    │
    │  Claude  Gemini  Hermes  Codex  Mock   │
    └───┬──────────────────────────┬─────────┘
        │                          │
   ┌────▼─────┐             ┌──────▼──────┐
   │  Skills  │             │  MCP Tools  │
   │ injector │             │  JSON-RPC   │
   └────┬─────┘             └─────────────┘
        │
   ┌────▼──────────────────────────────┐
   │  Memory layer                     │
   │  KnowledgeGraph (SQLite)          │
   │  VectorStore (TF-IDF RAG)         │
   │  SkillStore (EMA + eviction)      │
   └───────────────────────────────────┘
        │
   ┌────▼──────────┐
   │  Telemetry    │
   │  NDJSON/Jaeger│
   └───────────────┘
```

---

## CLI reference

All commands accept `--json` for machine-readable output and `--config <path>` to point at a custom agents config (default: `config/agents.json`).

### `swarm run <task>`

Execute a task through the full swarm pipeline.

```
Options:
  -a, --agent <id>         Pin to a specific agent id
  -t, --tier <tier>        Force model tier (haiku|sonnet|opus)
  --no-skills              Disable skill injection
  --no-cache               Disable prompt caching
  --no-worktree            Disable git-worktree isolation
  --timeout <ms>           Task timeout (default: 120000)
  --checkpoint <dir>       Checkpoint directory (default: .swarm/checkpoints)
  --dry-run                Print resolved plan without executing
  --mcp-config <path>      MCP servers config (default: config/mcp-servers.json)
```

```bash
# Basic run
swarm run "Write a REST API for user authentication"

# Force a specific tier, skip skills for speed
swarm run "Quick grammar check" --tier haiku --no-skills

# See what would happen without running
swarm run "Deploy to production" --dry-run
```

---

### `swarm eval [suite]`

Run scored benchmarks. `suite` is one of `quick` (default), `full`, or a benchmark id.

```
Options:
  -a, --agent <id>         Evaluate a specific agent
  --list                   List available benchmarks
  --threshold <score>      Fail below this pass-rate (default: 0.7)
  --concurrency <n>        Parallel workers (default: 4)
```

```bash
swarm eval quick                    # 5 fast benchmarks
swarm eval full                     # all 10 benchmarks
swarm eval fizzbuzz                 # single benchmark
swarm eval --list                   # show benchmark catalogue
swarm eval full --threshold 0.8     # CI gate at 80% pass rate
```

**Built-in benchmarks:**

| ID | Category | Description |
|---|---|---|
| `fizzbuzz` | logic | FizzBuzz up to 20 |
| `syllogism` | reasoning | 3-step deductive syllogism |
| `palindrome` | logic | Detect + explain palindromes |
| `bigO` | code | Identify Big-O of a code snippet |
| `codeSmells` | code | Name 3 code smells in a sample |
| `summarize` | language | Summarise a paragraph in ≤2 sentences |
| `tsBullets` | language | TypeScript doc → 3 bullet features |
| `idempotency` | knowledge | Define idempotency with an example |
| `apiAcronym` | knowledge | Expand API + explain REST |
| `unitConvert` | logic | Convert 72°F to Celsius |

---

### `swarm skills`

Inspect the learned skill store.

```
Options:
  --list                   List all skills
  --search <query>         Semantic TF-IDF search
  --agent <id>             Filter by agent
  --type <type>            Filter by type (rag|routing|tool|combo)
  --prune                  Remove stale / low-score skills
  --clear                  Delete all skills (with confirmation)
  --store <path>           Skill store path (default: .swarm/skills.json)
  --limit <n>              Max results (default: 20)
```

---

### `swarm cost`

Show prompt token and USD cost summary.

```
Options:
  --since <iso>            Filter runs after ISO date
  --agent <id>             Filter by agent
  --reset                  Reset counters
  --store <path>           Cost log path (default: .swarm/cost.json)
```

Sample output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Cost Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
┌──────────┬──────┬───────────┬────────────┬───────────┬──────────────┐
│ Agent    │ Runs │ Input tok │ Output tok │ Cache hits│ USD          │
├──────────┼──────┼───────────┼────────────┼───────────┼──────────────┤
│ claude   │   12 │    48 291 │      9 842 │       231 │ $0.000842    │
│ haiku    │    8 │    12 004 │      2 201 │        89 │ $0.000031    │
│ TOTAL    │   20 │    60 295 │     12 043 │       320 │ $0.000873    │
└──────────┴──────┴───────────┴────────────┴───────────┴──────────────┘
✔ Cache saved an estimated $0.000124 (12.4%)
```

---

### `swarm traces`

Dump or tail OpenTelemetry spans.

```
Options:
  --tail                   Stream new spans in real time
  --since <iso>            Show spans after this date
  --trace <id>             Show a single trace tree
  --agent <id>             Filter by agent
  --store <path>           NDJSON path (default: .swarm/traces.ndjson)
  --limit <n>              Max spans (default: 50)
```

```bash
swarm traces --tail                    # live stream
swarm traces --trace abc123            # single trace tree
swarm traces --since 2024-01-15T00:00  # recent runs
```

To send to Jaeger, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` before running any swarm command.

---

### `swarm resume [runId]`

Resume a crashed or interrupted run.

```
Options:
  --list                   List available checkpoints
  --checkpoint <dir>       Checkpoint directory (default: .swarm/checkpoints)
```

```bash
swarm resume --list          # see all saved checkpoints
swarm resume run_abc123      # resume specific run
```

---

### `swarm a2a`

Inspect the agent-to-agent message bus.

```
Options:
  --history                Show recent message history (default)
  --agents                 List agents currently registered on the bus
  --send <message>         Broadcast a test message
  --from <id>              Sender id for --send (default: cli)
  --limit <n>              Max messages (default: 30)
  --store <path>           A2A log path (default: .swarm/a2a.ndjson)
```

---

### `swarm mcp`

Manage MCP tool servers.

```
Options:
  --list                   List all registered tools (default)
  --call <tool>            Call a named tool
  --params <json>          JSON params for --call
  --config <path>          MCP servers config (default: config/mcp-servers.json)
```

```bash
swarm mcp --list
swarm mcp --call web_search --params '{"query":"openai gpt-5"}'
```

---

### `swarm viz`

Launch the D3 force-directed knowledge-graph visualiser.

```
Options:
  --port <n>               Port (default: 4242)
  --no-open                Start server but do not open browser
```

---

## API reference

### MasterAgent

```js
import { MasterAgent } from 'swarm-master-v2';

const master = new MasterAgent({
  agents:      [],          // agent config array (see config/agents.json)
  mcpServers:  [],          // MCP server config array
  useSkills:   true,        // inject learned skills into prompts
  useCache:    true,        // enable prompt-cache prefix logic
  useWorktree: true,        // isolate each task in a git worktree
  checkpoint:  '.swarm/checkpoints',
  forceTier:   null,        // 'haiku' | 'sonnet' | 'opus'
  forceAgent:  null,        // specific agent id
  timeout:     120_000,
});

const result = await master.run(task);
// result: { output, agent, tier, latencyMs, cost, traceId }

await master.resume(runId);
```

---

### Agents

```js
import { ClaudeAgent, MockAgent } from 'swarm-master-v2/agents';

const agent = new ClaudeAgent({ model: 'claude-sonnet-4-5', apiKey: process.env.ANTHROPIC_API_KEY });
const result = await agent.run('Explain monads', { systemPrompt: '…' });
```

Available agent types: `ClaudeAgent`, `GeminiAgent`, `HermesAgent`, `CodexAgent`, `PerplexityAgent`, `MockAgent`.

---

### KnowledgeGraph

SQLite-backed shared knowledge graph.

```js
import { KnowledgeGraph } from 'swarm-master-v2/memory/graph';

const graph = new KnowledgeGraph({ path: '.swarm/graph.db' });
graph.addNode({ id: 'task-1', type: 'task', label: 'Auth refactor' });
graph.addEdge({ from: 'task-1', to: 'task-2', label: 'depends_on' });
const nodes = graph.query({ type: 'task' });
```

---

### VectorStore

TF-IDF vector store with cosine similarity search.

```js
import { VectorStore } from 'swarm-master-v2/memory/vector';

const store = new VectorStore();
store.add({ id: 'doc-1', content: 'OAuth 2.0 implementation guide' });
const hits = store.search('authentication flow', 5);
// hits: [{ id, score, content }]
```

---

### A2ABus

Agent-to-agent message bus.

```js
import { A2ABus } from 'swarm-master-v2/messaging/a2a';

const bus = new A2ABus();
bus.register('claude');
bus.register('codex');

await bus.ask({ from: 'claude', to: 'codex', content: 'Review this PR diff' });
await bus.broadcast({ from: 'claude', content: 'Task complete' });
await bus.handoff({ from: 'claude', to: 'hermes', task, context });
```

---

### MCPBus

JSON-RPC 2.0 client for MCP tool servers.

```js
import { MCPBus } from 'swarm-master-v2/tools/mcp';

const bus = new MCPBus({ servers: [{ name: 'search', url: 'http://localhost:3001' }] });
await bus.connect();

const tools = bus.listTools();
const result = await bus.call('web_search', { query: 'latest AI papers' });
```

---

### CostMeter

Prompt token and cost accounting.

```js
import { CostMeter } from 'swarm-master-v2/utils/cost';

const meter = new CostMeter({ path: '.swarm/cost.json' });
meter.record({ agentId: 'claude', inputTokens: 1200, outputTokens: 400, cacheHits: 3 });
const summary = meter.summary({ agentId: 'claude' });
// summary.totalUsd, summary.cacheSavingsPct, summary.byAgent
```

---

### Telemetry

OpenTelemetry span recording.

```js
import { Telemetry } from 'swarm-master-v2/utils/telemetry';

const tel = new Telemetry({ path: '.swarm/traces.ndjson' });
const span = tel.startSpan('agent.run', { agentId: 'claude', task: 'auth refactor' });
// … do work …
tel.endSpan(span, { status: 'OK', tokens: 1200 });
```

---

### WorktreeManager

Git worktree isolation per task.

```js
import { WorktreeManager } from 'swarm-master-v2/utils/worktree';

const wt = new WorktreeManager({ repoPath: process.cwd() });
await wt.withWorktree(async (dir) => {
  // all file edits happen inside `dir` — main repo untouched
});
```

---

### ModelRouter

Tiered model selection.

```js
import { ModelRouter } from 'swarm-master-v2/utils/router';

const router = new ModelRouter({ agents: agentPool });
const { tier, agentId, rationale } = router.route(task, { budget: 'low' });
```

---

### CheckpointManager

Crash recovery with heartbeats.

```js
import { CheckpointManager } from 'swarm-master-v2/utils/checkpoint';

const mgr = new CheckpointManager({ dir: '.swarm/checkpoints' });
const runId = mgr.start({ task, context });
mgr.heartbeat(runId, { step: 2, partialOutput: '…' });
mgr.complete(runId, result);

// Later, after a crash:
const checkpoint = await mgr.load(runId);
```

---

### EvalHarness

Scored benchmark runner.

```js
import { EvalHarness, makeMockAgentRunner } from 'swarm-master-v2/eval';
import { BENCHMARKS, addBenchmark }         from 'swarm-master-v2/eval/benchmarks';
import { formatReport }                     from 'swarm-master-v2/eval/scorer';

// Add a custom benchmark
addBenchmark({
  id:          'haiku',
  category:    'language',
  description: 'Write a haiku about async/await',
  prompt:      'Write a haiku (5-7-5) about JavaScript async/await.',
  judge: (output) => {
    const lines = output.trim().split('\n').filter(Boolean);
    return lines.length === 3 ? 1.0 : 0.0;
  },
});

const harness = new EvalHarness({ runner: makeMockAgentRunner(), concurrency: 4 });
harness.on('benchmark:done', ({ id, score }) => console.log(id, score));

const results = await harness.run('quick');
console.log(formatReport(results));
```

---

### SkillStore

Persistent skill store with EMA merging and TF-IDF search.

```js
import { SkillStore } from 'swarm-master-v2/skills/store';

const store = new SkillStore({
  path:    '.swarm/skills.json',
  maxSize: 1000,     // LRU eviction cap
  maxAge:  30,       // days before stale pruning
  minScore: 0.3,
});
await store.load();

store.add({ type: 'rag', agentId: 'claude', content: '…', score: 0.9 });
const hits = store.search('OAuth implementation', { type: 'rag', limit: 5 });
store.prune();
await store.save();
```

---

### Skills injector

High-level helpers that wrap the store.

```js
import { buildSkillContext, learnFromRun, withSkills } from 'swarm-master-v2/skills';

// Inject skills into a prompt
const context = await buildSkillContext('Refactor auth module', 'claude');
// context: string of relevant past skills to prepend to system prompt

// Learn from a completed run
await learnFromRun({
  task, agentId: 'claude', output, score: 0.85,
  mcpCalls, a2aMessages, tier: 'sonnet',
});

// Transparent wrapper
const smartAgent = withSkills('claude', myAgentFn);
const result = await smartAgent(task);
// automatically injects skills before, learns from output after
```

---

## Configuration

### `config/agents.json`

```json
[
  {
    "id": "claude",
    "type": "claude",
    "model": "claude-sonnet-4-5",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "tier": "sonnet"
  },
  {
    "id": "haiku",
    "type": "claude",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "tier": "haiku"
  }
]
```

Environment variables of the form `${VAR}` are expanded at load time.

### `config/mcp-servers.json`

```json
[
  {
    "name": "filesystem",
    "url":  "http://localhost:3001",
    "transport": "http"
  },
  {
    "name": "search",
    "url":  "http://localhost:3002",
    "transport": "http"
  }
]
```

---

## Testing

```bash
# All 279 tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# With coverage
npm run test:coverage
```

The test suite uses `tests/helpers/factories.js` for temp-dir factory functions — no real filesystem paths or API keys are needed.

---

## Contributing

1. Fork the repo and create a feature branch.
2. Add tests (maintain ≥100% coverage on new code).
3. Run `npm test` — all 279 must pass.
4. Open a PR against `main`.

Please see [CHANGELOG.md](CHANGELOG.md) for the full list of changes.

---

## License

[MIT](LICENSE) © swarm-master contributors
