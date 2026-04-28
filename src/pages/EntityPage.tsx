import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useParams } from 'react-router';
import { updateEntity, db } from '@/lib/db';
import type { Entity, EntityType } from '@/types';

const entityTypeLabels: Record<EntityType, string> = {
  person: '人员',
  project: '事项',
  event: '互动',
  topic: '主题',
};

export function EntityPage() {
  const { id } = useParams();
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
                <div key={relationship.id} className="px-4 py-3 text-sm text-[#4b5563]">
                  <p className="font-medium text-[#1f2937]">{relationship.type}</p>
                  <p className="mt-1 text-xs text-[#626965]">
                    {entityTitleById.get(relationship.from) ?? relationship.from} →{' '}
                    {entityTitleById.get(relationship.to) ?? relationship.to}
                  </p>
                </div>
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
                <div key={task.id} className="px-4 py-3 text-sm">
                  <p className="font-medium text-[#1f2937]">{task.description}</p>
                  <p className="mt-1 text-xs text-[#626965]">
                    owner: {entityTitleById.get(task.owner) ?? task.owner} · {task.status}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function EntityEditor({ entity }: { entity: Entity }) {
  const [title, setTitle] = useState(entity.title);
  const [summary, setSummary] = useState(entity.summary);
  const [tags, setTags] = useState(entity.tags.join(', '));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTitle(entity.title);
    setSummary(entity.summary);
    setTags(entity.tags.join(', '));
    setSaved(false);
  }, [entity]);

  async function handleSave() {
    await updateEntity(entity.id, {
      title,
      summary,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    setSaved(true);
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
          className="rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white"
        >
          保存修改
        </button>
      </div>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="mt-5 w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-2xl font-semibold outline-none focus:border-[#155eef]"
      />
      <textarea
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        className="mt-3 min-h-28 w-full resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
      />
      <input
        value={tags}
        onChange={(event) => setTags(event.target.value)}
        className="mt-3 w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
        placeholder="标签，用英文逗号分隔"
      />
      {saved ? <p className="mt-3 text-sm text-[#276749]">已保存。</p> : null}
    </section>
  );
}
