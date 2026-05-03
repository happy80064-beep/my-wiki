export type QueryIntentType =
  | 'person_pending_tasks'
  | 'my_pending_tasks'
  | 'project_tasks'
  | 'project_status'
  | 'project_improvements'
  | 'project_related_entities'
  | 'entity_relationship_path'
  | 'entity_profile'
  | 'fuzzy_memory';

export type QueryIntent = {
  type: QueryIntentType;
  entityName?: string;
  targetEntityName?: string;
  originalQuestion: string;
};

const taskWords = /(未完成|没完成|待办|任务|承诺|没兑现|待处理|todo)/i;
const improvementWords = /(下一阶段|后续|路线|短期优先级|优先级|优化|改进|重点问题|问题|需要.*做|需要.*处理|需要.*完善|需要.*强化)/;
const relatedEntityWords = /(用了哪些|使用哪些|依赖|相关.*工具|相关.*模型|相关.*组件|工具|模型|组件|技术栈|方案)/;
const statusWords = /(状态|进展|进度|当前情况|现在怎么样|做到了哪|完成情况)/;
const profileWords = /(叫什么|叫啥|名字|名称|是谁|是什么|介绍|讲讲|档案|信息|概况|总结)/;
const firstPersonWords = /(我|自己|本人)/;

export function parseQueryIntent(question: string): QueryIntent {
  const normalized = normalizeQuestion(question);
  const relationshipPair = extractRelationshipPair(normalized);

  if (relationshipPair) {
    return {
      type: 'entity_relationship_path',
      entityName: relationshipPair.from,
      targetEntityName: relationshipPair.to,
      originalQuestion: question,
    };
  }

  if (firstPersonWords.test(normalized) && taskWords.test(normalized)) {
    return { type: 'my_pending_tasks', entityName: '我', originalQuestion: question };
  }

  if (relatedEntityWords.test(normalized)) {
    return {
      type: 'project_related_entities',
      entityName: extractProjectName(normalized),
      originalQuestion: question,
    };
  }

  if (improvementWords.test(normalized)) {
    return {
      type: 'project_improvements',
      entityName: extractProjectName(normalized),
      originalQuestion: question,
    };
  }

  if (statusWords.test(normalized)) {
    return {
      type: 'project_status',
      entityName: extractProjectName(normalized),
      originalQuestion: question,
    };
  }

  if (profileWords.test(normalized)) {
    return {
      type: 'entity_profile',
      entityName: extractProjectName(normalized),
      originalQuestion: question,
    };
  }

  if (taskWords.test(normalized)) {
    const personName = extractPersonName(normalized);
    if (personName) {
      return { type: 'person_pending_tasks', entityName: personName, originalQuestion: question };
    }

    return {
      type: 'project_tasks',
      entityName: extractProjectName(normalized),
      originalQuestion: question,
    };
  }

  return {
    type: 'fuzzy_memory',
    entityName: extractProjectName(normalized),
    originalQuestion: question,
  };
}

function extractRelationshipPair(question: string) {
  const match = question.match(/^(.{1,40}?)(?:和|与|跟)(.{1,40}?)(?:有什么关系|是什么关系|关系是什么|有什么关联|如何关联|怎么关联|的关系)$/);
  if (!match?.[1] || !match[2]) return undefined;

  const from = cleanupName(match[1]);
  const to = cleanupName(match[2]);
  if (!from || !to) return undefined;

  return { from, to };
}

function normalizeQuestion(question: string) {
  return question
    .trim()
    .replace(/[？?。！!，,、]/g, '')
    .replace(/^(请问|帮我|帮忙|查一下|看一下|看看)/, '');
}

function extractPersonName(question: string) {
  const titleMatch = question.match(/([\u4e00-\u9fa5A-Za-z]{1,8}总)/);
  if (titleMatch) return titleMatch[1];

  const possessiveMatch = question.match(
    /([\u4e00-\u9fa5A-Za-z]{1,10})(?:有什么|有哪些|还有什么|的)(?:未完成|没完成|待办|任务|承诺|没兑现|待处理)/,
  );
  const candidate = possessiveMatch?.[1];
  if (!candidate || firstPersonWords.test(candidate)) return undefined;
  return cleanupName(candidate);
}

function extractProjectName(question: string) {
  const beforeIntent = question.split(
    /下一阶段|当前|短期优先级|优先级|推荐后续|后续|需要|有哪些|有什么|用了哪些|使用哪些|用了|使用|关联|相关|状态|进展|进度|任务|待办|未完成|没完成|重点问题|问题|叫什么|叫啥|名字|名称|是谁|是什么|介绍|讲讲|档案|信息|概况|总结/,
  )[0];

  const cleanedBefore = cleanupName(beforeIntent);
  if (cleanedBefore && cleanedBefore !== '这个项目' && cleanedBefore !== '该项目') {
    return cleanedBefore;
  }

  const cleaned = cleanupName(
    question
      .replace(improvementWords, '')
      .replace(relatedEntityWords, '')
      .replace(statusWords, '')
      .replace(profileWords, '')
      .replace(taskWords, ''),
  );

  if (!cleaned || cleaned === '这个项目' || cleaned === '该项目') return undefined;
  return cleaned;
}

function cleanupName(value: string) {
  return value
    .replace(/^(关于|项目|事项|这个|该)/, '')
    .replace(/(项目|事项|的|都)$/g, '')
    .replace(/\s+/g, '')
    .trim();
}
