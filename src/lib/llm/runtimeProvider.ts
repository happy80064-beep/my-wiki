import {
  anthropicCompatibleRequiresBearerAuth,
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  buildOpenAiChatCompletionsUrl,
  buildProviderTextRequest,
  type LlmTextRequestInput,
} from './textProvider';
import { validateLlmProviderConfig, type LlmProviderConfig } from './providers';
import { parseRuntimeJson, postJsonThroughRuntime } from '@/lib/runtime/httpJson';

export type RuntimeProviderResult =
  | { ok: true; text: string; providerName: string; model: string }
  | { ok: false; error: string; providerName: string; model: string };

export type RuntimeProviderRequestOptions = {
  signal?: AbortSignal;
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
  const providerName = config.providerId;
  let lastRetryableError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await requestConfiguredProviderTextOnce(config, input, options);
    if (result.ok || !isRetryableProviderError(result.error) || attempt === 3) return result;
    lastRetryableError = result.error;
    await sleep(retryDelayMs(attempt), options.signal);
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
  const providerName = config.providerId;
  let lastRetryableError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await requestConfiguredProviderVisionOnce(config, input, options);
    if (result.ok || !isRetryableProviderError(result.error) || attempt === 3) return result;
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

function isRetryableProviderError(error: string) {
  return /(429|rate.?limit|too many requests|timeout|timed out|temporarily|overloaded|503|502|504|500|ECONNRESET|ECONNREFUSED|network|fetch failed|socket|TLS|connection)/i.test(
    error,
  );
}

function retryDelayMs(attempt: number) {
  return 1200 * attempt * attempt;
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
