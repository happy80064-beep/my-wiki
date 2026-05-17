import type { Entity } from '@/types';
import { parseMarkdownFrontmatter, stringifyMarkdownFrontmatter, type FrontmatterData, type FrontmatterValue } from './frontmatter';
import { sanitizeWikiMarkdownOutput } from './markdownCompiler';
import { normalizeWikiReferenceValue } from './references';

export type WikiPageMetadata = {
  title: string;
  type: string;
  tags: string[];
  aliases: string[];
  sources: string[];
  related: string[];
  created?: string;
  updated?: string;
  description?: string;
  body: string;
  extras: Array<{ key: string; value: string }>;
};

const topLevelKeys = new Set(['title', 'type', 'tags', 'aliases', 'created', 'updated', 'description', 'sources', 'related', 'origin']);

export function buildWikiPageMetadata(markdown: string, fallback: Pick<Entity, 'title' | 'type' | 'tags'>): WikiPageMetadata {
  const cleaned = sanitizeWikiMarkdownOutput(markdown);
  const parsed = parseMarkdownFrontmatter(cleaned);
  const effectiveParsed = parsed.raw ? parsed : parseLooseFrontmatterBlock(cleaned) ?? parsed;
  const sanitizedBody = stripLeadingFrontmatterLikeBlocks(effectiveParsed.body).trim();
  const fallbackSummary = 'summary' in fallback && typeof fallback.summary === 'string' ? fallback.summary : '';
  return {
    title: stringValue(effectiveParsed.data.title) || fallback.title,
    type: stringValue(effectiveParsed.data.type) || fallback.type,
    tags: stringArray(effectiveParsed.data.tags, fallback.tags),
    aliases: stringArray(effectiveParsed.data.aliases),
    sources: stringArray(effectiveParsed.data.sources),
    related: stringArray(effectiveParsed.data.related).map(normalizeWikiReferenceValue).filter(Boolean),
    created: stringValue(effectiveParsed.data.created) || undefined,
    updated: stringValue(effectiveParsed.data.updated) || undefined,
    description: normalizeWikiDescription(stringValue(effectiveParsed.data.description), sanitizedBody, fallbackSummary),
    body: sanitizedBody,
    extras: buildExtras(effectiveParsed.data),
  };
}

export function normalizeWikiDescription(description: string, body: string, fallbackSummary = '') {
  const trimmed = description.trim();
  if (trimmed && !isSuspiciousWikiDescription(trimmed)) {
    return trimmed;
  }

  const bodySummary = buildBodySummary(body);
  if (bodySummary && !isSuspiciousWikiDescription(bodySummary)) {
    return bodySummary;
  }

  const fallback = fallbackSummary.trim();
  if (fallback && !isSuspiciousWikiDescription(fallback)) {
    return fallback;
  }

  return undefined;
}

export function isSuspiciousWikiDescription(value: string) {
  const text = value.trim();
  if (!text) return false;
  if (text.length > 240) return true;
  if (/(<think>|<\/think>|---FILE:|---END FILE---|MiniMax failed|DeepSeek fallback failed|fetch failed|Wiki compiler)/i.test(text)) {
    return true;
  }
  if (/(\[\[.+?\]\]|```|^##\s|^#\s)/m.test(text)) return true;
  if ((text.match(/\b(?:type|title|created|updated|tags|sources|related):/g) ?? []).length >= 3) return true;
  if ((text.match(/[{}<>]/g) ?? []).length >= 4) return true;
  if ((text.match(/[?#]{3,}|={3,}|-{4,}/g) ?? []).length >= 1) return true;
  return false;
}

export function repairWikiMarkdownDescription(
  markdown: string,
  fallback: Pick<Entity, 'title' | 'type' | 'tags'> & Partial<Pick<Entity, 'summary'>>,
) {
  const cleaned = sanitizeWikiMarkdownOutput(markdown).trim();
  const parsed = parseMarkdownFrontmatter(cleaned);
  const effectiveParsed = parsed.raw ? parsed : parseLooseFrontmatterBlock(cleaned);
  if (!effectiveParsed?.raw) return null;

  const originalDescription = stringValue(effectiveParsed.data.description);
  const sanitizedBody = stripLeadingFrontmatterLikeBlocks(effectiveParsed.body).trim();
  const nextDescription = normalizeWikiDescription(originalDescription, sanitizedBody, fallback.summary ?? '');
  const sanitizedDescription = nextDescription?.trim() || undefined;
  const originalSanitized = originalDescription.trim() || undefined;

  const nextData: FrontmatterData = { ...effectiveParsed.data };
  if (!stringValue(nextData.type)) nextData.type = fallback.type;
  if (!stringValue(nextData.title)) nextData.title = fallback.title;
  if (!stringArray(nextData.tags).length && fallback.tags.length) nextData.tags = fallback.tags;
  if (sanitizedDescription) {
    nextData.description = sanitizedDescription;
  } else {
    delete nextData.description;
  }

  const nextMarkdown = `${stringifyMarkdownFrontmatter(nextData)}\n\n${sanitizedBody}`.trim();
  const changed = cleaned !== nextMarkdown || originalSanitized !== sanitizedDescription;
  if (!changed) return null;

  return {
    markdown: nextMarkdown,
    description: sanitizedDescription,
  };
}

function buildExtras(data: FrontmatterData) {
  return Object.entries(data)
    .filter(([key, value]) => !topLevelKeys.has(key) && !isEmptyValue(value))
    .map(([key, value]) => ({ key, value: valueToDisplay(value) }));
}

function stringValue(value: FrontmatterValue | undefined) {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: FrontmatterValue | undefined, fallback: string[] = []) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function valueToDisplay(value: FrontmatterValue) {
  if (Array.isArray(value)) return value.map(String).join(', ');
  return value === null ? 'null' : String(value);
}

function isEmptyValue(value: FrontmatterValue) {
  if (Array.isArray(value)) return value.length === 0;
  return value === '' || value === null;
}

function buildBodySummary(body: string) {
  return stripLeadingFrontmatterLikeBlocks(body)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|') && !/^[-*]\s*$/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .join(' ')
    .slice(0, 180)
    .trim();
}

function stripLeadingFrontmatterLikeBlocks(body: string) {
  let current = body.replace(/^\uFEFF/, '').replace(/\r/g, '\n').trimStart();

  while (true) {
    const next = stripSingleLeadingFrontmatterLikeBlock(current);
    if (next === current) return current;
    current = next.trimStart();
  }
}

function stripSingleLeadingFrontmatterLikeBlock(body: string) {
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r/g, '\n').trimStart();
  const closedBlock = normalized.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (closedBlock) {
    return normalized.slice(closedBlock[0].length).trimStart();
  }

  const lines = normalized.split('\n');
  const firstLine = lines[0]?.trim() ?? '';

  if (firstLine.startsWith('---') && countFrontmatterKeys(firstLine) >= 3) {
    const suffix = firstLine.slice(3).trim();
    const remainder = suffix ? [suffix, ...lines.slice(1)] : lines.slice(1);
    return remainder.join('\n').trimStart();
  }

  if (lines[0]?.trim() === '---') {
    let index = 1;
    let yamlLikeLines = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line) {
        index += 1;
        continue;
      }
      if (line === '---') {
        return lines.slice(index + 1).join('\n').trimStart();
      }
      if (line.startsWith('---')) {
        const suffix = line.slice(3).trim();
        return [suffix, ...lines.slice(index + 1)].join('\n').trimStart();
      }
      if (/^#\s+/.test(line)) {
        return lines.slice(index).join('\n').trimStart();
      }
      if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
        yamlLikeLines += 1;
        index += 1;
        continue;
      }
      if (countFrontmatterKeys(line) >= 2) {
        yamlLikeLines += countFrontmatterKeys(line);
        index += 1;
        continue;
      }
      if (/^-\s+/.test(line) || /^\[[^\]]*\]$/.test(line)) {
        index += 1;
        continue;
      }
      break;
    }

    if (yamlLikeLines >= 3) {
      return lines.slice(index).join('\n').trimStart();
    }
  }

  if (/^(?:type|title|created|updated|tags|sources|related):\s*/m.test(normalized)) {
    const firstHeading = normalized.search(/^#\s+/m);
    if (firstHeading >= 0) {
      return normalized.slice(firstHeading).trimStart();
    }
  }

  if (countFrontmatterKeys(firstLine) >= 3) {
    return lines.slice(1).join('\n').trimStart();
  }

  return normalized;
}

function parseLooseFrontmatterBlock(markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r/g, '\n').trimStart();
  if (!normalized.startsWith('---')) return null;

  const lines = normalized.split('\n');
  const opener = lines[0].trim();
  if (!opener.startsWith('---')) return null;

  const frontmatterLines: string[] = [];
  let yamlLikeLines = 0;
  let index = 1;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      frontmatterLines.push(line);
      index += 1;
      continue;
    }

    if (trimmed === '---') {
      const reparsed = parseMarkdownFrontmatter(['---', ...frontmatterLines, '---', ...lines.slice(index + 1)].join('\n'));
      return reparsed.raw ? reparsed : null;
    }

    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) {
      frontmatterLines.push(trimmed);
      yamlLikeLines += 1;
      index += 1;
      continue;
    }

    if (/^-\s+/.test(trimmed) || /^\[[^\]]*\]$/.test(trimmed)) {
      frontmatterLines.push(trimmed);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('---')) {
      const suffix = trimmed.slice(3).trim();
      const bodyLines = suffix ? [suffix, ...lines.slice(index + 1)] : lines.slice(index + 1);
      const reparsed = parseMarkdownFrontmatter(['---', ...frontmatterLines, '---', ...bodyLines].join('\n'));
      return reparsed.raw ? reparsed : null;
    }

    if (yamlLikeLines >= 3) {
      const reparsed = parseMarkdownFrontmatter(['---', ...frontmatterLines, '---', ...lines.slice(index)].join('\n'));
      return reparsed.raw ? reparsed : null;
    }

    break;
  }

  if (yamlLikeLines >= 3) {
    const reparsed = parseMarkdownFrontmatter(['---', ...frontmatterLines, '---'].join('\n'));
    return reparsed.raw ? reparsed : null;
  }

  return null;
}

function countFrontmatterKeys(text: string) {
  return (text.match(/\b(?:type|title|created|updated|tags|sources|related|description|origin):/g) ?? []).length;
}
