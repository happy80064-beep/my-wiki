import type { EntityCategory, EntityType, RelationshipType, Scene, TaskStatus } from '@/types';

export type DraftEntity = {
  clientId: string;
  type: EntityType;
  title: string;
  summary: string;
  tags: string[];
  scenes: Scene[];
  categories?: Array<Omit<EntityCategory, 'updatedAt'>>;
};

export type DraftRelationship = {
  clientId: string;
  fromClientId: string;
  toClientId: string;
  type: RelationshipType;
};

export type DraftTask = {
  clientId: string;
  description: string;
  ownerClientId: string;
  linkedToClientIds: string[];
  dueDate?: string;
  status: TaskStatus;
};

export type DraftCompileSuggestion = {
  clientId: string;
  entityClientId: string;
  entityTitle: string;
  propertyKey: string;
  propertyLabel: string;
  propertyValue: string;
  evidenceSnippet: string;
  confidence: number;
};

export type CaptureDraft = {
  primaryEntity: DraftEntity;
  relatedEntities: DraftEntity[];
  relationships: DraftRelationship[];
  tasks: DraftTask[];
  compileSuggestions?: DraftCompileSuggestion[];
};

let draftIdSeed = 0;

export function createDraftId(prefix: string) {
  draftIdSeed += 1;
  return `${prefix}_${draftIdSeed}`;
}

export function getDraftEntities(draft: CaptureDraft) {
  return [draft.primaryEntity, ...draft.relatedEntities];
}

export function createLocalCaptureDraft(content: string): CaptureDraft {
  const cleaned = content.trim();
  const personTitle = extractPersonTitle(cleaned);
  const projectTitle = extractProjectTitle(cleaned);
  const primaryType = inferPrimaryType(cleaned, projectTitle);

  const primaryEntity: DraftEntity = {
    clientId: createDraftId('entity'),
    type: primaryType,
    title: inferPrimaryTitle(cleaned, primaryType, projectTitle),
    summary: cleaned.slice(0, 120),
    tags: inferTags(cleaned),
    scenes: ['work'],
  };

  const relatedEntities: DraftEntity[] = [];
  let personEntity: DraftEntity | undefined;
  let projectEntity: DraftEntity | undefined;

  if (personTitle && primaryEntity.title !== personTitle) {
    personEntity = {
      clientId: createDraftId('entity'),
      type: 'person',
      title: personTitle,
      summary: `${personTitle} 在本次捕获内容中被提及。`,
      tags: ['人物'],
      scenes: ['work'],
    };
    relatedEntities.push(personEntity);
  }

  if (projectTitle && primaryEntity.title !== projectTitle) {
    projectEntity = {
      clientId: createDraftId('entity'),
      type: 'project',
      title: projectTitle,
      summary: `${projectTitle} 相关事项。`,
      tags: ['项目'],
      scenes: ['work'],
    };
    relatedEntities.push(projectEntity);
  }

  const relationships = createDraftRelationships(primaryEntity, personEntity, projectEntity);
  const tasks = createDraftTasks(cleaned, personEntity ?? primaryEntity, projectEntity ?? primaryEntity);

  return { primaryEntity, relatedEntities, relationships, tasks, compileSuggestions: [] };
}

function inferPrimaryType(content: string, projectTitle?: string): EntityType {
  if (/(会议|会|同步|沟通|约了|聊了|讨论)/.test(content)) {
    return 'event';
  }
  if (projectTitle) {
    return 'project';
  }
  if (/(认识|朋友|同事|客户)/.test(content)) {
    return 'person';
  }
  return 'topic';
}

function inferPrimaryTitle(content: string, type: EntityType, projectTitle?: string) {
  if (type === 'event' && projectTitle) {
    return `${projectTitle}同步`;
  }
  if (type === 'project' && projectTitle) {
    return projectTitle;
  }
  if (type === 'person') {
    return extractPersonTitle(content) ?? '未命名人员';
  }
  return content.slice(0, 20) || '未命名主题';
}

function extractPersonTitle(content: string) {
  const titleMatch = content.match(/[\u4e00-\u9fa5A-Za-z]{1,8}总(?!结)/);
  if (titleMatch) {
    return titleMatch[0];
  }

  const withPerson = content.match(/(?:和|跟|向|找)([\u4e00-\u9fa5A-Za-z]{1,8})(?:约|聊|同步|沟通|确认|开|说)/);
  return withPerson?.[1];
}

function extractProjectTitle(content: string) {
  const projectMatch = content.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,18})项目/);
  return projectMatch?.[1];
}

function inferTags(content: string) {
  const tags = new Set<string>();
  if (/(会议|同步|沟通|讨论)/.test(content)) tags.add('会议');
  if (/(任务|确认|需要|待办|这周|下周)/.test(content)) tags.add('承诺');
  if (/项目/.test(content)) tags.add('项目');
  return [...tags].slice(0, 4);
}

function createDraftRelationships(
  primary: DraftEntity,
  person?: DraftEntity,
  project?: DraftEntity,
): DraftRelationship[] {
  const relationships: DraftRelationship[] = [];

  if (person && project) {
    relationships.push({
      clientId: createDraftId('rel'),
      fromClientId: person.clientId,
      toClientId: project.clientId,
      type: 'participant',
    });
  }

  if (primary.type === 'event') {
    if (person) {
      relationships.push({
        clientId: createDraftId('rel'),
        fromClientId: person.clientId,
        toClientId: primary.clientId,
        type: 'attendee',
      });
    }
    if (project) {
      relationships.push({
        clientId: createDraftId('rel'),
        fromClientId: primary.clientId,
        toClientId: project.clientId,
        type: 'about',
      });
    }
  }

  return relationships;
}

function createDraftTasks(content: string, owner: DraftEntity, linkedEntity: DraftEntity): DraftTask[] {
  const taskDescriptions = extractTaskDescriptions(content);
  return taskDescriptions.map((description) => ({
    clientId: createDraftId('task'),
    description,
    ownerClientId: owner.clientId,
    linkedToClientIds: [linkedEntity.clientId],
    dueDate: inferDueDate(content),
    status: 'pending',
  }));
}

function extractTaskDescriptions(content: string) {
  const results: string[] = [];
  const actionMatches = content.matchAll(/(?:确认|需要|要|负责|推进|完成)([^，。,；;]{2,24})/g);

  for (const match of actionMatches) {
    const description = normalizeTaskDescription(match[1]);
    if (description) {
      results.push(description);
    }
  }

  if (results.length === 0 && /(这周|下周|明天|今天|待办|任务)/.test(content)) {
    results.push(content.slice(0, 36));
  }

  return [...new Set(results)].slice(0, 5);
}

function normalizeTaskDescription(value?: string) {
  return value
    ?.replace(/^(这周内|本周内|下周开始|今天|明天)/, '')
    .replace(/^(把|将)/, '')
    .trim();
}

function inferDueDate(content: string) {
  if (/下周/.test(content)) return '下周';
  if (/(这周|本周)/.test(content)) return '本周内';
  if (/明天/.test(content)) return '明天';
  return undefined;
}
