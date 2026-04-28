import type { Entry, Entity, Relationship, Task } from '@/types';
import type { QuerySource, StructuredQueryResult } from './types';

export function emptyResult(answer: string, suggestions = ['先捕获一条会议记录', '查看知识库现有实体']): StructuredQueryResult {
  return {
    answer,
    sources: [],
    suggestions,
  };
}

export function candidateResult(kind: string, candidates: Entity[]): StructuredQueryResult {
  return {
    answer: `我找到了 ${candidates.length} 个可能的${kind}，需要先确认是哪一个。`,
    candidates,
    sources: candidates.map(entitySource),
    suggestions: ['换一个更完整的名称再问', '打开候选实体查看详情'],
  };
}

export function formatOwnerTasksAnswer(owner: Entity, tasks: Task[]) {
  if (tasks.length === 0) {
    return `${owner.title} 当前没有未完成任务。`;
  }

  return `${owner.title} 当前有 ${tasks.length} 个未完成任务：\n${formatTaskLines(tasks)}`;
}

export function formatProjectTasksAnswer(project: Entity, tasks: Task[], mode: 'tasks' | 'improvements') {
  if (tasks.length === 0) {
    const noun = mode === 'improvements' ? '需要优化或推进的任务' : '未完成任务';
    return `${project.title} 当前没有找到${noun}。`;
  }

  const heading = mode === 'improvements' ? '下一阶段主要需要优化或推进这些事项' : '当前未完成任务';
  return `${project.title}${heading}：\n${formatTaskLines(tasks)}`;
}

export function formatProjectStatusAnswer(project: Entity, tasks: Task[]) {
  const summary = project.summary ? `\n\n概况：${project.summary}` : '';
  const taskSummary =
    tasks.length > 0 ? `\n\n未完成任务：\n${formatTaskLines(tasks)}` : '\n\n当前没有找到未完成任务。';

  return `${project.title} 当前状态：${project.properties && 'status' in project.properties ? project.properties.status : '未标记'}${summary}${taskSummary}`;
}

export function formatRelatedEntitiesAnswer(project: Entity, relationships: Relationship[], relatedEntities: Entity[]) {
  if (relatedEntities.length === 0) {
    return `${project.title} 当前没有找到明确关联的工具、模型或组件。`;
  }

  const relationshipByEntityId = new Map<string, Relationship[]>();
  for (const relationship of relationships) {
    const otherId = relationship.from === project.id ? relationship.to : relationship.from;
    const list = relationshipByEntityId.get(otherId) ?? [];
    list.push(relationship);
    relationshipByEntityId.set(otherId, list);
  }

  const lines = relatedEntities.map((entity, index) => {
    const labels = Array.from(
      new Set((relationshipByEntityId.get(entity.id) ?? []).map((relationship) => relationshipTypeLabel(relationship.type))),
    );
    const relation = labels.length > 0 ? `，关系：${labels.join('、')}` : '';
    return `${index + 1}. ${entity.title}（${entityTypeLabel(entity.type)}${relation}）`;
  });

  return `${project.title} 当前关联了 ${relatedEntities.length} 个实体：\n${lines.join('\n')}`;
}

export function formatFuzzyAnswer(candidates: Entity[]) {
  const lines = candidates.map((candidate, index) => `${index + 1}. ${candidate.title}（${entityTypeLabel(candidate.type)}）`);
  return `找到 ${candidates.length} 条可能相关的实体：\n${lines.join('\n')}`;
}

export function entitySource(entity: Entity): QuerySource {
  return {
    type: 'entity',
    id: entity.id,
    title: entity.title,
    href: `/wiki/${entity.type}/${entity.id}`,
  };
}

export function taskSource(task: Task): QuerySource {
  return {
    type: 'task',
    id: task.id,
    title: task.description,
  };
}

export function entrySource(entry: Entry): QuerySource {
  return {
    type: 'entry',
    id: entry.id,
    title: entry.content.length > 28 ? `${entry.content.slice(0, 28)}...` : entry.content,
  };
}

export function dedupeSources(sources: QuerySource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type}:${source.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function relationshipTypeLabel(type: Relationship['type']) {
  const labels: Record<Relationship['type'], string> = {
    owner: '负责人',
    participant: '参与',
    stakeholder: '干系人',
    'decision-maker': '决策人',
    attendee: '参会',
    organizer: '组织',
    'mentioned-in': '被提及',
    colleague: '同事',
    friend: '朋友',
    family: '家人',
    mentor: '导师',
    'reports-to': '汇报',
    'parent-of': '父事项',
    'depends-on': '依赖',
    'related-to': '相关',
    about: '关于',
    'kicked-off': '启动',
    'relevant-to': '关联主题',
    mentions: '提及',
  };

  return labels[type];
}

function formatTaskLines(tasks: Task[]) {
  return tasks
    .map((task, index) => {
      const due = task.dueDate ? `，截止：${task.dueDate}` : '';
      return `${index + 1}. ${task.description}${due}`;
    })
    .join('\n');
}

function entityTypeLabel(type: Entity['type']) {
  const labels: Record<Entity['type'], string> = {
    person: '人员',
    project: '事项',
    event: '互动',
    topic: '主题',
  };

  return labels[type];
}
