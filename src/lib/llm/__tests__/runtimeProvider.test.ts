import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractProviderText,
  parseProviderStreamChunk,
  requestConfiguredProviderText,
  requestConfiguredProviderTextStream,
} from '@/lib/llm/runtimeProvider';
import type { LlmProviderConfig } from '@/lib/llm/providers';

const providerConfig: LlmProviderConfig = {
  providerId: 'custom-openai',
  enabled: true,
  apiMode: 'openai-compatible',
  endpoint: 'https://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  contextWindow: 8000,
  reasoningMode: 'auto',
};

describe('runtime provider response extraction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads forced Anthropic tool_use input for structured output', () => {
    const text = extractProviderText(
      {
        content: [
          { type: 'thinking', thinking: 'I will fill the tool.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'capture_analysis',
            input: {
              entities: [{ title: '福瑞健康科技园三期项目', type: 'project', evidence: '可研报告' }],
              concepts: [],
            },
          },
        ],
      },
      'anthropic-compatible',
      { includeToolUseInput: true },
    );

    expect(JSON.parse(text)).toMatchObject({
      entities: [expect.objectContaining({ title: '福瑞健康科技园三期项目' })],
    });
  });

  it('reads OpenAI function arguments for structured output', () => {
    const text = extractProviderText(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'capture_analysis',
                    arguments: '{"entities":[{"title":"项目测算","type":"topic","evidence":"表格"}]}',
                  },
                },
              ],
            },
          },
        ],
      },
      'openai-compatible',
      { includeToolUseInput: true },
    );

    expect(JSON.parse(text).entities[0].title).toBe('项目测算');
  });
  it('passes abort signals to browser provider fetch requests', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal ?? null;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }),
    );

    const result = await requestConfiguredProviderText(
      providerConfig,
      {
        prompt: 'hello',
        systemPrompt: 'test',
        maxTokens: 32,
      },
      { signal: controller.signal },
    );

    expect(result).toMatchObject({ ok: true, text: 'ok' });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('parses OpenAI-compatible stream chunks', () => {
    const text = parseProviderStreamChunk(
      [
        'data: {"choices":[{"delta":{"content":"结论"}}]}',
        'data: {"choices":[{"delta":{"content":"：已确认"}}]}',
        'data: [DONE]',
        '',
      ].join('\n'),
      'openai-compatible',
    );

    expect(text).toBe('结论：已确认');
  });

  it('parses Anthropic-compatible stream chunks', () => {
    const text = parseProviderStreamChunk(
      [
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"风险"}}',
        '',
      ].join('\n'),
      'anthropic-compatible',
    );

    expect(text).toBe('风险');
  });

  it('diagnoses streamed reasoning without final content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考'.repeat(300) } }] })}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n');
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const result = await requestConfiguredProviderTextStream(
      providerConfig,
      {
        prompt: 'hello',
        systemPrompt: 'test',
        maxTokens: 32,
        reasoningMode: 'disabled',
      },
      { onToken: vi.fn() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('reasoning/thinking but no final content');
    }
  });
});
