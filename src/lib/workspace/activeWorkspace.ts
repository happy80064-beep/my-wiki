import { normalizeWorkspacePath } from './paths';

export const activeWorkspaceRootStorageKey = 'mywiki:active-workspace-root:v1';

export function getPersistedWorkspaceRoot() {
  if (typeof window === 'undefined') return null;
  try {
    const root = window.localStorage.getItem(activeWorkspaceRootStorageKey);
    return root ? normalizeWorkspacePath(root) : null;
  } catch {
    return null;
  }
}

export function persistWorkspaceRoot(root: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(activeWorkspaceRootStorageKey, normalizeWorkspacePath(root));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function clearPersistedWorkspaceRoot() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(activeWorkspaceRootStorageKey);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}
