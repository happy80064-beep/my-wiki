import { buildWorkspaceLayout, normalizeWorkspacePath } from '@/lib/workspace/paths';
import { sanitizeWikiMarkdownOutput } from './markdownCompiler';
import { parseMarkdownFrontmatter, type FrontmatterData } from './frontmatter';
import { normalizeWikiPageType } from './schemaRules';

export type WikiPageType =
  | 'entity'
  | 'concept'
  | 'project'
  | 'source'
  | 'query'
  | 'synthesis'
  | 'purpose'
  | 'schema'
  | 'decision'
  | 'meeting'
  | 'overview'
  | 'comparison'
  | 'stakeholder'
  | 'methodology'
  | 'finding'
  | 'thesis'
  | 'book'
  | 'character'
  | 'theme'
  | 'plot-thread'
  | 'chapter'
  | 'goal'
  | 'habit'
  | 'reflection'
  | 'journal';

export const WIKI_PAGE_TYPES: readonly WikiPageType[] = [
  'overview',
  'project',
  'entity',
  'concept',
  'source',
  'query',
  'synthesis',
  'purpose',
  'schema',
  'comparison',
  'decision',
  'meeting',
  'stakeholder',
  'methodology',
  'finding',
  'thesis',
  'book',
  'character',
  'theme',
  'plot-thread',
  'chapter',
  'goal',
  'habit',
  'reflection',
  'journal',
] as const;

export const WIKI_PAGE_TYPE_ORDER: readonly WikiPageType[] = [
  'overview',
  'project',
  'thesis',
  'finding',
  'methodology',
  'entity',
  'stakeholder',
  'book',
  'character',
  'concept',
  'theme',
  'plot-thread',
  'chapter',
  'source',
  'query',
  'synthesis',
  'comparison',
  'decision',
  'meeting',
  'goal',
  'habit',
  'reflection',
  'journal',
] as const;

export type WikiFileAdapter = {
  listMarkdownFiles: (wikiRoot: string) => Promise<string[]>;
  readTextFile: (absolutePath: string) => Promise<string>;
};

export type WikiPageIndexEntry = {
  id: string;
  slug: string;
  path: string;
  absolutePath: string;
  type: WikiPageType;
  title: string;
  summary: string;
  tags: string[];
  aliases: string[];
  related: string[];
  sources: string[];
  updated?: string;
  frontmatter: FrontmatterData;
  wikilinks: string[];
};

const folderTypeMap: Record<string, WikiPageType> = {
  topic: 'concept',
  person: 'entity',
  event: 'entity',
  entities: 'entity',
  concepts: 'concept',
  projects: 'project',
  sources: 'source',
  queries: 'query',
  synthesis: 'synthesis',
  decisions: 'decision',
  meetings: 'meeting',
  comparisons: 'comparison',
  stakeholders: 'stakeholder',
  methodology: 'methodology',
  findings: 'finding',
  thesis: 'thesis',
  books: 'book',
  characters: 'character',
  themes: 'theme',
  'plot-threads': 'plot-thread',
  chapters: 'chapter',
  goals: 'goal',
  habits: 'habit',
  reflections: 'reflection',
  journal: 'journal',
};

const legacyFrontmatterTypeMap: Record<string, WikiPageType> = {
  topic: 'concept',
  person: 'entity',
  event: 'entity',
};

const structuralWikiRootFiles = new Set(['index.md', 'log.md', 'purpose.md', 'schema.md']);

export async function scanWikiPages(adapter: WikiFileAdapter, workspaceRoot: string): Promise<WikiPageIndexEntry[]> {
  const layout = buildWorkspaceLayout(workspaceRoot);
  const wikiRoot = layout.wiki;
  const files = (await adapter.listMarkdownFiles(wikiRoot)).filter(
    (absolutePath) => !isStructuralWikiFile(wikiRoot, absolutePath),
  );

  const pages = await Promise.all(
    files.map(async (absolutePath) => {
      try {
        return await scanWikiPage(adapter, layout.root, wikiRoot, absolutePath);
      } catch {
        return undefined;
      }
    }),
  );

  return pages
    .filter((page): page is WikiPageIndexEntry => Boolean(page))
    .sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

function isStructuralWikiFile(wikiRoot: string, absolutePath: string) {
  const normalizedPath = normalizeWorkspacePath(absolutePath);
  const normalizedWikiRoot = normalizeWorkspacePath(wikiRoot);
  const relativeInsideWiki = normalizedPath.startsWith(`${normalizedWikiRoot}/`)
    ? normalizedPath.slice(normalizedWikiRoot.length + 1)
    : normalizedPath.split('/').slice(-1)[0];
  return !relativeInsideWiki.includes('/') && structuralWikiRootFiles.has(relativeInsideWiki.toLowerCase());
}

async function scanWikiPage(
  adapter: WikiFileAdapter,
  workspaceRoot: string,
  wikiRoot: string,
  absolutePath: string,
): Promise<WikiPageIndexEntry> {
  const normalizedPath = normalizeWorkspacePath(absolutePath);
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  const normalizedWikiRoot = normalizeWorkspacePath(wikiRoot);
  const relativeInsideWiki = normalizedPath.startsWith(`${normalizedWikiRoot}/`)
    ? normalizedPath.slice(normalizedWikiRoot.length + 1)
    : normalizedPath.split('/').slice(-1)[0];
  const workspacePath = normalizedPath.startsWith(`${normalizedWikiRoot}/`)
    ? `wiki/${relativeInsideWiki}`
    : normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)
      ? normalizedPath.slice(normalizedWorkspaceRoot.length + 1)
      : normalizedPath.split('/').slice(-1)[0];
  const markdown = sanitizeWikiMarkdownOutput(await adapter.readTextFile(normalizedPath));
  const parsed = parseMarkdownFrontmatter(markdown);
  const slug = fileSlug(relativeInsideWiki);
  const folder = relativeInsideWiki.includes('/') ? relativeInsideWiki.split('/')[0] : '';
  const type = normalizeType(parsed.data.type) ?? (slug === 'overview' ? 'overview' : folderTypeMap[folder] ?? 'overview');

  return {
    id: slug,
    slug,
    path: workspacePath,
    absolutePath: normalizedPath,
    type,
    title: stringValue(parsed.data.title) || firstHeading(parsed.body) || slug,
    summary: extractSummary(parsed.body),
    tags: stringArray(parsed.data.tags),
    aliases: stringArray(parsed.data.aliases),
    related: stringArray(parsed.data.related),
    sources: stringArray(parsed.data.sources),
    updated: stringValue(parsed.data.updated),
    frontmatter: parsed.data,
    wikilinks: extractWikiLinks(parsed.body),
  };
}

function normalizeType(value: unknown): WikiPageType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalizeWikiPageType(value) ?? legacyFrontmatterTypeMap[normalized];
}

function fileSlug(path: string) {
  return normalizeWorkspacePath(path)
    .split('/')
    .pop()!
    .replace(/\.md$/i, '');
}

function firstHeading(body: string) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function extractSummary(body: string) {
  const summarySection = section(body, '摘要');
  const source = summarySection || body.replace(/^#\s+.+$/m, '');
  const firstParagraph = source
    .split(/\n\s*\n/)
    .find((paragraph) => paragraph.trim() && !paragraph.trim().startsWith('#')) ?? source;
  return firstParagraph
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|') && !line.startsWith('---'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function section(body: string, heading: string) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm');
  const match = body.match(pattern);
  if (!match) return '';
  const rest = body.slice((match.index ?? 0) + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function extractWikiLinks(body: string) {
  const links = new Set<string>();
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    links.add(match[1].trim());
  }
  return Array.from(links);
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function typeOrder(type: WikiPageType) {
  const index = WIKI_PAGE_TYPE_ORDER.indexOf(type);
  return index < 0 ? WIKI_PAGE_TYPE_ORDER.length : index;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
