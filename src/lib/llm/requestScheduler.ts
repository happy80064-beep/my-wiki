import type { LlmProviderConfig } from './providers';

type ProviderSlot = {
  tail: Promise<void>;
  cooldownUntil: number;
};

export type ProviderRequestSlotTiming = {
  queueMs: number;
  cooldownMs: number;
};

const providerSlots = new Map<string, ProviderSlot>();

export async function withProviderRequestSlot<T>(
  config: LlmProviderConfig,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
  onTiming?: (timing: ProviderRequestSlotTiming) => void,
): Promise<T> {
  const key = providerSlotKey(config);
  const slot = providerSlots.get(key) ?? { tail: Promise.resolve(), cooldownUntil: 0 };
  providerSlots.set(key, slot);

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = slot.tail;
  slot.tail = previous.catch(() => undefined).then(() => next);

  try {
    const queueStart = Date.now();
    await previous.catch(() => undefined);
    const queueMs = Date.now() - queueStart;
    throwIfAborted(signal);
    const waitMs = Math.max(0, slot.cooldownUntil - Date.now());
    onTiming?.({ queueMs, cooldownMs: waitMs });
    if (waitMs > 0) await sleep(waitMs, signal);
    return await task();
  } finally {
    release();
  }
}

export function rememberProviderFailure(config: LlmProviderConfig, error: string) {
  const cooldownMs = providerCooldownMs(error);
  if (cooldownMs <= 0) return;
  const key = providerSlotKey(config);
  const slot = providerSlots.get(key) ?? { tail: Promise.resolve(), cooldownUntil: 0 };
  slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + cooldownMs);
  providerSlots.set(key, slot);
}

export function isProviderRetryableError(error: string) {
  return /(429|rate.?limit|too many requests|timeout|timed out|temporarily|overloaded|503|502|504|500|ECONNRESET|ECONNREFUSED|network|fetch failed|socket|TLS|connection)/i.test(
    error,
  );
}

function providerCooldownMs(error: string) {
  if (!isProviderRetryableError(error)) return 0;
  if (/(429|rate.?limit|too many requests)/i.test(error)) return 30_000;
  if (/(timeout|timed out|overloaded|temporarily|503|502|504)/i.test(error)) return 15_000;
  return 8_000;
}

function providerSlotKey(config: LlmProviderConfig) {
  const endpoint = config.endpoint.trim().replace(/\/+$/, '').toLowerCase();
  const keyMarker = config.apiKey.trim() ? config.apiKey.trim().slice(-8) : 'no-key';
  return [config.providerId, config.apiMode, endpoint, config.model.trim(), keyMarker].join('|');
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
