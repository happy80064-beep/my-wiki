import { type ReactNode, useMemo } from 'react';
import { useLiveQuery } from '@/lib/db/liveQuery';
import { Link, useParams } from 'react-router';
import { db } from '@/lib/db';
import type { Entity, Relationship, Task } from '@/types';

export function EntryPage() {
  const { id } = useParams();
  const entry = useLiveQuery(() => (id ? db.entries.get(id) : undefined), [id]);
  const entities = useLiveQuery(() => (entry ? db.entities.bulkGet(entry.derivedEntities) : []), [entry], []);
  const tasks = useLiveQuery(() => (entry ? db.tasks.bulkGet(entry.derivedTasks) : []), [entry], []);
  const relationships = useLiveQuery(
    () => (entry ? db.relationships.bulkGet(entry.derivedRelationships) : []),
    [entry],
    [],
  );
  const allEntities = useLiveQuery(() => db.entities.toArray(), [], []);
  const entityTitleById = useMemo(
    () => new Map(allEntities.map((entity) => [entity.id, entity.title])),
    [allEntities],
  );

  if (entry === undefined) {
    return (
      <section className="mx-auto max-w-4xl px-5 py-8">
        <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-5 text-sm text-[#626965]">
          正在读取原文...
        </div>
      </section>
    );
  }

  if (!entry) {
    return (
      <section className="mx-auto max-w-4xl px-5 py-8">
        <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <p className="text-sm text-[#626965]">没有找到这条原始捕获。</p>
          <Link to="/wiki" className="mt-4 inline-flex text-sm text-[#155eef]">
            返回知识库
          </Link>
        </div>
      </section>
    );
  }

  const resolvedEntities: Entity[] = entities.flatMap((entity) => (entity ? [entity] : []));
  const resolvedTasks: Task[] = tasks.flatMap((task) => (task ? [task] : []));
  const resolvedRelationships: Relationship[] = relationships.flatMap((relationship) =>
    relationship ? [relationship] : [],
  );

  return (
    <section className="mx-auto max-w-4xl px-5 py-8">
      <Link to="/wiki" className="text-sm text-[#155eef]">
        返回知识库
      </Link>

      <section className="mt-4 rounded-[12px] border border-[#e5e5e4] bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#626965]">
            {entry.source}
          </span>
          <span className="text-xs text-[#626965]">{new Date(entry.capturedAt).toLocaleString()}</span>
        </div>
        <h2 className="mt-4 text-xl font-semibold text-[#1f2937]">原始捕获</h2>
        <pre className="mt-4 whitespace-pre-wrap rounded-[10px] border border-[#eeeeed] bg-[#fbfbfa] p-4 text-sm leading-7 text-[#1f2937]">
          {entry.content}
        </pre>
      </section>

      <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-white">
        <div className="border-b border-[#e5e5e4] px-4 py-3">
          <h3 className="text-sm font-semibold text-[#1f2937]">派生结果</h3>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-3">
          <DerivedBlock title="实体">
            {resolvedEntities.length === 0 ? (
              <EmptyText />
            ) : (
              resolvedEntities.map((entity) => (
                <Link key={entity.id} to={`/wiki/${entity.type}/${entity.id}`} className="block text-sm text-[#155eef]">
                  {entity.title}
                </Link>
              ))
            )}
          </DerivedBlock>
          <DerivedBlock title="关系">
            {resolvedRelationships.length === 0 ? (
              <EmptyText />
            ) : (
              resolvedRelationships.map((relationship) => (
                <p key={relationship.id} className="text-sm leading-6 text-[#4b5563]">
                  {entityTitleById.get(relationship.from) ?? relationship.from} →{' '}
                  {entityTitleById.get(relationship.to) ?? relationship.to}
                </p>
              ))
            )}
          </DerivedBlock>
          <DerivedBlock title="任务">
            {resolvedTasks.length === 0 ? (
              <EmptyText />
            ) : (
              resolvedTasks.map((task) => (
                <p key={task.id} className="text-sm leading-6 text-[#4b5563]">
                  {task.description}
                </p>
              ))
            )}
          </DerivedBlock>
        </div>
      </section>
    </section>
  );
}

function DerivedBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-[#626965]">{title}</h4>
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

function EmptyText() {
  return <p className="text-sm text-[#626965]">暂无。</p>;
}
