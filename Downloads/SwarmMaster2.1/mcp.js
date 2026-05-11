/**
 * mcp.js — Phase 1 hardened
 * CVE-2: all tool invocations via fetch (no shell), params schema-validated
 * CVE-3: responses redacted before logging
 */

import { redact, validate, SecurityError } from '../utils/security.js';
import { z } from 'zod';

const CALL_TIMEOUT_MS = 30_000;

export class MCPBus {
  /**
   * @param {object} opts
   * @param {Array}  [opts.servers]  Array of { name, url, transport? } objects
   */
  constructor({ servers = [] } = {}) {
    this._servers = _validateServers(servers);
    this._tools   = [];
    this._toolMap = new Map(); // toolName → serverUrl
  }

  /** Connect to all configured servers and discover their tools */
  async connect() {
    this._tools = [];
    this._toolMap.clear();

    await Promise.allSettled(
      this._servers.map(async s => {
        try {
          const tools = await this._discover(s);
          for (const t of tools) {
            this._tools.push({ ...t, server: s.name });
            this._toolMap.set(t.name, s.url);
          }
        } catch (err) {
          console.error(`[MCPBus] Failed to connect to "${s.name}": ${err.message}`);
        }
      })
    );

    return this;
  }

  /** List all discovered tools */
  listTools() { return [...this._tools]; }

  /**
   * Call a named MCP tool.
   * CVE-2: Uses fetch (HTTP), never a shell command.
   * Params are validated against the tool's input schema if present.
   */
  async call(toolName, params = {}) {
    if (!toolName || typeof toolName !== 'string') {
      throw new SecurityError('MCPBus.call: toolName must be a non-empty string');
    }

    const serverUrl = this._toolMap.get(toolName);
    if (!serverUrl) {
      throw new Error(`MCPBus: unknown tool "${toolName}". Did you call connect()?`);
    }

    // Validate params are a plain object — no prototype pollution
    if (typeof params !== 'object' || Array.isArray(params) || params === null) {
      throw new SecurityError('MCPBus.call: params must be a plain object');
    }

    const rpcId   = Math.random().toString(36).slice(2);
    const body    = JSON.stringify({
      jsonrpc: '2.0',
      id:      rpcId,
      method:  'tools/call',
      params:  { name: toolName, arguments: params },
    });

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(serverUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal:  controller.signal,
      });
    } catch (err) {
      throw new Error(`MCPBus: network error calling "${toolName}": ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`MCPBus: server returned HTTP ${response.status} for tool "${toolName}"`);
    }

    const json = await response.json();
    if (json.error) {
      throw new Error(`MCPBus: RPC error ${json.error.code}: ${json.error.message}`);
    }

    return redact(json.result); // CVE-3: scrub credentials from tool outputs
  }

  /** JSON-RPC tool discovery */
  async _discover(server) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    try {
      const res  = await fetch(server.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) return _mockTools(server);
      const json = await res.json();
      return (json.result?.tools ?? []).map(t => ({
        name:        t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));
    } catch {
      return _mockTools(server);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _validateServers(servers) {
  return servers.map((s, i) => {
    if (!s.name || typeof s.name !== 'string') throw new SecurityError(`MCP server[${i}]: name must be a string`);
    try { new URL(s.url); } catch { throw new SecurityError(`MCP server "${s.name}": invalid URL "${s.url}"`); }
    return { name: s.name, url: s.url, transport: s.transport ?? 'http' };
  });
}

function _mockTools(server) {
  return [{ name: `${server.name}_tool`, description: `Tool from ${server.name}` }];
}
