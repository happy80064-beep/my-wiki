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
const indicatorConfidences = ['high', 'medium', 'low'] as const;

type AiEntity = {
  type?: string;
  title?: string;
  summary?: string;
  tags?: unknown;
  scenes?: unknown;
  categories?: unknown;
  indicators?: unknown;
};

type AiCategory = {
  name?: string;
  aliases?: unknown;
  items?: unknown;
  evidence?: string;
};

type AiCategoryItem = {
  title?: string;
  kind?: string;
  summary?: string;
  evidence?: string;
};

type AiIndicator = {
  name?: string;
  value?: unknown;
  rawValue?: string;
  unit?: string;
  businessLine?: string;
  categoryName?: string;
  source?: {
    section?: string;
    page?: unknown;
    excerpt?: string;
  };
  confidence?: string;
  note?: string;
  asOfDate?: string;
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
  return `你是 MyWiki 个人知识库的结构化提取助手。请只根据下面的原文提取结构化信息。

原文：
<<<
${content}
>>>

严格输出一个 JSON 对象，不要输出 markdown 代码块，不要输出解释。
请根据“用户输入”的真实内容填充 JSON，禁止照抄 schema 占位文字，禁止输出空标题，禁止把正常中文判断为乱码、无效字符或无法识别。
输出中的人名、项目名、任务内容必须来自原文或由原文直接概括；原文没有的名称一律不要输出。

JSON schema:
{
  "primaryEntity": {
    "type": "person | project | event | topic",
    "title": "不超过 30 字",
    "summary": "2-3 句摘要",
    "tags": ["2-4 个中文标签"],
    "scenes": ["work | life | social | personal"],
    "categories": [
      {
        "name": "内部维度名，例如 医疗业态 / 康养业态 / 研发板块",
        "aliases": ["维度别名"],
        "items": [
          {"title": "该维度下的具体项目/服务/机构", "kind": "project|service|institution|method|topic", "summary": "一句说明", "evidence": "原文证据短句"}
        ],
        "evidence": "能证明该层级结构的原文短句"
      }
    ],
    "indicators": [
      {
        "name": "指标名，例如 住宅板块建筑面积 / 医疗板块用地面积 / 稳定运营期年均总收入",
        "value": 123.45,
        "rawValue": "123.45 万平方米",
        "unit": "万平方米",
        "businessLine": "住宅 / 医疗 / 康养 / 研发 / 文旅，可省略",
        "categoryName": "对应 categories 里的维度名，可省略",
        "source": {"section": "章节名，可省略", "page": 12, "excerpt": "包含指标名、数值和单位的原文证据；未提供时写明未提供的原文线索"},
        "confidence": "high | medium | low",
        "note": "如果 value 为 null，说明为什么资料未提供或不能确认",
        "asOfDate": "指标对应日期，可省略"
      }
    ]
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
      "ownerTitle": "负责人标题，必须是已输出实体之一；原文没有明确负责人时填 我，并在 relatedEntities 中补充 person 实体 我",
      "linkedToTitles": ["关联事项或互动标题"],
      "dueDate": "ISO date 或自然语言日期，可省略",
      "status": "pending"
    }
  ]
}

判断规则:
- 不要凭空创造没有被明确提到的人、项目、任务。
- 不要把“总结、总览、总之”识别成人名。
- 任务 owner 必须谨慎；没有明确负责人时，默认 ownerTitle 填“我”，因为这是个人知识库里的待确认任务草稿。
- “短期优先级 / 推荐后续路线 / 下一阶段核心 / 计划 / 待办 / 行动项”后面的编号列表或行动句，应优先提取为 tasks。
- 包含“稳住、完善、强化、保留、评估、做稳、减少、支持、让…成为”等执行动词的计划项，应作为任务候选。
- 关系方向要符合语义：人 attendee 互动；互动 about 事项；人 participant/owner 事项。
- owner / participant / stakeholder / decision-maker 只能用于 person -> project；工具、模型、框架、技术组件不能作为“负责人”。
- Gemini、SenseVoice-Small、OpenCLI、OpenClaw、Fish Audio S2、Live2D/Pixi、Electron、Whisper.cpp 等技术实体的 type 应为 topic，不应为 person。
- 项目与工具、模型、框架、技术组件的关系应优先使用 depends-on 或 related-to，不要使用 owner。
- 对项目、主题中出现“业态 / 版块 / 板块 / 业务线 / 模块 / 分类”且其下有具体项目、服务、机构或方法时，必须写入 primaryEntity.categories 或对应 relatedEntities.categories。
- categories 表示“父实体内部的层级结构”，不要用它替代 relationships；扁平实体关系仍照常输出。
- category.items 只能放该维度下面的具体项目、服务、机构、方法或产品，不要放目录标题、页码、章节号、标点点线或宣传口号。
- 对项目、主题中的数值事实，优先写入 indicators。典型指标包括：用地面积、建筑面积、投资额、收入、成本、利润、人数、床位数、时间节点。
- indicators 必须保留完整单位和原文摘录；如果原文没有明确给出某个被材料讨论到的关键指标，可以输出 value: null，并在 note 中说明“资料未提供明确数值”。
- 不要把目录编号、页码、章节号、点线、OCR 碎片或其他板块的数字写成指标值；一个高置信指标必须能在原文里找到“维度/主体 + 指标名 + 数值 + 单位”的完整上下文。
- 输出中的人名、项目名、任务内容必须来自用户输入或由用户输入直接概括，不能照抄 schema 或示例词。
`;
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
      if (!from || !to) return undefined;
      const normalized = normalizeRelationship(
        from,
        to,
        pickEnum(relationship.type, relationshipTypes, 'mentions'),
      );
      return {
        clientId: createDraftId('rel'),
        fromClientId: normalized.from.clientId,
        toClientId: normalized.to.clientId,
        type: normalized.type,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const tasks = toArray<AiTask>(parsed.tasks)
    .map((task) => {
      if (!task.description?.trim()) return undefined;
      const owner = resolveTaskOwner(task.ownerTitle, entityByTitle, related, createImplicitOwner);
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

function normalizeRelationship(from: DraftEntity, to: DraftEntity, type: RelationshipType) {
  const personToProjectTypes = ['owner', 'participant', 'stakeholder', 'decision-maker'] as const;
  const personToEventTypes = ['attendee', 'organizer', 'mentioned-in'] as const;

  if (personToProjectTypes.includes(type as (typeof personToProjectTypes)[number])) {
    if (isLikelyTechnicalEntity(from) && to.type === 'project') {
      return { from: to, to: from, type: 'depends-on' as const };
    }

    if (from.type === 'project' && isLikelyTechnicalEntity(to)) {
      return { from, to, type: 'depends-on' as const };
    }

    if (from.type === 'person' && to.type === 'project') {
      return { from, to, type };
    }

    if (from.type === 'project' && to.type === 'person') {
      return { from: to, to: from, type };
    }

    if (from.type === 'project' && to.type !== 'person') {
      return { from, to, type: 'depends-on' as const };
    }

    return { from, to, type: 'related-to' as const };
  }

  if (personToEventTypes.includes(type as (typeof personToEventTypes)[number])) {
    if (from.type === 'person' && to.type === 'event') {
      return { from, to, type };
    }

    if (from.type === 'event' && to.type === 'person') {
      return { from: to, to: from, type };
    }

    return { from, to, type: 'related-to' as const };
  }

  return { from, to, type };
}

function resolveTaskOwner(
  ownerTitle: string | undefined,
  entityByTitle: Map<string, DraftEntity>,
  relatedEntities: DraftEntity[],
  createOwner: () => DraftEntity,
) {
  const normalizedOwnerTitle = ownerTitle?.trim();
  if (normalizedOwnerTitle && normalizedOwnerTitle !== 'uncertain') {
    const owner = entityByTitle.get(normalizedOwnerTitle);
    if (owner) return owner;
  }

  const existingUser = entityByTitle.get('我');
  if (existingUser) return existingUser;

  const owner = createOwner();
  relatedEntities.push(owner);
  entityByTitle.set(owner.title, owner);
  return owner;
}

function createImplicitOwner(): DraftEntity {
  return {
    clientId: createDraftId('entity'),
    type: 'person',
    title: '我',
    summary: '未明确负责人时默认归属到我，保存前可修改。',
    tags: ['待确认负责人'],
    scenes: ['personal'],
  };
}

function normalizeEntity(entity: AiEntity | undefined, fallbackType: EntityType): DraftEntity {
  const title = entity?.title?.trim() || '未命名实体';
  const requestedType = pickEnum(entity?.type, entityTypes, fallbackType);
  return {
    clientId: createDraftId('entity'),
    type: requestedType === 'person' && isLikelyTechnicalEntity({ title, summary: entity?.summary, tags: entity?.tags })
      ? 'topic'
      : requestedType,
    title,
    summary: entity?.summary?.trim() || `${title} 相关记录。`,
    tags: toArray<string>(entity?.tags)
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 6),
    scenes: toArray<string>(entity?.scenes)
      .map((scene) => pickEnum(scene, scenes, undefined))
      .filter((scene): scene is Scene => Boolean(scene)),
    categories: normalizeAiCategories(entity?.categories),
    indicators: normalizeAiIndicators(entity?.indicators),
  };
}

function normalizeAiCategories(value: unknown): DraftEntity['categories'] {
  return toArray<AiCategory>(value)
    .map((category) => ({
      name: category.name?.trim() ?? '',
      aliases: toArray<string>(category.aliases).map((alias) => String(alias).trim()).filter(Boolean),
      items: toArray<AiCategoryItem | string>(category.items)
        .map((item) => {
          if (typeof item === 'string') return { title: item.trim() };
          return {
            title: item.title?.trim() ?? '',
            kind: item.kind?.trim(),
            summary: item.summary?.trim(),
            evidence: item.evidence?.trim(),
          };
        })
        .filter((item) => item.title && !isLikelyListNoise(item.title)),
      evidence: category.evidence?.trim(),
    }))
    .filter((category) => category.name && category.items.length > 0);
}

function normalizeAiIndicators(value: unknown): DraftEntity['indicators'] {
  return toArray<AiIndicator>(value)
    .map((indicator) => ({
      name: indicator.name?.trim() ?? '',
      value: parseIndicatorValue(indicator.value),
      rawValue: indicator.rawValue?.trim(),
      unit: indicator.unit?.trim(),
      businessLine: indicator.businessLine?.trim(),
      categoryName: indicator.categoryName?.trim(),
      source: indicator.source
        ? {
            page: Number.isFinite(Number(indicator.source.page)) ? Number(indicator.source.page) : undefined,
            section: indicator.source.section?.trim(),
            excerpt: indicator.source.excerpt?.trim(),
          }
        : undefined,
      confidence: pickEnum(indicator.confidence, indicatorConfidences, 'medium'),
      note: indicator.note?.trim(),
      asOfDate: indicator.asOfDate?.trim(),
    }))
    .filter((indicator) => indicator.name && indicator.confidence);
}

function parseIndicatorValue(value: unknown) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[,，]/g, '').trim();
    if (/^(null|none|not-found|未提供|未知|无法确认)$/i.test(normalized)) return null;
    const number = Number(normalized.match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function isLikelyListNoise(value: string) {
  return /(\.{3,}|…{2,}|-{2,}|\bof\s+\d+\b|目录|页码|第\s*\d+\s*页)/i.test(value);
}

function parseBestCaptureJson(text: string) {
  const objects = extractJsonObjects(text);
  for (const objectText of objects.reverse()) {
    try {
      const parsed = JSON.parse(cleanCaptureJsonCandidate(objectText)) as AiCaptureResponse;
      if (parsed.primaryEntity && typeof parsed.primaryEntity.title === 'string') {
        return parsed;
      }
    } catch {
      try {
        const parsed = JSON.parse(repairLooseCaptureJsonCandidate(objectText)) as AiCaptureResponse;
        if (parsed.primaryEntity && typeof parsed.primaryEntity.title === 'string') {
          return parsed;
        }
      } catch {
        // Try the previous candidate.
      }
    }
  }

  throw new Error('LLM did not return a valid MyWiki JSON object.');
}

function cleanCaptureJsonCandidate(value: string) {
  return normalizeJsonSyntaxOutsideStrings(value).replace(/,\s*([}\]])/g, '$1');
}

function repairLooseCaptureJsonCandidate(value: string) {
  let repaired = cleanCaptureJsonCandidate(value);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const next = injectMissingCommas(repaired)
      .replace(/}\s*(?={)/g, '},')
      .replace(/]\s*(?={)/g, '],')
      .replace(/]\s*(?=")/g, '],')
      .replace(/"\s+(?="[^"]+"\s*:)/g, '", ')
      .replace(/"\s+(?=")/g, '", ')
      .replace(/"\s*\n\s*"/g, '",\n"')
      .replace(/}\s*\n\s*{/g, '},\n{')
      .replace(/]\s*\n\s*"/g, '],\n"')
      .replace(/}\s*\n\s*"/g, '},\n"')
      .replace(/"\s*\n\s*{/g, '",\n{')
      .replace(/(\d|true|false|null)\s*\n\s*"/g, '$1,\n"')
      .replace(/(\d|true|false|null)\s*\n\s*{/g, '$1,\n{');
    if (next === repaired) break;
    repaired = cleanCaptureJsonCandidate(next);
  }
  return repaired;
}

function injectMissingCommas(value: string) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lastSignificant = '';
  let gapHasWhitespace = false;

  for (const char of value) {
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        lastSignificant = '"';
      }
      continue;
    }

    if (/\s/.test(char)) {
      output += char;
      gapHasWhitespace = true;
      continue;
    }

    if (char === '"') {
      if (shouldInsertMissingComma(lastSignificant, char, gapHasWhitespace)) output += ',';
      output += char;
      inString = true;
      escaped = false;
      gapHasWhitespace = false;
      continue;
    }

    if (shouldInsertMissingComma(lastSignificant, char, gapHasWhitespace)) output += ',';
    output += char;
    lastSignificant = char;
    gapHasWhitespace = false;
  }

  return output;
}

function normalizeJsonSyntaxOutsideStrings(value: string) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      output += char;
      inString = true;
      escaped = false;
      continue;
    }

    output += normalizeJsonSyntaxChar(char);
  }

  return output;
}

function normalizeJsonSyntaxChar(char: string) {
  if (char === '，' || char === '、' || char === '；' || char === ';') return ',';
  if (char === '：') return ':';
  if (char === '｛') return '{';
  if (char === '｝') return '}';
  if (char === '［' || char === '【') return '[';
  if (char === '］' || char === '】') return ']';
  return char;
}

function shouldInsertMissingComma(previous: string, next: string, hasWhitespace: boolean) {
  if (!previous) return false;
  const previousEndsValue = previous === '"' || previous === '}' || previous === ']' || (hasWhitespace && /[0-9eEl]/.test(previous));
  const nextStartsValueOrKey = next === '"' || next === '{' || next === '[' || next === '-' || /[0-9tfn]/i.test(next);
  return previousEndsValue && nextStartsValueOrKey;
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
    throw new Error('LLM did not return a JSON object.');
  }
  return objects;
}

function isLikelyTechnicalEntity(entity: { title: string; summary?: unknown; tags?: unknown }) {
  const tags = Array.isArray(entity.tags) ? entity.tags.join(' ') : '';
  const text = [entity.title, entity.summary, tags].filter(Boolean).join(' ');

  return /(?:Gemini|SenseVoice|OpenCLI|OpenClaw|Fish Audio|Live2D|Pixi|Electron|Whisper|MiniMax|豆包|GLM|TTS|ASR|LLM|RTC|VoiceChat|KWS|VAD|Router|PowerShell|System\.Speech|Gmail|Google Search|grounding|provider|fallback|API|SDK|CLI|\.cpp)/i.test(
    text,
  );
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
