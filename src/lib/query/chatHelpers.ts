import type { StructuredQueryResult } from '@/lib/graph';
import type { RetrievedWikiPage } from './wikiRetrieval';

export type QueryChatReference = {
  key: string;
  title: string;
  href?: string;
  type: StructuredQueryResult['sources'][number]['type'];
  preview?: QueryChatReferencePreview;
};

export type QueryChatReferencePreview =
  | {
      kind: 'wiki';
      entityId?: string;
      title: string;
      pageType?: string;
      path?: string;
      summary?: string;
      content?: string;
      tags?: string[];
      sources?: string[];
      related?: string[];
      updated?: string;
      truncated?: boolean;
    }
  | {
      kind: 'source';
      entryId?: string;
      title: string;
      path?: string;
      summary?: string;
      content?: string;
      truncated?: boolean;
    }
  | {
      kind: 'web';
      title: string;
      url: string;
      source?: string;
      snippet?: string;
      content?: string;
      relevance?: 'direct' | 'weak';
      relevanceReason?: string;
    };

export function buildConversationTitle(question: string) {
  const trimmed = question.trim();
  if (!trimmed) return '新对话';
  return trimmed.length > 28 ? `${trimmed.slice(0, 27)}…` : trimmed;
}

export function buildQueryReferences(result: StructuredQueryResult): QueryChatReference[] {
  return result.sources.map((source) => ({
    key: `${source.type}:${source.id}`,
    title: source.title,
    href:
      source.type === 'entity'
        ? buildWikiReferenceHref(source.title)
        : source.type === 'entry'
          ? source.href && !source.href.startsWith('/entries/')
            ? source.href
            : buildSourceReferenceHref(source.id || source.title)
          : source.href,
    type: source.type,
    preview:
      source.type === 'entity'
        ? {
            kind: 'wiki',
            entityId: source.id,
            title: source.title,
          }
        : source.type === 'entry'
          ? {
              kind: 'source',
              entryId: source.id,
              title: source.title,
            }
        : source.type === 'web'
          ? {
              kind: 'web',
              title: source.title,
              url: source.href ?? source.id,
              source: source.href ? safeHost(source.href) : undefined,
            }
          : undefined,
  }));
}

export function buildWikiPageReferences(
  pages: RetrievedWikiPage[],
  citedIndices: number[] = [],
): QueryChatReference[] {
  const selected =
    citedIndices.length > 0
      ? pages.filter((page) => citedIndices.includes(page.index))
      : pages.slice(0, 6);

  return selected.map((page) => ({
    key: `entity:${page.entityId}`,
    title: page.title,
    href: buildWikiReferenceHref(page.title),
    type: 'entity',
    preview: {
      kind: 'wiki',
      entityId: page.entityId,
      title: page.title,
      pageType: page.type,
      path: page.path,
      summary: page.summary,
      content: truncatePreviewContent(page.content, 18000),
      tags: page.tags,
      sources: page.sources,
      related: page.related,
      updated: page.updated,
      truncated: page.content.length > 18000,
    },
  }));
}

export function stripAnswerForCopy(answer: string) {
  return stripHiddenAnswerParts(answer).replace(/\s+$/g, '').trim();
}

export function stripHiddenAnswerParts(answer: string) {
  return answer
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function buildWikiReferenceHref(reference: string) {
  return `/wiki?ref=${encodeURIComponent(reference)}`;
}

function buildSourceReferenceHref(reference: string) {
  return `/wiki?source=${encodeURIComponent(reference)}`;
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function truncatePreviewContent(content: string, maxLength: number) {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trim()}\n\n[...preview truncated...]`;
}
