import { detectLouvainCommunities, type CommunityGraphEdge } from '../graph/community';
import { parseMarkdownFrontmatter } from './frontmatter';
import { sanitizeWikiMarkdownOutput } from './markdownCompiler';
import { normalizeWikiReferenceValue } from './references';

export type WikiLintSeverity = 'info' | 'warning';

export type WikiLintResultType =
  | 'orphan'
  | 'weakly-linked'
  | 'broken-link'
  | 'no-outlinks'
  | 'frontmatter'
  | 'redirect-cycle'
  | 'knowledge-gap'
  | 'semantic';

export type WikiLintPage = {
  id: string;
  title: string;
  type: string;
  path: string;
  markdown: string;
  slug?: string;
  aliases?: string[];
  absolutePath?: string;
  related?: string[];
  sources?: string[];
  wikilinks?: string[];
};

export type WikiLintResult = {
  id: string;
  type: WikiLintResultType;
  severity: WikiLintSeverity;
  page: string;
  pageId?: string;
  pagePath?: string;
  title: string;
  detail: string;
  affectedPages?: string[];
};

export type SemanticWikiLintPayload = {
  pages: WikiLintPage[];
  contextMap?: WikiLintContextMap;
  outputLanguage?: 'zh-CN' | 'en';
};

export type WikiLintContextMap = {
  purpose?: string;
  index?: string;
  overview?: string;
  log?: string;
  schema?: string;
};

const lintBlockPattern =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g;

const defaultFrontmatterRequiredKeys = ['type', 'title', 'updated'];

export function runStructuralWikiLint(pages: WikiLintPage[], contextMap?: WikiLintContextMap): WikiLintResult[] {
  const normalizedPages = pages.map(normalizeLintPage).filter((page) => page.markdown.trim());
  const targetMap = buildPageTargetMap(normalizedPages, contextMap);
  const inboundCounts = new Map<string, number>();
  const results: WikiLintResult[] = [];
  const requiredFrontmatterKeys = inferRequiredFrontmatterKeys(contextMap?.schema);

  for (const page of normalizedPages) {
    const outlinks = collectOutgoingReferences(page);
    for (const link of outlinks) {
      const target = resolveReference(link, targetMap);
      if (target) {
        inboundCounts.set(target.canonicalKey, (inboundCounts.get(target.canonicalKey) ?? 0) + 1);
      }
    }
  }

  for (const page of normalizedPages) {
    const frontmatterIssues = validateFrontmatter(page, requiredFrontmatterKeys);
    for (const issue of frontmatterIssues) {
      results.push({
        id: `frontmatter:${page.id}:${issue.key}`,
        type: 'frontmatter',
        severity: 'warning',
        page: page.path,
        pageId: page.id,
        pagePath: page.path,
        title: 'Frontmatter 不完整',
        detail: issue.detail,
      });
    }

    const inbound = inboundCounts.get(page.canonicalKey) ?? 0;
    if (inbound === 0 && page.type !== 'overview') {
      results.push({
        id: `orphan:${page.id}`,
        type: 'orphan',
        severity: 'info',
        page: page.path,
        pageId: page.id,
        pagePath: page.path,
        title: 'Orphan Page',
        detail: '没有其他 Wiki 页面链接到这个页面。',
      });
    } else if (inbound === 1 && page.type !== 'overview') {
      results.push({
        id: `weakly-linked:${page.id}`,
        type: 'weakly-linked',
        severity: 'info',
        page: page.path,
        pageId: page.id,
        pagePath: page.path,
        title: 'Weakly Linked Page',
        detail: '这个页面入链只有 1 条，知识连接偏弱，建议补充到 index.md 或相关概念页。',
      });
    }

    const outlinks = collectOutgoingReferences(page);
    if (outlinks.length === 0 && page.type !== 'overview') {
      results.push({
        id: `no-outlinks:${page.id}`,
        type: 'no-outlinks',
        severity: 'info',
        page: page.path,
        pageId: page.id,
        pagePath: page.path,
        title: 'No Outbound Links',
        detail: '这个页面没有 [[wikilink]] 或 related 交叉引用。',
      });
    }

    for (const link of outlinks) {
      if (resolveReference(link, targetMap)) continue;
      results.push({
        id: `broken-link:${page.id}:${normalizeReferenceKey(link)}`,
        type: 'broken-link',
        severity: 'warning',
        page: page.path,
        pageId: page.id,
        pagePath: page.path,
        title: 'Broken Link',
        detail: `断链：找不到 [[${link}]] 指向的页面。`,
        affectedPages: [page.path],
      });
    }
  }

  results.push(...detectRedirectCycles(normalizedPages, targetMap));
  results.push(...detectLowCohesionCommunities(normalizedPages, targetMap));

  return results.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.page.localeCompare(b.page, 'zh-Hans-CN'));
}

export function buildSemanticWikiLintPrompt(payload: SemanticWikiLintPayload) {
  const summaries = payload.pages
    .map(normalizeLintPage)
    .map((page) => {
      const preview = compactMarkdownPreview(page.markdown, 1200);
      return [`### ${page.path}`, `Title: ${page.title}`, `Type: ${page.type}`, preview].join('\n');
    });
  const languageDirective =
    payload.outputLanguage === 'en'
      ? 'Write findings in English.'
      : '请用简体中文输出问题标题和描述。';

  return [
    'You are a wiki quality analyst. Review the following wiki page previews and identify genuine quality issues.',
    '',
    languageDirective,
    '',
    'For each issue, output exactly this format:',
    '',
    '---LINT: type | severity | Short title---',
    'Description of the issue.',
    'PAGES: page1.md, page2.md',
    '---END LINT---',
    '',
    'Types:',
    '- contradiction: two or more pages make conflicting claims',
    '- stale: information that appears outdated or superseded',
    '- missing-page: an important concept is referenced but has no dedicated page',
    '- suggestion: a source, question, or cross-link worth adding',
    '',
    'Severities:',
    '- warning: should be addressed',
    '- info: useful but lower priority',
    '',
    'Rules:',
    '- Only report issues grounded in the provided pages.',
    '- Do not invent facts, dates, missing entities, or risks.',
    '- Use the Context Map as the wiki goal, schema, radar, overview, and recent audit log.',
    '- Check for contradiction, stale claims, concept drift, missing cross-links, and schema/purpose mismatch.',
    '- Prefer fewer, higher-signal findings.',
    '- Output ONLY ---LINT--- blocks.',
    '',
    buildContextMapBlock(payload.contextMap),
    '',
    '## Wiki Pages',
    '',
    summaries.join('\n\n'),
  ].join('\n');
}

export function normalizeSemanticWikiLintResponse(rawText: string): WikiLintResult[] {
  const text = stripModelReasoning(rawText)
    .replace(/```(?:markdown|text)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const results: WikiLintResult[] = [];

  for (const match of text.matchAll(lintBlockPattern)) {
    const rawType = match[1].trim().toLowerCase();
    const severity = match[2].trim().toLowerCase() === 'warning' ? 'warning' : 'info';
    const title = match[3].trim() || 'Semantic Issue';
    const body = match[4].trim();
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m);
    const affectedPages = pagesMatch
      ? pagesMatch[1]
          .split(',')
          .map((page) => page.trim())
          .filter(Boolean)
      : [];
    const detail = body.replace(/^PAGES:.*$/m, '').trim();
    const page = affectedPages[0] ?? title;

    results.push({
      id: `semantic:${results.length}:${normalizeReferenceKey(title)}`,
      type: 'semantic',
      severity,
      page,
      pagePath: page,
      title,
      detail: `[${rawType}] ${detail || title}`,
      affectedPages,
    });
  }

  return results;
}

export function extractWikilinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const link = normalizeWikiReferenceValue(match[1]);
    if (link) links.add(link);
  }
  return Array.from(links);
}

function extractWikilinksWithLabels(markdown: string) {
  const links: Array<{ target: string; label: string }> = [];
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const target = normalizeWikiReferenceValue(match[1]);
    if (!target) continue;
    links.push({ target, label: match[2]?.trim() || target });
  }
  return links;
}

type NormalizedLintPage = WikiLintPage & {
  markdown: string;
  slug: string;
  canonicalKey: string;
  aliases: string[];
  wikilinks: string[];
  related: string[];
  sources: string[];
};

type TargetMapEntry = {
  page: NormalizedLintPage;
  canonicalKey: string;
};

function normalizeLintPage(page: WikiLintPage): NormalizedLintPage {
  const markdown = sanitizeWikiMarkdownOutput(page.markdown ?? '');
  const frontmatter = parseMarkdownFrontmatter(markdown);
  const slug = page.slug || slugFromPath(page.path) || slugFromTitle(page.title);
  return {
    ...page,
    title: page.title || stringValue(frontmatter.data.title) || slug,
    type: page.type || stringValue(frontmatter.data.type) || 'entity',
    markdown,
    slug,
    canonicalKey: normalizeReferenceKey(page.path.replace(/^wiki\//i, '').replace(/\.md$/i, '')),
    aliases: Array.from(new Set([...(page.aliases ?? []), ...stringArray(frontmatter.data.aliases)].map(normalizeWikiReferenceValue).filter(Boolean))),
    wikilinks: (page.wikilinks ?? extractWikilinks(frontmatter.body)).map(normalizeWikiReferenceValue).filter(Boolean),
    related: (page.related ?? stringArray(frontmatter.data.related)).map(normalizeWikiReferenceValue).filter(Boolean),
    sources: (page.sources ?? stringArray(frontmatter.data.sources)).map(normalizeWikiReferenceValue).filter(Boolean),
  };
}

function buildPageTargetMap(pages: NormalizedLintPage[], contextMap?: WikiLintContextMap) {
  const map = new Map<string, TargetMapEntry>();
  const ambiguousKeys = new Set<string>();
  const addEntry = (key: string, entry: TargetMapEntry, options: { overwrite?: boolean } = {}) => {
    for (const normalized of buildReferenceLookupKeys(key)) {
      if (!normalized) continue;
      if (ambiguousKeys.has(normalized)) continue;
      const existing = map.get(normalized);
      if (existing && existing.canonicalKey !== entry.canonicalKey && !options.overwrite) {
        map.delete(normalized);
        ambiguousKeys.add(normalized);
        continue;
      }
      if (options.overwrite || !map.has(normalized)) map.set(normalized, entry);
    }
  };

  for (const page of pages) {
    const keys = [
      page.path,
      page.path.replace(/^wiki\//i, ''),
      page.path.replace(/^wiki\//i, '').replace(/\.md$/i, ''),
      page.slug,
      page.title,
      ...page.aliases,
      ...(page.type === 'source' ? page.sources : []),
      slugFromPath(page.path),
    ];
    const canonicalKey = page.canonicalKey;
    for (const key of keys) {
      addEntry(key, { page, canonicalKey });
    }
  }

  for (const link of extractWikilinksWithLabels(contextMap?.index ?? '')) {
    const target = resolveReference(link.target, map);
    if (!target || !link.label || link.label === link.target) continue;
    addEntry(link.label, target);
  }

  return map;
}

function collectOutgoingReferences(page: NormalizedLintPage) {
  return Array.from(
    new Set(
      [...page.wikilinks, ...page.related]
        .map(normalizeWikiReferenceValue)
        .filter((reference) => reference && !isRawWorkspaceReference(reference)),
    ),
  );
}

function resolveReference(reference: string, targetMap: Map<string, TargetMapEntry>) {
  for (const key of buildReferenceLookupKeys(reference)) {
    const target = targetMap.get(key);
    if (target) return target;
  }
  return undefined;
}

function validateFrontmatter(page: NormalizedLintPage, requiredKeys: string[]) {
  const parsed = parseMarkdownFrontmatter(page.markdown);
  const issues: Array<{ key: string; detail: string }> = [];
  if (!parsed.raw) {
    issues.push({
      key: 'missing-block',
      detail: '页面缺少 YAML frontmatter，schema/index/retrieval 都很难稳定识别它。',
    });
    return issues;
  }

  for (const key of requiredKeys) {
    const value = parsed.data[key];
    if (value === undefined || value === null || value === '') {
      issues.push({
        key,
        detail: `frontmatter 缺少 ${key}: 字段。`,
      });
    }
  }

  return issues;
}

function detectRedirectCycles(pages: NormalizedLintPage[], targetMap: Map<string, TargetMapEntry>): WikiLintResult[] {
  const redirectByPage = new Map<string, string>();
  const pageByKey = new Map<string, NormalizedLintPage>();
  for (const page of pages) {
    pageByKey.set(page.canonicalKey, page);
    const parsed = parseMarkdownFrontmatter(page.markdown);
    const redirect = stringValue(parsed.data.redirect) || stringValue(parsed.data.redirect_to) || stringValue(parsed.data.redirects_to);
    const target = redirect ? resolveReference(redirect, targetMap) : null;
    if (target) redirectByPage.set(page.canonicalKey, target.canonicalKey);
  }

  const results: WikiLintResult[] = [];
  const seenCycles = new Set<string>();
  for (const page of pages) {
    const path: string[] = [];
    const visitedAt = new Map<string, number>();
    let current: string | undefined = page.canonicalKey;
    while (current && redirectByPage.has(current)) {
      if (visitedAt.has(current)) {
        const cycle = path.slice(visitedAt.get(current)!);
        const cycleKey = [...cycle].sort().join('>');
        if (!seenCycles.has(cycleKey)) {
          seenCycles.add(cycleKey);
          const cyclePages = cycle.map((key) => pageByKey.get(key)).filter((item): item is NormalizedLintPage => Boolean(item));
          const first = cyclePages[0] ?? page;
          results.push({
            id: `redirect-cycle:${cycleKey}`,
            type: 'redirect-cycle',
            severity: 'warning',
            page: first.path,
            pageId: first.id,
            pagePath: first.path,
            title: 'Redirect Cycle',
            detail: `发现循环重定向：${cyclePages.map((item) => item.path).join(' -> ')}`,
            affectedPages: cyclePages.map((item) => item.path),
          });
        }
        break;
      }
      visitedAt.set(current, path.length);
      path.push(current);
      current = redirectByPage.get(current);
    }
  }
  return results;
}

function detectLowCohesionCommunities(pages: NormalizedLintPage[], targetMap: Map<string, TargetMapEntry>): WikiLintResult[] {
  if (pages.length < 8) return [];

  const pageByKey = new Map<string, NormalizedLintPage>();
  const edges: CommunityGraphEdge[] = [];
  for (const page of pages) {
    pageByKey.set(page.canonicalKey, page);
    for (const link of collectOutgoingReferences(page)) {
      const target = resolveReference(link, targetMap);
      if (!target || target.canonicalKey === page.canonicalKey) continue;
      edges.push({ source: page.canonicalKey, target: target.canonicalKey, weight: 1 });
    }
  }

  const detection = detectLouvainCommunities(
    pages.map((page) => ({
      id: page.canonicalKey,
      label: page.title,
      rank: collectOutgoingReferences(page).length,
    })),
    edges,
    { resolution: 1 },
  );

  return detection.communities
    .filter((community) => community.nodeCount >= 3 && community.cohesion < 0.15)
    .map((community) => {
      const communityPages = community.nodeIds
        .map((key) => pageByKey.get(key))
        .filter((item): item is NormalizedLintPage => Boolean(item));
      const representative = communityPages[0];
      return {
        id: `knowledge-gap:${community.id}:${community.nodeIds.slice(0, 8).join(':')}`,
        type: 'knowledge-gap',
        severity: 'info',
        page: representative?.path ?? community.id,
        pageId: representative?.id,
        pagePath: representative?.path,
        title: 'Low Cohesion Community',
        detail: `Louvain 发现这一组 ${communityPages.length} 个页面的社区凝聚度约为 ${community.cohesion.toFixed(2)}，知识分布偏散，建议补充 synthesis/query 页面或交叉引用。`,
        affectedPages: communityPages.slice(0, 10).map((item) => item.path),
      } satisfies WikiLintResult;
    });
}

function compactMarkdownPreview(markdown: string, maxLength: number) {
  const parsed = parseMarkdownFrontmatter(sanitizeWikiMarkdownOutput(markdown));
  const text = [parsed.raw ? `---\n${parsed.raw}\n---` : '', parsed.body]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function buildContextMapBlock(contextMap: WikiLintContextMap | undefined) {
  if (!contextMap) return '## Context Map\n(No context map provided.)';
  const sections = [
    ['purpose.md', contextMap.purpose],
    ['schema.md', contextMap.schema],
    ['wiki/index.md', contextMap.index],
    ['wiki/overview.md', contextMap.overview],
    ['wiki/log.md', contextMap.log],
  ] as const;

  return [
    '## Context Map',
    ...sections
      .filter(([, content]) => content?.trim())
      .map(([name, content]) => `### ${name}\n${compactPlainText(content!, 2500)}`),
  ].join('\n\n');
}

function inferRequiredFrontmatterKeys(schemaMarkdown: string | undefined) {
  if (!schemaMarkdown?.trim()) return defaultFrontmatterRequiredKeys;

  const keys = new Set(defaultFrontmatterRequiredKeys);
  const allPagesSection = schemaMarkdown.match(/All pages must include YAML frontmatter:[\s\S]*?---\s*\n([\s\S]*?)\n---/i);
  const source = allPagesSection?.[1] ?? '';
  for (const match of source.matchAll(/^([A-Za-z0-9_-]+):/gm)) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}

function compactPlainText(value: string, maxLength: number) {
  const text = value.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function slugFromPath(path: string) {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '')
    .trim() ?? '';
}

function slugFromTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeReferenceKey(value: string) {
  return normalizeWikiReferenceValue(value)
    .replace(/\\/g, '/')
    .replace(/^wiki\//i, '')
    .replace(/\.md$/i, '')
    .normalize('NFKC')
    .replace(/\s*([()[\]{}])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function buildReferenceLookupKeys(value: string) {
  const keys = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeReferenceKey(candidate);
    if (!normalized) return;
    keys.add(normalized);
    keys.add(normalized.replace(/[\s_-]+/g, '-'));
    const withoutSourceDocumentExtension = stripSourceDocumentExtension(normalized);
    if (withoutSourceDocumentExtension) {
      keys.add(withoutSourceDocumentExtension);
      keys.add(withoutSourceDocumentExtension.replace(/[\s_-]+/g, '-'));
    }
    const withoutAsciiParenthetical = stripAsciiParentheticalAlias(normalized);
    if (withoutAsciiParenthetical) {
      keys.add(withoutAsciiParenthetical);
      keys.add(withoutAsciiParenthetical.replace(/[\s_-]+/g, '-'));
    }
  };

  add(value);
  add(slugFromPath(value));
  const withoutWiki = value.replace(/\\/g, '/').replace(/^wiki\//i, '');
  add(withoutWiki);
  add(withoutWiki.replace(/\.md$/i, ''));

  return Array.from(keys);
}

function stripAsciiParentheticalAlias(value: string) {
  if (!/[\u4e00-\u9fa5]/.test(value)) return '';
  const stripped = value
    .replace(/\((?=[^)]*[a-z0-9])[^)]*\)/gi, '')
    .replace(/[\s_-]+/g, ' ')
    .trim();
  if (!stripped || stripped === value || stripped.length < 2) return '';
  return stripped;
}

function stripSourceDocumentExtension(value: string) {
  const stripped = value.replace(/\.(?:pdf|docx?|pptx?|xlsx?|xlsm|xlsb|csv|tsv|zip|html?|md|markdown|txt)$/i, '');
  if (!stripped || stripped === value) return '';
  return stripped;
}

function isRawWorkspaceReference(value: string) {
  return /^raw\//i.test(value.replace(/\\/g, '/'));
}

function severityRank(severity: WikiLintSeverity) {
  return severity === 'warning' ? 2 : 1;
}

function stripModelReasoning(value: string) {
  return value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}
