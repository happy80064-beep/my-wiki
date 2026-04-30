export type QueryIndexEntity = {
  id: string;
  type: string;
  title: string;
  aliases: string[];
  summary: string;
  tags: string[];
  scenes: string[];
  sourceCount: number;
  relationshipCount: number;
  updatedAt: number;
};

export type QueryPlanIntent =
  | 'attribute_lookup'
  | 'entity_profile'
  | 'task_lookup'
  | 'relationship_lookup'
  | 'time_lookup'
  | 'evidence_search';

export type QueryPlan = {
  intent: QueryPlanIntent;
  selectedEntityIds: string[];
  entityCandidates: string[];
  attribute?: string;
  evidenceTerms: string[];
  needsRawEvidence: boolean;
  needsGlobalSearch: boolean;
  answerType: 'direct' | 'yes_no_with_evidence' | 'list' | 'summary' | 'unknown';
  confidence: number;
  rationale?: string;
};

export type QueryPlanRequest = {
  question: string;
  index: QueryIndexEntity[];
};

const intents: QueryPlanIntent[] = [
  'attribute_lookup',
  'entity_profile',
  'task_lookup',
  'relationship_lookup',
  'time_lookup',
  'evidence_search',
];

const answerTypes: QueryPlan['answerType'][] = ['direct', 'yes_no_with_evidence', 'list', 'summary', 'unknown'];

export function buildQueryPlanPrompt(request: QueryPlanRequest) {
  return `你是 MyWiki 的 Query Agent。你的任务不是回答问题，而是读取知识目录，生成结构化查询计划。

用户问题：
${request.question}

知识目录 EntityIndex：
${JSON.stringify(request.index, null, 2)}

请只输出 JSON 对象，不要 markdown，不要解释。

输出 schema：
{
  "intent": "attribute_lookup | entity_profile | task_lookup | relationship_lookup | time_lookup | evidence_search",
  "selectedEntityIds": ["从 EntityIndex 中选择的相关 entity id，最多 3 个"],
  "entityCandidates": ["用户可能指代的实体名或别名，最多 5 个"],
  "attribute": "用户想查的属性，如 runtimeEnvironment / wakeWord / stopWord / model / owner / openSourceStatus / derivedFrom，可省略",
  "evidenceTerms": ["用于搜索实体文档和原始材料的证据词，最多 8 个"],
  "needsRawEvidence": true,
  "needsGlobalSearch": false,
  "answerType": "direct | yes_no_with_evidence | list | summary | unknown",
  "confidence": 0.0,
  "rationale": "一句话说明为什么选择这些页面，可省略"
}

规则：
- 必须先从 EntityIndex 中判断相关页面。用户说“数字生命体”时，可能指“桌面数字生命体”。
- 对“能否/是否/可不可以/能不能”类问题，通常是 attribute_lookup，answerType 用 yes_no_with_evidence。
- 对“A 和 B 有什么关系/有什么关联”类问题，intent 用 relationship_lookup；selectedEntityIds 放目录里能确定的 A/B 页面。如果 B 不是独立页面，不要编造 id，evidenceTerms 放 B 的短语、同义词和属性词。
- 对“Windows 环境运行/运行在 Windows/桌面运行”类问题，attribute 用 runtimeEnvironment，evidenceTerms 包含 Windows、Windows 桌面、运行在 Windows、运行环境、桌面。
- 对“唤醒词/叫醒词/KWS”类问题，attribute 用 wakeWord。
- 对“终止词/停止词/打断词/miki”类问题，attribute 用 stopWord。
- 对“路径/目录/文件夹/本地项目路径”类问题，attribute 用 localPath。
- 对“是否开源/是不是开源/Open Source”类问题，attribute 用 openSourceStatus，evidenceTerms 包含 开源、开源项目、open source。
- 对“基于什么开源项目/来源于什么/二次开发自什么”类问题，attribute 用 derivedFrom，evidenceTerms 包含 基于、开源项目、二次开发、来源、项目名。
- 注意区分 openSourceStatus 和 derivedFrom：“A 是开源的吗？”不是问来源；“A 基于什么开源项目？”才是问来源/基于项目。
- 如果目录中没有足够确定的页面，但问题看起来可能在原始材料里，needsGlobalSearch 设为 true。
- selectedEntityIds 也会作为后续证据读取范围；如果一个问题需要读多个页面，请把这些页面都放进去，最多 3 个。
- 不要编造 EntityIndex 中不存在的 entity id。`;
}

export function normalizeQueryPlan(rawText: string, request: QueryPlanRequest): QueryPlan {
  const parsed = parseBestJson(rawText);
  const selectedIds = new Set(request.index.map((item) => item.id));
  return {
    intent: pickEnum(parsed.intent, intents, 'evidence_search'),
    selectedEntityIds: toArray<string>(parsed.selectedEntityIds)
      .filter((id) => selectedIds.has(id))
      .slice(0, 3),
    entityCandidates: toArray<string>(parsed.entityCandidates)
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 5),
    attribute: typeof parsed.attribute === 'string' ? parsed.attribute.trim() : undefined,
    evidenceTerms: toArray<string>(parsed.evidenceTerms)
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8),
    needsRawEvidence: Boolean(parsed.needsRawEvidence),
    needsGlobalSearch: Boolean(parsed.needsGlobalSearch),
    answerType: pickEnum(parsed.answerType, answerTypes, 'unknown'),
    confidence: clamp(Number(parsed.confidence) || 0, 0, 1),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : undefined,
  };
}

function parseBestJson(text: string) {
  const withoutFence = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Query Agent did not return a JSON object.');
  }
  return JSON.parse(withoutFence.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickEnum<T extends string>(value: unknown, values: readonly T[], fallback: T) {
  return values.includes(value as T) ? (value as T) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
