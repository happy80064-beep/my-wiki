import { assertDevAiApiAvailable, buildDevApiUrl } from '@/lib/ai/devApiGuard';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import { requestConfiguredProviderText, requestConfiguredProviderTextStream } from '@/lib/llm/runtimeProvider';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import {
  buildQueryChatPrompt,
  normalizeQueryChatResponse,
  type QueryChatAnswerRequest,
  type QueryChatAnswerResponse,
} from './chatAnswer';

export async function answerQueryChat(
  payload: QueryChatAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryChatAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return answerQueryChatWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 闲聊回复');

  const response = await fetch(buildDevApiUrl('/api/query/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as QueryChatAnswerResponse | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || 'Query 闲聊回复失败');
  }

  return body;
}

export async function streamAnswerQueryChat(
  payload: QueryChatAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
): Promise<QueryChatAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return streamAnswerQueryChatWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 闲聊流式回复');

  const response = await fetch(buildDevApiUrl('/api/query/chat/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stripClientOnlyFields(payload)),
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || 'Query 闲聊流式回复失败');
  }

  return readQueryChatEventStream(response, payload.onToken);
}

async function answerQueryChatWithRuntimeProvider(
  payload: QueryChatAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryChatAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能回复闲聊消息。');
  }

  const providerResult = await requestConfiguredProviderText(payload.providerConfig, {
    prompt: buildQueryChatPrompt(payload),
    systemPrompt:
      '你是 MyWiki 的中文对话助手。当前轮次是闲聊、助手能力说明或外部实时信息分流，简短自然回复，不要声称检索了 Wiki；遇到实时天气、新闻、股价等问题不要编造实时结果。',
    maxTokens: 800,
    reasoningMode: payload.reasoningMode,
  });
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const answer = normalizeQueryChatResponse(providerResult.text) || '你好，我在。你可以直接问我知识库里的具体问题。';
  return {
    answer,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}

async function streamAnswerQueryChatWithRuntimeProvider(
  payload: QueryChatAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
): Promise<QueryChatAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能回复闲聊消息。');
  }

  const providerResult = await requestConfiguredProviderTextStream(
    payload.providerConfig,
    {
      prompt: buildQueryChatPrompt(payload),
      systemPrompt:
        '你是 MyWiki 的中文对话助手。当前轮次是闲聊、助手能力说明或外部实时信息分流，简短自然回复，不要声称检索了 Wiki；遇到实时天气、新闻、股价等问题不要编造实时结果。',
      maxTokens: 800,
      reasoningMode: payload.reasoningMode,
    },
    { onToken: payload.onToken },
  );
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const answer = normalizeQueryChatResponse(providerResult.text) || '你好，我在。你可以直接问我知识库里的具体问题。';
  return {
    answer,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}

async function readQueryChatEventStream(response: Response, onToken: (token: string) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Query 闲聊流式回复没有返回可读流。');
  const decoder = new TextDecoder();
  let buffer = '';
  let final: QueryChatAnswerResponse | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const event of events) {
      const payload = parseSseEvent(event);
      if (!payload) continue;
      if (payload.type === 'token' && typeof payload.text === 'string') onToken(payload.text);
      if (payload.type === 'done') final = payload as QueryChatAnswerResponse & { type: 'done' };
      if (payload.type === 'error') throw new Error(String(payload.error || 'Query 闲聊流式回复失败'));
    }
  }

  if (buffer.trim()) {
    const payload = parseSseEvent(buffer);
    if (payload?.type === 'done') final = payload as QueryChatAnswerResponse & { type: 'done' };
    if (payload?.type === 'error') throw new Error(String(payload.error || 'Query 闲聊流式回复失败'));
  }

  if (!final) throw new Error('Query 闲聊流式回复没有收到完成事件。');
  return {
    answer: final.answer,
    provider: final.provider,
    model: final.model,
    fallbackFrom: final.fallbackFrom,
    llmTiming: final.llmTiming,
  };
}

function parseSseEvent(event: string) {
  const data = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  return JSON.parse(data) as Record<string, unknown>;
}

function stripClientOnlyFields(
  payload: QueryChatAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
) {
  const { onToken: _onToken, ...rest } = payload;
  return rest;
}
