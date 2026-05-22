import type { LlmProviderConfig, LlmReasoningMode } from './providers';

export type { LlmReasoningMode } from './providers';

export type LlmTextRequestInput = {
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  responseFormat?: 'json_object';
  structuredOutput?: LlmStructuredOutputSpec;
  reasoningMode?: LlmReasoningMode;
};

export type LlmTextHttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  responseApiMode: LlmProviderConfig['apiMode'];
};

export type LlmStructuredOutputSpec = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

const jsonContentType = 'application/json';

export function buildOpenAiChatCompletionsUrl(endpoint: string) {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

export function buildAnthropicMessagesUrl(endpoint: string) {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (/\/v\d+\/messages$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function anthropicCompatibleRequiresBearerAuth(url: string) {
  const normalized = url.toLowerCase().replace(/\/+$/, '');
  return (
    normalized.startsWith('https://api.minimax.io/anthropic') ||
    normalized.startsWith('https://api.minimaxi.com/anthropic') ||
    normalized.startsWith('https://coding.dashscope.aliyuncs.com/apps/anthropic')
  );
}

export function buildOpenAiTextRequest(config: LlmProviderConfig, input: LlmTextRequestInput): LlmTextHttpRequest {
  const maxTokens = resolveTextMaxTokens(config, input);
  const reasoningBody = buildOpenAiReasoningBody(config, input.reasoningMode);
  const temperatureBody = shouldOmitOpenAiTemperature(config) ? {} : { temperature: 0.2 };
  const tokenBudgetBody = shouldUseOpenAiCompletionTokens(config) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const structuredTool = input.structuredOutput
    ? {
        type: 'function',
        function: {
          name: input.structuredOutput.name,
          description: input.structuredOutput.description,
          parameters: input.structuredOutput.schema,
        },
      }
    : null;
  return {
    url: buildOpenAiChatCompletionsUrl(config.endpoint),
    responseApiMode: 'openai-compatible',
    headers: {
      'Content-Type': jsonContentType,
      ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.prompt },
      ],
      stream: false,
      ...temperatureBody,
      ...tokenBudgetBody,
      ...(structuredTool
        ? {
            tools: [structuredTool],
            tool_choice: { type: 'function', function: { name: input.structuredOutput?.name } },
          }
        : {}),
      ...(input.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      ...reasoningBody,
    },
  };
}

export function buildAnthropicTextRequest(config: LlmProviderConfig, input: LlmTextRequestInput): LlmTextHttpRequest {
  const url = buildAnthropicMessagesUrl(config.endpoint);
  const maxTokens = resolveTextMaxTokens(config, input);
  const reasoningBody = buildAnthropicReasoningBody(config, input.reasoningMode);
  const thinkingEnabled = isAnthropicThinkingEnabled(reasoningBody);
  const headers: Record<string, string> = { 'Content-Type': jsonContentType };
  if (anthropicCompatibleRequiresBearerAuth(url)) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  } else if (config.apiKey.trim()) {
    headers['x-api-key'] = config.apiKey.trim();
    headers['anthropic-version'] = '2023-06-01';
  }

  return {
    url,
    responseApiMode: 'anthropic-compatible',
    headers,
    body: {
      model: config.model,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.prompt }],
      stream: false,
      ...(thinkingEnabled ? {} : { temperature: 0.2 }),
      max_tokens: maxTokens,
      ...(input.structuredOutput
        ? {
            tools: [
              {
                name: input.structuredOutput.name,
                description: input.structuredOutput.description,
                input_schema: input.structuredOutput.schema,
              },
            ],
            tool_choice: { type: 'tool', name: input.structuredOutput.name },
          }
        : {}),
      ...reasoningBody,
    },
  };
}

export function buildGeminiGenerateContentUrl(config: LlmProviderConfig) {
  const base = config.endpoint.trim().replace(/\/+$/, '');
  const model = encodeURIComponent(config.model);
  const key = encodeURIComponent(config.apiKey.trim());
  return `${base}/v1beta/models/${model}:generateContent?key=${key}`;
}

export function buildGeminiTextRequest(config: LlmProviderConfig, input: LlmTextRequestInput): LlmTextHttpRequest {
  const maxTokens = resolveTextMaxTokens(config, input);
  const thinkingConfig = buildGeminiThinkingConfig(config, input.reasoningMode);
  return {
    url: buildGeminiGenerateContentUrl(config),
    responseApiMode: 'gemini-native',
    headers: { 'Content-Type': jsonContentType },
    body: {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        ...(input.responseFormat === 'json_object' || input.structuredOutput ? { responseMimeType: 'application/json' } : {}),
        ...(input.structuredOutput ? { responseSchema: input.structuredOutput.schema } : {}),
        ...thinkingConfig,
      },
    },
  };
}

export function buildProviderTextRequest(config: LlmProviderConfig, input: LlmTextRequestInput): LlmTextHttpRequest {
  if (config.apiMode === 'openai-compatible') return buildOpenAiTextRequest(config, input);
  if (config.apiMode === 'anthropic-compatible') return buildAnthropicTextRequest(config, input);
  if (config.apiMode === 'gemini-native') return buildGeminiTextRequest(config, input);
  throw new Error(`Provider mode ${config.apiMode} is not supported by the browser recompile bridge yet.`);
}

function resolveTextMaxTokens(config: LlmProviderConfig, input: LlmTextRequestInput) {
  if ((input.responseFormat === 'json_object' || input.structuredOutput) && shouldUseLargeJsonOutputBudget(config)) {
    return Math.max(input.maxTokens, 8000);
  }
  return input.maxTokens;
}

function isMiniMaxProvider(providerId: LlmProviderConfig['providerId']) {
  return providerId === 'minimax-cn' || providerId === 'minimax-global';
}

function shouldUseLargeJsonOutputBudget(config: LlmProviderConfig) {
  return isMiniMaxProvider(config.providerId) || config.providerId === 'deepseek' || endpointLooksLike(config.endpoint, /deepseek/i);
}

function buildOpenAiReasoningBody(config: LlmProviderConfig, reasoningMode: LlmReasoningMode | undefined) {
  const mode = reasoningMode ?? config.reasoningMode ?? 'auto';
  if (mode === 'auto') return {};
  if (mode === 'disabled' && shouldUseOpenAiThinkingObject(config)) {
    return { thinking: { type: 'disabled' } };
  }
  if (mode === 'disabled' && (config.providerId === 'ollama' || /qwen[-_]?3/i.test(config.model))) {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  if (mode !== 'disabled' && shouldUseOpenAiThinkingObject(config)) {
    return {
      thinking: { type: 'enabled' },
      ...(mode === 'low' || mode === 'medium' || mode === 'high' ? { reasoning_effort: mode } : {}),
    };
  }
  if (mode === 'low' || mode === 'medium' || mode === 'high') {
    return { reasoning_effort: mode };
  }
  return {};
}

function buildAnthropicReasoningBody(config: LlmProviderConfig, reasoningMode: LlmReasoningMode | undefined) {
  const mode = reasoningMode ?? config.reasoningMode ?? 'auto';
  if (mode === 'auto' || mode === 'disabled') {
    if (mode === 'disabled' && (isMiniMaxProvider(config.providerId) || endpointLooksLike(config.endpoint, /(minimax|minimaxi)/i))) {
      return { thinking: { type: 'disabled' } };
    }
    return {};
  }

  const budget = resolveReasoningBudgetTokens(config, mode);
  if (budget <= 0) return {};
  return compactUndefinedProperties({
    thinking: { type: 'enabled', budget_tokens: budget },
    max_tokens: Math.max(resolveReasoningBudgetCeiling(config, budget), budget + 1),
  });
}

function buildGeminiThinkingConfig(config: LlmProviderConfig, reasoningMode: LlmReasoningMode | undefined) {
  const mode = reasoningMode ?? config.reasoningMode ?? 'auto';
  if (mode === 'auto') return {};
  if (mode === 'disabled') return { thinkingConfig: { thinkingBudget: 0 } };
  return { thinkingConfig: { thinkingBudget: resolveReasoningBudgetTokens(config, mode) } };
}

function shouldUseOpenAiThinkingObject(config: LlmProviderConfig) {
  return (
    isMiniMaxProvider(config.providerId) ||
    config.providerId === 'deepseek' ||
    config.providerId === 'zhipu' ||
    endpointLooksLike(config.endpoint, /(minimax|minimaxi|deepseek|bigmodel|z\.ai)/i)
  );
}

function shouldOmitOpenAiTemperature(config: LlmProviderConfig) {
  if (shouldUseOpenAiCompletionTokens(config)) return true;
  return endpointLooksLike(config.endpoint, /api\.moonshot\.(ai|cn)/i) || /(^|[/:.-])kimi([/:.-]|$)/i.test(config.model);
}

function shouldUseOpenAiCompletionTokens(config: LlmProviderConfig) {
  const model = config.model.trim().toLowerCase();
  return config.providerId === 'openai' && (/^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model));
}

function isAnthropicThinkingEnabled(body: Record<string, unknown>) {
  const thinking = body.thinking;
  return Boolean(thinking && typeof thinking === 'object' && (thinking as { type?: unknown }).type === 'enabled');
}

function resolveReasoningBudgetTokens(config: LlmProviderConfig, mode: LlmReasoningMode) {
  if (mode === 'custom') return Math.max(0, Math.floor(config.reasoningBudgetTokens ?? 0));
  if (mode === 'low') return 1024;
  if (mode === 'medium') return 4096;
  if (mode === 'high') return 8192;
  if (mode === 'max') return 16384;
  return 0;
}

function resolveReasoningBudgetCeiling(config: LlmProviderConfig, budget: number) {
  return Math.max(4096, Math.min(config.contextWindow || 200000, budget + 4096));
}

function compactUndefinedProperties<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function endpointLooksLike(endpoint: string, pattern: RegExp) {
  return pattern.test(endpoint.trim());
}
