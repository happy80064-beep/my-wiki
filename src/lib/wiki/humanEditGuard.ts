import type { Entity, WikiReviewMergeMode } from '@/types';
import { buildSupersededBlock, stripSupersededMarkdown } from './superseded';

export type HumanEditMergeResult = {
  markdown: string;
  mode: WikiReviewMergeMode;
  changed: boolean;
};

type MarkdownParts = {
  frontmatter: string;
  body: string;
};

type MarkdownSection = {
  key: string;
  heading: string;
  content: string;
  raw: string;
};

export function createWikiMarkdownHash(markdown: string) {
  const normalized = normalizeActiveMarkdown(markdown);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeActiveMarkdown(markdown: string) {
  return stripSupersededMarkdown(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasHumanEditedWiki(entity: Entity) {
  return Boolean(entity.wikiHumanEditedAt && entity.wikiHumanEditHash && entity.wikiMarkdown?.trim());
}

export function buildHumanEditedWikiPatch(markdown: string, editedAt = Date.now()) {
  return {
    wikiHumanEditedAt: editedAt,
    wikiHumanEditHash: createWikiMarkdownHash(markdown),
  } satisfies Pick<Entity, 'wikiHumanEditedAt' | 'wikiHumanEditHash'>;
}

export function shouldQueueHumanEditReview(entity: Entity, proposedMarkdown: string) {
  if (!hasHumanEditedWiki(entity)) return false;
  const current = entity.wikiMarkdown ?? '';
  if (!current.trim() || !proposedMarkdown.trim()) return false;
  return createWikiMarkdownHash(current) !== createWikiMarkdownHash(proposedMarkdown);
}

export function mergeAiMarkdownWithHumanSuperseded(input: {
  currentMarkdown: string;
  proposedMarkdown: string;
  reason: string;
  source?: string;
  now?: number;
}): HumanEditMergeResult {
  const now = input.now ?? Date.now();
  const current = splitFrontmatter(input.currentMarkdown);
  const proposed = splitFrontmatter(input.proposedMarkdown);
  const currentSections = parseLevelTwoSections(current.body);
  const proposedSections = parseLevelTwoSections(proposed.body);

  if (currentSections.length === 0 || proposedSections.length === 0) {
    const superseded = buildSupersededBlock(current.body, {
      reason: input.reason,
      supersededAt: now,
      source: input.source,
    });
    const markdown = joinMarkdownParts(proposed.frontmatter || current.frontmatter, [
      proposed.body.trim(),
      superseded,
    ]);
    return {
      markdown,
      mode: 'whole-document',
      changed: normalizeActiveMarkdown(markdown) !== normalizeActiveMarkdown(input.currentMarkdown),
    };
  }

  const currentByKey = new Map(currentSections.map((section) => [section.key, section]));
  const proposedKeys = new Set(proposedSections.map((section) => section.key));
  const mergedBlocks: string[] = [];
  const proposedPrefix = bodyPrefixBeforeSections(proposed.body);
  const currentPrefix = bodyPrefixBeforeSections(current.body);

  if (proposedPrefix.trim()) {
    mergedBlocks.push(proposedPrefix.trim());
    if (currentPrefix.trim() && normalizeBlock(currentPrefix) !== normalizeBlock(proposedPrefix)) {
      mergedBlocks.push(buildSupersededBlock(currentPrefix, {
        reason: input.reason,
        supersededAt: now,
        source: input.source,
      }));
    }
  } else if (currentPrefix.trim()) {
    mergedBlocks.push(currentPrefix.trim());
  }

  for (const proposedSection of proposedSections) {
    const currentSection = currentByKey.get(proposedSection.key);
    mergedBlocks.push(proposedSection.raw.trim());
    if (currentSection && normalizeBlock(currentSection.raw) !== normalizeBlock(proposedSection.raw)) {
      mergedBlocks.push(buildSupersededBlock(currentSection.content, {
        reason: input.reason,
        supersededAt: now,
        source: input.source,
      }));
    }
  }

  for (const currentSection of currentSections) {
    if (!proposedKeys.has(currentSection.key)) {
      mergedBlocks.push(currentSection.raw.trim());
    }
  }

  const markdown = joinMarkdownParts(proposed.frontmatter || current.frontmatter, mergedBlocks);
  return {
    markdown,
    mode: 'section',
    changed: normalizeActiveMarkdown(markdown) !== normalizeActiveMarkdown(input.currentMarkdown),
  };
}

function splitFrontmatter(markdown: string): MarkdownParts {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  const match = normalized.match(/^(---\n[\s\S]*?\n---)\n*/);
  if (!match) return { frontmatter: '', body: normalized };
  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length).trim(),
  };
}

function joinMarkdownParts(frontmatter: string, bodyBlocks: string[]) {
  return [frontmatter.trim(), bodyBlocks.map((block) => block.trim()).filter(Boolean).join('\n\n')]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function bodyPrefixBeforeSections(body: string) {
  const index = body.search(/^##\s+/m);
  return index < 0 ? body : body.slice(0, index).trim();
}

function parseLevelTwoSections(body: string): MarkdownSection[] {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  const matches = Array.from(normalized.matchAll(/^##\s+(.+)$/gm));
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? normalized.length : normalized.length;
    const raw = normalized.slice(start, end).trim();
    const firstNewline = raw.indexOf('\n');
    const heading = raw.slice(0, firstNewline < 0 ? raw.length : firstNewline).trim();
    const content = firstNewline < 0 ? '' : raw.slice(firstNewline + 1).trim();
    return {
      key: normalizeHeading(match[1]),
      heading,
      content,
      raw,
    };
  });
}

function normalizeHeading(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
    .trim();
}

function normalizeBlock(value: string) {
  return normalizeActiveMarkdown(value).replace(/\s+/g, ' ');
}
