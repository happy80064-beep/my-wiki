import type { EntityType, RelationshipType, Scene, TaskStatus } from '@/types';

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
- 不确定、冲突或需要用户判断的内容放入 contradictions 或 recommendedUpdates。
- 不要生成数据库 ID，不要输出 markdown。`;
}

export function buildWikiPatchPrompt(content: string, analysis: CaptureAnalysis) {
  return `你是 MyWiki 的 WikiPatch 生成 Agent。你根据已完成的分析，生成可被代码校验的结构化 patch。

原始材料：
${content}

分析结果：
${JSON.stringify(analysis, null, 2)}

请只输出 JSON 数组，每一项必须符合以下 patch 类型之一：
- CREATE_ENTITY
- UPDATE_ENTITY_PROPERTY
- CREATE_RELATIONSHIP
- CREATE_TASK
- REVIEW_REQUIRED

约束：
- UPDATE_ENTITY_PROPERTY.propertyKey 只能使用：${allowedWikiPatchPropertyKeys.join(', ')}
- REVIEW_REQUIRED.options 只能从 Create Page / Update Existing / Skip 中选择。
- 每个 patch 都必须带 evidence，evidence 必须是原文中的短证据片段。
- 不要输出 markdown，不要输出解释。`;
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
