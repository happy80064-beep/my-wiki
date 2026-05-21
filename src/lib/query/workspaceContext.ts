import { buildWorkspaceLayout, createWorkspaceStorage } from '@/lib/workspace';
import { stripSupersededMarkdown } from '@/lib/wiki/superseded';
import type { QueryMode } from './queryMode';
import type { QueryWorkspaceContext } from './queryAnswer';

export type LoadQueryWorkspaceContextInput = {
  workspaceRoot: string;
  question: string;
  queryMode: QueryMode;
  maxContextChars?: number;
};

const MAX_MARKDOWN_FILES = 240;
const MAX_FILE_READS = 80;
const DEFAULT_FILE_LIMIT = 6;
const STOP_WORDS = new Set([
  '这个',
  '项目',
  '什么',
  '哪些',
  '怎么',
  '如何',
  '是否',
  '有没有',
  '以及',
  '分别',
  'the',
  'what',
  'how',
  'why',
]);

export async function loadQueryWorkspaceContext(
  input: LoadQueryWorkspaceContextInput,
): Promise<QueryWorkspaceContext | undefined> {
  if (!input.queryMode.retrieval.includeWorkspaceContext && !input.queryMode.retrieval.enableSemanticChunks) {
    return undefined;
  }

  const storage = createWorkspaceStorage();
  const layout = buildWorkspaceLayout(input.workspaceRoot);
  const trace: string[] = [];
  const [purpose, index] = await Promise.all([
    readOptionalText(storage, layout.purpose, 'purpose.md', trace),
    readOptionalText(storage, layout.wikiIndex, 'wiki/index.md', trace),
  ]);

  const tokens = tokenize(input.question);
  const files = input.queryMode.retrieval.enableSemanticChunks
    ? await retrieveWorkspaceMarkdownCandidates(storage, layout, tokens, input.maxContextChars, trace)
    : [];

  if (!purpose && !index && files.length === 0 && trace.length === 0) return undefined;
  if (input.queryMode.retrieval.enableSemanticChunks) {
    trace.push(
      files.length > 0
        ? `已执行工作区 Markdown chunk 级词法召回，选入 ${files.length} 个候选片段。`
        : '已尝试工作区 Markdown chunk 级词法召回，但没有命中候选片段。',
    );
    trace.push('当前项目尚未发现可复用的 embedding 查询索引，本轮未把词法召回冒充为语义向量召回。');
  }

  return {
    purpose: trimBudget(purpose, 2000),
    index: trimIndexForQuestion(index, tokens, 2600),
    files,
    trace,
  };
}

async function readOptionalText(
  storage: ReturnType<typeof createWorkspaceStorage>,
  path: string,
  label: string,
  trace: string[],
) {
  try {
    if (!(await storage.exists(path))) {
      trace.push(`${label} 不存在，已跳过。`);
      return '';
    }
    const text = await storage.readTextFile(path);
    trace.push(`已读取 ${label}。`);
    return text;
  } catch (error) {
    trace.push(`${label} 读取失败：${error instanceof Error ? error.message : '未知错误'}`);
    return '';
  }
}

async function retrieveWorkspaceMarkdownCandidates(
  storage: ReturnType<typeof createWorkspaceStorage>,
  layout: ReturnType<typeof buildWorkspaceLayout>,
  tokens: string[],
  maxContextChars: number | undefined,
  trace: string[],
): Promise<NonNullable<QueryWorkspaceContext['files']>> {
  try {
    const roots = [layout.wiki, layout.rawSources];
    const fileLists = await Promise.all(
      roots.map(async (root) => {
        if (!(await storage.exists(root))) return [];
        return storage.listMarkdownFiles(root);
      }),
    );
    const files = Array.from(new Set(fileLists.flat())).slice(0, MAX_MARKDOWN_FILES);
    const candidates: NonNullable<QueryWorkspaceContext['files']> = [];
    const readLimit = Math.min(files.length, MAX_FILE_READS);

    for (const path of files.slice(0, readLimit)) {
      const raw = await storage.readTextFile(path);
      const markdown = stripSupersededMarkdown(raw);
      const score = scoreText(path, markdown, tokens);
      if (score <= 0) continue;
      candidates.push({
        path: relativeWorkspacePath(layout.root, path),
        title: titleFromMarkdown(path, markdown),
        kind: isPathUnder(path, layout.rawSources) ? 'source' : 'wiki',
        excerpt: buildExcerpt(markdown, tokens, chunkBudget(maxContextChars)),
        score,
      });
    }

    if (files.length > readLimit) {
      trace.push(`工作区 Markdown 文件 ${files.length} 个，本轮按预算扫描前 ${readLimit} 个。`);
    } else {
      trace.push(`工作区 Markdown 文件 ${files.length} 个，本轮全部纳入候选扫描。`);
    }

    return candidates.sort((left, right) => right.score - left.score).slice(0, DEFAULT_FILE_LIMIT);
  } catch (error) {
    trace.push(`工作区 Markdown 候选召回失败：${error instanceof Error ? error.message : '未知错误'}`);
    return [];
  }
}

function tokenize(value: string) {
  const normalized = value.toLowerCase();
  const rough = normalized
    .split(/[^\u4e00-\u9fa5a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  const cjkPairs = rough.flatMap((token) => {
    if (!/[\u4e00-\u9fa5]/.test(token) || token.length <= 2) return [];
    const chars = [...token];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  });
  return Array.from(new Set([...rough, ...cjkPairs]));
}

function scoreText(path: string, markdown: string, tokens: string[]) {
  const normalizedPath = normalize(path);
  const normalizedMarkdown = normalize(markdown);
  let score = 0;
  for (const token of tokens) {
    const normalizedToken = normalize(token);
    if (!normalizedToken) continue;
    if (normalizedPath.includes(normalizedToken)) score += 12;
    const occurrences = countOccurrences(normalizedMarkdown, normalizedToken);
    score += Math.min(occurrences, 12);
  }
  return score;
}

function buildExcerpt(markdown: string, tokens: string[], maxLength: number) {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedTokens = tokens.map(normalize).filter(Boolean);
  const hitIndex = lines.findIndex((line) => normalizedTokens.some((token) => normalize(line).includes(token)));
  const start = Math.max(0, hitIndex - 4);
  const selected = lines.slice(hitIndex >= 0 ? start : 0, hitIndex >= 0 ? start + 14 : 12).join('\n');
  return trimBudget(selected || markdown, maxLength);
}

function titleFromMarkdown(path: string, markdown: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || path;
}

function trimIndexForQuestion(index: string | undefined, tokens: string[], maxLength: number) {
  if (!index) return '';
  const lines = index.split('\n').filter((line) => {
    const normalizedLine = normalize(line);
    return tokens.some((token) => normalizedLine.includes(normalize(token)));
  });
  const selected = lines.length ? lines.join('\n') : index;
  return trimBudget(selected, maxLength);
}

function trimBudget(value: string | undefined, maxLength: number) {
  const text = (value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}\n\n[...workspace context truncated...]`;
}

function chunkBudget(maxContextChars: number | undefined) {
  if (!maxContextChars || maxContextChars < 20_000) return 1400;
  return 2200;
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while (true) {
    const next = haystack.indexOf(needle, position);
    if (next < 0) break;
    count += 1;
    position = next + needle.length;
  }
  return count;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

function relativeWorkspacePath(root: string, path: string) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedPath = path.replace(/\\/g, '/');
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function isPathUnder(path: string, root: string) {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
