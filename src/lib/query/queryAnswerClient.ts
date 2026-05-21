import { assertDevAiApiAvailable, buildDevApiUrl } from '@/lib/ai/devApiGuard';
import { requestConfiguredProviderText, requestConfiguredProviderTextStream } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import type { LlmReasoningMode } from '@/lib/llm/textProvider';
import {
  buildQueryAnswerPrompt,
  normalizeQueryAnswerResponse,
  type QueryAnswerRequest,
  type QueryAnswerResponse,
} from './queryAnswer';

export async function answerQueryWithWikiPages(
  payload: QueryAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return answerQueryWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 2.0 页面回答');

  const response = await fetch(buildDevApiUrl('/api/query/answer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as QueryAnswerResponse | { error?: string };
  if (!response.ok || !('answer' in body)) {
    throw new Error((body as { error?: string }).error || 'Query 2.0 页面回答失败');
  }

  return body;
}

export async function streamAnswerQueryWithWikiPages(
  payload: QueryAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
): Promise<QueryAnswerResponse> {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    return streamAnswerQueryWithRuntimeProvider(payload);
  }

  assertDevAiApiAvailable('Query 3.0 流式页面回答');

  const response = await fetch(buildDevApiUrl('/api/query/answer/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stripClientOnlyFields(payload)),
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || 'Query 3.0 流式页面回答失败');
  }

  return readQueryAnswerEventStream(response, payload.onToken);
}

async function answerQueryWithRuntimeProvider(
  payload: QueryAnswerRequest & { providerConfig?: LlmProviderConfig | null; reasoningMode?: LlmReasoningMode },
): Promise<QueryAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能生成最终回答。');
  }

  const providerResult = await requestConfiguredProviderText(payload.providerConfig, {
    prompt: buildQueryAnswerPrompt(payload),
    systemPrompt:
      '你是 MyWiki Query 2.0 的中文 Wiki 对话分析助手。请基于给定的编号 Wiki 页面进行高质量 Markdown 回答，禁止输出 <think>、思考过程或 JSON。必须在末尾追加一个形如 <!-- cited: 1,2 --> 的 HTML 注释。',
    maxTokens: 1800,
    reasoningMode: payload.reasoningMode,
  });
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const normalized = normalizeQueryAnswerResponse(
    providerResult.text,
    payload.structuredSupport?.draftAnswer || '现有 Wiki 页面还不能可靠回答这个问题。',
  );
  return {
    ...normalized,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}

async function streamAnswerQueryWithRuntimeProvider(
  payload: QueryAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
): Promise<QueryAnswerResponse> {
  if (!payload.providerConfig) {
    throw new Error('请先在设置里配置 Query/Deep Research 模型，安装版才能生成最终回答。');
  }

  const providerResult = await requestConfiguredProviderTextStream(
    payload.providerConfig,
    {
      prompt: buildQueryAnswerPrompt(payload),
      systemPrompt:
        '你是 MyWiki Query 3.0 的中文 Wiki 对话分析助手。请基于给定的编号 Wiki 页面进行高质量 Markdown 回答，禁止输出 <think>、思考过程或 JSON。必须在末尾追加一个形如 <!-- cited: 1,2 --> 的 HTML 注释。',
      maxTokens: resolveQueryAnswerMaxTokens(payload),
      reasoningMode: payload.reasoningMode,
    },
    { onToken: payload.onToken },
  );
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  const normalized = normalizeQueryAnswerResponse(
    providerResult.text,
    payload.structuredSupport?.draftAnswer || '现有 Wiki 页面还不能可靠回答这个问题。',
  );
  return {
    ...normalized,
    provider: providerResult.providerName,
    model: providerResult.model,
    llmTiming: providerResult.timing,
  };
}

async function readQueryAnswerEventStream(response: Response, onToken: (token: string) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Query 3.0 流式页面回答没有返回可读流。');
  const decoder = new TextDecoder();
  let buffer = '';
  let final: QueryAnswerResponse | null = null;

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
      if (payload.type === 'done') final = payload as QueryAnswerResponse & { type: 'done' };
      if (payload.type === 'error') throw new Error(String(payload.error || 'Query 3.0 流式页面回答失败'));
    }
  }

  if (buffer.trim()) {
    const payload = parseSseEvent(buffer);
    if (payload?.type === 'done') final = payload as QueryAnswerResponse & { type: 'done' };
    if (payload?.type === 'error') throw new Error(String(payload.error || 'Query 3.0 流式页面回答失败'));
  }

  if (!final) throw new Error('Query 3.0 流式页面回答没有收到完成事件。');
  return {
    answer: final.answer,
    citedIndices: final.citedIndices,
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
  payload: QueryAnswerRequest & {
    providerConfig?: LlmProviderConfig | null;
    reasoningMode?: LlmReasoningMode;
    onToken: (token: string) => void;
  },
) {
  const { onToken: _onToken, ...rest } = payload;
  return rest;
}

function resolveQueryAnswerMaxTokens(payload: QueryAnswerRequest) {
  const mode = payload.queryMode;
  if (!mode || mode.kind === 'lookup') return mode?.answerShape === 'direct' ? 900 : 1400;
  return 2400;
}
