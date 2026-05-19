import { db } from '@/lib/db';
import { inferWikiTargetSpec } from '@/lib/wiki/markdownCompiler';
import { buildWikiPageMetadata } from '@/lib/wiki/pageMetadata';
import { normalizeWikiPageType } from '@/lib/wiki/schemaRules';
import type { WikiPageType } from '@/lib/wiki/scanner';
import type { Entity, Entry, Relationship, Task } from '@/types';

export type MarkdownExportFile = {
  path: string;
  content: string;
};

export async function buildMarkdownExportFiles(): Promise<MarkdownExportFile[]> {
  const [entries, entities, relationships, tasks] = await Promise.all([
    db.entries.orderBy('capturedAt').toArray(),
    db.entities.orderBy('updatedAt').toArray(),
    db.relationships.orderBy('createdAt').toArray(),
    db.tasks.orderBy('createdAt').toArray(),
  ]);

  return buildMarkdownExportFilesFromRecords({ entries, entities, relationships, tasks });
}

export function buildMarkdownExportFilesFromRecords({
  entries,
  entities,
  relationships,
  tasks,
}: {
  entries: Entry[];
  entities: Entity[];
  relationships: Relationship[];
  tasks: Task[];
}): MarkdownExportFile[] {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const files: MarkdownExportFile[] = [
    {
      path: 'README.md',
      content: buildReadme({ entries, entities, relationships, tasks }),
    },
    {
      path: 'wiki/index.md',
      content: buildIndex(entities),
    },
    {
      path: 'tasks/pending-tasks.md',
      content: buildTaskIndex(tasks, entityById),
    },
  ];

  for (const entity of entities) {
    files.push({
      path: buildEntityPath(entity),
      content: entity.wikiMarkdown?.trim() || buildEntityMarkdown(entity, relationships, tasks, entityById),
    });
  }

  for (const entry of entries) {
    files.push({
      path: `raw/entries/${safeSegment(entry.id)}.md`,
      content: buildEntryMarkdown(entry, entityById),
    });
  }

  return files.filter((file) => isSafeExportPath(file.path));
}

export function serializeMarkdownExportBundle(files: MarkdownExportFile[]) {
  return files
    .map((file) => [`<!-- FILE: ${file.path} -->`, '', file.content.trim(), ''].join('\n'))
    .join('\n---\n\n');
}

export function buildMarkdownZipBlob(files: MarkdownExportFile[]) {
  return new Blob([buildMarkdownZipArchive(files)], { type: 'application/zip' });
}

export function buildMarkdownZipArchive(files: MarkdownExportFile[], now = new Date()) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;
  const { dosTime, dosDate } = toDosDateTime(now);

  for (const file of files.filter((item) => isSafeExportPath(item.path))) {
    const nameBytes = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const localHeader = new Uint8Array(30 + nameBytes.length + data.length);
    const local = new DataView(localHeader.buffer);

    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0x0800);
    writeUint16(local, 8, 0);
    writeUint16(local, 10, dosTime);
    writeUint16(local, 12, dosDate);
    writeUint32(local, 14, crc);
    writeUint32(local, 18, data.length);
    writeUint32(local, 22, data.length);
    writeUint16(local, 26, nameBytes.length);
    writeUint16(local, 28, 0);
    localHeader.set(nameBytes, 30);
    localHeader.set(data, 30 + nameBytes.length);
    chunks.push(localHeader);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, 0x0800);
    writeUint16(central, 10, 0);
    writeUint16(central, 12, dosTime);
    writeUint16(central, 14, dosDate);
    writeUint32(central, 16, crc);
    writeUint32(central, 20, data.length);
    writeUint32(central, 24, data.length);
    writeUint16(central, 28, nameBytes.length);
    writeUint16(central, 30, 0);
    writeUint16(central, 32, 0);
    writeUint16(central, 34, 0);
    writeUint16(central, 36, 0);
    writeUint32(central, 38, 0);
    writeUint32(central, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length;
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = new Uint8Array(22);
  const end = new DataView(endRecord.buffer);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 4, 0);
  writeUint16(end, 6, 0);
  writeUint16(end, 8, centralDirectory.length);
  writeUint16(end, 10, centralDirectory.length);
  writeUint32(end, 12, centralSize);
  writeUint32(end, 16, centralOffset);
  writeUint16(end, 20, 0);

  return concatUint8Arrays([...chunks, ...centralDirectory, endRecord]);
}

export function isSafeExportPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[a-zA-Z]:\//.test(normalized) &&
    !normalized.split('/').includes('..') &&
    !/[\u0000-\u001f]/.test(normalized)
  );
}

function buildReadme({
  entries,
  entities,
  relationships,
  tasks,
}: {
  entries: Entry[];
  entities: Entity[];
  relationships: Relationship[];
  tasks: Task[];
}) {
  return [
    '# MyWiki Export',
    '',
    '本文件由 MyWiki 本地知识库导出，可用 Obsidian 或任意 Markdown 工具打开。',
    '',
    '## 统计',
    '',
    `- 实体：${entities.length}`,
    `- 关系：${relationships.length}`,
    `- 捕获原文：${entries.length}`,
    `- 任务：${tasks.length}`,
    '',
    '## 入口',
    '',
    '- [[index|知识目录]]',
    '- [[tasks/pending-tasks|任务清单]]',
  ].join('\n');
}

function buildIndex(entities: Entity[]) {
  const grouped = groupBy(entities, (entity) => buildEntityTarget(entity).type);
  const typeOrder: WikiPageType[] = [
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
  ];
  return [
    '# 知识目录',
    '',
    ...typeOrder.flatMap((type) => [
      `## ${wikiTypeLabel(type)}`,
      '',
      ...(grouped.get(type) ?? []).map((entity) => `- [[${withoutMd(buildEntityPath(entity))}|${entity.title}]]`),
      '',
    ]),
  ].join('\n');
}

function buildTaskIndex(tasks: Task[], entityById: Map<string, Entity>) {
  const rows = tasks
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => {
      const owner = entityById.get(task.owner);
      const ownerLink = owner ? `[[${withoutMd(buildEntityPath(owner))}|${owner.title}]]` : task.owner;
      return `- [${task.status === 'done' ? 'x' : ' '}] ${task.description}（负责人：${ownerLink}）`;
    });

  return ['# 任务清单', '', rows.length > 0 ? rows.join('\n') : '暂无任务。'].join('\n');
}

function buildEntityMarkdown(
  entity: Entity,
  relationships: Relationship[],
  tasks: Task[],
  entityById: Map<string, Entity>,
) {
  const relatedRelationships = relationships.filter(
    (relationship) => relationship.from === entity.id || relationship.to === entity.id,
  );
  const relatedTasks = tasks.filter(
    (task) => task.owner === entity.id || task.linkedTo.includes(entity.id),
  );

  return [
    buildFrontmatter({
      id: entity.id,
      type: inferWikiTargetSpec(entity).type,
      mywiki_status: 'structured_only',
      entity_type: entity.type,
      tags: entity.tags,
      scenes: entity.scenes,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      sources: entity.sourceEntries,
    }),
    `# ${entity.title}`,
    '',
    '> 状态：未生成完整 Wiki。以下内容是 MyWiki 根据结构化入库结果生成的档案预览，可在应用内点击“AI 生成/更新”或“批量生成/更新wiki页”生成完整页面。',
    '',
    entity.summary || '暂无摘要。',
    '',
    '## 属性',
    '',
    formatProperties(entity.properties),
    '',
    '## 关系',
    '',
    relatedRelationships.length > 0
      ? relatedRelationships
          .map((relationship) => formatRelationshipLine(entity, relationship, entityById))
          .join('\n')
      : '暂无关系。',
    '',
    '## 任务',
    '',
    relatedTasks.length > 0
      ? relatedTasks.map((task) => `- [${task.status === 'done' ? 'x' : ' '}] ${task.description}`).join('\n')
      : '暂无任务。',
    '',
    '## 来源',
    '',
    entity.sourceEntries.length > 0
      ? entity.sourceEntries.map((entryId) => `- [[raw/entries/${safeSegment(entryId)}|${entryId}]]`).join('\n')
      : '暂无来源。',
    '',
    '## 结构与板块',
    '',
    formatCategories(entity.categories),
    '',
    '## 关键指标',
    '',
    formatIndicators(entity.indicators),
  ].join('\n');
}

function buildEntryMarkdown(entry: Entry, entityById: Map<string, Entity>) {
  return [
    buildFrontmatter({
      id: entry.id,
      type: 'raw-entry',
      source: entry.source,
      capturedAt: entry.capturedAt,
      processed: entry.processed,
    }),
    `# 捕获原文 ${entry.id}`,
    '',
    '## 关联实体',
    '',
    entry.derivedEntities.length > 0
      ? entry.derivedEntities
          .map((entityId) => entityById.get(entityId))
          .filter((entity): entity is Entity => Boolean(entity))
          .map((entity) => `- [[${withoutMd(buildEntityPath(entity))}|${entity.title}]]`)
          .join('\n')
      : '暂无关联实体。',
    '',
    '## 原文',
    '',
    entry.content,
  ].join('\n');
}

function buildFrontmatter(values: Record<string, unknown>) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function formatProperties(properties: unknown) {
  if (!properties || typeof properties !== 'object') return '暂无属性。';
  const entries = Object.entries(properties as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  if (entries.length === 0) return '暂无属性。';

  return entries
    .map(([key, value]) => `- ${key}: ${formatPropertyValue(value)}`)
    .join('\n');
}

function formatCategories(categories: Entity['categories']) {
  if (!categories?.length) return '当前来源未提供明确结构板块。';

  return categories
    .map((category) => {
      const items = category.items.length
        ? category.items
            .map((item) => `  - ${item.title}${item.kind ? `（${item.kind}）` : ''}${item.summary ? `：${item.summary}` : ''}`)
            .join('\n')
        : '  - 当前来源未列出下级条目。';
      return [`- ${category.name}`, items, category.evidence ? `  - 证据：${category.evidence}` : ''].filter(Boolean).join('\n');
    })
    .join('\n');
}

function formatIndicators(indicators: Entity['indicators']) {
  if (!indicators?.length) return '当前来源未提供明确指标。';

  return [
    '| 指标 | 数值 | 维度 | 置信度 | 证据 |',
    '|---|---:|---|---|---|',
    ...indicators.map((indicator) =>
      [
        indicator.name,
        formatIndicatorValue(indicator),
        [indicator.businessLine, indicator.categoryName].filter(Boolean).join(' / ') || '-',
        indicator.confidence,
        indicator.source?.excerpt ?? indicator.note ?? '-',
      ]
        .map(escapeTableCell)
        .join(' | '),
    ).map((row) => `| ${row} |`),
  ].join('\n');
}

function formatIndicatorValue(indicator: NonNullable<Entity['indicators']>[number]) {
  if (indicator.value === null) return indicator.rawValue || '未在当前来源中确认';
  return `${indicator.value}${indicator.unit ? ` ${indicator.unit}` : ''}`;
}

function escapeTableCell(value: unknown) {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function formatPropertyValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatPropertyValue).join('、');
  if (typeof value === 'object' && value) return JSON.stringify(value);
  return String(value);
}

function formatRelationshipLine(
  current: Entity,
  relationship: Relationship,
  entityById: Map<string, Entity>,
) {
  const otherId = relationship.from === current.id ? relationship.to : relationship.from;
  const other = entityById.get(otherId);
  const direction = relationship.from === current.id ? '→' : '←';
  const target = other ? `[[${withoutMd(buildEntityPath(other))}|${other.title}]]` : otherId;
  return `- ${direction} ${relationship.type}: ${target}`;
}

function buildEntityPath(entity: Entity) {
  return buildEntityTarget(entity).path;
}

function buildEntityTarget(entity: Entity) {
  if (!entity.wikiMarkdown?.trim()) return inferWikiTargetSpec(entity);
  const metadata = buildWikiPageMetadata(entity.wikiMarkdown, entity);
  return inferWikiTargetSpec(entity, { preferredType: normalizeWikiPageType(metadata.type) });
}

function withoutMd(path: string) {
  return path.replace(/\.md$/, '');
}

function safeSegment(value: string) {
  const cleaned = value
    .trim()
    .replace(/[\\/?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 96);
  return cleaned || 'untitled';
}

function wikiTypeLabel(type: string) {
  const labels: Record<string, string> = {
    overview: '总览',
    project: '项目',
    entity: '实体',
    concept: '概念',
    source: '来源',
    query: '查询',
    synthesis: '综合',
    comparison: '对比',
    decision: '决策',
    meeting: '会议',
    stakeholder: '干系人',
    thesis: '论点',
    finding: '发现',
    methodology: '方法',
    book: '书籍',
    character: '人物',
    theme: '主题',
    'plot-thread': '情节线',
    chapter: '章节',
    goal: '目标',
    habit: '习惯',
    reflection: '复盘',
    journal: '日记',
  };
  return labels[type] ?? type;
}

function groupBy<T, TKey>(items: T[], getKey: (item: T) => TKey) {
  const grouped = new Map<TKey, T[]>();
  for (const item of items) {
    const key = getKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function toDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}
