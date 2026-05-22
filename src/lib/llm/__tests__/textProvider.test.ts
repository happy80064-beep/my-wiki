import { describe, expect, it } from 'vitest';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import {
  anthropicCompatibleRequiresBearerAuth,
  buildAnthropicMessagesUrl,
  buildGeminiTextRequest,
  buildOpenAiChatCompletionsUrl,
  buildProviderTextRequest,
} from '@/lib/llm/textProvider';

const baseInput = {
  prompt: '请生成页面正文',
  systemPrompt: '你是 Wiki 编译器',
  maxTokens: 1200,
};

describe('text provider bridge', () => {
  it('normalizes OpenAI-compatible endpoints to /chat/completions', () => {
    expect(buildOpenAiChatCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(buildOpenAiChatCompletionsUrl('https://api.deepseek.com/chat/completions')).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('normalizes Anthropic-compatible endpoints to /v1/messages', () => {
    expect(buildAnthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://api.minimaxi.com/anthropic')).toBe(
      'https://api.minimaxi.com/anthropic/v1/messages',
    );
  });

  it('uses Bearer auth for MiniMax Anthropic-compatible endpoints like llm-wiki', () => {
    expect(anthropicCompatibleRequiresBearerAuth('https://api.minimaxi.com/anthropic/v1/messages')).toBe(true);
    expect(anthropicCompatibleRequiresBearerAuth('https://api.minimax.io/anthropic/v1/messages')).toBe(true);
    expect(anthropicCompatibleRequiresBearerAuth('https://api.anthropic.com/v1/messages')).toBe(false);

    const request = buildProviderTextRequest(
      {
        providerId: 'minimax-cn',
        enabled: true,
        apiMode: 'anthropic-compatible',
        endpoint: 'https://api.minimaxi.com/anthropic',
        apiKey: 'sk-mini',
        model: 'MiniMax-M2.7',
        contextWindow: 200000,
      },
      baseInput,
    );

    expect(request.url).toBe('https://api.minimaxi.com/anthropic/v1/messages');
    expect(request.responseApiMode).toBe('anthropic-compatible');
    expect(request.headers.Authorization).toBe('Bearer sk-mini');
    expect(request.headers['x-api-key']).toBeUndefined();
  });

  it('keeps MiniMax structured output requests in the selected Anthropic-compatible mode', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'minimax-cn',
        enabled: true,
        apiMode: 'anthropic-compatible',
        endpoint: 'https://api.minimaxi.com/anthropic',
        apiKey: 'sk-mini',
        model: 'MiniMax-M2.7',
        contextWindow: 200000,
      },
      {
        ...baseInput,
        structuredOutput: {
          name: 'capture_analysis',
          description: 'Return capture analysis',
          schema: {
            type: 'object',
            properties: {
              entities: { type: 'array', items: { type: 'object' } },
            },
            required: ['entities'],
          },
        },
      },
    );

    expect(request.url).toBe('https://api.minimaxi.com/anthropic/v1/messages');
    expect(request.responseApiMode).toBe('anthropic-compatible');
    expect(request.headers.Authorization).toBe('Bearer sk-mini');
    expect(request.body.response_format).toBeUndefined();
    expect(request.body.max_tokens).toBe(8000);
    expect(request.body).toMatchObject({
      model: 'MiniMax-M2.7',
      system: baseInput.systemPrompt,
      messages: [{ role: 'user', content: baseInput.prompt }],
      tools: [
        {
          name: 'capture_analysis',
          input_schema: expect.objectContaining({ type: 'object' }),
        },
      ],
      tool_choice: { type: 'tool', name: 'capture_analysis' },
    });
  });

  it('adds response_format for OpenAI-compatible JSON requests', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'openai',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-5.5',
        contextWindow: 200000,
      },
      { ...baseInput, responseFormat: 'json_object' },
    );

    expect(request.body.response_format).toEqual({ type: 'json_object' });
  });

  it('maps strict OpenAI reasoning models to max_completion_tokens and omits temperature', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'openai',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'o3-mini',
        contextWindow: 200000,
      },
      baseInput,
    );

    expect(request.body.max_completion_tokens).toBe(baseInput.maxTokens);
    expect(request.body.max_tokens).toBeUndefined();
    expect(request.body.temperature).toBeUndefined();
  });

  it('can request reasoning disabled for query-only DeepSeek-style requests', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'deepseek',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.deepseek.com',
        apiKey: 'sk-deep',
        model: 'deepseek-chat',
        contextWindow: 200000,
      },
      { ...baseInput, reasoningMode: 'disabled' },
    );

    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

  it('can request reasoning disabled for MiniMax query roles without changing other roles', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'minimax-cn',
        enabled: true,
        apiMode: 'anthropic-compatible',
        endpoint: 'https://api.minimaxi.com/anthropic',
        apiKey: 'sk-mini',
        model: 'MiniMax-M2.7',
        contextWindow: 200000,
      },
      { ...baseInput, reasoningMode: 'disabled' },
    );

    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

  it('leaves reasoning fields out when simple query is not requested', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'minimax-cn',
        enabled: true,
        apiMode: 'anthropic-compatible',
        endpoint: 'https://api.minimaxi.com/anthropic',
        apiKey: 'sk-mini',
        model: 'MiniMax-M2.7',
        contextWindow: 200000,
      },
      baseInput,
    );

    expect(request.body.thinking).toBeUndefined();
  });

  it('uses provider-level reasoning mode when the caller does not override it', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'deepseek',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.deepseek.com',
        apiKey: 'sk-deep',
        model: 'deepseek-v4-pro',
        contextWindow: 200000,
        reasoningMode: 'disabled',
      },
      baseInput,
    );

    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

  it('maps DeepSeek high reasoning without undocumented token-budget fields', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'deepseek',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.deepseek.com',
        apiKey: 'sk-deep',
        model: 'deepseek-reasoner',
        contextWindow: 200000,
        reasoningMode: 'auto',
      },
      { ...baseInput, reasoningMode: 'high' },
    );

    expect(request.body.thinking).toEqual({ type: 'enabled' });
    expect(request.body.reasoning_effort).toBe('high');
    expect(request.body.max_reasoning_tokens).toBeUndefined();
  });

  it('maps Anthropic reasoning budget to extended thinking and removes temperature', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'anthropic',
        enabled: true,
        apiMode: 'anthropic-compatible',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-anthropic',
        model: 'claude-sonnet-4.6',
        contextWindow: 200000,
        reasoningMode: 'custom',
        reasoningBudgetTokens: 2048,
      },
      baseInput,
    );

    expect(request.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(request.body.max_tokens).toBeGreaterThan(2048);
    expect(request.body.temperature).toBeUndefined();
  });

  it('maps Gemini reasoning off to thinkingBudget 0', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'gemini',
        enabled: true,
        apiMode: 'gemini-native',
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'gem-key',
        model: 'gemini-2.5-pro',
        contextWindow: 200000,
        reasoningMode: 'auto',
      },
      { ...baseInput, reasoningMode: 'disabled' },
    );

    expect((request.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('adds forced tool calls for OpenAI-compatible structured requests', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'openai',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-openai',
        model: 'gpt-5.5',
        contextWindow: 200000,
      },
      {
        ...baseInput,
        structuredOutput: {
          name: 'capture_analysis',
          description: 'Return capture analysis',
          schema: { type: 'object', properties: { entities: { type: 'array' } }, required: ['entities'] },
        },
      },
    );

    expect(request.body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'capture_analysis' }),
      }),
    ]);
    expect(request.body.tool_choice).toEqual({ type: 'function', function: { name: 'capture_analysis' } });
  });

  it('uses a larger output budget for DeepSeek structured ingestion requests', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'deepseek',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.deepseek.com',
        apiKey: 'sk-deep',
        model: 'deepseek-v4-pro',
        contextWindow: 200000,
      },
      {
        ...baseInput,
        maxTokens: 4200,
        structuredOutput: {
          name: 'capture_analysis',
          description: 'Return capture analysis',
          schema: { type: 'object', properties: { entities: { type: 'array' } }, required: ['entities'] },
        },
      },
    );

    expect(request.body.max_tokens).toBe(8000);
    expect(request.body.tool_choice).toEqual({ type: 'function', function: { name: 'capture_analysis' } });
  });

  it('uses bounded JSON content for DeepSeek streamed structured ingestion requests', () => {
    const request = buildProviderTextRequest(
      {
        providerId: 'deepseek',
        enabled: true,
        apiMode: 'openai-compatible',
        endpoint: 'https://api.deepseek.com',
        apiKey: 'sk-deep',
        model: 'deepseek-v4-pro',
        contextWindow: 200000,
      },
      {
        ...baseInput,
        maxTokens: 4200,
        responseFormat: 'json_object',
        reasoningMode: 'disabled',
      },
    );

    expect(request.body.max_tokens).toBe(8000);
    expect(request.body.response_format).toEqual({ type: 'json_object' });
    expect(request.body.tools).toBeUndefined();
    expect(request.body.tool_choice).toBeUndefined();
    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

  it('builds Gemini-native requests without OpenAI-compatible auth headers', () => {
    const request = buildGeminiTextRequest(
      {
        providerId: 'gemini',
        enabled: true,
        apiMode: 'gemini-native',
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'gem-key',
        model: 'gemini-2.5-pro',
        contextWindow: 200000,
      },
      baseInput,
    );

    expect(request.url).toContain('/v1beta/models/gemini-2.5-pro:generateContent?key=gem-key');
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      systemInstruction: { parts: [{ text: '你是 Wiki 编译器' }] },
      contents: [{ role: 'user', parts: [{ text: '请生成页面正文' }] }],
    });
  });

  it('routes request building by apiMode', () => {
    const config: LlmProviderConfig = {
      providerId: 'openai',
      enabled: true,
      apiMode: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-5.5',
      contextWindow: 200000,
    };

    expect(buildProviderTextRequest(config, baseInput)).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: 'Bearer sk-openai' },
    });
  });
});
