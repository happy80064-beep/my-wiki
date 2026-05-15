import { create } from 'zustand';
import { createEntry } from '@/lib/db';
import { createIngestJob, processIngestJob } from '@/lib/ingest';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import type { LlmProviderConfig } from '@/lib/llm/providers';
import { requestConfiguredProviderText, stripThinking } from '@/lib/llm/runtimeProvider';
import { parseRuntimeJson, postJsonThroughRuntime } from '@/lib/runtime/httpJson';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { loadResearchSettings, type ResearchSettings } from './settings';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

export type ResearchTaskStatus = 'queued' | 'searching' | 'synthesizing' | 'saving' | 'ingesting' | 'done' | 'error';

export type ResearchTask = {
  id: string;
  topic: string;
  searchQueries: string[];
  status: ResearchTaskStatus;
  webResults: WebSearchResult[];
  synthesis: string;
  entryId?: string;
  ingestJobId?: string;
  provider?: string;
  model?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

type ResearchState = {
  tasks: ResearchTask[];
  maxConcurrent: number;
  addTask: (topic: string, options?: { searchQueries?: string[] }) => string;
  updateTask: (id: string, patch: Partial<ResearchTask>) => void;
  removeTask: (id: string) => void;
  runTask: (id: string) => Promise<void>;
  queueResearch: (topic: string, options?: { searchQueries?: string[] }) => string;
  getRunningCount: () => number;
};

export type ResearchRunRequest = {
  topic: string;
  searchQueries: string[];
  searchConfig: ResearchSettings;
  providerConfig: LlmProviderConfig | null;
};

export type ResearchSearchRequest = Pick<ResearchRunRequest, 'topic' | 'searchQueries' | 'searchConfig'>;

export type ResearchSearchResponse = {
  webResults: WebSearchResult[];
};

export type ResearchSynthesisRequest = Pick<ResearchRunRequest, 'topic' | 'providerConfig'> & {
  webResults: WebSearchResult[];
};

export type ResearchSynthesisResponse = {
  synthesis: string;
  provider: string;
  model: string;
};

export type ResearchRunResponse = ResearchSearchResponse & ResearchSynthesisResponse;

let counter = 0;

export const useResearchStore = create<ResearchState>((set, get) => ({
  tasks: [],
  maxConcurrent: 2,

  addTask: (topic, options) => {
    const now = Date.now();
    const id = `research-${now}-${++counter}`;
    set((state) => ({
      tasks: [
        {
          id,
          topic: topic.trim(),
          searchQueries: uniqueStrings(options?.searchQueries?.map((query) => query.trim()).filter(Boolean) ?? []),
          status: 'queued',
          webResults: [],
          synthesis: '',
          createdAt: now,
          updatedAt: now,
        },
        ...state.tasks,
      ],
    }));
    return id;
  },

  updateTask: (id, patch) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              ...patch,
              updatedAt: Date.now(),
            }
          : task,
      ),
    })),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== id),
    })),

  runTask: async (id) => {
    const task = get().tasks.find((item) => item.id === id);
    if (!task || !task.topic.trim()) return;

    try {
      get().updateTask(id, { status: 'searching', error: undefined });
      const searchQueries = task.searchQueries.length ? task.searchQueries : [task.topic];
      const { webResults } = await searchConfiguredDeepResearch(task.topic, {
        searchQueries,
      });

      get().updateTask(id, {
        status: 'synthesizing',
        webResults,
      });

      const synthesisPayload = await synthesizeConfiguredDeepResearch(task.topic, webResults);
      const payload: ResearchRunResponse = {
        webResults,
        ...synthesisPayload,
      };

      get().updateTask(id, {
        status: 'saving',
        webResults: payload.webResults,
        synthesis: payload.synthesis,
        provider: payload.provider || undefined,
        model: payload.model || undefined,
      });

      const content = buildResearchMarkdown({
        topic: task.topic,
        synthesis: payload.synthesis,
        webResults: payload.webResults,
        provider: payload.provider || undefined,
        model: payload.model || undefined,
      });
      const filename = `research-${slugify(task.topic)}-${new Date().toISOString().slice(0, 10)}.md`;
      const entry = await createEntry({
        content,
        source: 'file',
        processed: false,
        fileMetadata: {
          filename,
          mimeType: 'text/markdown',
          url: `research://${id}`,
        },
      });

      get().updateTask(id, { status: 'ingesting', entryId: entry.id });
      const ingestJob = await createIngestJob({
        content,
        source: 'file',
        filename,
        targetEntryId: entry.id,
      });
      get().updateTask(id, { ingestJobId: ingestJob.id });
      const processed = await processIngestJob(ingestJob.id);
      get().updateTask(id, {
        status: processed?.status === 'failed' ? 'error' : 'done',
        error: processed?.status === 'failed' ? processed.error || '研究结果已保存，但自动入库失败。' : undefined,
      });
    } catch (error) {
      get().updateTask(id, {
        status: 'error',
        error: error instanceof Error ? error.message : '深度研究失败。',
      });
    }
  },

  queueResearch: (topic, options) => {
    const id = get().addTask(topic, options);
    window.setTimeout(() => {
      const running = get().getRunningCount();
      if (running < get().maxConcurrent) {
        void get().runTask(id);
      }
    }, 20);
    return id;
  },

  getRunningCount: () =>
    get().tasks.filter((task) => ['searching', 'synthesizing', 'saving', 'ingesting'].includes(task.status)).length,
}));

export async function runConfiguredDeepResearch(
  topic: string,
  options: { searchQueries?: string[] } = {},
): Promise<ResearchRunResponse> {
  const trimmedTopic = topic.trim();
  if (!trimmedTopic) throw new Error('研究主题不能为空。');

  const { webResults } = await searchConfiguredDeepResearch(trimmedTopic, options);
  const synthesisPayload = await synthesizeConfiguredDeepResearch(trimmedTopic, webResults);
  return {
    webResults,
    ...synthesisPayload,
  };
}

export async function searchConfiguredDeepResearch(
  topic: string,
  options: { searchQueries?: string[] } = {},
): Promise<ResearchSearchResponse> {
  const trimmedTopic = topic.trim();
  if (!trimmedTopic) throw new Error('研究主题不能为空。');

  const researchSettings = loadResearchSettings();
  if (researchSettings.provider === 'none' || !researchSettings.apiKey.trim()) {
    throw new Error('请先在设置里配置 Tavily API Key，才能运行深度研究。');
  }

  const request: ResearchSearchRequest = {
    topic: trimmedTopic,
    searchQueries: options.searchQueries?.length ? options.searchQueries : [trimmedTopic],
    searchConfig: researchSettings,
  };

  return !import.meta.env.DEV && isTauriRuntime()
    ? await searchResearchWithRuntimeBridge(request)
    : await searchResearchWithDevApi(request);
}

export async function synthesizeConfiguredDeepResearch(
  topic: string,
  webResults: WebSearchResult[],
): Promise<ResearchSynthesisResponse> {
  const trimmedTopic = topic.trim();
  if (!trimmedTopic) throw new Error('研究主题不能为空。');
  if (webResults.length === 0) {
    return {
      synthesis: buildNoWebResultsSynthesis(trimmedTopic),
      provider: '',
      model: '',
    };
  }

  const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'query-deep');
  if (!providerConfig) {
    throw new Error('请先在设置里配置可用的 Query/Deep Research 模型。');
  }

  const request: ResearchSynthesisRequest = {
    topic: trimmedTopic,
    webResults,
    providerConfig,
  };

  return !import.meta.env.DEV && isTauriRuntime()
    ? await synthesizeResearchWithRuntimeBridge(request)
    : await synthesizeResearchWithDevApi(request);
}

async function searchResearchWithDevApi(request: ResearchSearchRequest): Promise<ResearchSearchResponse> {
  const response = await fetch('/api/research/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const payload = (await response.json()) as ResearchSearchResponse | { error?: string };
  if (!response.ok || !('webResults' in payload)) {
    throw new Error((payload as { error?: string }).error || '深度研究搜索失败。');
  }
  return payload;
}

async function synthesizeResearchWithDevApi(request: ResearchSynthesisRequest): Promise<ResearchSynthesisResponse> {
  const response = await fetch('/api/research/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const payload = (await response.json()) as ResearchSynthesisResponse | { error?: string };
  if (!response.ok || !('synthesis' in payload)) {
    throw new Error((payload as { error?: string }).error || '深度研究生成失败。');
  }
  return payload;
}

async function searchResearchWithRuntimeBridge(request: ResearchSearchRequest): Promise<ResearchSearchResponse> {
  if (request.searchConfig.provider !== 'tavily' || !request.searchConfig.apiKey.trim()) {
    throw new Error('Tavily API Key is required for deep research.');
  }

  const queries = uniqueStrings(request.searchQueries.map((query) => query.trim()).filter(Boolean)).slice(0, 4);
  const maxResults = Math.min(10, Math.max(1, Number(request.searchConfig.maxResults) || 5));
  const webResults = await runTavilySearches(queries.length ? queries : [request.topic], request.searchConfig.apiKey, maxResults);
  return { webResults };
}

async function synthesizeResearchWithRuntimeBridge(
  request: ResearchSynthesisRequest,
): Promise<ResearchSynthesisResponse> {
  if (request.webResults.length === 0) {
    return {
      synthesis: buildNoWebResultsSynthesis(request.topic),
      provider: '',
      model: '',
    };
  }
  if (!request.providerConfig) {
    throw new Error('请先在设置里配置可用的 Query/Deep Research 模型。');
  }

  const providerResult = await requestConfiguredProviderText(request.providerConfig, {
    prompt: buildDeepResearchPrompt(request.topic, request.webResults),
    systemPrompt:
      'You are MyWiki Deep Research. Synthesize web search results into a concise, cited Chinese wiki research note. Do not reveal chain-of-thought.',
    maxTokens: 3600,
  });
  if (!providerResult.ok) {
    throw new Error(`${providerResult.providerName} failed: ${providerResult.error}`);
  }

  return {
    synthesis: stripThinking(providerResult.text),
    provider: providerResult.providerName,
    model: providerResult.model,
  };
}

async function runTavilySearches(queries: string[], apiKey: string, maxResults: number): Promise<WebSearchResult[]> {
  const seen = new Set<string>();
  const merged: WebSearchResult[] = [];
  for (const query of queries) {
    const response = await postJsonThroughRuntime({
      url: 'https://api.tavily.com/search',
      headers: { 'Content-Type': 'application/json' },
      body: {
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
        include_answer: false,
      },
    });
    const data = parseRuntimeJson<{
      results?: Array<{ title?: string; url?: string; content?: string }>;
      error?: string;
      message?: string;
    }>(response.body);
    if (!response.ok) {
      throw new Error(data.error || data.message || `Tavily search failed with ${response.status}.`);
    }
    for (const item of data.results ?? []) {
      const url = item.url?.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push({
        title: item.title?.trim() || 'Untitled',
        url,
        snippet: item.content?.trim() || '',
        source: safeHost(url),
      });
    }
  }
  return merged.slice(0, Math.max(maxResults, 1) * Math.max(queries.length, 1));
}

function buildDeepResearchPrompt(topic: string, webResults: WebSearchResult[]) {
  const sources = webResults
    .map((result, index) => [`[${index + 1}] ${result.title}`, `URL: ${result.url}`, `摘要: ${result.snippet}`].join('\n'))
    .join('\n\n');
  return [
    `研究主题：${topic}`,
    '',
    '请基于下面的网页搜索结果生成可写入 Wiki 的中文研究条目：',
    '- 先给出结论摘要',
    '- 分主题整理事实、数据、争议和未知项',
    '- 使用 [1]、[2] 这样的编号引用来源',
    '- 明确指出还需要补充验证的内容',
    '- 保持中性、可复用、适合进入知识库',
    '',
    '## Web Search Results',
    '',
    sources,
  ].join('\n');
}

function buildNoWebResultsSynthesis(topic: string) {
  return `# ${topic}\n\n没有检索到可用的外部来源。建议换一个更具体的主题或检查 Tavily 配置。`;
}

function buildResearchMarkdown(input: {
  topic: string;
  synthesis: string;
  webResults: WebSearchResult[];
  provider?: string;
  model?: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const references = input.webResults
    .map((result, index) => `${index + 1}. [${escapeMarkdown(result.title)}](${result.url}) - ${result.source}`)
    .join('\n');

  return [
    '---',
    'type: query',
    `title: "Research: ${input.topic.replace(/"/g, '\\"')}"`,
    `created: ${today}`,
    `updated: ${today}`,
    'origin: deep-research',
    'tags: [research, deep-research]',
    'related: []',
    '---',
    '',
    `# Research: ${input.topic}`,
    '',
    input.synthesis.trim(),
    '',
    '## References',
    '',
    references || '- 暂无外部搜索来源。',
    '',
    input.provider ? `> Generated by ${input.provider}${input.model ? ` / ${input.model}` : ''}.` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'topic';
}

function escapeMarkdown(value: string) {
  return value.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
