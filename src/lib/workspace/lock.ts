import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { normalizeWorkspacePath } from './paths';

export type WorkspaceLockOptions = {
  timeoutMs?: number;
  retryMs?: number;
  ttlMs?: number;
};

type LockState = {
  tail: Promise<unknown>;
};

const localLocks = new Map<string, LockState>();

export async function withWorkspaceLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T> | T,
  options: WorkspaceLockOptions = {},
): Promise<T> {
  const normalizedRoot = normalizeWorkspacePath(root);
  if (!isTauriRuntime()) {
    return withLocalWorkspaceLock(normalizedRoot, name, fn);
  }

  const owner = createLockOwner(name);
  const ttlMs = options.ttlMs ?? 120_000;
  const retryMs = options.retryMs ?? 80;
  const timeoutMs = options.timeoutMs ?? 30_000;
  await acquireTauriWorkspaceLock(normalizedRoot, name, owner, { ttlMs, retryMs, timeoutMs });

  const heartbeat = window.setInterval(() => {
    void tauriInvoke<boolean>('workspace_acquire_lock', {
      root: normalizedRoot,
      name,
      owner,
      ttlMs,
    }).catch(() => undefined);
  }, Math.max(1_000, Math.floor(ttlMs / 3)));

  try {
    return await fn();
  } finally {
    window.clearInterval(heartbeat);
    await tauriInvoke<boolean>('workspace_release_lock', {
      root: normalizedRoot,
      name,
      owner,
    }).catch(() => false);
  }
}

export function workspaceRootFromStatePath(path: string) {
  const normalized = normalizeWorkspacePath(path);
  const marker = '/.mywiki/';
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(0, index) : normalized.replace(/\/[^/]*$/, '');
}

async function acquireTauriWorkspaceLock(
  root: string,
  name: string,
  owner: string,
  options: Required<WorkspaceLockOptions>,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= options.timeoutMs) {
    const acquired = await tauriInvoke<boolean>('workspace_acquire_lock', {
      root,
      name,
      owner,
      ttlMs: options.ttlMs,
    });
    if (acquired) return;
    await sleep(options.retryMs);
  }
  throw new Error(`Workspace lock "${name}" is busy.`);
}

async function withLocalWorkspaceLock<T>(root: string, name: string, fn: () => Promise<T> | T) {
  const key = `${root}::${name}`;
  const previous = localLocks.get(key)?.tail ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  localLocks.set(key, { tail });
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    const state = localLocks.get(key);
    if (state?.tail === tail) localLocks.delete(key);
  }
}

function createLockOwner(name: string) {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
