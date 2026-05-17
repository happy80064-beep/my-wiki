import type { TauriWorkspaceStorage } from './tauriStorage';

type WorkspaceApiError = {
  error?: string;
};

export function createDevWorkspaceStorage(): TauriWorkspaceStorage {
  return {
    ensureDir(path) {
      return postWorkspaceJson<void>('/api/workspace/ensure-dir', { path });
    },
    exists(path) {
      return postWorkspaceJson<boolean>('/api/workspace/exists', { path });
    },
    writeTextFile(path, content) {
      return postWorkspaceJson<void>('/api/workspace/write-text-file', { path, content });
    },
    writeBinaryFile(path, dataBase64) {
      return postWorkspaceJson<void>('/api/workspace/write-binary-file', { path, dataBase64 });
    },
    listMarkdownFiles(root) {
      return postWorkspaceJson<string[]>('/api/workspace/list-markdown-files', { root });
    },
    listFiles(root) {
      return postWorkspaceJson<string[]>('/api/workspace/list-files', { root });
    },
    readTextFile(path) {
      return postWorkspaceJson<string>('/api/workspace/read-text-file', { path });
    },
    deletePath(root, path) {
      return postWorkspaceJson<void>('/api/workspace/delete-path', { root, path });
    },
  };
}

export async function getDevDefaultWorkspaceRoot() {
  return getWorkspaceJson<string>('/api/workspace/default-root');
}

async function getWorkspaceJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  return parseWorkspaceJsonResponse<T>(response);
}

async function postWorkspaceJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseWorkspaceJsonResponse<T>(response);
}

async function parseWorkspaceJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & WorkspaceApiError;
  if (!response.ok) {
    throw new Error(payload.error || `Workspace API failed with HTTP ${response.status}.`);
  }
  return payload as T;
}
