import type { EntityType, RelationshipType, Scene, TaskStatus } from '../../types';
import type { CaptureDraft, DraftEntity } from '../capture/draft';
import { createDraftId } from '../capture/draft';
import {
  buildWikiSchemaRulesTable,
  normalizeWikiPageType,
  parseWikiSchemaPageTypes,
} from '../wiki/schemaRules';

export type WikiPatchType =
  | 'CREATE_ENTITY'
  | 'UPDATE_ENTITY_CATEGORIES'
  | 'UPDATE_ENTITY_INDICATORS'
  | 'UPDATE_ENTITY_PROPERTY'
  | 'CREATE_RELATIONSHIP'
  | 'CREATE_TASK'
  | 'REVIEW_REQUIRED';

export type CaptureAnalysis = {
  entities: Array<{
    title: string;
    type: EntityType;
    pageType?: string;
    tags?: string[];
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
  hierarchies: Array<{
    parentTitle: string;
    categoryName: string;
    items: Array<{
      title: string;
      kind?: string;
      evidence: string;
    }>;
    evidence: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  indicators: Array<{
    entityTitle: string;
    name: string;
    value: number | null;
    rawValue?: string;
    unit?: string;
    businessLine?: string;
    categoryName?: string;
    evidence: string;
    confidence: 'high' | 'medium' | 'low';
    note?: string;
    asOfDate?: string;
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

export type CaptureWorkspaceContext = {
  purpose?: string;
  schema?: string;
  templateId?: string;
};

export const captureAnalysisLimits = {
  entities: 12,
  concepts: 8,
  claims: 20,
  hierarchies: 8,
  hierarchyItems: 8,
  indicators: 20,
  contradictions: 8,
  recommendedUpdates: 16,
  titleChars: 80,
  evidenceChars: 180,
  reasonChars: 180,
  tagChars: 40,
  tags: 8,
  aliases: 6,
} as const;

function buildCaptureWorkspaceContextBlock(context?: CaptureWorkspaceContext) {
  const purpose = context?.purpose?.trim();
  const schema = context?.schema?.trim();
  if (!purpose && !schema) {
    return [
      '## Current Knowledge Base Schema',
      '(No active workspace schema was provided. Use the built-in general Page Types.)',
    ].join('\n');
  }

  const pageTypes = schema ? buildWikiSchemaRulesTable(schema) : '';
  return [
    '## Current Knowledge Base Schema',
    context?.templateId ? `templateId: ${context.templateId}` : '',
    purpose ? `### purpose.md\n${truncateCaptureContextText(purpose, 2400)}` : '',
    pageTypes ? `### schema.md Page Types\n${pageTypes}` : '',
    schema ? `### schema.md excerpt\n${truncateCaptureContextText(schema, 5000)}` : '',
    'Schema routing rule: choose entities[].pageType from the Page Types table above when possible, and also include that pageType in entities[].tags.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function truncateCaptureContextText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.round(maxChars * 0.62);
  const tail = maxChars - head;
  return `${trimmed.slice(0, head)}\n\n...[workspace context truncated]...\n\n${trimmed.slice(-tail)}`;
}

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
      type: 'UPDATE_ENTITY_CATEGORIES';
      entityTitle: string;
      categories: Array<{
        name: string;
        aliases?: string[];
        items: Array<{
          title: string;
          kind?: string;
          summary?: string;
          evidence?: string;
        }>;
        evidence?: string;
      }>;
      evidence: string;
      confidence: number;
    }
  | {
      type: 'UPDATE_ENTITY_INDICATORS';
      entityTitle: string;
      indicators: NonNullable<DraftEntity['indicators']>;
      evidence: string;
      confidence: number;
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

export const CAPTURE_STRUCTURED_SOURCE_MAX_CHARS = 50000;
export const CAPTURE_DIGEST_FALLBACK_THRESHOLD = 3000;

export function shouldUseCaptureDigest(content: string, threshold = CAPTURE_DIGEST_FALLBACK_THRESHOLD) {
  return content.trim().length > threshold;
}

export function resolveCaptureDigestThreshold(contextWindow?: number, maxChars = CAPTURE_STRUCTURED_SOURCE_MAX_CHARS) {
  if (!Number.isFinite(contextWindow) || !contextWindow || contextWindow <= 0) {
    return CAPTURE_DIGEST_FALLBACK_THRESHOLD;
  }

  const promptBudget = Math.floor(contextWindow * 0.45);
  return Math.max(CAPTURE_DIGEST_FALLBACK_THRESHOLD, Math.min(maxChars, promptBudget));
}

export function buildCaptureSourceForStructuredProcessing(content: string, maxChars = CAPTURE_STRUCTURED_SOURCE_MAX_CHARS) {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const truncationNotice = `[...truncated to ${maxChars} characters before structured capture; the complete source is still stored in the raw material entry...]`;
  const excerptBudget = Math.max(0, maxChars - truncationNotice.length - 2);
  return [
    trimmed.slice(0, excerptBudget),
    '',
    truncationNotice,
  ].join('\n');
}

export function splitCaptureContentIntoChunks(content: string, maxChars = 10000, maxChunks = 5) {
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

export function buildStructuredCaptureExcerpt(content: string, maxChars = 28000) {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const headerBudget = Math.round(maxChars * 0.4);
  const priorityBudget = Math.round(maxChars * 0.28);
  const tailBudget = maxChars - headerBudget - priorityBudget;
  const priorityLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(摘要|结论|总结|建议|问题|风险|任务|行动|计划|路线|优先级|目标|项目|下一阶段|待办|TODO|todo|业态|板块|面积|投资|收入|成本|利润|时间节点|负责人)/i.test(line))
    .join('\n')
    .slice(0, priorityBudget);

  return [
    '# 长文档本地摘录',
    '',
    '以下为本地保留的开头、关键行和结尾摘录。请基于这些内容核验证据并生成结构化 Wiki 草稿；完整原文仍保存在 Raw Entry 中。',
    '',
    '--- 开头 ---',
    trimmed.slice(0, headerBudget),
    priorityLines ? '\n--- 关键行 ---' : '',
    priorityLines,
    '\n--- 结尾 ---',
    trimmed.slice(-tailBudget),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars + 320);
}

export function buildCaptureSourceIdentityBlock(content: string) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines.find((line) => /^#\s*导入文件[:：]/.test(line));
  if (!title) return '';

  const metadata = lines.filter((line) => /^(来源格式|文件大小|内容指纹)[:：]/.test(line)).slice(0, 6);
  return [title, ...metadata].join('\n');
}

export function buildCaptureDigestPrompt(
  content: string,
  chunkIndex = 1,
  totalChunks = 1,
  workspaceContext?: CaptureWorkspaceContext,
) {
  return `你是 MyWiki 的长文档阅读 Agent。请把下面这段原始材料整理成 Markdown 阅读摘要，先不要输出 JSON。

材料分块：${chunkIndex}/${totalChunks}

${buildCaptureWorkspaceContextBlock(workspaceContext)}

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

export function buildCaptureMarkdownAnalysisPrompt(
  content: string,
  entityIndexJson: string,
  workspaceContext?: CaptureWorkspaceContext,
) {
  return `你是 MyWiki 的原文件阅读 Agent。请参考旧版 llm-wiki 的稳定入库方式：先把原始材料理解成 Markdown 分析文本，不要在这一轮输出 JSON。

原始材料：
${content}

当前 Wiki 目录：
${entityIndexJson}

${buildCaptureWorkspaceContextBlock(workspaceContext)}

请输出 Markdown，包含这些小节：

## 材料概览
- 这份原文件是什么，围绕什么项目、主题、对象或事件展开
- 如果是 PDF/Word/Excel/PPT/图片，说明来源文件本身和文件中真正讲到的知识对象

## 应入库的 Page Types
- source：来源文件页标题、证据
- project/entity/topic/event/concept：应该创建或更新的 Wiki 词条标题、类型、证据
- 必须参考上方 schema.md 的 Page Types；如果当前知识库是 personal-growth/research/reading/business 等模板，优先使用该 schema 里的 goal/habit/reflection/journal/thesis/finding/book/chapter 等类型名称作为归类建议。

## 关键事实与关系
- 主体｜属性或关系｜对象/数值｜证据短句

## 层级结构与指标
- 业态/板块/模块/分类：父实体 -> 分类 -> 子项
- 数值指标：主体/维度｜指标名｜数值或 null｜单位｜证据

## 冲突、待审核与后续动作
- 只记录真实矛盾、明显不确定、待补证、待深度研究的事项

规则：
- 只根据材料，不要补充外部知识。
- 保留原文中的专名、日期、路径、模型名、项目名和数值单位。
- 对导入文件，不要只总结“导入文件：xxx”；必须尽量识别文件中真正讲到的项目、主题、方法、指标、任务。
- 如果材料很长，优先保留标题、摘要、目录后的正文结论、指标表、业务/项目描述、风险、行动项。
- 不要输出 JSON，不要输出代码块。`;
}

export function buildCaptureAnalysisFromMarkdownPrompt(input: {
  sourceExcerpt: string;
  markdownAnalysis: string;
  entityIndexJson: string;
  workspaceContext?: CaptureWorkspaceContext;
}) {
  return `你是 MyWiki 的结构化入库 Agent。上一轮已经把原文件读成 Markdown 分析；这一轮只把分析结果整理成程序可解析的结构化对象。

上一轮 Markdown 分析：
${input.markdownAnalysis.slice(0, 16000)}

原始材料摘录（用于核验证据，不要全文复述）：
${input.sourceExcerpt}

当前 Wiki 目录：
${input.entityIndexJson}

${buildCaptureWorkspaceContextBlock(input.workspaceContext)}

如果当前接口支持 tool/function call，请调用指定的结构化输出工具并把对象放进 tool input / function arguments；如果接口不支持工具，请只输出 JSON 对象，字段为：
{
  "entities": [{"title": "", "type": "person|project|event|topic", "pageType": "schema Page Type", "tags": [], "aliases": [], "evidence": "", "existsLikely": false}],
  "concepts": [{"title": "", "evidence": ""}],
  "claims": [{"subject": "", "predicate": "", "object": "", "evidence": "", "confidence": "high|medium|low"}],
  "hierarchies": [{"parentTitle": "", "categoryName": "", "items": [{"title": "", "kind": "", "evidence": ""}], "evidence": "", "confidence": "high|medium|low"}],
  "indicators": [{"entityTitle": "", "name": "", "value": null, "rawValue": "", "unit": "", "businessLine": "", "categoryName": "", "evidence": "", "confidence": "high|medium|low", "note": ""}],
  "contradictions": [{"title": "", "evidence": ""}],
  "recommendedUpdates": [{"targetTitle": "", "action": "CREATE_ENTITY|UPDATE_ENTITY_INDICATORS|UPDATE_ENTITY_PROPERTY|CREATE_RELATIONSHIP|CREATE_TASK|REVIEW_REQUIRED", "reason": ""}]
}

硬性规则：
- 第一字符必须是 {，最后一个字符必须是 }；不要 Markdown，不要解释。
- 所有 key 使用英文双引号；数组分隔只能用英文逗号。
- 输出只保留最重要、证据最强的条目：entities 最多 ${captureAnalysisLimits.entities} 个，concepts 最多 ${captureAnalysisLimits.concepts} 个，claims 最多 ${captureAnalysisLimits.claims} 个，hierarchies 最多 ${captureAnalysisLimits.hierarchies} 个且每个 items 最多 ${captureAnalysisLimits.hierarchyItems} 个，indicators 最多 ${captureAnalysisLimits.indicators} 个，contradictions 最多 ${captureAnalysisLimits.contradictions} 个，recommendedUpdates 最多 ${captureAnalysisLimits.recommendedUpdates} 个。
- evidence 和 reason 必须是短句，不要整段复制；单条 evidence/reason 最多 ${captureAnalysisLimits.evidenceChars} 个中文字符左右。
- 对导入文件，必须包含来源文件本身对应的 recommendedUpdates，并至少包含一个文件中真正讲到的 project/topic/concept/entity，除非材料完全没有可读知识。
- entities[].pageType 必须优先从当前 schema.md 的 Page Types 中选择；同时把这个 pageType 放进 tags，方便知识树按 schema 分类。
- 不要把来源文件标题当作唯一知识项；source 页和知识对象要分开。
- event 只用于明确的会议、访谈、时间点事件；报告、方案、表格、截图通常不是 event。
- indicators 必须有 entityTitle、name、evidence、confidence；没有明确数值时 value 用 null 并写 note。
- evidence 必须是 Markdown 分析或原始摘录中能找到的短句。
- 不要生成数据库 ID。`;
}

export function buildCaptureAnalysisStructuredOutput(name = 'capture_analysis') {
  return {
    name,
    description: 'MyWiki source ingestion analysis object used to create or update wiki page types.',
    schema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          maxItems: captureAnalysisLimits.entities,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              type: { type: 'string', enum: ['person', 'project', 'event', 'topic'] },
              pageType: { type: 'string', maxLength: captureAnalysisLimits.tagChars },
              tags: { type: 'array', maxItems: captureAnalysisLimits.tags, items: { type: 'string', maxLength: captureAnalysisLimits.tagChars } },
              aliases: { type: 'array', maxItems: captureAnalysisLimits.aliases, items: { type: 'string', maxLength: captureAnalysisLimits.titleChars } },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              existsLikely: { type: 'boolean' },
            },
            required: ['title', 'type', 'evidence'],
          },
        },
        concepts: {
          type: 'array',
          maxItems: captureAnalysisLimits.concepts,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
            },
            required: ['title', 'evidence'],
          },
        },
        claims: {
          type: 'array',
          maxItems: captureAnalysisLimits.claims,
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              predicate: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              object: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['subject', 'predicate', 'object', 'evidence', 'confidence'],
          },
        },
        hierarchies: {
          type: 'array',
          maxItems: captureAnalysisLimits.hierarchies,
          items: {
            type: 'object',
            properties: {
              parentTitle: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              categoryName: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              items: {
                type: 'array',
                maxItems: captureAnalysisLimits.hierarchyItems,
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
                    kind: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
                    evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
                  },
                  required: ['title', 'evidence'],
                },
              },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['parentTitle', 'categoryName', 'items', 'evidence', 'confidence'],
          },
        },
        indicators: {
          type: 'array',
          maxItems: captureAnalysisLimits.indicators,
          items: {
            type: 'object',
            properties: {
              entityTitle: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              name: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              value: { type: ['number', 'null'] },
              rawValue: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              unit: { type: 'string', maxLength: captureAnalysisLimits.tagChars },
              businessLine: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              categoryName: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              note: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
              asOfDate: { type: 'string', maxLength: captureAnalysisLimits.tagChars },
            },
            required: ['entityTitle', 'name', 'value', 'evidence', 'confidence'],
          },
        },
        contradictions: {
          type: 'array',
          maxItems: captureAnalysisLimits.contradictions,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              evidence: { type: 'string', maxLength: captureAnalysisLimits.evidenceChars },
            },
            required: ['title', 'evidence'],
          },
        },
        recommendedUpdates: {
          type: 'array',
          maxItems: captureAnalysisLimits.recommendedUpdates,
          items: {
            type: 'object',
            properties: {
              targetTitle: { type: 'string', maxLength: captureAnalysisLimits.titleChars },
              action: {
                type: 'string',
                enum: [
                  'CREATE_ENTITY',
                  'UPDATE_ENTITY_INDICATORS',
                  'UPDATE_ENTITY_PROPERTY',
                  'CREATE_RELATIONSHIP',
                  'CREATE_TASK',
                  'REVIEW_REQUIRED',
                ],
              },
              reason: { type: 'string', maxLength: captureAnalysisLimits.reasonChars },
            },
            required: ['targetTitle', 'action', 'reason'],
          },
        },
      },
      required: ['entities', 'concepts', 'claims', 'hierarchies', 'indicators', 'contradictions', 'recommendedUpdates'],
    },
  };
}

export function buildCaptureAnalysisPrompt(
  content: string,
  entityIndexJson: string,
  workspaceContext?: CaptureWorkspaceContext,
) {
  return `你是 MyWiki 的摄入分析 Agent。你只负责理解材料，不负责写入数据库。

原始材料：
${content}

当前 Wiki 目录：
${entityIndexJson}

${buildCaptureWorkspaceContextBlock(workspaceContext)}

请输出 JSON，字段为：
{
  "entities": [{"title": "", "type": "person|project|event|topic", "pageType": "schema Page Type", "tags": [], "aliases": [], "evidence": "", "existsLikely": false}],
  "concepts": [{"title": "", "evidence": ""}],
  "claims": [{"subject": "", "predicate": "", "object": "", "evidence": "", "confidence": "high|medium|low"}],
  "hierarchies": [{"parentTitle": "", "categoryName": "", "items": [{"title": "", "kind": "", "evidence": ""}], "evidence": "", "confidence": "high|medium|low"}],
  "indicators": [{"entityTitle": "", "name": "", "value": 123.45, "rawValue": "123.45 万平方米", "unit": "万平方米", "businessLine": "住宅", "categoryName": "住宅业态", "evidence": "", "confidence": "high|medium|low", "note": ""}],
  "contradictions": [{"title": "", "evidence": ""}],
  "recommendedUpdates": [{"targetTitle": "", "action": "CREATE_ENTITY|UPDATE_ENTITY_INDICATORS|UPDATE_ENTITY_PROPERTY|CREATE_RELATIONSHIP|CREATE_TASK|REVIEW_REQUIRED", "reason": ""}]
}

规则：
- 只提取材料中有证据的内容。
- entities 必须对照当前 Wiki 目录判断 existsLikely；名称相近、别名相近、摘要相近都应视为可能已存在。
- entities[].pageType 必须优先从当前 schema.md 的 Page Types 中选择；同时把 pageType 放进 tags，供知识树和 Wiki 编译路由使用。
- 对 PDF、Word、表格、图片等“导入文件”材料，必须先识别“来源文件本身”与“文件中讲到的知识对象”：来源文件用于生成 source 页面；关键项目/业务/对象用 project/entity/topic；关键方法/模型/机制/路线用 concepts。不要只输出“导入文件：xxx”这种保底主题。
- 导入材料如果围绕一个长期项目、商业案例、研究对象、软件系统或可研方案展开，entities 至少应包含该 project/topic；如果材料只是截图，也要根据视觉描述提取可见的项目、概念、指标或任务。
- 不要因为正文中出现“会、会议、同步、讨论”等普通词就创建 event。只有材料本身明确是在记录一次具体会议、沟通、访谈或时间点事件时，才允许 type=event。
- concepts 用来记录重要概念、方法、技术路线或主题，不要把所有普通名词都列进去。
- claims 必须是可写入 Wiki 的事实属性或关系事实，例如 runtimeEnvironment、wakeWord、stopWord、localPath、models、ownerNote、derivedFrom、openSourceStatus。
- hierarchies 用来记录层级结构，例如“福瑞三期 -> 医疗业态 -> FMT 疗法 / 中蒙医院”。只在材料明确出现“业态/版块/板块/业务线/模块/分类”及其下属项目、服务、机构或方法时输出。
- indicators 用来记录数值或事实指标，例如“住宅板块建筑面积”“医疗板块用地面积”“稳定运营期年均总收入”。每条必须有 entityTitle、name、evidence 和 confidence。
- 如果材料讨论了某个关键指标但没有给出明确数值，indicator.value 应输出 null，并在 note 中写明“原文未提供明确数值”；不要为了凑答案从目录、页码或其他板块数字中猜。
- 每条 claim 的 evidence 必须是原文中能支撑 subject / predicate / object 的短片段，不要只给关键词。
- 每条 indicator 的 evidence 必须能支撑“主体/维度 + 指标名 + 数值 + 单位”；若不能支撑，只能标为 low 或 value: null。
- hierarchy.items 不能放目录标题、页码、章节号、点线、宣传口号或无法归类的碎片。
- contradictions 只放真正冲突或张力，不要把普通不确定都放进去。
- recommendedUpdates 要明确建议创建或更新哪些实体、关系、任务或待审核项。
- 对导入文件，recommendedUpdates 必须包含一个面向来源页的 CREATE_ENTITY 建议，并包含关键 project/entity/concept 的 CREATE_ENTITY 或 UPDATE 建议；除非材料完全没有可读内容。
- 不确定、冲突或需要用户判断的内容放入 contradictions 或 recommendedUpdates。
- 如果材料暗示需要后续深度研究，可在 recommendedUpdates.reason 中写出 2-3 个搜索关键词。
- 不要生成数据库 ID，不要输出 markdown。`;
}

export function buildCaptureAnalysisJsonRepairPrompt(
  rawText: string,
  content: string,
  entityIndexJson: string,
  workspaceContext?: CaptureWorkspaceContext,
) {
  return `你是 MyWiki 的 JSON 修复 Agent。上一轮摄入分析模型输出不能被程序解析。

你的任务：只根据“原始材料”和“当前 Wiki 目录”重新输出一个合法 JSON 对象。不要解释，不要 Markdown，不要代码块。

必须输出这个 schema：
{
  "entities": [{"title": "", "type": "person|project|event|topic", "pageType": "schema Page Type", "tags": [], "aliases": [], "evidence": "", "existsLikely": false}],
  "concepts": [{"title": "", "evidence": ""}],
  "claims": [{"subject": "", "predicate": "", "object": "", "evidence": "", "confidence": "high|medium|low"}],
  "hierarchies": [{"parentTitle": "", "categoryName": "", "items": [{"title": "", "kind": "", "evidence": ""}], "evidence": "", "confidence": "high|medium|low"}],
  "indicators": [{"entityTitle": "", "name": "", "value": null, "rawValue": "", "unit": "", "businessLine": "", "categoryName": "", "evidence": "", "confidence": "high|medium|low", "note": ""}],
  "contradictions": [{"title": "", "evidence": ""}],
  "recommendedUpdates": [{"targetTitle": "", "action": "CREATE_ENTITY|UPDATE_ENTITY_INDICATORS|UPDATE_ENTITY_PROPERTY|CREATE_RELATIONSHIP|CREATE_TASK|REVIEW_REQUIRED", "reason": ""}]
}

硬性规则：
- 返回值必须是一个 JSON object，第一字符必须是 {，最后一个字符必须是 }。
- 所有 key 必须使用英文双引号。
- 数组分隔只能用英文逗号，不能用中文顿号、中文逗号或分号。
- 如果没有内容，输出空数组，不要省略字段。
- entities[].pageType 必须优先从当前 schema.md 的 Page Types 中选择；同时把 pageType 放进 tags。
- 对“# 导入文件：...”材料，至少识别来源文件本身；如果材料中有项目/表格/报告对象，也要识别对应 project/topic。
- 只保留有原文证据的内容，不要猜测。

原始材料：
${content}

当前 Wiki 目录：
${entityIndexJson}

${buildCaptureWorkspaceContextBlock(workspaceContext)}

上一轮不可解析输出，仅供参考，不能照抄其中的格式错误：
${rawText.slice(0, 12000)}`;
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
- UPDATE_ENTITY_CATEGORIES
- UPDATE_ENTITY_INDICATORS
- UPDATE_ENTITY_PROPERTY
- CREATE_RELATIONSHIP
- CREATE_TASK
- REVIEW_REQUIRED

约束：
- UPDATE_ENTITY_PROPERTY.propertyKey 只能使用：${allowedWikiPatchPropertyKeys.join(', ')}
- REVIEW_REQUIRED.options 只能从 Create Page / Update Existing / Skip 中选择。
- 每个 patch 都必须带 evidence，evidence 必须是原文中的短证据片段。
- 对“# 导入文件：...”材料，必须生成一个来源摘要页 patch：CREATE_ENTITY，entityType 为 topic，title 使用文件名去掉扩展名，tags 必须包含 "source" 或 "来源"。这张页会被 schema 路由到 wiki/sources/。
- 对导入文件中真正讲到的关键对象，还要生成 project/entity/topic/concept 对应的 CREATE_ENTITY 或 UPDATE patch；不要只生成来源摘要页。
- concepts 中的重要概念应转换为 CREATE_ENTITY(entityType="topic")，tags 包含 "concept" 或 "概念"，以便路由到 wiki/concepts/。
- CREATE_ENTITY 只在分析认为实体不存在或值得新建时使用；可能已存在的实体优先 UPDATE_ENTITY_PROPERTY、CREATE_RELATIONSHIP 或 REVIEW_REQUIRED。
- 对导入报告、可研、商业计划书、测算表、截图等文件，CREATE_ENTITY 的 entityType 优先使用 project/topic；不要把文件名或项目名生成为“同步”事件页，除非原文明确是一场会议纪要。
- UPDATE_ENTITY_CATEGORIES 用于写入父实体内部层级结构，格式为 {"type":"UPDATE_ENTITY_CATEGORIES","entityTitle":"父实体","categories":[{"name":"医疗业态","aliases":["医疗"],"items":[{"title":"FMT 疗法","kind":"method","evidence":"..."}]}],"evidence":"...","confidence":0.8}。
- UPDATE_ENTITY_CATEGORIES 只能在原文明确给出“某维度下包含哪些项目/服务/机构/方法”时生成；不要把目录、页码、章节标题或上一级业态列表当成 items。
- UPDATE_ENTITY_INDICATORS 用于写入结构化指标，格式为 {"type":"UPDATE_ENTITY_INDICATORS","entityTitle":"父实体","indicators":[{"name":"住宅板块建筑面积","value":null,"unit":"万平方米","businessLine":"住宅","categoryName":"住宅业态","source":{"excerpt":"原文未明确披露住宅板块建筑面积"},"confidence":"high","note":"原文未提供明确数值"}],"evidence":"...","confidence":0.8}。
- UPDATE_ENTITY_INDICATORS 可以写入 value: null，表示“已经编译过，资料未提供明确值”。这类 null 指标优先级高于查询时临时 OCR 抽取。
- 指标 value 只有在原文同时出现主体/维度、指标名、数值和单位时才能给具体数字；否则 value 必须为 null 或标 low，不能把目录编号、页码、章节号、点线、OCR 碎片或其他板块数字当作指标。
- UPDATE_ENTITY_PROPERTY 的 propertyValue 必须是完整值，不要用“开源”“方案”“模型”等泛词代替具体对象；例如“OpenMaic 开源项目”“小林”“Windows”。
- CREATE_RELATIONSHIP 必须同时有 fromTitle、toTitle、relationshipType 和能证明二者关系的 evidence。
- REVIEW_REQUIRED 只用于冲突、疑似重复、重要但缺页、需要用户判断的内容；不要创建琐碎 review。
- 如果 REVIEW_REQUIRED 是 suggestion 或 missing-page 类问题，reason 中应包含可用于后续搜索的关键词。
- 如果没有足够证据，不要生成 patch；宁可 REVIEW_REQUIRED。
- 不要输出 markdown，不要输出解释。`;
}

export function buildWikiPatchJsonRepairPrompt(rawText: string, content: string, analysis: CaptureAnalysis) {
  return `你是 MyWiki 的 WikiPatch JSON 修复 Agent。上一轮 WikiPatch 输出不能被程序解析。

你的任务：根据“原始材料”和“分析结果”重新输出一个合法 JSON 对象。不要解释，不要 Markdown，不要代码块。

必须输出：
{
  "patches": []
}

patches 只能包含以下类型：
- CREATE_ENTITY
- UPDATE_ENTITY_CATEGORIES
- UPDATE_ENTITY_INDICATORS
- UPDATE_ENTITY_PROPERTY
- CREATE_RELATIONSHIP
- CREATE_TASK
- REVIEW_REQUIRED

硬性规则：
- 返回值必须是一个 JSON object，第一字符必须是 {，最后一个字符必须是 }。
- 所有 key 必须使用英文双引号。
- 数组分隔只能用英文逗号，不能用中文顿号、中文逗号或分号。
- 每个 patch 都必须带 evidence，且 evidence 必须来自原始材料。
- 对“# 导入文件：...”材料，必须至少生成一个来源摘要页 patch：CREATE_ENTITY，entityType 为 topic，title 使用文件名去掉扩展名，tags 包含 "source" 或 "来源"。
- 如果材料中有项目、业务、测算表、报告对象，也要生成对应 project/topic 的 CREATE_ENTITY 或 UPDATE patch。
- 如果无法安全生成 patch，输出 {"patches": []}，不要输出自然语言。

原始材料：
${content}

分析结果：
${JSON.stringify(analysis, null, 2)}

上一轮不可解析输出，仅供参考，不能照抄其中的格式错误：
${rawText.slice(0, 12000)}`;
}

export function normalizeCaptureAnalysis(rawText: string): CaptureAnalysis {
  const parsed = parseBestJson(rawText, { repair: true }) as Partial<CaptureAnalysis>;
  return {
    entities: toArray<Record<string, unknown>>(parsed.entities)
      .map((entity) => ({
        title: stringValue(entity.title),
        type: pickEnum(entity.type, entityTypes, 'topic'),
        pageType: normalizeWikiPageType(stringValue(entity.pageType ?? entity.wikiPageType ?? entity.schemaType)) ?? undefined,
        tags: normalizeAnalysisTags(entity.tags),
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
    hierarchies: toArray<Record<string, unknown>>((parsed as Partial<CaptureAnalysis>).hierarchies)
      .map((hierarchy) => ({
        parentTitle: stringValue(hierarchy.parentTitle),
        categoryName: stringValue(hierarchy.categoryName),
        items: toArray<Record<string, unknown>>(hierarchy.items)
          .map((item) => ({
            title: stringValue(item.title),
            kind: stringValue(item.kind) || undefined,
            evidence: stringValue(item.evidence),
          }))
          .filter((item) => item.title && item.evidence && !isLikelyListNoise(item.title)),
        evidence: stringValue(hierarchy.evidence),
        confidence: pickEnum(hierarchy.confidence, confidenceLevels, 'medium'),
      }))
      .filter((hierarchy) => hierarchy.parentTitle && hierarchy.categoryName && hierarchy.items.length > 0 && hierarchy.evidence),
    indicators: toArray<Record<string, unknown>>((parsed as Partial<CaptureAnalysis>).indicators)
      .map((indicator) => ({
        entityTitle: stringValue(indicator.entityTitle),
        name: stringValue(indicator.name),
        value: parseIndicatorValue(indicator.value),
        rawValue: stringValue(indicator.rawValue) || undefined,
        unit: stringValue(indicator.unit) || undefined,
        businessLine: stringValue(indicator.businessLine) || undefined,
        categoryName: stringValue(indicator.categoryName) || undefined,
        evidence: stringValue(indicator.evidence),
        confidence: pickEnum(indicator.confidence, confidenceLevels, 'medium'),
        note: stringValue(indicator.note) || undefined,
        asOfDate: stringValue(indicator.asOfDate) || undefined,
      }))
      .filter((indicator) => indicator.entityTitle && indicator.name && indicator.evidence),
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
  const parsed = parseBestJson(rawText, { repair: true }) as { patches?: unknown } | unknown[];
  const rawPatches = Array.isArray(parsed) ? parsed : toArray((parsed as { patches?: unknown }).patches);
  return rawPatches.map(normalizeWikiPatch).filter((patch): patch is WikiPatch => Boolean(patch && validateWikiPatch(patch)));
}

export function normalizeWikiPatchesToCaptureDraft(patches: WikiPatch[], content: string): CaptureDraft {
  const entityByTitle = new Map<string, DraftEntity>();
  let importedSourceClientId: string | undefined;

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
    if (patch.type === 'UPDATE_ENTITY_CATEGORIES') {
      const entity = ensureEntity(patch.entityTitle, 'project', patch.evidence);
      entity.categories = mergeDraftCategories(entity.categories ?? [], patch.categories);
    }
    if (patch.type === 'UPDATE_ENTITY_INDICATORS') {
      const entity = ensureEntity(patch.entityTitle, 'project', patch.evidence);
      entity.indicators = mergeDraftIndicators(entity.indicators ?? [], patch.indicators);
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

  const importedSource = extractImportedSourceInfo(content);
  if (importedSource) {
    const sourceEntity = ensureEntity(importedSource.title, 'topic', importedSource.summary);
    importedSourceClientId = sourceEntity.clientId;
    sourceEntity.tags = mergeUniqueStrings(sourceEntity.tags, importedSource.tags);
    sourceEntity.scenes = mergeUniqueStrings(sourceEntity.scenes, ['work']) as DraftEntity['scenes'];
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

  if (importedSourceClientId) {
    for (const entity of entities) {
      if (entity.clientId === importedSourceClientId) continue;
      if (relationships.some((relationship) => relationship.fromClientId === importedSourceClientId && relationship.toClientId === entity.clientId)) {
        continue;
      }
      relationships.push({
        clientId: createDraftId('rel'),
        fromClientId: importedSourceClientId,
        toClientId: entity.clientId,
        type: 'mentions',
      });
    }
  }

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

export function normalizeCaptureAnalysisToCaptureDraft(
  analysis: CaptureAnalysis,
  content: string,
  workspaceContext?: CaptureWorkspaceContext,
): CaptureDraft {
  const entityByTitle = new Map<string, DraftEntity>();
  const importedSource = extractImportedSourceInfo(content);
  let importedSourceClientId: string | undefined;
  const projectTitles = analysis.entities
    .filter((entity) => entity.type === 'project')
    .map((entity) => entity.title.trim())
    .filter(Boolean);

  const ensureEntity = (
    title: string,
    fallbackType: EntityType = 'topic',
    summary?: string,
    tags: string[] = [],
  ) => {
    const cleanedTitle = title.trim();
    const key = normalizeTitle(cleanedTitle);
    if (!key) return undefined;
    const existing = entityByTitle.get(key);
    if (existing) {
      existing.summary = existing.summary.trim() || summary?.trim() || existing.summary;
      existing.tags = mergeUniqueStrings(existing.tags, tags);
      return existing;
    }

    const entity: DraftEntity = {
      clientId: createDraftId('entity'),
      type: fallbackType,
      title: cleanedTitle,
      summary: summary?.trim() || `${cleanedTitle} 相关记录。`,
      tags: mergeUniqueStrings([], tags),
      scenes: ['work'],
    };
    entityByTitle.set(key, entity);
    return entity;
  };

  if (importedSource) {
    const sourceEntity = ensureEntity(importedSource.title, 'topic', importedSource.summary, importedSource.tags);
    importedSourceClientId = sourceEntity?.clientId;
  }

  for (const entity of analysis.entities.slice(0, 18)) {
    if (shouldFoldThinListedSubtopic(entity.title, entity.type, entity.evidence, projectTitles, importedSource)) continue;
    ensureEntity(
      entity.title,
      entity.type,
      entity.evidence,
      buildSchemaAwareEntityTags(entity, workspaceContext?.schema),
    );
  }

  for (const concept of analysis.concepts.slice(0, 18)) {
    if (shouldFoldThinListedSubtopic(concept.title, 'topic', concept.evidence, projectTitles, importedSource)) continue;
    ensureEntity(concept.title, 'topic', concept.evidence, ['concept', '概念']);
  }

  for (const hierarchy of analysis.hierarchies) {
    const entity = ensureEntity(hierarchy.parentTitle, 'project', hierarchy.evidence, ['project', '项目']);
    if (!entity) continue;
    entity.categories = mergeDraftCategories(entity.categories ?? [], [
      {
        name: hierarchy.categoryName,
        items: hierarchy.items.map((item) => ({
          title: item.title,
          kind: item.kind,
          evidence: item.evidence,
        })),
        evidence: hierarchy.evidence,
      },
    ]);
  }

  for (const indicator of analysis.indicators) {
    const entity = ensureEntity(indicator.entityTitle, 'project', indicator.evidence, ['project', '项目']);
    if (!entity) continue;
    entity.indicators = mergeDraftIndicators(entity.indicators ?? [], [
      {
        name: indicator.name,
        value: indicator.value,
        rawValue: indicator.rawValue,
        unit: indicator.unit,
        businessLine: indicator.businessLine,
        categoryName: indicator.categoryName,
        source: {
          excerpt: indicator.evidence,
        },
        confidence: indicator.confidence,
        note: indicator.note,
        asOfDate: indicator.asOfDate,
      },
    ]);
  }

  for (const update of analysis.recommendedUpdates.slice(0, 16)) {
    if (shouldFoldThinListedSubtopic(update.targetTitle, 'topic', update.reason, projectTitles, importedSource)) continue;
    const inferred = inferEntityFromRecommendedUpdate(update, importedSource, workspaceContext?.schema);
    if (!inferred) continue;
    ensureEntity(update.targetTitle, inferred.type, update.reason, inferred.tags);
  }

  if (importedSource && countNonSourceEntities(entityByTitle) === 0) {
    const inferred = inferImportedKnowledgeEntity(content, importedSource);
    if (inferred) {
      ensureEntity(inferred.title, inferred.type, inferred.summary, inferred.tags);
    }
  }

  const compileSuggestions = analysis.claims
    .filter((claim) => allowedWikiPatchPropertyKeys.includes(claim.predicate as (typeof allowedWikiPatchPropertyKeys)[number]))
    .map((claim) => {
      const entity = ensureEntity(claim.subject, 'topic', claim.evidence);
      if (!entity) return undefined;
      return {
        clientId: createDraftId('compile'),
        entityClientId: entity.clientId,
        entityTitle: entity.title,
        propertyKey: claim.predicate,
        propertyLabel: propertyLabel(claim.predicate),
        propertyValue: claim.object,
        evidenceSnippet: claim.evidence,
        confidence: confidenceToNumber(claim.confidence),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  for (const update of analysis.recommendedUpdates) {
    if (update.action === 'CREATE_ENTITY' || update.action === 'REVIEW_REQUIRED') {
      if (shouldFoldThinListedSubtopic(update.targetTitle, 'topic', update.reason, projectTitles, importedSource)) continue;
      ensureEntity(update.targetTitle, 'topic', update.reason, update.action === 'REVIEW_REQUIRED' ? ['待审核'] : []);
    }
  }

  if (entityByTitle.size === 0) {
    ensureEntity(content.slice(0, 24) || '未命名主题', 'topic', content.slice(0, 120), ['导入材料']);
  }

  const entities = Array.from(entityByTitle.values());
  const sourceEntity = importedSourceClientId ? entities.find((entity) => entity.clientId === importedSourceClientId) : undefined;
  const primaryEntity = entities.find((entity) => entity.clientId !== importedSourceClientId) ?? sourceEntity ?? entities[0];
  const relatedEntities = entities.filter((entity) => entity.clientId !== primaryEntity.clientId);
  const relationships: CaptureDraft['relationships'] = [];

  if (importedSourceClientId) {
    for (const entity of entities) {
      if (entity.clientId === importedSourceClientId) continue;
      relationships.push({
        clientId: createDraftId('rel'),
        fromClientId: importedSourceClientId,
        toClientId: entity.clientId,
        type: 'mentions',
      });
    }
  }

  return { primaryEntity, relatedEntities, relationships, tasks: [], compileSuggestions };
}

function shouldFoldThinListedSubtopic(
  title: string,
  type: EntityType,
  evidence: string,
  projectTitles: string[],
  importedSource?: ReturnType<typeof extractImportedSourceInfo>,
) {
  const cleanedTitle = title.trim();
  const cleanedEvidence = evidence.trim();
  if (!importedSource || !cleanedTitle || projectTitles.length === 0) return false;
  if (!['topic', 'project'].includes(type)) return false;
  if (normalizeTitle(cleanedTitle) === normalizeTitle(importedSource.title)) return false;
  if (type === 'project' && cleanedEvidence.indexOf(cleanedTitle) <= 5) return false;
  if (cleanedEvidence.length > 120 || !cleanedEvidence.includes(cleanedTitle)) return false;
  if (!projectTitles.some((projectTitle) => cleanedEvidence.includes(projectTitle))) return false;
  const listSeparators = cleanedEvidence.match(/[、，,；;和及与]/g)?.length ?? 0;
  return listSeparators >= 2;
}

export function validateWikiPatch(patch: WikiPatch) {
  if (!patch.type || !('evidence' in patch) || !patch.evidence.trim()) return false;

  if (patch.type === 'UPDATE_ENTITY_PROPERTY') {
    return allowedWikiPatchPropertyKeys.includes(
      patch.propertyKey as (typeof allowedWikiPatchPropertyKeys)[number],
    );
  }

  if (patch.type === 'UPDATE_ENTITY_CATEGORIES') {
    return patch.entityTitle.trim() && patch.categories.length > 0;
  }

  if (patch.type === 'UPDATE_ENTITY_INDICATORS') {
    return patch.entityTitle.trim() && patch.indicators.length > 0;
  }

  if (patch.type === 'REVIEW_REQUIRED') {
    return patch.options.every((option) => ['Create Page', 'Update Existing', 'Skip'].includes(option));
  }

  return true;
}

function extractImportedSourceInfo(content: string) {
  const filename = content.match(/^#\s*导入文件[:：]\s*(.+)$/m)?.[1]?.trim();
  if (!filename) return undefined;

  const sourceFormat = content.match(/来源格式[:：]\s*([^\n]+)/)?.[1]?.trim();
  const title = stripSourceExtension(stripImportTitlePrefix(filename)) || filename;
  const body = content
    .replace(/^#\s*导入文件[:：].*$/m, '')
    .replace(/来源格式[:：].*$/m, '')
    .replace(/文件大小[:：].*$/m, '')
    .replace(/内容指纹[:：].*$/m, '')
    .trim();
  const summary = buildSourceSummary(filename, body || content);

  return {
    filename,
    title,
    summary,
    tags: mergeUniqueStrings(['source', '来源', '导入材料'], sourceFormat ? [sourceFormat] : []),
  };
}

function stripImportTitlePrefix(value: string) {
  return value.replace(/^导入文件[:：]\s*/i, '').trim();
}

function stripSourceExtension(value: string) {
  return value.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
}

function buildSourceSummary(filename: string, content: string) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('---') && !/^#+\s*/.test(line))
    .filter((line) => !/^!\[/.test(line))
    .slice(0, 8);
  const summary = lines.join(' ').replace(/\s+/g, ' ').slice(0, 320).trim();
  return summary || `${filename} 的来源摘要。`;
}

function defaultTagsForEntityType(type: EntityType) {
  const tags: Record<EntityType, string[]> = {
    person: ['entity', '人物'],
    project: ['project', '项目'],
    event: ['event', '事件'],
    topic: ['topic'],
  };
  return tags[type];
}

function normalizeAnalysisTags(value: unknown) {
  return toArray(value)
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function buildSchemaAwareEntityTags(
  entity: CaptureAnalysis['entities'][number],
  schema?: string,
) {
  const tags = mergeUniqueStrings(defaultTagsForEntityType(entity.type), entity.tags ?? []);
  const pageType = normalizeWikiPageType(entity.pageType);
  if (pageType && isPageTypeAvailableInSchema(pageType, schema)) {
    tags.push(pageType);
  }
  return mergeUniqueStrings([], tags);
}

function isPageTypeAvailableInSchema(pageType: string, schema?: string) {
  const normalized = normalizeWikiPageType(pageType);
  if (!normalized) return false;
  return parseWikiSchemaPageTypes(schema).some((rule) => rule.type === normalized);
}

function inferEntityFromRecommendedUpdate(
  update: CaptureAnalysis['recommendedUpdates'][number],
  importedSource: ReturnType<typeof extractImportedSourceInfo>,
  schema?: string,
): { type: EntityType; tags: string[] } | undefined {
  const title = update.targetTitle.trim();
  if (!title) return undefined;

  const sourceKey = importedSource ? normalizeTitle(importedSource.title) : '';
  const titleKey = normalizeTitle(title);
  if (importedSource && titleKey && titleKey === sourceKey) {
    return { type: 'topic', tags: importedSource.tags };
  }

  const text = `${title} ${update.reason}`;
  const explicitPageType = parseWikiSchemaPageTypes(schema).find((rule) =>
    new RegExp(`(^|[^a-z0-9-])${escapeRegExp(rule.type)}([^a-z0-9-]|$)`, 'i').test(text),
  )?.type;
  const tags = explicitPageType ? [explicitPageType] : [];
  const type = inferEntityTypeFromKnowledgeText(text);
  return { type, tags: mergeUniqueStrings(defaultTagsForEntityType(type), tags) };
}

function countNonSourceEntities(entityByTitle: Map<string, DraftEntity>) {
  return Array.from(entityByTitle.values()).filter((entity) => !isSourceDraftEntity(entity)).length;
}

function isSourceDraftEntity(entity: Pick<DraftEntity, 'tags'>) {
  return entity.tags.some((tag) => {
    const normalized = tag.trim().toLowerCase();
    return normalized === 'source' || normalized === '来源' || normalized === '源文件';
  });
}

function inferImportedKnowledgeEntity(
  content: string,
  importedSource: NonNullable<ReturnType<typeof extractImportedSourceInfo>>,
): { title: string; type: EntityType; summary: string; tags: string[] } | undefined {
  const candidates = extractImportedKnowledgeTitleCandidates(content);
  const sourceKey = normalizeTitle(importedSource.title);
  const selected = candidates.find((candidate) => {
    const key = normalizeTitle(candidate);
    return key && key !== sourceKey;
  });
  if (!selected) return undefined;

  const type = inferEntityTypeFromKnowledgeText(selected);
  return {
    title: selected,
    type,
    summary: buildSourceSummary(importedSource.filename, content),
    tags: defaultTagsForEntityType(type),
  };
}

function extractImportedKnowledgeTitleCandidates(content: string) {
  const candidates = content
    .replace(/^#\s*导入文件[:：].*$/m, '')
    .replace(/^#\s*原始文件[:：].*$/m, '')
    .split(/\r?\n/)
    .flatMap((line) => {
      const isHeading = /^#{1,6}\s+\S/.test(line.trim());
      return splitCandidateLine(line)
        .map(cleanCandidateTitle)
        .filter(Boolean)
        .map((title) => ({ title, scoreBonus: isHeading ? 5 : 0 }));
    });

  const byTitle = new Map<string, number>();
  for (const candidate of candidates) {
    byTitle.set(candidate.title, Math.max(byTitle.get(candidate.title) ?? 0, candidate.scoreBonus));
  }

  return Array.from(byTitle.entries())
    .map(([title, scoreBonus]) => ({ title, score: scoreKnowledgeTitleCandidate(title) + scoreBonus }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.title.length - right.title.length)
    .map((item) => item.title)
    .slice(0, 12);
}

function splitCandidateLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const withoutHeading = trimmed.replace(/^#{1,6}\s+/, '');
  return withoutHeading
    .split(/\s*[|｜\t]\s*/)
    .flatMap((part) => part.split(/\s{2,}/))
    .map((part) => part.trim());
}

function cleanCandidateTitle(value: string) {
  return value
    .replace(/^[-*+\d.、\s]+/, '')
    .replace(/^[：:]+|[：:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

function scoreKnowledgeTitleCandidate(value: string) {
  const title = value.trim();
  if (title.length < 4 || title.length > 96) return -10;
  if (/^(来源格式|文件大小|内容指纹|采集状态|导入文件|原始文件|工作表|Sheet\d*|第\s*\d+\s*页|--\s*\d+\s+of\s+\d+)/i.test(title)) {
    return -10;
  }
  if (/^\d+(?:[.,]\d+)?$/.test(title)) return -10;
  if (/^[|｜\-.·\s]+$/.test(title)) return -10;

  let score = 0;
  if (/(项目|可研|报告|方案|测算|计划|规划|平台|系统|业务|模型|疗法|技术|Project|Study|Report|Plan|Platform|System)/i.test(title)) {
    score += 6;
  }
  if (/(目标|习惯|复盘|日记|goal|habit|reflection|journal)/i.test(title)) score += 4;
  if (/(摘要|结论|建议|风险|指标|收入|成本|投资|面积)/i.test(title)) score += 2;
  if (/[:：]/.test(title)) score -= 1;
  if (title.length <= 48) score += 1;
  return score;
}

function inferEntityTypeFromKnowledgeText(value: string): EntityType {
  if (/(项目|可研|方案|测算|计划|规划|执行框架|落地执行|Project|Study|Plan)/i.test(value)) return 'project';
  if (/(会议|纪要|访谈|meeting|minutes|interview)/i.test(value)) return 'event';
  return 'topic';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeUniqueStrings(left: string[], right: string[]) {
  return Array.from(new Set([...left, ...right].map((item) => item.trim()).filter(Boolean)));
}

function confidenceToNumber(confidence: CaptureAnalysis['claims'][number]['confidence']) {
  if (confidence === 'high') return 0.9;
  if (confidence === 'low') return 0.45;
  return 0.65;
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

  if (type === 'UPDATE_ENTITY_CATEGORIES') {
    return {
      type,
      entityTitle: stringValue(raw.entityTitle),
      categories: toArray<Record<string, unknown>>(raw.categories)
        .map((category) => ({
          name: stringValue(category.name),
          aliases: toArray(category.aliases).map((alias) => String(alias).trim()).filter(Boolean),
          items: toArray<Record<string, unknown> | string>(category.items)
            .map((item) => {
              if (typeof item === 'string') return { title: item.trim() };
              return {
                title: stringValue(item.title),
                kind: stringValue(item.kind) || undefined,
                summary: stringValue(item.summary) || undefined,
                evidence: stringValue(item.evidence) || undefined,
              };
            })
            .filter((item) => item.title && !isLikelyListNoise(item.title)),
          evidence: stringValue(category.evidence) || undefined,
        }))
        .filter((category) => category.name && category.items.length > 0),
      evidence: stringValue(raw.evidence),
      confidence: clamp(Number(raw.confidence) || 0.65, 0, 1),
    };
  }

  if (type === 'UPDATE_ENTITY_INDICATORS') {
    return {
      type,
      entityTitle: stringValue(raw.entityTitle),
      indicators: toArray<Record<string, unknown>>(raw.indicators)
        .map((indicator) => ({
          name: stringValue(indicator.name),
          value: parseIndicatorValue(indicator.value),
          rawValue: stringValue(indicator.rawValue) || undefined,
          unit: stringValue(indicator.unit) || undefined,
          businessLine: stringValue(indicator.businessLine) || undefined,
          categoryName: stringValue(indicator.categoryName) || undefined,
          source: {
            page: Number.isFinite(Number(indicator.page ?? (indicator.source as Record<string, unknown> | undefined)?.page))
              ? Number(indicator.page ?? (indicator.source as Record<string, unknown> | undefined)?.page)
              : undefined,
            section: stringValue(indicator.section ?? (indicator.source as Record<string, unknown> | undefined)?.section) || undefined,
            excerpt: stringValue(indicator.excerpt ?? (indicator.source as Record<string, unknown> | undefined)?.excerpt) || undefined,
          },
          confidence: pickEnum(indicator.confidence, confidenceLevels, 'medium'),
          note: stringValue(indicator.note) || undefined,
          asOfDate: stringValue(indicator.asOfDate) || undefined,
        }))
        .filter((indicator) => indicator.name && indicator.confidence),
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

function mergeDraftCategories(
  existing: NonNullable<DraftEntity['categories']>,
  incoming: NonNullable<DraftEntity['categories']>,
) {
  const byName = new Map<string, NonNullable<DraftEntity['categories']>[number]>();
  for (const category of existing) byName.set(normalizeTitle(category.name), category);
  for (const category of incoming) {
    const key = normalizeTitle(category.name);
    const current = byName.get(key);
    byName.set(key, {
      ...current,
      ...category,
      aliases: Array.from(new Set([...(current?.aliases ?? []), ...(category.aliases ?? []), category.name].filter(Boolean))),
      items: mergeDraftCategoryItems([...(current?.items ?? []), ...(category.items ?? [])]),
      evidence: category.evidence ?? current?.evidence,
    });
  }
  return Array.from(byName.values());
}

function mergeDraftCategoryItems(items: NonNullable<DraftEntity['categories']>[number]['items']) {
  const byTitle = new Map<string, NonNullable<DraftEntity['categories']>[number]['items'][number]>();
  for (const item of items) {
    const title = item.title.trim();
    if (!title || isLikelyListNoise(title)) continue;
    const key = normalizeTitle(title);
    byTitle.set(key, { ...byTitle.get(key), ...item, title });
  }
  return Array.from(byTitle.values());
}

function mergeDraftIndicators(
  existing: NonNullable<DraftEntity['indicators']>,
  incoming: NonNullable<DraftEntity['indicators']>,
) {
  const byKey = new Map<string, NonNullable<DraftEntity['indicators']>[number]>();
  for (const indicator of existing) byKey.set(draftIndicatorKey(indicator), indicator);
  for (const indicator of incoming) {
    const key = draftIndicatorKey(indicator);
    const current = byKey.get(key);
    const shouldUseIncomingValue = !current || indicator.value !== null || current.value === null;
    byKey.set(key, {
      ...current,
      ...indicator,
      value: shouldUseIncomingValue ? indicator.value : current?.value ?? null,
      rawValue: shouldUseIncomingValue ? indicator.rawValue : current?.rawValue,
      unit: shouldUseIncomingValue ? indicator.unit : current?.unit,
      source: indicator.source ?? current?.source,
      note: indicator.note ?? current?.note,
      confidence: current ? betterIndicatorConfidence(current.confidence, indicator.confidence) : indicator.confidence,
    });
  }
  return Array.from(byKey.values());
}

function draftIndicatorKey(indicator: Pick<NonNullable<DraftEntity['indicators']>[number], 'name' | 'businessLine' | 'categoryName'>) {
  return [
    normalizeTitle(indicator.businessLine ?? ''),
    normalizeTitle(indicator.categoryName ?? ''),
    normalizeTitle(indicator.name),
  ].join(':');
}

function betterIndicatorConfidence(
  left: NonNullable<DraftEntity['indicators']>[number]['confidence'],
  right: NonNullable<DraftEntity['indicators']>[number]['confidence'],
) {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return rank[right] > rank[left] ? right : left;
}

function isLikelyListNoise(value: string) {
  return /(\.{3,}|…{2,}|-{2,}|\bof\s+\d+\b|目录|页码|第\s*\d+\s*页)/i.test(value);
}

function parseBestJson(text: string, options: { repair?: boolean } = {}) {
  const withoutFence = text.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const candidates = extractJsonCandidates(withoutFence);
  if (candidates.length === 0) {
    throw new Error('LLM did not return a JSON object.');
  }

  let lastError: unknown;
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(cleanJsonCandidate(candidate)) as unknown;
    } catch (error) {
      lastError = error;
      if (!options.repair) continue;
      try {
        return JSON.parse(repairLooseJsonCandidate(candidate)) as unknown;
      } catch (repairError) {
        lastError = repairError;
      }
    }
  }

  throw new Error(`模型返回的结构化 JSON 仍不合法，请重试或换一个 Wiki 编译模型。${lastError instanceof Error ? `原始错误：${lastError.message}` : ''}`);
}

function cleanJsonCandidate(value: string) {
  return normalizeJsonSyntaxOutsideStrings(value).replace(/,\s*([}\]])/g, '$1');
}

function repairLooseJsonCandidate(value: string) {
  let repaired = cleanJsonCandidate(value);
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
    repaired = cleanJsonCandidate(next);
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

function extractJsonCandidates(text: string) {
  const candidates: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
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
      inString = true;
      escaped = false;
      continue;
    }

    const expectedClose = openingJsonBracketClose(char);
    if (expectedClose) {
      if (stack.length === 0) start = index;
      stack.push(expectedClose);
      continue;
    }

    if (stack.length > 0 && char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0 && start !== -1) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function openingJsonBracketClose(char: string) {
  if (char === '{' || char === '｛') return char === '{' ? '}' : '｝';
  if (char === '[' || char === '［' || char === '【') return char === '[' ? ']' : char === '［' ? '］' : '】';
  return '';
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

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
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
  'UPDATE_ENTITY_CATEGORIES',
  'UPDATE_ENTITY_INDICATORS',
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
