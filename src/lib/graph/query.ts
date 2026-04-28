import { db } from '@/lib/db';
import type { Entity, Task } from '@/types';

export type QuerySource = {
  type: 'entity' | 'task' | 'entry';
  id: string;
  title: string;
  href?: string;
};

export type StructuredQueryResult = {
  answer: string;
  sources: QuerySource[];
  suggestions: string[];
  candidates?: Entity[];
};

export async function runStructuredQuery(question: string): Promise<StructuredQueryResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return emptyResult('请输入一个问题。');
  }

  if (isPendingTaskQuestion(trimmed)) {
    return answerPendingTasks(trimmed);
  }

  return answerFuzzySearch(trimmed);
}

async function answerPendingTasks(question: string): Promise<StructuredQueryResult> {
  const personName = extractPersonName(question);
  if (!personName) {
    return emptyResult('我还不能确定你问的是谁的任务。可以把人名写得更明确一点。');
  }

  const candidates = await db.entities
    .where('type')
    .equals('person')
    .filter((entity) => entity.title.includes(personName) || personName.includes(entity.title))
    .toArray();

  if (candidates.length === 0) {
    return emptyResult(`没有找到名为「${personName}」的人员记录。`);
  }

  if (candidates.length > 1) {
    return {
      answer: `我找到了 ${candidates.length} 个可能的人，需要先确认是哪一个。`,
      candidates,
      sources: candidates.map(entitySource),
      suggestions: ['查看这些候选人的最近互动', '换一个更完整的人名再问'],
    };
  }

  const owner = candidates[0];
  const tasks = await db.tasks
    .where('owner')
    .equals(owner.id)
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .toArray();

  if (tasks.length === 0) {
    return {
      answer: `${owner.title} 当前没有未完成任务。`,
      sources: [entitySource(owner)],
      suggestions: [`查看${owner.title}的互动记录`, `查看${owner.title}参与的事项`],
    };
  }

  return {
    answer: formatTaskAnswer(owner, tasks),
    sources: [entitySource(owner), ...tasks.map(taskSource)],
    suggestions: [`查看${owner.title}的人员页`, '继续问这些任务关联到哪些事项'],
  };
}

async function answerFuzzySearch(question: string): Promise<StructuredQueryResult> {
  const entities = await db.entities
    .filter((entity) => entity.title.includes(question) || entity.summary.includes(question))
    .limit(5)
    .toArray();

  if (entities.length === 0) {
    return emptyResult('没有找到相关记录。当前最小查询闭环优先支持“某人的未完成任务”。');
  }

  return {
    answer: `找到 ${entities.length} 条可能相关的实体。`,
    sources: entities.map(entitySource),
    suggestions: ['打开相关实体查看详情', '换一个更具体的问题'],
  };
}

function isPendingTaskQuestion(question: string) {
  return /(未完成|没完成|待办|任务|承诺|没兑现)/.test(question);
}

function extractPersonName(question: string) {
  const titleMatch = question.match(/([\u4e00-\u9fa5A-Za-z]{1,8}总)/);
  if (titleMatch) return titleMatch[1];

  const possessiveMatch = question.match(/([\u4e00-\u9fa5A-Za-z]{1,8})(?:有什么|有哪些|的)(?:未完成|没完成|待办|任务|承诺)/);
  return possessiveMatch?.[1];
}

function formatTaskAnswer(owner: Entity, tasks: Task[]) {
  const lines = tasks.map((task, index) => {
    const due = task.dueDate ? `，截止：${task.dueDate}` : '';
    return `${index + 1}. ${task.description}${due}`;
  });
  return `${owner.title} 当前有 ${tasks.length} 个未完成任务：\n${lines.join('\n')}`;
}

function entitySource(entity: Entity): QuerySource {
  return {
    type: 'entity',
    id: entity.id,
    title: entity.title,
    href: `/wiki/${entity.type}/${entity.id}`,
  };
}

function taskSource(task: Task): QuerySource {
  return {
    type: 'task',
    id: task.id,
    title: task.description,
  };
}

function emptyResult(answer: string): StructuredQueryResult {
  return {
    answer,
    sources: [],
    suggestions: ['先捕获一条会议记录', '查看知识库现有实体'],
  };
}
