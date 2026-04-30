import { db } from '@/lib/db';
import type { CompileSuggestionRecord, Entity, Relationship, Task } from '@/types';

export type WikiLintSeverity = 'info' | 'warning' | 'error';

export type WikiLintIssue = {
  id: string;
  type:
    | 'orphan-entity'
    | 'missing-source'
    | 'broken-relationship'
    | 'pending-compile-suggestion'
    | 'stale-task';
  severity: WikiLintSeverity;
  title: string;
  detail: string;
  entityId?: string;
  relationshipId?: string;
  taskId?: string;
  suggestionId?: string;
};

export type WikiLintReport = {
  generatedAt: number;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  issues: WikiLintIssue[];
};

export async function runWikiLint(): Promise<WikiLintReport> {
  const [entities, relationships, tasks, compileSuggestions] = await Promise.all([
    db.entities.toArray(),
    db.relationships.toArray(),
    db.tasks.toArray(),
    db.compileSuggestions.toArray(),
  ]);

  return buildWikiLintReport({ entities, relationships, tasks, compileSuggestions });
}

export function buildWikiLintReport({
  entities,
  relationships,
  tasks,
  compileSuggestions,
}: {
  entities: Entity[];
  relationships: Relationship[];
  tasks: Task[];
  compileSuggestions: CompileSuggestionRecord[];
}): WikiLintReport {
  const entityIds = new Set(entities.map((entity) => entity.id));
  const degreeByEntity = new Map<string, number>();
  const issues: WikiLintIssue[] = [];

  for (const relationship of relationships) {
    if (!entityIds.has(relationship.from) || !entityIds.has(relationship.to)) {
      issues.push({
        id: `broken-relationship:${relationship.id}`,
        type: 'broken-relationship',
        severity: 'error',
        title: '断裂关系',
        detail: `关系 ${relationship.type} 指向了不存在的实体。`,
        relationshipId: relationship.id,
      });
      continue;
    }

    degreeByEntity.set(relationship.from, (degreeByEntity.get(relationship.from) ?? 0) + 1);
    degreeByEntity.set(relationship.to, (degreeByEntity.get(relationship.to) ?? 0) + 1);
  }

  for (const entity of entities) {
    if ((degreeByEntity.get(entity.id) ?? 0) === 0) {
      issues.push({
        id: `orphan-entity:${entity.id}`,
        type: 'orphan-entity',
        severity: 'warning',
        title: '孤立实体',
        detail: `「${entity.title}」还没有任何关系连接。`,
        entityId: entity.id,
      });
    }

    if (entity.sourceEntries.length === 0) {
      issues.push({
        id: `missing-source:${entity.id}`,
        type: 'missing-source',
        severity: 'warning',
        title: '缺少来源',
        detail: `「${entity.title}」没有可追溯的原始捕获。`,
        entityId: entity.id,
      });
    }
  }

  for (const task of tasks) {
    if (task.status === 'pending' && task.createdAt < Date.now() - 1000 * 60 * 60 * 24 * 30) {
      issues.push({
        id: `stale-task:${task.id}`,
        type: 'stale-task',
        severity: 'info',
        title: '长期未处理任务',
        detail: `任务「${task.description}」已超过 30 天仍未完成。`,
        taskId: task.id,
      });
    }
  }

  for (const suggestion of compileSuggestions.filter((item) => item.status === 'pending')) {
    issues.push({
      id: `pending-compile-suggestion:${suggestion.id}`,
      type: 'pending-compile-suggestion',
      severity: 'info',
      title: '待编译项未确认',
      detail: `「${suggestion.entityTitle}」的「${suggestion.propertyLabel}」等待确认写回。`,
      entityId: suggestion.entityId,
      suggestionId: suggestion.id,
    });
  }

  const summary = {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length,
  };

  return {
    generatedAt: Date.now(),
    summary,
    issues: issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
  };
}

function severityRank(severity: WikiLintSeverity) {
  if (severity === 'error') return 3;
  if (severity === 'warning') return 2;
  return 1;
}
