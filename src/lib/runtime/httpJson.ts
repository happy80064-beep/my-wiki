import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauri';

export type RuntimeHttpJsonRequest = {
  url: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
};

export type RuntimeHttpJsonOptions = {
  signal?: AbortSignal;
};

export type RuntimeHttpJsonResponse = {
  status: number;
  ok: boolean;
  body: string;
};

export async function postJsonThroughRuntime(
  request: RuntimeHttpJsonRequest,
  options: RuntimeHttpJsonOptions = {},
): Promise<RuntimeHttpJsonResponse> {
  throwIfAborted(options.signal);

  if (isTauriRuntime()) {
    const response = await invoke<RuntimeHttpJsonResponse>('http_post_json', { request });
    throwIfAborted(options.signal);
    return response;
  }

  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: options.signal,
  });

  return {
    status: response.status,
    ok: response.ok,
    body: await response.text(),
  };
}

export function parseRuntimeJson<T = unknown>(body: string): T {
  return (body ? JSON.parse(body) : {}) as T;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
