# Changelog

All notable changes to **swarm-master-v2** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] — 2024-01-01

### Added

#### Core orchestration
- `MasterAgent` v2 — full task lifecycle management with pluggable agent pool
- `BaseAgent` v2 — unified interface for Claude, Gemini, Hermes, Codex, Perplexity, and Mock agents

#### GAP 1 — Prompt caching & cost metering (`src/utils/cost.js`)
- Anthropic-compatible prompt-cache prefix logic
- Per-agent token accounting (input, output, cache-hit, cache-write)
- `CostMeter.summary()` with USD estimates and cache-savings percentage
- NDJSON cost log with `--since` / `--agent` filtering

#### GAP 2 — OpenTelemetry telemetry (`src/utils/telemetry.js`)
- W3C-compliant `traceId` / `spanId` generation
- NDJSON span export compatible with Jaeger OTLP-HTTP
- `Telemetry.tail()` for live span streaming
- Structured `attributes` carrying agent id, tier, task hash

#### GAP 3 — Git worktree isolation (`src/utils/worktree.js`)
- One `git worktree add` per task — zero cross-task file clobber
- Automatic cleanup on task completion or crash
- `WorktreeManager.withWorktree(fn)` wrapper

#### GAP 4 — Agent-to-agent bus (`src/messaging/a2a.js`)
- `ask` / `reply` / `handoff` / `broadcast` message types
- In-memory routing with optional NDJSON persistence
- `A2ABus.history()` for post-hoc audit

#### GAP 5 — Tiered model routing (`src/utils/router.js`)
- Haiku → Sonnet → Opus automatic escalation
- Budget, latency, and complexity scoring per request
- `ModelRouter.route(task, context)` returning `{ tier, agentId, rationale }`

#### GAP 6 — Crash recovery & heartbeat (`src/utils/checkpoint.js`)
- Periodic heartbeat writes to `.swarm/checkpoints/<runId>.json`
- `CheckpointManager.resume(runId)` replays from last saved state
- Configurable retry limit and backoff strategy

#### GAP 7 — MCP JSON-RPC tool bus (`src/tools/mcp.js`)
- JSON-RPC 2.0 client for any MCP server
- `MCPBus.connect()` initialises all servers from config
- `MCPBus.call(tool, params)` with automatic server routing
- `MCPBus.listTools()` aggregated across servers

#### GAP 8 — TF-IDF vector store & RAG (`src/memory/vector.js`)
- In-memory TF-IDF index with cosine similarity
- `VectorStore.add(doc)` / `VectorStore.search(query, k)`
- RAG context injection into agent prompts
- Shared with `KnowledgeGraph` (SQLite) for persistence

#### GAP 9 — Eval harness (`src/eval/`)
- 10 built-in benchmarks across 5 categories (logic, reasoning, code, language, knowledge)
- `EvalHarness.run(suite)` — `quick` / `full` / single benchmark id
- Judge functions score 0–1 with token-count penalty and tier bonus
- `formatReport()` — boxed ASCII table with pass-rate, cost, latency per agent and benchmark
- `EventEmitter`: `start`, `benchmark:start`, `benchmark:done`, `done`
- `addBenchmark()` for user-defined benchmarks
- `makeMockAgentRunner()` for CI without real API keys

#### GAP 10 — Auto skill learning (`src/skills/`)
- `SkillExtractor` pulls 4 skill types from every run:
  - **RAG seeds** — high-quality outputs (score ≥ 0.7, length > 50)
  - **Routing hints** — which tier succeeded for which task signals
  - **Tool sequences** — MCP call chains that succeeded
  - **Agent combos** — A2A delegation patterns that worked
- `SkillStore` — EMA score merging, TF-IDF search, LRU eviction, disk persistence, stale-skill pruning
- `buildSkillContext(task, agentId)` — injects relevant skills into system prompts
- `learnFromRun(data)` — one-call integration after any run
- `withSkills(agentId, fn)` — transparent decorator for any agent function

#### CLI (`src/cli/swarm.js`)
- `swarm run <task>` — full run with all GAPs wired
- `swarm eval [suite]` — scored benchmarks with `--threshold` CI gate
- `swarm skills` — list / search / prune / clear skill store
- `swarm cost` — token & USD summary with cache savings
- `swarm traces` — dump or tail OTel spans
- `swarm resume [runId]` — replay a crashed run from checkpoint
- `swarm a2a` — inspect message bus history and agents
- `swarm mcp` — list or call MCP tools
- `swarm viz` — launch D3 knowledge-graph visualiser

#### Knowledge graph visualiser (`src/memory/visualize.js`)
- D3 force-directed graph at `http://localhost:4242`
- Live updates via SSE as nodes/edges are added

#### Test suite
- 279 passing tests across 12 suites (10 unit, 2 integration)
- Zero mocking of real filesystem paths; all I/O uses temp dirs via `factories.js`

---

## [1.0.0] — legacy

Initial release — single-agent wrapper, no orchestration.

---

[2.0.0]: https://github.com/swarm-master/swarm-master-v2/releases/tag/v2.0.0
[1.0.0]: https://github.com/swarm-master/swarm-master-v2/releases/tag/v1.0.0
