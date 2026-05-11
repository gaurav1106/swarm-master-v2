/**
 * registry.js — Phase 3: Plugin microkernel for agent registration
 *
 * Allows third-party agents without forking the core.
 * Packages named `swarm-agent-*` are auto-discovered from node_modules.
 *
 * Usage
 *   import { AgentRegistry } from './registry.js'
 *   AgentRegistry.register('my-agent', opts => new MyAgent(opts))
 *   const agent = AgentRegistry.create('my-agent', { apiKey: '...' })
 */

import { existsSync, readdirSync } from 'fs';
import { resolve, join }           from 'path';
import { validate, SecurityError } from '../utils/security.js';
import { z }                       from 'zod';

const BUILT_IN_TYPES = new Set(['claude', 'gemini', 'hermes', 'codex', 'perplexity', 'mock']);

const factorySchema = z.function().args(z.object({}).passthrough()).returns(z.any());
const idSchema      = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);

export class AgentRegistry {
  static _factories = new Map(); // agentType → factory function
  static _loaded    = false;

  /**
   * Register a factory for an agent type.
   * @param {string}   type     Unique agent type id (e.g. 'claude', 'my-gpt')
   * @param {Function} factory  (opts) => BaseAgent instance
   */
  static register(type, factory) {
    const safeType = idSchema.parse(type);
    if (typeof factory !== 'function') throw new SecurityError('AgentRegistry.register: factory must be a function');
    AgentRegistry._factories.set(safeType, factory);
  }

  /**
   * Create an agent by type. Throws if type is not registered.
   */
  static create(type, opts = {}) {
    const safeType = idSchema.parse(type);
    const factory  = AgentRegistry._factories.get(safeType);
    if (!factory) {
      const available = [...AgentRegistry._factories.keys()].join(', ');
      throw new Error(`AgentRegistry: unknown agent type "${safeType}". Available: ${available}`);
    }
    return factory(opts);
  }

  /**
   * Check if a type is registered.
   */
  static has(type) {
    return AgentRegistry._factories.has(type);
  }

  /**
   * List all registered agent types.
   */
  static list() {
    return [...AgentRegistry._factories.keys()];
  }

  /**
   * Auto-discover and load plugin packages matching `swarm-agent-*` or `swarm-mcp-*`
   * from node_modules in the given root (defaults to process.cwd()).
   */
  static async autoDiscover(root = process.cwd()) {
    if (AgentRegistry._loaded) return;
    AgentRegistry._loaded = true;

    const nmDir = resolve(root, 'node_modules');
    if (!existsSync(nmDir)) return;

    let entries = [];
    try { entries = readdirSync(nmDir); } catch { return; }

    const plugins = entries.filter(
      n => n.startsWith('swarm-agent-') || n.startsWith('swarm-mcp-')
    );

    for (const pkg of plugins) {
      try {
        const pkgJson = JSON.parse(
          await import('fs').then(fs =>
            fs.readFileSync(join(nmDir, pkg, 'package.json'), 'utf8')
          )
        );
        const main = pkgJson.main ?? 'index.js';
        const mod  = await import(join(nmDir, pkg, main));
        if (typeof mod.register === 'function') {
          mod.register(AgentRegistry);
          console.log(`[AgentRegistry] Loaded plugin: ${pkg}`);
        }
      } catch (err) {
        console.warn(`[AgentRegistry] Failed to load plugin "${pkg}": ${err.message}`);
      }
    }
  }
}

// ── Register built-in types ───────────────────────────────────────────────────

async function _registerBuiltIns() {
  const { ClaudeAgent, GeminiAgent, HermesAgent, CodexAgent, PerplexityAgent, MockAgent } =
    await import('./agents.js');

  AgentRegistry.register('claude',      opts => new ClaudeAgent(opts));
  AgentRegistry.register('gemini',      opts => new GeminiAgent(opts));
  AgentRegistry.register('hermes',      opts => new HermesAgent(opts));
  AgentRegistry.register('codex',       opts => new CodexAgent(opts));
  AgentRegistry.register('perplexity',  opts => new PerplexityAgent(opts));
  AgentRegistry.register('mock',        opts => new MockAgent(opts));
}

// Register built-ins eagerly on module load
_registerBuiltIns().catch(() => {});
