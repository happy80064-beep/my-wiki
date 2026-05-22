import {
  anthropicCompatibleRequiresBearerAuth,
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  buildOpenAiChatCompletionsUrl,
  buildProviderTextRequest,
  type LlmTextRequestInput,
} from './textProvider';
import { validateLlmProviderConfig, type LlmProviderConfig } from './providers';
import { parseRuntimeJson, postJsonStreamThroughRuntime, postJsonThroughRuntime } from '@/lib/runtime/httpJson';
import { isProviderRetryableError, rememberProviderFailure, withProviderRequestSlot } from './requestScheduler';

export type RuntimeProviderTiming = {
  queueMs: number;
  cooldownMs: number;
  requestMs: number;
  retryDelayMs: number;
  attempts: number;
};

export type RuntimeProviderResult =
  | { ok: true; text: string; providerName: string; model: string; timing?: RuntimeProviderTiming }
  | { ok: false; error: string; providerName: string; model: string; timing?: RuntimeProviderTiming };

export type RuntimeProviderRequestOptions = {
  signal?: AbortSignal;
};

export type RuntimeProviderStreamOptions = RuntimeProviderRequestOptions & {
  onToken: (token: string) => void;
};

export function normalizeRequestProviderConfig(input: LlmProviderConfig | null | undefined): LlmProviderConfig | null {
  if (!input) return null;
  const config = { ...input, enabled: true };
  const errors = validateLlmProviderConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
  return config;
}

export async function requestConfiguredProviderText(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderRequestOptions = {},
): Promise<RuntimeProviderResult> {
  const timing = createProviderTiming();
  const result = await withProviderRequestSlot(
    config,
    options.signal,
    () => requestConfiguredProviderTextScheduled(config, input, options, timing),
    (slotTiming) => {
      timing.queueMs += slotTiming.queueMs;
      timing.cooldownMs += slotTiming.cooldownMs;
    },
  );
  return { ...result, timing };
}

export async function requestConfiguredProviderTextStream(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderStreamOptions,
): Promise<RuntimeProviderResult> {
  const timing = createProviderTiming();
  const result = await withProviderRequestSlot(
    config,
    options.signal,
    () => requestConfiguredProviderTextStreamScheduled(config, input, options, timing),
    (slotTiming) => {
      timing.queueMs += slotTiming.queueMs;
      timing.cooldownMs += slotTiming.cooldownMs;
    },
  );
  return { ...result, timing };
}

async function requestConfiguredProviderTextStreamScheduled(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderStreamOptions,
  timing: RuntimeProviderTiming,
): Promise<RuntimeProviderResult> {
  throwIfAborted(options.signal);
  timing.attempts = 1;
  const requestStart = Date.now();
  const result = await requestConfiguredProviderTextStreamOnce(config, input, options);
  timing.requestMs += Date.now() - requestStart;
  if (!result.ok && isProviderRetryableError(result.error)) rememberProviderFailure(config, result.error);
  return result;
}

async function requestConfiguredProviderTextStreamOnce(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderStreamOptions,
): Promise<RuntimeProviderResult> {
  const providerName = config.providerId;
  try {
    const request = buildProviderTextRequest(config, input);
    const streamRequest = {
      ...request,
      body: buildStreamingProviderBody(request.body, request.responseApiMode),
    };
    let rawBody = '';
    let text = '';
    let streamBuffer = '';
    let reasoningCharsObserved = 0;
    const response = await postJsonStreamThroughRuntime(
      streamRequest,
      (event) => {
        if (event.type !== 'chunk') return;
        rawBody += event.text;
        streamBuffer += event.text;
        const chunks = takeCompleteStreamEvents(streamBuffer);
        streamBuffer = chunks.remainder;
        for (const chunk of chunks.events) {
          reasoningCharsObserved += countReasoningCharsInStreamChunk(chunk, request.responseApiMode);
          const parsed = parseProviderStreamChunk(chunk, request.responseApiMode);
          if (!parsed) continue;
          text += parsed;
          options.onToken(parsed);
        }
      },
      { signal: options.signal },
    );
    if (streamBuffer.trim()) {
      reasoningCharsObserved += countReasoningCharsInStreamChunk(streamBuffer, request.responseApiMode);
      const parsed = parseProviderStreamChunk(streamBuffer, request.responseApiMode);
      if (parsed) {
        text += parsed;
        options.onToken(parsed);
      }
    }

    if (!response.ok) {
      const data = parseJsonBody(response.body || rawBody);
      return {
        ok: false,
        error: extractProviderError(data) || `${providerName} stream request failed with ${response.status}.`,
        providerName,
        model: config.model,
      };
    }

    const fullStreamText = parseProviderStreamChunk(response.body || rawBody, request.responseApiMode).trim();
    const finalText = fullStreamText || text.trim();
    if (!finalText) {
      const data = parseJsonBody(response.body || rawBody);
      const nonStreamingText = extractProviderText(data, request.responseApiMode, {
        includeToolUseInput: Boolean(input.structuredOutput),
      });
      if (nonStreamingText) {
        options.onToken(nonStreamingText);
        return { ok: true, text: nonStreamingText, providerName, model: config.model };
      }
      if (reasoningCharsObserved >= 512) {
        return {
          ok: false,
          error: `${providerName} streamed ${reasoningCharsObserved} characters of reasoning/thinking but no final content. 请关闭 thinking/reasoning 或降低该任务复杂度后重试。`,
          providerName,
          model: config.model,
        };
      }
      return { ok: false, error: `${providerName} returned empty streamed content.`, providerName, model: config.model };
    }

    return { ok: true, text: finalText, providerName, model: config.model };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      ok: false,
      error: formatUnknownError(error, `${providerName} stream request failed.`),
      providerName,
      model: config.model,
    };
  }
}

async function requestConfiguredProviderTextScheduled(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderRequestOptions,
  timing: RuntimeProviderTiming,
): Promise<RuntimeProviderResult> {
  const providerName = config.providerId;
  let lastRetryableError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(options.signal);
    timing.attempts = attempt;
    const requestStart = Date.now();
    const result = await requestConfiguredProviderTextOnce(config, input, options);
    timing.requestMs += Date.now() - requestStart;
    if (result.ok || !isProviderRetryableError(result.error) || attempt === 3) {
      if (!result.ok && isProviderRetryableError(result.error)) rememberProviderFailure(config, result.error);
      return result;
    }
    lastRetryableError = result.error;
    const delayMs = retryDelayMs(attempt);
    timing.retryDelayMs += delayMs;
    await sleep(delayMs, options.signal);
  }

  return { ok: false, error: lastRetryableError || `${providerName} request failed.`, providerName, model: config.model };
}

async function requestConfiguredProviderTextOnce(
  config: LlmProviderConfig,
  input: LlmTextRequestInput,
  options: RuntimeProviderRequestOptions,
): Promise<RuntimeProviderResult> {
  const providerName = config.providerId;
  try {
    const request = buildProviderTextRequest(config, input);
    const response = await postJsonThroughRuntime(request, { signal: options.signal });
    const data = parseJsonBody(response.body);

    if (!response.ok) {
      return {
        ok: false,
        error: extractProviderError(data) || `${providerName} request failed with ${response.status}.`,
        providerName,
        model: config.model,
      };
    }

    const text = extractProviderText(data, request.responseApiMode, {
      includeToolUseInput: Boolean(input.structuredOutput),
    });
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.`, providerName, model: config.model };
    }

    return { ok: true, text, providerName, model: config.model };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      ok: false,
      error: formatUnknownError(error, `${providerName} request failed.`),
      providerName,
      model: config.model,
    };
  }
}

export async function requestConfiguredProviderVision(
  config: LlmProviderConfig,
  input: { prompt: string; imageBase64: string; mimeType: string; maxTokens: number },
  options: RuntimeProviderRequestOptions = {},
): Promise<RuntimeProviderResult> {
  return withProviderRequestSlot(config, options.signal, () => requestConfiguredProviderVisionScheduled(config, input, options));
}

async function requestConfiguredProviderVisionScheduled(
  config: LlmProviderConfig,
  input: { prompt: string; imageBase64: string; mimeType: string; maxTokens: number },
  options: RuntimeProviderRequestOptions,
): Promise<RuntimeProviderResult> {
  const providerName = config.providerId;
  let lastRetryableError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await requestConfiguredProviderVisionOnce(config, input, options);
    if (result.ok || !isProviderRetryableError(result.error) || attempt === 3) {
      if (!result.ok && isProviderRetryableError(result.error)) rememberProviderFailure(config, result.error);
      return result;
    }
    lastRetryableError = result.error;
    await sleep(retryDelayMs(attempt), options.signal);
  }

  return { ok: false, error: lastRetryableError || `${providerName} vision request failed.`, providerName, model: config.model };
}

async function requestConfiguredProviderVisionOnce(
  config: LlmProviderConfig,
  input: { prompt: string; imageBase64: string; mimeType: string; maxTokens: number },
  options: RuntimeProviderRequestOptions,
): Promise<RuntimeProviderResult> {
  const providerName = config.providerId;
  try {
    const request = buildProviderVisionRequest(config, input);
    const response = await postJsonThroughRuntime(request, { signal: options.signal });
    const data = parseJsonBody(response.body);

    if (!response.ok) {
      return {
        ok: false,
        error: extractProviderError(data) || `${providerName} request failed with ${response.status}.`,
        providerName,
        model: config.model,
      };
    }

    const text = extractProviderText(data, config.apiMode);
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.`, providerName, model: config.model };
    }

    return { ok: true, text, providerName, model: config.model };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      ok: false,
      error: formatUnknownError(error, `${providerName} vision request failed.`),
      providerName,
      model: config.model,
    };
  }
}

export function extractProviderText(
  data: unknown,
  apiMode: LlmProviderConfig['apiMode'],
  options: { includeToolUseInput?: boolean } = {},
) {
  if (!data || typeof data !== 'object') return '';
  const payload = data as Record<string, unknown>;

  if (apiMode === 'anthropic-compatible') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : options.includeToolUseInput &&
              part &&
              typeof part === 'object' &&
              (part as { type?: unknown }).type === 'tool_use' &&
              (part as { input?: unknown }).input !== undefined
            ? JSON.stringify((part as { input: unknown }).input)
          : '',
      )
      .join('')
      .trim();
  }

  if (apiMode === 'gemini-native') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const first = candidates[0] as { content?: { parts?: Array<{ text?: string; thought?: boolean }> } } | undefined;
    return (first?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as
    | {
        message?: {
          content?: string;
          tool_calls?: Array<{ function?: { arguments?: string } }>;
        };
      }
    | undefined;
  if (options.includeToolUseInput) {
    const toolArguments = first?.message?.tool_calls?.find((call) => call.function?.arguments)?.function?.arguments;
    if (toolArguments?.trim()) return toolArguments.trim();
  }
  return first?.message?.content?.trim() ?? '';
}

export function extractProviderError(data: unknown) {
  if (!data || typeof data !== 'object') return '';
  const payload = data as { error?: string | { message?: string; type?: string }; message?: string };
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error?.message) return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}

export function parseProviderStreamChunk(chunk: string, apiMode: LlmProviderConfig['apiMode']) {
  if (apiMode === 'anthropic-compatible') return parseAnthropicStreamChunk(chunk);
  if (apiMode === 'gemini-native') return parseGeminiStreamChunk(chunk);
  return parseOpenAiStreamChunk(chunk);
}

function countReasoningCharsInStreamChunk(chunk: string, apiMode: LlmProviderConfig['apiMode']) {
  if (apiMode === 'gemini-native') return 0;
  let count = 0;
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { reasoning_content?: string; reasoning?: string } }>;
        type?: string;
        delta?: { type?: string; thinking?: string };
      };
      for (const choice of payload.choices ?? []) {
        count += choice.delta?.reasoning_content?.length ?? 0;
        count += choice.delta?.reasoning?.length ?? 0;
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'thinking_delta') {
        count += payload.delta.thinking?.length ?? 0;
      }
    } catch {
      continue;
    }
  }
  return count;
}

export function stripThinking(text: string) {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}

function buildProviderVisionRequest(
  config: LlmProviderConfig,
  input: { prompt: string; imageBase64: string; mimeType: string; maxTokens: number },
) {
  if (config.apiMode === 'anthropic-compatible') {
    const url = buildAnthropicMessagesUrl(config.endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (anthropicCompatibleRequiresBearerAuth(url)) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    } else if (config.apiKey.trim()) {
      headers['x-api-key'] = config.apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url,
      headers,
      body: {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: input.mimeType,
                  data: input.imageBase64,
                },
              },
            ],
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: input.maxTokens,
      },
    };
  }

  if (config.apiMode === 'gemini-native') {
    return {
      url: buildGeminiGenerateContentUrl(config),
      headers: { 'Content-Type': 'application/json' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: input.prompt },
              { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: input.maxTokens,
        },
      },
    };
  }

  return {
    url: buildOpenAiChatCompletionsUrl(config.endpoint),
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    body: {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            {
              type: 'image_url',
              image_url: { url: buildOpenAiVisionImageUrl(input) },
            },
          ],
        },
      ],
      stream: false,
      temperature: 0,
      max_tokens: input.maxTokens,
    },
  };
}

function buildOpenAiVisionImageUrl(
  input: { imageBase64: string; mimeType: string },
) {
  return `data:${input.mimeType};base64,${input.imageBase64}`;
}

function buildStreamingProviderBody(body: Record<string, unknown>, apiMode: LlmProviderConfig['apiMode']) {
  if (apiMode === 'gemini-native') return body;
  return {
    ...body,
    stream: true,
  };
}

function parseOpenAiStreamChunk(chunk: string) {
  let text = '';
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      text += payload.choices?.map((choice) => choice.delta?.content ?? choice.message?.content ?? '').join('') ?? '';
    } catch {
      continue;
    }
  }
  return text;
}

function parseAnthropicStreamChunk(chunk: string) {
  let text = '';
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data) as {
        type?: string;
        delta?: { text?: string };
        content_block?: { text?: string };
      };
      if (payload.type === 'content_block_delta') text += payload.delta?.text ?? '';
      if (payload.type === 'content_block_start') text += payload.content_block?.text ?? '';
    } catch {
      continue;
    }
  }
  return text;
}

function parseGeminiStreamChunk(chunk: string) {
  let text = '';
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!data || data === '[DONE]' || data === '[' || data === ']') continue;
    try {
      const cleaned = data.replace(/,$/, '');
      const payload = JSON.parse(cleaned) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      text +=
        payload.candidates?.[0]?.content?.parts
          ?.filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('') ?? '';
    } catch {
      continue;
    }
  }
  return text;
}

function takeCompleteStreamEvents(buffer: string) {
  const parts = buffer.split(/\r?\n\r?\n/);
  return {
    events: parts.slice(0, -1),
    remainder: parts.at(-1) ?? '',
  };
}

function parseJsonBody(body: string) {
  try {
    return parseRuntimeJson(body);
  } catch {
    return { message: body };
  }
}

function formatUnknownError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function retryDelayMs(attempt: number) {
  return 2000 * attempt * attempt;
}

function createProviderTiming(): RuntimeProviderTiming {
  return {
    queueMs: 0,
    cooldownMs: 0,
    requestMs: 0,
    retryDelayMs: 0,
    attempts: 0,
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
