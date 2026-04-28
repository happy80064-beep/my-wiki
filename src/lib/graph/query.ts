import {
  candidateResult,
  dedupeSources,
  emptyResult,
  entitySource,
  entrySource,
  formatFuzzyAnswer,
  formatOwnerTasksAnswer,
  formatProjectStatusAnswer,
  formatProjectTasksAnswer,
  formatRelatedEntitiesAnswer,
  taskSource,
} from './answer';
import {
  findEntityCandidates,
  fuzzyFindEntities,
  getEntriesByIds,
  getPendingTasksByOwner,
  getPendingTasksForProject,
  getRelatedEntities,
  getRelationshipsWithEntity,
} from './filter';
import { parseQueryIntent } from './queryIntent';
import type { StructuredQueryResult } from './types';
import type { Entity } from '@/types';

export type { QuerySource, StructuredQueryResult } from './types';

export async function runStructuredQuery(question: string): Promise<StructuredQueryResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return emptyResult('请输入一个问题。');
  }

  const intent = parseQueryIntent(trimmed);

  if (intent.type === 'my_pending_tasks') {
    return answerOwnerTasks(intent.entityName ?? '我', true);
  }

  if (intent.type === 'person_pending_tasks') {
    return answerOwnerTasks(intent.entityName, false);
  }

  if (intent.type === 'project_tasks') {
    return answerProjectTasks(intent.entityName, 'tasks');
  }

  if (intent.type === 'project_improvements') {
    return answerProjectTasks(intent.entityName, 'improvements');
  }

  if (intent.type === 'project_status') {
    return answerProjectStatus(intent.entityName);
  }

  if (intent.type === 'project_related_entities') {
    return answerProjectRelatedEntities(intent.entityName);
  }

  return answerFuzzySearch(trimmed);
}

async function answerOwnerTasks(personName: string | undefined, isSelf: boolean): Promise<StructuredQueryResult> {
  if (!personName) {
    return emptyResult('我还不能确定你问的是谁的任务。可以把人名写得更明确一点。');
  }

  const candidates = await findEntityCandidates(personName, ['person']);
  if (candidates.length === 0) {
    const name = isSelf ? '我' : personName;
    return emptyResult(`没有找到名为「${name}」的人员记录。`, ['先捕获一条包含任务负责人的记录', '查看知识库现有人员']);
  }

  if (candidates.length > 1) {
    return candidateResult('人员', candidates.map((candidate) => candidate.entity));
  }

  const owner = candidates[0].entity;
  const tasks = await getPendingTasksByOwner(owner.id);
  const entries = await getEntriesByIds(tasks.map((task) => task.source));

  return {
    answer: formatOwnerTasksAnswer(owner, tasks),
    sources: dedupeSources([entitySource(owner), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${owner.title}的人员页`, `继续问${owner.title}参与了哪些事项`],
  };
}

async function answerProjectTasks(
  projectName: string | undefined,
  mode: 'tasks' | 'improvements',
): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const tasks = await getPendingTasksForProject(project.entity.id);
  const entries = await getEntriesByIds(tasks.map((task) => task.source));

  return {
    answer: formatProjectTasksAnswer(project.entity, tasks, mode),
    sources: dedupeSources([entitySource(project.entity), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}相关工具`, `查看${project.entity.title}当前状态`],
  };
}

async function answerProjectStatus(projectName: string | undefined): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const tasks = await getPendingTasksForProject(project.entity.id);
  const entries = await getEntriesByIds([
    ...project.entity.sourceEntries,
    ...tasks.map((task) => task.source),
  ]);

  return {
    answer: formatProjectStatusAnswer(project.entity, tasks),
    sources: dedupeSources([entitySource(project.entity), ...tasks.map(taskSource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}下一阶段优化项`, `查看${project.entity.title}关联实体`],
  };
}

async function answerProjectRelatedEntities(projectName: string | undefined): Promise<StructuredQueryResult> {
  const project = await resolveSingleProject(projectName);
  if ('result' in project) return project.result;

  const relationships = await getRelationshipsWithEntity(project.entity.id);
  const relatedEntities = await getRelatedEntities(project.entity.id, relationships);
  const evidenceEntryIds = relationships.flatMap((relationship) => relationship.evidence);
  const entries = await getEntriesByIds(evidenceEntryIds);

  return {
    answer: formatRelatedEntitiesAnswer(project.entity, relationships, relatedEntities),
    sources: dedupeSources([entitySource(project.entity), ...relatedEntities.map(entitySource), ...entries.map(entrySource)]),
    suggestions: [`查看${project.entity.title}下一阶段优化项`, `查看${project.entity.title}未完成任务`],
  };
}

async function answerFuzzySearch(question: string): Promise<StructuredQueryResult> {
  const candidates = await fuzzyFindEntities(question);

  if (candidates.length === 0) {
    return emptyResult('没有找到相关记录。可以换一个更具体的人名、事项名或主题词。');
  }

  const entities = candidates.map((candidate) => candidate.entity);
  return {
    answer: formatFuzzyAnswer(entities),
    candidates: entities,
    sources: entities.map(entitySource),
    suggestions: ['打开相关实体查看详情', '换一个更具体的问题'],
  };
}

type ProjectResolution = { entity: Entity } | { result: StructuredQueryResult };

async function resolveSingleProject(projectName: string | undefined): Promise<ProjectResolution> {
  if (!projectName) {
    return {
      result: emptyResult('我还不能确定你问的是哪个事项。可以把事项名称写得更明确一点。', [
        '查看知识库现有事项',
        '换一个更完整的事项名再问',
      ]),
    };
  }

  const candidates = await findEntityCandidates(projectName, ['project']);
  if (candidates.length === 0) {
    return {
      result: emptyResult(`没有找到名为「${projectName}」的事项记录。`, [
        '先捕获一条包含该事项的记录',
        '查看知识库现有事项',
      ]),
    };
  }

  if (candidates.length > 1) {
    return {
      result: candidateResult('事项', candidates.map((candidate) => candidate.entity)),
    };
  }

  return { entity: candidates[0].entity };
}
