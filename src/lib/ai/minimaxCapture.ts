import type { EntityType, RelationshipType, Scene, TaskStatus } from '../../types';
import type { CaptureDraft, DraftEntity } from '../capture/draft';
import { createDraftId } from '../capture/draft';

const entityTypes = ['person', 'project', 'event', 'topic'] as const;
const scenes = ['work', 'life', 'social', 'personal'] as const;
const relationshipTypes = [
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
] as const;
const taskStatuses = ['pending', 'done', 'overdue', 'cancelled'] as const;

type AiEntity = {
  type?: string;
  title?: string;
  summary?: string;
  tags?: unknown;
  scenes?: unknown;
};

type AiRelationship = {
  fromTitle?: string;
  toTitle?: string;
  type?: string;
};

type AiTask = {
  description?: string;
  ownerTitle?: string;
  linkedToTitles?: unknown;
  dueDate?: string;
  status?: string;
};

type AiCaptureResponse = {
  primaryEntity?: AiEntity;
  relatedEntities?: unknown;
  relationships?: unknown;
  tasks?: unknown;
};

export function buildMiniMaxCapturePrompt(content: string) {
  return `你是 MyWiki 个人知识库的结构化提取助手。请分析用户输入，严格输出一个 JSON 对象，不要输出 markdown 代码块，不要输出解释。

JSON schema:
{
  "primaryEntity": {
    "type": "person | project | event | topic",
    "title": "不超过 30 字",
    "summary": "2-3 句摘要",
    "tags": ["2-4 个中文标签"],
    "scenes": ["work | life | social | personal"]
  },
  "relatedEntities": [
    {
      "type": "person | project | event | topic",
      "title": "实体标题",
      "summary": "一句摘要",
      "tags": ["标签"],
      "scenes": ["work | life | social | personal"]
    }
  ],
  "relationships": [
    {
      "fromTitle": "实体A标题，必须出现在 primaryEntity 或 relatedEntities 中",
      "toTitle": "实体B标题，必须出现在 primaryEntity 或 relatedEntities 中",
      "type": "owner | participant | stakeholder | decision-maker | attendee | organizer | mentioned-in | colleague | friend | family | mentor | reports-to | parent-of | depends-on | related-to | about | kicked-off | relevant-to | mentions"
    }
  ],
  "tasks": [
    {
      "description": "任务内容",
      "ownerTitle": "负责人标题，必须是已输出实体之一；无法确定时填 uncertain",
      "linkedToTitles": ["关联事项或互动标题"],
      "dueDate": "ISO date 或自然语言日期，可省略",
      "status": "pending"
    }
  ]
}

判断规则:
- 不要凭空创造没有被明确提到的人、项目、任务。
- 不要把“总结、总览、总之”识别成人名。
- 任务 owner 必须谨慎，不能确定就填 uncertain。
- 关系方向要符合语义：人 attendee 互动；互动 about 事项；人 participant/owner 事项。

用户输入:
${content}`;
}

export function normalizeMiniMaxCaptureResponse(rawText: string): CaptureDraft {
  const parsed = parseBestCaptureJson(rawText);
  const primary = normalizeEntity(parsed.primaryEntity, 'event');
  const related = toArray<AiEntity>(parsed.relatedEntities).map((entity) => normalizeEntity(entity, 'topic'));
  const allEntities = [primary, ...related];
  const entityByTitle = new Map(allEntities.map((entity) => [entity.title, entity]));

  const relationships = toArray<AiRelationship>(parsed.relationships)
    .map((relationship) => {
      const from = relationship.fromTitle ? entityByTitle.get(relationship.fromTitle) : undefined;
      const to = relationship.toTitle ? entityByTitle.get(relationship.toTitle) : undefined;
      const type = pickEnum(relationship.type, relationshipTypes, 'mentions');
      if (!from || !to) return undefined;
      return {
        clientId: createDraftId('rel'),
        fromClientId: from.clientId,
        toClientId: to.clientId,
        type,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const tasks = toArray<AiTask>(parsed.tasks)
    .map((task) => {
      const owner = task.ownerTitle ? entityByTitle.get(task.ownerTitle) : undefined;
      if (!owner || task.ownerTitle === 'uncertain' || !task.description?.trim()) return undefined;
      return {
        clientId: createDraftId('task'),
        description: task.description.trim(),
        ownerClientId: owner.clientId,
        linkedToClientIds: toArray<string>(task.linkedToTitles)
          .map((title) => entityByTitle.get(title)?.clientId)
          .filter((id): id is string => Boolean(id)),
        dueDate: task.dueDate,
        status: pickEnum(task.status, taskStatuses, 'pending') as TaskStatus,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    primaryEntity: primary,
    relatedEntities: related,
    relationships,
    tasks,
  };
}

function normalizeEntity(entity: AiEntity | undefined, fallbackType: EntityType): DraftEntity {
  const title = entity?.title?.trim() || '未命名实体';
  return {
    clientId: createDraftId('entity'),
    type: pickEnum(entity?.type, entityTypes, fallbackType),
    title,
    summary: entity?.summary?.trim() || `${title} 相关记录。`,
    tags: toArray<string>(entity?.tags)
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 6),
    scenes: toArray<string>(entity?.scenes)
      .map((scene) => pickEnum(scene, scenes, undefined))
      .filter((scene): scene is Scene => Boolean(scene)),
  };
}

function parseBestCaptureJson(text: string) {
  const objects = extractJsonObjects(text);
  for (const objectText of objects.reverse()) {
    try {
      const parsed = JSON.parse(objectText) as AiCaptureResponse;
      if (parsed.primaryEntity && typeof parsed.primaryEntity.title === 'string') {
        return parsed;
      }
    } catch {
      // Try the previous candidate.
    }
  }

  throw new Error('MiniMax did not return a valid MyWiki JSON object.');
}

function extractJsonObjects(text: string) {
  const withoutFence = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let index = 0; index < withoutFence.length; index += 1) {
    const char = withoutFence[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    }
    if (char === '}') depth -= 1;

    if (depth === 0 && start !== -1) {
      objects.push(withoutFence.slice(start, index + 1).replace(/,\s*([}\]])/g, '$1'));
      start = -1;
    }
  }

  if (objects.length === 0) {
    throw new Error('MiniMax did not return a JSON object.');
  }
  return objects;
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickEnum<T extends string, TFallback extends T | undefined>(
  value: unknown,
  values: readonly T[],
  fallback: TFallback,
) {
  return values.includes(value as T) ? (value as T) : fallback;
}
