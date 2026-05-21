import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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

export type RuntimeHttpStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; status: number; ok: boolean; body: string }
  | { type: 'error'; error: string };

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

export async function postJsonStreamThroughRuntime(
  request: RuntimeHttpJsonRequest,
  onEvent: (event: RuntimeHttpStreamEvent) => void,
  options: RuntimeHttpJsonOptions = {},
): Promise<RuntimeHttpJsonResponse> {
  throwIfAborted(options.signal);

  if (isTauriRuntime()) {
    const streamId = nextStreamId();
    const unlisten = await listen<RuntimeHttpStreamEvent>(`http-post-json-stream://${streamId}`, (event) => {
      onEvent(event.payload);
    });
    try {
      const response = await invoke<RuntimeHttpJsonResponse>('http_post_json_stream', { streamId, request });
      throwIfAborted(options.signal);
      return response;
    } finally {
      unlisten();
    }
  }

  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: options.signal,
  });
  const body = await readResponseStream(response, onEvent);
  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

export function parseRuntimeJson<T = unknown>(body: string): T {
  return (body ? JSON.parse(body) : {}) as T;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function readResponseStream(response: Response, onEvent: (event: RuntimeHttpStreamEvent) => void) {
  if (!response.body) {
    const body = await response.text();
    onEvent({ type: 'done', status: response.status, ok: response.ok, body });
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    body += text;
    onEvent({ type: 'chunk', text });
  }
  const tail = decoder.decode();
  if (tail) {
    body += tail;
    onEvent({ type: 'chunk', text: tail });
  }
  onEvent({ type: 'done', status: response.status, ok: response.ok, body });
  return body;
}

function nextStreamId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
