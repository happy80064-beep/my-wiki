import { Save, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useParams } from 'react-router';
import { RelationshipGraph } from '@/components/wiki/RelationshipGraph';
import { getSubgraph, relationshipTypeLabel } from '@/lib/graph';
import { deleteRelationship, deleteTask, updateEntity, updateRelationship, updateTask, db } from '@/lib/db';
import { refreshCompiledProfile, refreshCompiledProfiles } from '@/lib/wikiIndex';
import type {
  Entity,
  EntityType,
  PersonProps,
  ProjectProps,
  Relationship,
  RelationshipType,
  Task,
  TaskStatus,
  TopicProps,
} from '@/types';

const entityTypeLabels: Record<EntityType, string> = {
  person: '人员',
  project: '事项',
  event: '互动',
  topic: '主题',
};

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

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function EntityPage() {
  const { id } = useParams();
  const [graphDepth, setGraphDepth] = useState(1);
  const entity = useLiveQuery(() => (id ? db.entities.get(id) : undefined), [id]);
  const relationships = useLiveQuery(
    () =>
      id
        ? db.relationships
            .filter((relationship) => relationship.from === id || relationship.to === id)
            .toArray()
        : [],
    [id],
    [],
  );
  const tasks = useLiveQuery(
    () =>
      id
        ? db.tasks
            .filter((task) => task.owner === id || task.linkedTo.includes(id))
            .toArray()
        : [],
    [id],
    [],
  );
  const allEntities = useLiveQuery(() => db.entities.toArray(), [], []);
  const subgraph = useLiveQuery(() => (id ? getSubgraph(id, graphDepth) : undefined), [id, graphDepth]);
  const entityTitleById = useMemo(
    () => new Map(allEntities.map((item) => [item.id, item.title])),
    [allEntities],
  );

  if (entity === undefined) {
    return (
      <section className="mx-auto max-w-4xl px-5 py-8">
        <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-5 text-sm text-[#626965]">
          正在读取实体...
        </div>
      </section>
    );
  }

  if (!entity) {
    return (
      <section className="mx-auto max-w-4xl px-5 py-8">
        <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <p className="text-sm text-[#626965]">没有找到这个实体。</p>
          <Link to="/wiki" className="mt-4 inline-flex text-sm text-[#155eef]">
            返回知识库
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl px-5 py-8">
      <Link to="/wiki" className="text-sm text-[#155eef]">
        返回知识库
      </Link>
      <EntityEditor entity={entity} />
      <EntityTypePanel entity={entity} tasks={tasks} relatedEntities={allEntities} />
      <SourceEntries entity={entity} />

      <div className="mt-5">
        <RelationshipGraph
          centerEntity={entity}
          relationships={subgraph?.edges ?? relationships}
          entities={subgraph?.nodes ?? [entity]}
          depth={graphDepth}
          onDepthChange={setGraphDepth}
        />
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <section className="rounded-[12px] border border-[#e5e5e4] bg-white">
          <div className="border-b border-[#e5e5e4] px-4 py-3">
            <h3 className="text-sm font-semibold text-[#1f2937]">关系</h3>
          </div>
          {relationships.length === 0 ? (
            <p className="px-4 py-5 text-sm text-[#626965]">暂无关系。</p>
          ) : (
            <div className="divide-y divide-[#eeeeed]">
              {relationships.map((relationship) => (
                <RelationshipEditor key={relationship.id} relationship={relationship} entities={allEntities} />
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[12px] border border-[#e5e5e4] bg-white">
          <div className="border-b border-[#e5e5e4] px-4 py-3">
            <h3 className="text-sm font-semibold text-[#1f2937]">相关任务</h3>
          </div>
          {tasks.length === 0 ? (
            <p className="px-4 py-5 text-sm text-[#626965]">暂无任务。</p>
          ) : (
            <div className="divide-y divide-[#eeeeed]">
              {tasks.map((task) => (
                <TaskEditor key={task.id} task={task} entities={allEntities} entityTitleById={entityTitleById} />
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function EntityTypePanel({
  entity,
  tasks,
  relatedEntities,
}: {
  entity: Entity;
  tasks: Task[];
  relatedEntities: Entity[];
}) {
  if (entity.type === 'person') {
    return <PersonPanel entity={entity} tasks={tasks} />;
  }
  if (entity.type === 'project') {
    return <ProjectPanel entity={entity} tasks={tasks} relatedEntities={relatedEntities} />;
  }
  if (entity.type === 'topic') {
    return <TopicPanel entity={entity} />;
  }
  return <EventPanel entity={entity} />;
}

function PersonPanel({ entity, tasks }: { entity: Entity; tasks: Task[] }) {
  const props = entity.properties as PersonProps;
  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  return (
    <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <h3 className="text-sm font-semibold text-[#1f2937]">人员状态</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <InfoTile label="最近联系" value={props.lastContactAt ? new Date(props.lastContactAt).toLocaleDateString() : '暂无'} />
        <InfoTile label="未完成任务" value={`${openTasks.length}`} />
        <InfoTile label="来源记录" value={`${entity.sourceEntries.length}`} />
      </div>
    </section>
  );
}

function ProjectPanel({ entity, tasks, relatedEntities }: { entity: Entity; tasks: Task[]; relatedEntities: Entity[] }) {
  const props = entity.properties as ProjectProps;
  const [status, setStatus] = useState(props.status);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');

  useEffect(() => {
    setStatus(props.status);
    setSaveState('idle');
  }, [entity.id]);

  async function handleSave() {
    setSaveState('saving');
    try {
      await updateEntity(entity.id, {
        properties: {
          ...props,
          status,
        },
      });
      await refreshCompiledProfile(entity.id);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">事项状态</h3>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveState === 'saving'}
          className="rounded-full bg-[#155eef] px-3 py-1.5 text-xs text-white disabled:bg-[#a8b7d8]"
        >
          {saveState === 'saving' ? '保存中...' : '保存状态'}
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <Field label="状态">
          <Select
            value={status}
            options={[
              ['active', 'active'],
              ['paused', 'paused'],
              ['done', 'done'],
              ['archived', 'archived'],
            ]}
            onChange={(value) => setStatus(value as ProjectProps['status'])}
          />
        </Field>
        <InfoTile label="未完成任务" value={`${openTasks.length}`} />
        <InfoTile label="关联实体" value={`${relatedEntities.length}`} />
        <InfoTile label="来源记录" value={`${entity.sourceEntries.length}`} />
      </div>
      <SaveFeedback state={saveState} savedText="事项状态已保存。" />
    </section>
  );
}

function TopicPanel({ entity }: { entity: Entity }) {
  const props = entity.properties as TopicProps;
  const [myView, setMyView] = useState(props.myView ?? '');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setMyView(props.myView ?? '');
    setSaveState('idle');
  }, [entity.id]);

  async function handleSave() {
    setSaveState('saving');
    try {
      await updateEntity(entity.id, {
        properties: {
          ...props,
          myView,
          viewHistory: props.myView
            ? [...(props.viewHistory ?? []), { view: props.myView, updatedAt: Date.now() }]
            : props.viewHistory,
        },
      });
      await refreshCompiledProfile(entity.id);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">主题编译</h3>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveState === 'saving'}
          className="rounded-full bg-[#155eef] px-3 py-1.5 text-xs text-white disabled:bg-[#a8b7d8]"
        >
          {saveState === 'saving' ? '保存中...' : '保存观点'}
        </button>
      </div>
      <textarea
        value={myView}
        onChange={(event) => {
          setMyView(event.target.value);
          setSaveState('idle');
        }}
        className="mt-3 min-h-24 w-full resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
        placeholder="我的核心观点"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {props.autoCollectedSnippets.map((entryId, index) => (
          <Link key={entryId} to={`/entries/${entryId}`} className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#155eef]">
            素材 {index + 1}
          </Link>
        ))}
      </div>
      <SaveFeedback state={saveState} savedText="主题观点已保存。" />
    </section>
  );
}

function EventPanel({ entity }: { entity: Entity }) {
  return (
    <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <h3 className="text-sm font-semibold text-[#1f2937]">互动信息</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <InfoTile label="发生时间" value={new Date((entity.properties as { occurredAt?: number }).occurredAt ?? entity.createdAt).toLocaleString()} />
        <InfoTile label="来源记录" value={`${entity.sourceEntries.length}`} />
      </div>
    </section>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[#eeeeed] bg-[#fbfbfa] px-3 py-2">
      <p className="text-xs text-[#626965]">{label}</p>
      <p className="mt-1 text-sm font-medium text-[#1f2937]">{value}</p>
    </div>
  );
}

function SourceEntries({ entity }: { entity: Entity }) {
  if (entity.sourceEntries.length === 0) return null;

  return (
    <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <h3 className="text-sm font-semibold text-[#1f2937]">来源原文</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {entity.sourceEntries.map((entryId, index) => (
          <Link
            key={entryId}
            to={`/entries/${entryId}`}
            className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#155eef]"
          >
            原文 {index + 1}
          </Link>
        ))}
      </div>
    </section>
  );
}

function RelationshipEditor({ relationship, entities }: { relationship: Relationship; entities: Entity[] }) {
  const [from, setFrom] = useState(relationship.from);
  const [to, setTo] = useState(relationship.to);
  const [type, setType] = useState<RelationshipType>(relationship.type);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setFrom(relationship.from);
    setTo(relationship.to);
    setType(relationship.type);
    setSaveState('idle');
  }, [relationship.id]);

  async function handleSave() {
    setSaveState('saving');
    try {
      await updateRelationship(relationship.id, { from, to, type });
      await refreshCompiledProfiles([from, to]);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function handleDelete() {
    await deleteRelationship(relationship.id);
  }

  return (
    <div className="px-4 py-3 text-sm">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
        <Field label="起点">
          <Select
            value={from}
            options={entities.map((entity) => [entity.id, entity.title])}
            onChange={(value) => {
              setFrom(value);
              setSaveState('idle');
            }}
          />
        </Field>
        <Field label="关系">
          <Select
            value={type}
            options={relationshipTypes.map((relationshipType) => [
              relationshipType,
              relationshipTypeLabel(relationshipType),
            ])}
            onChange={(value) => {
              setType(value as RelationshipType);
              setSaveState('idle');
            }}
          />
        </Field>
        <Field label="终点">
          <Select
            value={to}
            options={entities.map((entity) => [entity.id, entity.title])}
            onChange={(value) => {
              setTo(value);
              setSaveState('idle');
            }}
          />
        </Field>
        <div className="flex items-end justify-end">
          <IconButton label="保存关系" onClick={handleSave}>
            <Save size={15} />
          </IconButton>
        </div>
        <div className="flex items-end justify-end">
          <IconButton label="删除关系" onClick={handleDelete}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      <SaveFeedback state={saveState} savedText="关系已保存。" />
      {relationship.evidence.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {relationship.evidence.map((entryId, index) => (
            <Link
              key={entryId}
              to={`/entries/${entryId}`}
              className="rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs text-[#155eef]"
            >
              证据 {index + 1}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskEditor({
  task,
  entities,
  entityTitleById,
}: {
  task: Task;
  entities: Entity[];
  entityTitleById: Map<string, string>;
}) {
  const [description, setDescription] = useState(task.description);
  const [owner, setOwner] = useState(task.owner);
  const [linkedTo, setLinkedTo] = useState(task.linkedTo[0] ?? '');
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setDescription(task.description);
    setOwner(task.owner);
    setLinkedTo(task.linkedTo[0] ?? '');
    setDueDate(task.dueDate ?? '');
    setStatus(task.status);
    setSaveState('idle');
  }, [task.id]);

  async function handleSave() {
    setSaveState('saving');
    try {
      await updateTask(task.id, {
        description,
        owner,
        linkedTo: linkedTo ? [linkedTo] : [],
        dueDate: dueDate || undefined,
        status,
        completedAt: status === 'done' ? task.completedAt ?? Date.now() : undefined,
      });
      await refreshCompiledProfiles([owner, ...new Set(linkedTo ? [linkedTo] : [])]);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function handleDelete() {
    await deleteTask(task.id);
  }

  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <input
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setSaveState('idle');
          }}
          className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
        />
        <IconButton label="保存任务" onClick={handleSave}>
          <Save size={15} />
        </IconButton>
        <IconButton label="删除任务" onClick={handleDelete}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-4">
        <Field label="负责人">
          <Select
            value={owner}
            options={entities.map((entity) => [entity.id, entity.title])}
            onChange={(value) => {
              setOwner(value);
              setSaveState('idle');
            }}
          />
        </Field>
        <Field label="关联实体">
          <Select
            value={linkedTo}
            options={[['', '无关联'], ...entities.map((entity) => [entity.id, entity.title] as [string, string])]}
            onChange={(value) => {
              setLinkedTo(value);
              setSaveState('idle');
            }}
          />
        </Field>
        <Field label="状态">
          <Select
            value={status}
            options={taskStatuses.map((taskStatus) => [taskStatus, taskStatus])}
            onChange={(value) => {
              setStatus(value as TaskStatus);
              setSaveState('idle');
            }}
          />
        </Field>
        <Field label="截止">
          <input
            value={dueDate}
            onChange={(event) => {
              setDueDate(event.target.value);
              setSaveState('idle');
            }}
            className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
          />
        </Field>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#626965]">
        <span>当前负责人：{entityTitleById.get(task.owner) ?? task.owner}</span>
        <Link to={`/entries/${task.source}`} className="rounded-full border border-[#d9d9d6] px-2.5 py-1 text-[#155eef]">
          查看来源
        </Link>
        {saveState === 'saved' ? <span className="text-[#276749]">任务已保存。</span> : null}
        {saveState === 'saving' ? <span className="text-[#626965]">保存中...</span> : null}
        {saveState === 'error' ? <span className="text-[#b42318]">保存失败，请重试。</span> : null}
      </div>
    </div>
  );
}

function EntityEditor({ entity }: { entity: Entity }) {
  const [title, setTitle] = useState(entity.title);
  const [summary, setSummary] = useState(entity.summary);
  const [tags, setTags] = useState(entity.tags.join(', '));
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setTitle(entity.title);
    setSummary(entity.summary);
    setTags(entity.tags.join(', '));
    setSaveState('idle');
  }, [entity.id]);

  async function handleSave() {
    if (!title.trim()) {
      setSaveState('error');
      return;
    }

    setSaveState('saving');
    try {
      await updateEntity(entity.id, {
        title: title.trim(),
        summary,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      await refreshCompiledProfile(entity.id);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <section className="mt-4 rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#626965]">
          {entityTypeLabels[entity.type]}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveState === 'saving'}
          className="rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white disabled:bg-[#a8b7d8]"
        >
          {saveState === 'saving' ? '保存中...' : saveState === 'saved' ? '已保存' : '保存修改'}
        </button>
      </div>
      <input
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setSaveState('idle');
        }}
        className="mt-5 w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-2xl font-semibold outline-none focus:border-[#155eef]"
      />
      <textarea
        value={summary}
        onChange={(event) => {
          setSummary(event.target.value);
          setSaveState('idle');
        }}
        className="mt-3 min-h-28 w-full resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
      />
      <input
        value={tags}
        onChange={(event) => {
          setTags(event.target.value);
          setSaveState('idle');
        }}
        className="mt-3 w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
        placeholder="标签，用英文逗号分隔"
      />
      <SaveFeedback state={saveState} savedText="修改已保存。" />
    </section>
  );
}

function SaveFeedback({ state, savedText }: { state: SaveState; savedText: string }) {
  if (state === 'idle') return null;
  if (state === 'saving') return <p className="mt-2 text-xs text-[#626965]">保存中...</p>;
  if (state === 'saved') return <p className="mt-2 text-xs text-[#276749]">{savedText}</p>;
  return <p className="mt-2 text-xs text-[#b42318]">保存失败，请重试。</p>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#626965]">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-[10px] border border-[#d9d9d6] bg-white px-3 py-2 text-sm outline-none focus:border-[#155eef]"
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef]"
    >
      {children}
    </button>
  );
}
