import type { WikiPageIndexEntry } from './scanner';

export type WorkspaceArea = 'wiki' | 'raw' | 'state' | 'other';

export type WorkspaceFileEntry = {
  absolutePath: string;
  relativePath: string;
  name: string;
  extension: string;
  area: WorkspaceArea;
  isMarkdown: boolean;
  isTextLike: boolean;
};

const textLikeExtensions = new Set([
  'md',
  'mdx',
  'txt',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'html',
  'htm',
  'xml',
  'log',
]);

export function buildWorkspaceFileEntries(root: string, absolutePaths: string[]): WorkspaceFileEntry[] {
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '');
  return absolutePaths
    .map((absolutePath) => {
      const normalizedPath = normalizePath(absolutePath);
      const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath;
      const name = relativePath.split('/').pop() ?? relativePath;
      const extension = getExtension(name);
      return {
        absolutePath: normalizedPath,
        relativePath,
        name,
        extension,
        area: detectWorkspaceArea(relativePath),
        isMarkdown: extension === 'md' || extension === 'mdx',
        isTextLike: textLikeExtensions.has(extension),
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'));
}

export function filterRawSourceEntries(entries: WorkspaceFileEntry[]) {
  return entries.filter((entry) => entry.area === 'raw' && !entry.relativePath.includes('/.cache/'));
}

export function findMatchingSourcePage(source: WorkspaceFileEntry, pages: WikiPageIndexEntry[]) {
  const sourceName = source.name.toLowerCase();
  const sourceStem = stripExtension(source.name).toLowerCase();
  return (
    pages.find((page) =>
      page.sources.some((item) => {
        const normalizedItem = item.toLowerCase();
        const itemStem = stripExtension(normalizedItem);
        return normalizedItem.includes(sourceName) || normalizedItem.includes(sourceStem) || itemStem === sourceStem;
      }),
    ) ??
    pages.find((page) => page.title.toLowerCase() === sourceStem) ??
    pages.find((page) => page.path.toLowerCase().includes(`/sources/${sourceStem}.md`)) ??
    null
  );
}

export function findWorkspaceSourceEntryByLabel(label: string, entries: WorkspaceFileEntry[]) {
  const normalizedLabel = normalizeLookup(label);
  const labelStem = normalizeLookup(stripExtension(label));
  return (
    entries.find((entry) => normalizeLookup(entry.name) === normalizedLabel) ??
    entries.find((entry) => normalizeLookup(entry.relativePath) === normalizedLabel) ??
    entries.find((entry) => normalizeLookup(entry.name) === labelStem) ??
    entries.find((entry) => normalizeLookup(stripExtension(entry.name)) === labelStem) ??
    null
  );
}

export function findWikiPageByReference(reference: string, pages: WikiPageIndexEntry[]) {
  const normalized = normalizeLookup(reference);
  const normalizedStem = normalizeLookup(stripExtension(reference));
  return (
    pages.find((page) => normalizeLookup(page.title) === normalized) ??
    pages.find((page) => normalizeLookup(page.slug) === normalized) ??
    pages.find((page) => normalizeLookup(page.path) === normalized) ??
    pages.find((page) => normalizeLookup(page.absolutePath) === normalized) ??
    pages.find((page) => normalizeLookup(page.title) === normalizedStem) ??
    pages.find((page) => normalizeLookup(page.slug) === normalizedStem) ??
    null
  );
}

export function workspaceAreaLabel(area: WorkspaceArea) {
  return {
    wiki: 'Wiki 页面',
    raw: '原始材料',
    state: '系统状态',
    other: '其他文件',
  }[area];
}

function detectWorkspaceArea(relativePath: string): WorkspaceArea {
  if (relativePath.startsWith('wiki/')) return 'wiki';
  if (relativePath.startsWith('raw/')) return 'raw';
  if (relativePath.startsWith('.mywiki/')) return 'state';
  return 'other';
}

function getExtension(name: string) {
  const index = name.lastIndexOf('.');
  if (index < 0) return '';
  return name.slice(index + 1).toLowerCase();
}

function stripExtension(name: string) {
  const index = name.lastIndexOf('.');
  if (index < 0) return name;
  return name.slice(0, index);
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/');
}

function normalizeLookup(value: string) {
  return value.trim().replace(/\\/g, '/').toLowerCase();
}
