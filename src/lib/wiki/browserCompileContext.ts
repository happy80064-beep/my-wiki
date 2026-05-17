import { getProjectTemplate } from '@/lib/workspace/projectTemplates';
import type { Entity, Entry, Relationship } from '@/types';
import type { WikiCompileContextMap } from './markdownCompiler';
import { inferWikiTargetSpecFromSchema, parseWikiSchemaPageTypes } from './schemaRules';
import type { WikiPageType } from './scanner';

export function buildBrowserWikiCompileContext({
  entities,
  entries,
  relationships,
  workspaceContext,
}: {
  entities: Entity[];
  entries: Entry[];
  relationships: Relationship[];
  workspaceContext?: Pick<WikiCompileContextMap, 'purpose' | 'schema'>;
}): WikiCompileContextMap {
  const template = getProjectTemplate('general');
  const schema = workspaceContext?.schema?.trim() || template.schema;
  const purpose = workspaceContext?.purpose?.trim() || template.purpose;

  return {
    purpose: [
      purpose,
      '',
      '## Runtime note',
      'This browser-indexed knowledge base should follow schema.md as the source of truth for page type, directory, frontmatter, source traceability, and cross-reference rules.',
    ].join('\n'),
    schema,
    index: buildBrowserRuntimeIndex(entities, schema),
    overview: buildBrowserRuntimeOverview(entities, entries, relationships, schema),
    log: buildBrowserRuntimeLog(entries),
  };
}

function buildBrowserRuntimeIndex(entities: Entity[], schema: string) {
  const grouped = new Map<WikiPageType, string[]>();
  for (const entity of entities) {
    const target = inferWikiTargetSpecFromSchema(entity, { schema });
    const summary = entity.summary.trim() ? ` — ${oneLine(entity.summary, 110)}` : '';
    grouped.set(target.type, [...(grouped.get(target.type) ?? []), `- [[${target.path.replace(/^wiki\//, '').replace(/\.md$/i, '')}|${entity.title}]]${summary}`]);
  }

  const preferredOrder = parseWikiSchemaPageTypes(schema).map((rule) => rule.type);
  const orderedTypes = [...preferredOrder, ...[...grouped.keys()].filter((type) => !preferredOrder.includes(type))];
  const sections = orderedTypes
    .filter((type) => grouped.has(type))
    .flatMap((type) => [`## ${type}`, '', ...(grouped.get(type) ?? []), '']);

  return ['# Wiki Index', '', ...sections].join('\n').trim();
}

function buildBrowserRuntimeOverview(entities: Entity[], entries: Entry[], relationships: Relationship[], schema: string) {
  const grouped = new Map<string, number>();
  for (const entity of entities) {
    const target = inferWikiTargetSpecFromSchema(entity, { schema });
    grouped.set(target.type, (grouped.get(target.type) ?? 0) + 1);
  }

  const typeSummary = [...grouped.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  const topPages = entities
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 12)
    .map((entity) => `- ${entity.title}: ${oneLine(entity.summary, 140) || 'No summary yet.'}`)
    .join('\n');

  return [
    '# Runtime Overview',
    '',
    `The current IndexedDB wiki has ${entities.length} pages, ${entries.length} source entries, and ${relationships.length} relationships.`,
    typeSummary ? `Page type distribution: ${typeSummary}.` : '',
    '',
    '## Recently Updated Pages',
    topPages || 'No wiki pages yet.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildBrowserRuntimeLog(entries: Entry[]) {
  const recent = entries
    .slice()
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .slice(0, 8)
    .map((entry) => {
      const date = new Date(entry.capturedAt).toISOString().slice(0, 10);
      const title = entry.fileMetadata?.filename ?? oneLine(entry.content, 60) ?? entry.id;
      return `- ${date}: captured ${title}`;
    });

  return ['# Runtime Log', '', `## ${new Date().toISOString().slice(0, 10)}`, '', ...(recent.length ? recent : ['- No recent captures.'])].join('\n');
}

function oneLine(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
