import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { db } from '@/lib/db';
import type { Entity, EntityType } from '@/types';

const entityTypeLabels: Record<EntityType, string> = {
  person: '人员',
  project: '事项',
  event: '互动',
  topic: '主题',
};

const entityTypes: EntityType[] = ['person', 'project', 'event', 'topic'];

export function WikiPage() {
  const entities = useLiveQuery(() => db.entities.orderBy('updatedAt').reverse().toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const relationships = useLiveQuery(() => db.relationships.toArray(), [], []);

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <StatCard label="实体" value={entities.length} />
        <StatCard label="关系" value={relationships.length} />
        <StatCard label="任务" value={tasks.length} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-[12px] border border-[#e5e5e4] bg-white p-4">
          <p className="text-xs font-medium text-[#155eef]">Wiki</p>
          <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">知识库</h2>
          <p className="mt-3 text-sm leading-6 text-[#626965]">
            这里按四类实体浏览本地知识图谱。实体保存后仍可进入详情页继续编辑。
          </p>
        </aside>

        <div className="space-y-5">
          {entityTypes.map((type) => (
            <EntityGroup key={type} type={type} entities={entities.filter((entity) => entity.type === type)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <p className="text-xs text-[#626965]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[#1f2937]">{value}</p>
    </div>
  );
}

function EntityGroup({ type, entities }: { type: EntityType; entities: Entity[] }) {
  return (
    <section className="rounded-[12px] border border-[#e5e5e4] bg-white">
      <div className="flex items-center justify-between border-b border-[#e5e5e4] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">{entityTypeLabels[type]}</h3>
        <span className="rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs text-[#626965]">
          {entities.length}
        </span>
      </div>
      {entities.length === 0 ? (
        <p className="px-4 py-5 text-sm text-[#626965]">暂无记录。</p>
      ) : (
        <div className="divide-y divide-[#eeeeed]">
          {entities.map((entity) => (
            <Link
              key={entity.id}
              to={`/wiki/${entity.type}/${entity.id}`}
              className="block px-4 py-3 transition hover:bg-[#f7f7f5]"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#1f2937]">{entity.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#626965]">{entity.summary || '暂无摘要'}</p>
                </div>
                <span className="shrink-0 text-xs text-[#155eef]">打开</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
