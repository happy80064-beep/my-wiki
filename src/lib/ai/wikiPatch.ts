import type { EntityType, RelationshipType, Scene, TaskStatus } from '../../types';
import type { CaptureDraft, DraftEntity } from '../capture/draft';
import { createDraftId } from '../capture/draft';

export type WikiPatchType =
  | 'CREATE_ENTITY'
  | 'UPDATE_ENTITY_PROPERTY'
  | 'CREATE_RELATIONSHIP'
  | 'CREATE_TASK'
  | 'REVIEW_REQUIRED';

export type CaptureAnalysis = {
  entities: Array<{
    title: string;
    type: EntityType;
    aliases?: string[];
    evidence: string;
    existsLikely?: boolean;
  }>;
  concepts: Array<{
    title: string;
    evidence: string;
  }>;
  claims: Array<{
    subject: string;
    predicate: string;
    object: string;
    evidence: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  contradictions: Array<{
    title: string;
    evidence: string;
  }>;
  recommendedUpdates: Array<{
    targetTitle: string;
    action: WikiPatchType;
    reason: string;
  }>;
};

export type WikiPatch =
  | {
      type: 'CREATE_ENTITY';
      title: string;
      entityType: EntityType;
      summary: string;
      tags: string[];
      scenes: Scene[];
      evidence: string;
    }
  | {
      type: 'UPDATE_ENTITY_PROPERTY';
      entityTitle: string;
      propertyKey: string;
      propertyValue: string;
      evidence: string;
      confidence: number;
    }
  | {
      type: 'CREATE_RELATIONSHIP';
      fromTitle: string;
      toTitle: string;
      relationshipType: RelationshipType;
      evidence: string;
      confidence: number;
    }
  | {
      type: 'CREATE_TASK';
      description: string;
      ownerTitle: string;
      linkedToTitles: string[];
      dueDate?: string;
      status: TaskStatus;
      evidence: string;
    }
  | {
      type: 'REVIEW_REQUIRED';
      title: string;
      reason: string;
      evidence: string;
      options: Array<'Create Page' | 'Update Existing' | 'Skip'>;
    };

export const allowedWikiPatchPropertyKeys = [
  'runtimeEnvironment',
  'wakeWord',
  'stopWord',
  'localPath',
  'models',
  'ownerNote',
  'derivedFrom',
  'openSourceStatus',
] as const;

export function shouldUseCaptureDigest(content: string, threshold = 3000) {
  return content.trim().length > threshold;
}

export function splitCaptureContentIntoChunks(content: string, maxChars = 5000, maxChunks = 6) {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length > maxChars) {
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      current = '';
    } else {
      current = paragraph;
    }
  }

  if (current) chunks.push(current);
  return selectRepresentativeChunks(chunks, maxChunks);
}

export function buildCaptureDigestPrompt(content: string, chunkIndex = 1, totalChunks = 1) {
  return `你是 MyWiki 的长文档阅读 Agent。请把下面这段原始材料整理成 Markdown 阅读摘要，先不要输出 JSON。

材料分块：${chunkIndex}/${totalChunks}

原始材料：
${content}

请输出 Markdown，包含这些小节：

## 这段材料讲什么
用 2-4 句话概括。

## 关键实体
- 实体名：类型（person/project/event/topic），证据短句

## 关键事实
- 主体｜属性/关系｜值｜证据短句

## 任务与行动项
- 任务：负责人（不确定则写“我”），关联事项，证据短句

## 需要回写 Wiki 的建议
- 建议创建/更新的实体、属性、关系或任务

规则：
- 只根据材料，不要补充外部知识。
- 保留原文中的专名、日期、路径、模型名、项目名。
- 不要输出 JSON，不要输出代码块。`;
}

export function buildCaptureAnalysisPrompt(content: string, entityIndexJson: string) {
  return `你是 MyWiki 的摄入分析 Agent。你只负责理解材料，不负责写入数据库。

原始材料：
${content}

当前 Wiki 目录：
${entityIndexJson}

请输出 JSON，字段为：
{
  "entities": [{"title": "", "type": "person|project|event|topic", "aliases": [], "evidence": "", "existsLikely": false}],
  "concepts": [{"title": "", "evidence": ""}],
  "claims": [{"subject": "", "predicate": "", "object": "", "evidence": "", "confidence": "high|medium|low"}],
  "contradictions": [{"title": "", "evidence": ""}],
  "recommendedUpdates": [{"targetTitle": "", "action": "CREATE_ENTITY|UPDATE_ENTITY_PROPERTY|CREATE_RELATIONSHIP|CREATE_TASK|REVIEW_REQUIRED", "reason": ""}]
}

规则：
- 只提取材料中有证据的内容。
- entities 必须对照当前 Wiki 目录判断 existsLikely；名称相近、别名相近、摘要相近都应视为可能已存在。
- concepts 用来记录重要概念、方法、技术路线或主题，不要把所有普通名词都列进去。
- claims 必须是可写入 Wiki 的事实属性或关系事实，例如 runtimeEnvironment、wakeWord、stopWord、localPath、models、ownerNote、derivedFrom、openSourceStatus。
- 每条 claim 的 evidence 必须是原文中能支撑 subject / predicate / object 的短片段，不要只给关键词。
- contradictions 只放真正冲突或张力，不要把普通不确定都放进去。
- recommendedUpdates 要明确建议创建或更新哪些实体、关系、任务或待审核项。
- 不确定、冲突或需要用户判断的内容放入 contradictions 或 recommendedUpdates。
- 如果材料暗示需要后续深度研究，可在 recommendedUpdates.reason 中写出 2-3 个搜索关键词。
- 不要生成数据库 ID，不要输出 markdown。`;
}

export function buildWikiPatchPrompt(content: string, analysis: CaptureAnalysis) {
  return `你是 MyWiki 的 WikiPatch 生成 Agent。你根据已完成的分析，生成可被代码校验的结构化 patch。

原始材料：
${content}

分析结果：
${JSON.stringify(analysis, null, 2)}

请只输出 JSON 对象，格式为：
{
  "patches": []
}

patches 中每一项必须符合以下 patch 类型之一：
- CREATE_ENTITY
- UPDATE_ENTITY_PROPERTY
- CREATE_RELATIONSHIP
- CREATE_TASK
- REVIEW_REQUIRED

约束：
- UPDATE_ENTITY_PROPERTY.propertyKey 只能使用：${allowedWikiPatchPropertyKeys.join(', ')}
- REVIEW_REQUIRED.options 只能从 Create Page / Update Existing / Skip 中选择。
- 每个 patch 都必须带 evidence，evidence 必须是原文中的短证据片段。
- CREATE_ENTITY 只在分析认为实体不存在或值得新建时使用；可能已存在的实体优先 UPDATE_ENTITY_PROPERTY、CREATE_RELATIONSHIP 或 REVIEW_REQUIRED。
- UPDATE_ENTITY_PROPERTY 的 propertyValue 必须是完整值，不要用“开源”“方案”“模型”等泛词代替具体对象；例如“OpenMaic 开源项目”“小林”“Windows”。
- CREATE_RELATIONSHIP 必须同时有 fromTitle、toTitle、relationshipType 和能证明二者关系的 evidence。
- REVIEW_REQUIRED 只用于冲突、疑似重复、重要但缺页、需要用户判断的内容；不要创建琐碎 review。
- 如果 REVIEW_REQUIRED 是 suggestion 或 missing-page 类问题，reason 中应包含可用于后续搜索的关键词。
- 如果没有足够证据，不要生成 patch；宁可 REVIEW_REQUIRED。
- 不要输出 markdown，不要输出解释。`;
}

export function normalizeCaptureAnalysis(rawText: string): CaptureAnalysis {
  const parsed = parseBestJson(rawText) as Partial<CaptureAnalysis>;
  return {
    entities: toArray<Record<string, unknown>>(parsed.entities)
      .map((entity) => ({
        title: stringValue(entity.title),
        type: pickEnum(entity.type, entityTypes, 'topic'),
        aliases: toArray(entity.aliases).map((alias) => String(alias).trim()).filter(Boolean),
        evidence: stringValue(entity.evidence),
        existsLikely: Boolean(entity.existsLikely),
      }))
      .filter((entity) => entity.title && entity.evidence),
    concepts: toArray<Record<string, unknown>>(parsed.concepts)
      .map((concept) => ({
        title: stringValue(concept.title),
        evidence: stringValue(concept.evidence),
      }))
      .filter((concept) => concept.title && concept.evidence),
    claims: toArray<Record<string, unknown>>(parsed.claims)
      .map((claim) => ({
        subject: stringValue(claim.subject),
        predicate: stringValue(claim.predicate),
        object: stringValue(claim.object),
        evidence: stringValue(claim.evidence),
        confidence: pickEnum(claim.confidence, confidenceLevels, 'medium'),
      }))
      .filter((claim) => claim.subject && claim.predicate && claim.object && claim.evidence),
    contradictions: toArray<Record<string, unknown>>(parsed.contradictions)
      .map((item) => ({
        title: stringValue(item.title),
        evidence: stringValue(item.evidence),
      }))
      .filter((item) => item.title && item.evidence),
    recommendedUpdates: toArray<Record<string, unknown>>(parsed.recommendedUpdates)
      .map((item) => ({
        targetTitle: stringValue(item.targetTitle),
        action: pickEnum(item.action, wikiPatchTypes, 'REVIEW_REQUIRED'),
        reason: stringValue(item.reason),
      }))
      .filter((item) => item.targetTitle && item.reason),
  };
}

export function normalizeWikiPatchResponse(rawText: string): WikiPatch[] {
  const parsed = parseBestJson(rawText) as { patches?: unknown } | unknown[];
  const rawPatches = Array.isArray(parsed) ? parsed : toArray((parsed as { patches?: unknown }).patches);
  return rawPatches.map(normalizeWikiPatch).filter((patch): patch is WikiPatch => Boolean(patch && validateWikiPatch(patch)));
}

export function normalizeWikiPatchesToCaptureDraft(patches: WikiPatch[], content: string): CaptureDraft {
  const entityByTitle = new Map<string, DraftEntity>();

  const ensureEntity = (title: string, fallbackType: EntityType = 'topic', summary?: string) => {
    const key = normalizeTitle(title);
    const existing = entityByTitle.get(key);
    if (existing) return existing;

    const entity: DraftEntity = {
      clientId: createDraftId('entity'),
      type: fallbackType,
      title: title.trim(),
      summary: summary?.trim() || `${title.trim()} 相关记录。`,
      tags: [],
      scenes: ['work'],
    };
    entityByTitle.set(key, entity);
    return entity;
  };

  for (const patch of patches) {
    if (patch.type === 'CREATE_ENTITY') {
      const entity = ensureEntity(patch.title, patch.entityType, patch.summary);
      entity.tags = patch.tags;
      entity.scenes = patch.scenes.length > 0 ? patch.scenes : entity.scenes;
    }
    if (patch.type === 'UPDATE_ENTITY_PROPERTY') {
      ensureEntity(patch.entityTitle, inferEntityTypeFromPropertyPatch(patch), patch.evidence);
    }
    if (patch.type === 'CREATE_RELATIONSHIP') {
      ensureEntity(patch.fromTitle);
      ensureEntity(patch.toTitle);
    }
    if (patch.type === 'CREATE_TASK') {
      ensureEntity(patch.ownerTitle, 'person');
      for (const title of patch.linkedToTitles) ensureEntity(title);
    }
  }

  if (entityByTitle.size === 0) {
    ensureEntity(content.slice(0, 24) || '未命名主题', 'topic', content.slice(0, 120));
  }

  const entities = Array.from(entityByTitle.values());
  const primaryEntity = entities[0];
  const relatedEntities = entities.slice(1);

  const relationships = patches
    .filter((patch): patch is Extract<WikiPatch, { type: 'CREATE_RELATIONSHIP' }> => patch.type === 'CREATE_RELATIONSHIP')
    .map((patch) => {
      const from = entityByTitle.get(normalizeTitle(patch.fromTitle));
      const to = entityByTitle.get(normalizeTitle(patch.toTitle));
      if (!from || !to) return undefined;
      return {
        clientId: createDraftId('rel'),
        fromClientId: from.clientId,
        toClientId: to.clientId,
        type: patch.relationshipType,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const tasks = patches
    .filter((patch): patch is Extract<WikiPatch, { type: 'CREATE_TASK' }> => patch.type === 'CREATE_TASK')
    .map((patch) => {
      const owner = entityByTitle.get(normalizeTitle(patch.ownerTitle));
      if (!owner) return undefined;
      return {
        clientId: createDraftId('task'),
        description: patch.description,
        ownerClientId: owner.clientId,
        linkedToClientIds: patch.linkedToTitles
          .map((title) => entityByTitle.get(normalizeTitle(title))?.clientId)
          .filter((id): id is string => Boolean(id)),
        dueDate: patch.dueDate,
        status: patch.status,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const compileSuggestions = patches
    .filter((patch): patch is Extract<WikiPatch, { type: 'UPDATE_ENTITY_PROPERTY' }> => patch.type === 'UPDATE_ENTITY_PROPERTY')
    .map((patch) => {
      const entity = entityByTitle.get(normalizeTitle(patch.entityTitle));
      if (!entity) return undefined;
      return {
        clientId: createDraftId('compile'),
        entityClientId: entity.clientId,
        entityTitle: entity.title,
        propertyKey: patch.propertyKey,
        propertyLabel: propertyLabel(patch.propertyKey),
        propertyValue: patch.propertyValue,
        evidenceSnippet: patch.evidence,
        confidence: patch.confidence,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return { primaryEntity, relatedEntities, relationships, tasks, compileSuggestions };
}

export function validateWikiPatch(patch: WikiPatch) {
  if (!patch.type || !('evidence' in patch) || !patch.evidence.trim()) return false;

  if (patch.type === 'UPDATE_ENTITY_PROPERTY') {
    return allowedWikiPatchPropertyKeys.includes(
      patch.propertyKey as (typeof allowedWikiPatchPropertyKeys)[number],
    );
  }

  if (patch.type === 'REVIEW_REQUIRED') {
    return patch.options.every((option) => ['Create Page', 'Update Existing', 'Skip'].includes(option));
  }

  return true;
}

function normalizeWikiPatch(value: unknown): WikiPatch | undefined {
  const raw = value as Record<string, unknown>;
  const type = pickEnum(raw.type, wikiPatchTypes, undefined);
  if (!type) return undefined;

  if (type === 'CREATE_ENTITY') {
    return {
      type,
      title: stringValue(raw.title),
      entityType: pickEnum(raw.entityType ?? raw.typeName, entityTypes, 'topic'),
      summary: stringValue(raw.summary),
      tags: toArray(raw.tags).map((tag) => String(tag).trim()).filter(Boolean),
      scenes: toArray(raw.scenes).map((scene) => pickEnum(scene, scenes, undefined)).filter((scene): scene is Scene => Boolean(scene)),
      evidence: stringValue(raw.evidence),
    };
  }

  if (type === 'UPDATE_ENTITY_PROPERTY') {
    return {
      type,
      entityTitle: stringValue(raw.entityTitle),
      propertyKey: stringValue(raw.propertyKey),
      propertyValue: stringValue(raw.propertyValue),
      evidence: stringValue(raw.evidence),
      confidence: clamp(Number(raw.confidence) || 0.65, 0, 1),
    };
  }

  if (type === 'CREATE_RELATIONSHIP') {
    return {
      type,
      fromTitle: stringValue(raw.fromTitle),
      toTitle: stringValue(raw.toTitle),
      relationshipType: pickEnum(raw.relationshipType, relationshipTypes, 'related-to'),
      evidence: stringValue(raw.evidence),
      confidence: clamp(Number(raw.confidence) || 0.65, 0, 1),
    };
  }

  if (type === 'CREATE_TASK') {
    return {
      type,
      description: stringValue(raw.description),
      ownerTitle: stringValue(raw.ownerTitle) || '我',
      linkedToTitles: toArray(raw.linkedToTitles).map((title) => String(title).trim()).filter(Boolean),
      dueDate: typeof raw.dueDate === 'string' ? raw.dueDate : undefined,
      status: pickEnum(raw.status, taskStatuses, 'pending'),
      evidence: stringValue(raw.evidence),
    };
  }

  return {
    type,
    title: stringValue(raw.title),
    reason: stringValue(raw.reason),
    evidence: stringValue(raw.evidence),
    options: toArray(raw.options).filter((option): option is 'Create Page' | 'Update Existing' | 'Skip' =>
      ['Create Page', 'Update Existing', 'Skip'].includes(String(option)),
    ),
  };
}

function inferEntityTypeFromPropertyPatch(patch: Extract<WikiPatch, { type: 'UPDATE_ENTITY_PROPERTY' }>): EntityType {
  if (['wakeWord', 'stopWord', 'runtimeEnvironment', 'localPath', 'derivedFrom'].includes(patch.propertyKey)) {
    return 'project';
  }
  return 'topic';
}

function propertyLabel(propertyKey: string) {
  const labels: Record<string, string> = {
    runtimeEnvironment: '运行环境',
    wakeWord: '唤醒词',
    stopWord: '终止词',
    localPath: '本地路径',
    models: '相关模型',
    ownerNote: '负责人说明',
    derivedFrom: '来源/基于项目',
    openSourceStatus: '开源状态',
  };
  return labels[propertyKey] ?? propertyKey;
}

function parseBestJson(text: string) {
  const withoutFence = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('LLM did not return a JSON object.');
  }
  return JSON.parse(withoutFence.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')) as unknown;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function toArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickEnum<T extends string, TFallback extends T | undefined>(
  value: unknown,
  values: readonly T[],
  fallback: TFallback,
) {
  return values.includes(value as T) ? (value as T) : fallback;
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '').trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function selectRepresentativeChunks(chunks: string[], maxChunks: number) {
  if (chunks.length <= maxChunks) return chunks;

  const selectedIndexes = new Set<number>();
  selectedIndexes.add(0);
  selectedIndexes.add(chunks.length - 1);

  const scored = chunks
    .map((chunk, index) => ({
      index,
      score: /(摘要|结论|总结|建议|问题|风险|任务|行动|计划|路线|优先级|目标|项目|下一阶段|待办|TODO|todo)/i.test(chunk)
        ? 2
        : 0,
    }))
    .sort((left, right) => right.score - left.score);

  for (const item of scored) {
    if (selectedIndexes.size >= maxChunks) break;
    selectedIndexes.add(item.index);
  }

  return [...selectedIndexes].sort((left, right) => left - right).map((index) => chunks[index]);
}

const entityTypes = ['person', 'project', 'event', 'topic'] as const;
const scenes = ['work', 'life', 'social', 'personal'] as const;
const confidenceLevels = ['high', 'medium', 'low'] as const;
const wikiPatchTypes: WikiPatchType[] = [
  'CREATE_ENTITY',
  'UPDATE_ENTITY_PROPERTY',
  'CREATE_RELATIONSHIP',
  'CREATE_TASK',
  'REVIEW_REQUIRED',
];
const relationshipTypes: RelationshipType[] = [
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
];
const taskStatuses: TaskStatus[] = ['pending', 'done', 'overdue', 'cancelled'];
