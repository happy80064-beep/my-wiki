import { db, getClientId } from '@/lib/db';
import type { Entity, Entry, Relationship, RelationshipType, Scene, Task } from '@/types';

export type MarkdownImportRecords = {
  entries: Entry[];
  entities: Entity[];
  relationships: Relationship[];
  tasks: Task[];
};

export type MarkdownFileRecord = {
  path: string;
  content: string;
};

const entityTypes = new Set(['person', 'project', 'event', 'topic']);
const entityFilePathPattern =
  /^wiki\/(?:person|project|event|topic|entities|concepts|projects|queries|comparisons|synthesis|decisions|meetings|stakeholders|methodology|findings|thesis|goals|habits|reflections|journal|books|characters|themes|plot-threads|chapters)\//;
const relationshipTypes = new Set<RelationshipType>([
  'owner',
  'participant',
  'stakeholder',
  'decision-maker',
  'attendee',
  'organizer',
  'mentioned-in',
  'colleague',
  'friend',
  'family',
  'mentor',
  'reports-to',
  'parent-of',
  'depends-on',
  'related-to',
  'about',
  'kicked-off',
  'relevant-to',
  'mentions',
]);

export async function restoreMarkdownExportZip(file: Blob) {
  const records = await parseMarkdownExportZip(file);
  await restoreMarkdownImportRecords(records);
  return records;
}

export async function restoreMarkdownImportRecords(records: MarkdownImportRecords) {
  await db.transaction(
    'rw',
    [
      db.entries,
      db.entities,
      db.relationships,
      db.tasks,
      db.compileSuggestions,
      db.ingestJobs,
      db.ingestCache,
      db.graphInsightDismissals,
      db.rawAssets,
      db.queryCache,
      db.wikiBatchJobs,
    ],
    async () => {
      await Promise.all([
        db.entries.clear(),
        db.entities.clear(),
        db.relationships.clear(),
        db.tasks.clear(),
        db.compileSuggestions.clear(),
        db.ingestJobs.clear(),
        db.ingestCache.clear(),
        db.graphInsightDismissals.clear(),
        db.rawAssets.clear(),
        db.queryCache.clear(),
        db.wikiBatchJobs.clear(),
      ]);
      await db.entries.bulkPut(records.entries);
      await db.entities.bulkPut(records.entities);
      await db.relationships.bulkPut(records.relationships);
      await db.tasks.bulkPut(records.tasks);
    },
  );
}

export async function parseMarkdownExportZip(file: Blob): Promise<MarkdownImportRecords> {
  const files = parseStoredZipArchive(new Uint8Array(await file.arrayBuffer()));
  return parseMarkdownExportFileRecords(files);
}

export function parseMarkdownExportFileRecords(files: MarkdownFileRecord[]): MarkdownImportRecords {
  const byPath = new Map(files.map((item) => [normalizePath(item.path), item.content]));
  const entityFiles = files.filter((item) => entityFilePathPattern.test(normalizePath(item.path)));
  const rawFiles = files.filter((item) => /^raw\/entries\/[^/]+\.md$/.test(normalizePath(item.path)));
  const clientId = getClientId();
  const pathToEntityId = new Map<string, string>();

  for (const item of entityFiles) {
    const { data } = parseFrontmatter(item.content);
    if (typeof data.id === 'string') {
      pathToEntityId.set(stripMd(normalizePath(item.path)), data.id);
    }
  }

  const entries: Entry[] = rawFiles.map((item): Entry => {
    const { data, body } = parseFrontmatter(item.content);
    const id = typeof data.id === 'string' ? data.id : stripMd(normalizePath(item.path)).split('/').pop()!;
    const derivedEntities = parseWikiLinks(section(body, '关联实体'))
      .map((link) => pathToEntityId.get(link.path))
      .filter((id): id is string => Boolean(id));
    return {
      id,
      clientId,
      content: section(body, '原文') || body.trim(),
      source: data.source === 'image' || data.source === 'voice' || data.source === 'file' || data.source === 'paste'
        ? data.source
        : 'text',
      capturedAt: numeric(data.capturedAt) ?? Date.now(),
      processed: data.processed !== false,
      derivedEntities: unique(derivedEntities),
      derivedTasks: [],
      derivedRelationships: [],
    } satisfies Entry;
  });
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  const entities = entityFiles.map((item) => {
    const { data, body } = parseFrontmatter(item.content);
    const type = inferEntityTypeFromWikiFile(item.path, data);
    const createdAt = numeric(data.createdAt) ?? Date.now();
    const sourceEntries = parseWikiLinks(section(body, '来源'))
      .map((link) => link.path.match(/^raw\/entries\/([^/]+)$/)?.[1])
      .filter((id): id is string => Boolean(id && entryById.has(id)));
    return {
      id: typeof data.id === 'string' ? data.id : `${type}_import_${hash(normalizePath(item.path))}`,
      clientId,
      type,
      title: title(body) || stripMd(normalizePath(item.path)).split('/').pop() || 'Untitled',
      summary: summary(body),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      scenes: normalizeScenes(data.scenes),
      properties: parseProperties(type, createdAt, section(body, '属性')),
      sourceEntries: unique(sourceEntries),
      createdAt,
      updatedAt: numeric(data.updatedAt) ?? createdAt,
    } as Entity;
  });
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));

  const relationships: Relationship[] = [];
  const relationshipSeen = new Set<string>();
  for (const item of entityFiles) {
    const { data, body } = parseFrontmatter(item.content);
    const currentId = typeof data.id === 'string' ? data.id : undefined;
    if (!currentId || !entityById.has(currentId)) continue;

    for (const line of section(body, '关系').split(/\r?\n/)) {
      const match = line.match(/^-\s*([→←])\s*([^:：]+)[:：]\s*(.+)$/);
      if (!match) continue;
      const type = relationshipTypes.has(match[2].trim() as RelationshipType)
        ? match[2].trim() as RelationshipType
        : 'related-to';
      const target = parseWikiLinks(match[3])[0];
      const targetId = target ? pathToEntityId.get(target.path) : undefined;
      if (!targetId || !entityById.has(targetId)) continue;
      const from = match[1] === '→' ? currentId : targetId;
      const to = match[1] === '→' ? targetId : currentId;
      const key = `${from}|${to}|${type}`;
      if (relationshipSeen.has(key)) continue;
      relationshipSeen.add(key);

      const fromEntity = entityById.get(from);
      const toEntity = entityById.get(to);
      const evidence = unique([...(fromEntity?.sourceEntries ?? []), ...(toEntity?.sourceEntries ?? [])]).slice(0, 3);
      relationships.push({
        id: `rel_import_${hash(key)}`,
        clientId,
        from,
        to,
        type,
        evidence,
        createdAt: Math.max(fromEntity?.updatedAt ?? Date.now(), toEntity?.updatedAt ?? Date.now()),
      });
    }
  }

  const tasks = parseTasks(byPath.get('tasks/pending-tasks.md') ?? '', pathToEntityId, entityById, entries, clientId);
  for (const relationship of relationships) {
    for (const entryId of relationship.evidence) {
      const entry = entryById.get(entryId);
      if (entry) entry.derivedRelationships = unique([...entry.derivedRelationships, relationship.id]);
    }
  }
  for (const task of tasks) {
    const entry = entryById.get(task.source);
    if (entry) entry.derivedTasks = unique([...entry.derivedTasks, task.id]);
  }

  return { entries, entities, relationships, tasks };
}

function parseStoredZipArchive(bytes: Uint8Array): MarkdownFileRecord[] {
  const decoder = new TextDecoder();
  const files: MarkdownFileRecord[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = readUint32(bytes, offset);
    if (signature !== 0x04034b50) break;
    const flags = readUint16(bytes, offset + 6);
    const method = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const uncompressedSize = readUint32(bytes, offset + 22);
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    if (flags & 0x08) {
      throw new Error('暂不支持带 data descriptor 的 zip 文件，请使用 MyWiki 导出的备份 zip。');
    }
    if (method !== 0) {
      throw new Error('暂不支持压缩过的 zip 文件，请使用 MyWiki 导出的 Markdown 备份。');
    }
    const size = compressedSize || uncompressedSize;
    const data = bytes.slice(dataStart, dataStart + size);
    if (name && !name.endsWith('/')) {
      files.push({ path: name, content: decoder.decode(data) });
    }
    offset = dataStart + size;
  }
  return files;
}

function parseTasks(
  content: string,
  pathToEntityId: Map<string, string>,
  entityById: Map<string, Entity>,
  entries: Entry[],
  clientId: string,
) {
  const fallbackOwner = [...entityById.values()].find((entity) => entity.type === 'person')?.id ?? [...entityById.keys()][0];
  const fallbackSource = entries[0]?.id ?? 'restore_source';
  const tasks: Task[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^-\s*\[( |x)\]\s*(.+)$/);
    if (!match) continue;
    let description = match[2].trim();
    const ownerMatch = description.match(/（负责人：(\[\[[^\]]+\]\])）\s*$/);
    let owner = fallbackOwner;
    if (ownerMatch) {
      const link = parseWikiLinks(ownerMatch[1])[0];
      owner = link ? pathToEntityId.get(link.path) ?? owner : owner;
      description = description.slice(0, ownerMatch.index).trim();
    }
    if (!owner || !description) continue;
    const linkedTo = parseWikiLinks(description).map((link) => pathToEntityId.get(link.path)).filter((id): id is string => Boolean(id));
    const source = entityById.get(owner)?.sourceEntries[0] ?? fallbackSource;
    tasks.push({
      id: `task_import_${hash(`${description}|${owner}`)}`,
      clientId,
      description,
      owner,
      linkedTo: unique(linkedTo),
      status: match[1] === 'x' ? 'done' : 'pending',
      source,
      createdAt: Date.now(),
    });
  }
  return tasks;
}

function inferEntityTypeFromWikiFile(path: string, data: Record<string, unknown>): Entity['type'] {
  const explicitType = String(data.entityType ?? data.entity_type ?? data.kind ?? '');
  if (entityTypes.has(explicitType)) return explicitType as Entity['type'];

  const frontmatterType = String(data.type ?? '');
  if (entityTypes.has(frontmatterType)) return frontmatterType as Entity['type'];

  const normalizedPath = normalizePath(path);
  if (/^wiki\/projects?\//.test(normalizedPath)) return 'project';
  if (/^wiki\/(decisions|meetings|event)\//.test(normalizedPath)) return 'event';
  if (/^wiki\/(stakeholders|person)\//.test(normalizedPath)) return 'person';
  return 'topic';
}

function parseFrontmatter(text: string) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const data: Record<string, unknown> = {};
  if (!match) return { data, body: text };
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    const raw = item[2].trim();
    if (raw === 'true' || raw === 'false') data[item[1]] = raw === 'true';
    else if (/^-?\d+(?:\.\d+)?$/.test(raw)) data[item[1]] = Number(raw);
    else if (raw.startsWith('[')) {
      try {
        data[item[1]] = JSON.parse(raw);
      } catch {
        data[item[1]] = [];
      }
    } else {
      data[item[1]] = raw.replace(/^"|"$/g, '');
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function title(body: string) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function summary(body: string) {
  const titleMatch = body.match(/^#\s+.+$/m);
  if (!titleMatch) return '';
  const afterTitle = body.slice((titleMatch.index ?? 0) + titleMatch[0].length);
  const nextHeading = afterTitle.search(/^##\s+/m);
  return (nextHeading >= 0 ? afterTitle.slice(0, nextHeading) : afterTitle).trim();
}

function section(body: string, heading: string) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm');
  const match = body.match(pattern);
  if (!match) return '';
  const rest = body.slice((match.index ?? 0) + match[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

function parseWikiLinks(text: string) {
  const links: Array<{ path: string; title: string }> = [];
  for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    links.push({ path: normalizePath(match[1]), title: (match[2] ?? match[1]).trim() });
  }
  return links;
}

function parseProperties(type: Entity['type'], createdAt: number, text: string): Entity['properties'] {
  const properties: Record<string, unknown> =
    type === 'project'
      ? { status: 'active' }
      : type === 'event'
        ? { occurredAt: createdAt }
        : type === 'topic'
          ? { isPersonal: false, autoCollectedSnippets: [] }
          : {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^-\s*([^:：]+)[:：]\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    properties[match[1].trim()] = value.includes('、') ? value.split('、').map((item) => item.trim()).filter(Boolean) : value;
  }
  return properties as Entity['properties'];
}

function normalizeScenes(value: unknown): Scene[] {
  const scenes = Array.isArray(value) ? value.map(String) : [];
  const allowed = new Set(['work', 'life', 'social', 'personal']);
  return scenes.filter((scene): scene is Scene => allowed.has(scene));
}

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function stripMd(value: string) {
  return normalizePath(value).replace(/\.md$/i, '');
}

function readUint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function numeric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function hash(value: string) {
  let hashValue = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 0x01000193);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
