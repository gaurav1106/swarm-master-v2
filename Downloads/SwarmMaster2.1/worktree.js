/**
 * worktree.js — Phase 1 hardened
 * CVE-1: all paths jail-checked before fs access
 * CVE-2: all git commands via safeSpawn, shell:false
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir }              from 'os';
import { join, resolve }       from 'path';
import { jailPath, safeSpawn, SecurityError } from './security.js';

const GIT_BINARY = process.env.GIT_BINARY ?? 'git';

export class WorktreeManager {
  constructor({ repoPath = process.cwd(), worktreeBase = tmpdir() } = {}) {
    this.repoPath     = resolve(repoPath);
    this.worktreeBase = resolve(worktreeBase);
  }

  async _assertGitRepo() {
    const { code } = await safeSpawn(GIT_BINARY, ['-C', this.repoPath, 'rev-parse', '--git-dir']);
    if (code !== 0) throw new SecurityError(`Not a git repository: ${this.repoPath}`);
  }

  async withWorktree(fn, { branch } = {}) {
    const worktreeDir = mkdtempSync(join(this.worktreeBase, 'swarm-wt-'));
    jailPath(this.worktreeBase, worktreeDir); // CVE-1

    let isGitWorktree = false;
    try {
      await this._assertGitRepo();
      const wtArgs = ['worktree', 'add', '--detach', worktreeDir];
      if (branch) {
        _assertSafeBranchName(branch); // CVE-2 guard
        wtArgs.splice(2, 1);
        wtArgs.push(branch);
      }
      const { code, stderr } = await safeSpawn(GIT_BINARY, ['-C', this.repoPath, ...wtArgs]);
      if (code !== 0) throw new Error(`git worktree add failed: ${stderr}`);
      isGitWorktree = true;
    } catch (err) {
      if (err instanceof SecurityError) throw err;
      // non-fatal: fall through to plain temp dir
    }

    try {
      return await fn(worktreeDir);
    } finally {
      if (isGitWorktree) {
        await safeSpawn(GIT_BINARY, ['-C', this.repoPath, 'worktree', 'remove', '--force', worktreeDir]).catch(() => {});
      }
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  }

  async list() {
    const { stdout, code } = await safeSpawn(GIT_BINARY, ['-C', this.repoPath, 'worktree', 'list', '--porcelain']);
    if (code !== 0) return [];
    return stdout.split('\n\n').filter(Boolean).map(block => {
      const lines = Object.fromEntries(block.trim().split('\n').map(l => l.split(' ')));
      return { path: lines.worktree, head: lines.HEAD, branch: lines.branch };
    });
  }
}

function _assertSafeBranchName(name) {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) throw new SecurityError(`Unsafe branch name: "${name}"`);
  if (name.includes('..') || name.startsWith('-') || name.endsWith('.')) throw new SecurityError(`Unsafe branch name: "${name}"`);
}
