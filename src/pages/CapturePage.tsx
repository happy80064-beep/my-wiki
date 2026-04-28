import { Loader2, Save, WandSparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type CaptureDraft,
  type DraftEntity,
  createLocalCaptureDraft,
  getDraftEntities,
  persistCaptureDraft,
} from '@/lib/capture';
import type { EntityType, RelationshipType, Scene, TaskStatus } from '@/types';

const entityTypes: EntityType[] = ['person', 'project', 'event', 'topic'];
const scenes: Scene[] = ['work', 'life', 'social', 'personal'];
const relationshipTypes: RelationshipType[] = [
  'owner',
  'participant',
  'attendee',
  'about',
  'mentions',
  'relevant-to',
  'related-to',
];
const taskStatuses: TaskStatus[] = ['pending', 'done', 'overdue', 'cancelled'];

type SaveResult = {
  entities: number;
  relationships: number;
  tasks: number;
};

export function CapturePage() {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSave, setLastSave] = useState<SaveResult | null>(null);

  const draftEntities = useMemo(() => (draft ? getDraftEntities(draft) : []), [draft]);

  function handleOrganize() {
    const trimmed = content.trim();
    if (!trimmed) return;

    setIsProcessing(true);
    setLastSave(null);
    window.setTimeout(() => {
      setDraft(createLocalCaptureDraft(trimmed));
      setIsProcessing(false);
    }, 250);
  }

  async function handleSave() {
    if (!draft || !content.trim()) return;

    setIsSaving(true);
    const result = await persistCaptureDraft(content.trim(), draft, 'text');
    setLastSave({
      entities: result.entities.length,
      relationships: result.relationships.length,
      tasks: result.tasks.length,
    });
    setIsSaving(false);
  }

  function updateDraftEntity(clientId: string, patch: Partial<DraftEntity>) {
    setDraft((current) => {
      if (!current) return current;
      if (current.primaryEntity.clientId === clientId) {
        return { ...current, primaryEntity: { ...current.primaryEntity, ...patch } };
      }
      return {
        ...current,
        relatedEntities: current.relatedEntities.map((entity) =>
          entity.clientId === clientId ? { ...entity, ...patch } : entity,
        ),
      };
    });
  }

  return (
    <section className="mx-auto max-w-6xl px-5 py-8">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <p className="text-xs font-medium text-[#155eef]">Capture</p>
          <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">快速捕获</h2>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="mt-5 min-h-72 w-full resize-y rounded-[12px] border border-[#d9d9d6] bg-[#fbfbfa] p-4 text-sm leading-6 outline-none transition focus:border-[#155eef] focus:bg-white"
            placeholder="粘贴会议记录、聊天摘要、临时想法..."
            autoFocus
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleOrganize}
              disabled={!content.trim() || isProcessing}
              className="inline-flex items-center gap-2 rounded-full bg-[#155eef] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-[#a8b7d8]"
            >
              {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <WandSparkles size={16} />}
              AI 整理
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!draft || isSaving}
              className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#1f2937] disabled:cursor-not-allowed disabled:text-[#a0a0a0]"
            >
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              保存到知识库
            </button>
          </div>
          {lastSave ? (
            <p className="mt-4 rounded-[10px] border border-[#b7e4c7] bg-[#f0fff4] px-3 py-2 text-sm text-[#276749]">
              已保存：{lastSave.entities} 个实体、{lastSave.relationships} 条关系、{lastSave.tasks} 个任务。
            </p>
          ) : null}
        </section>

        <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[#155eef]">Review</p>
              <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">结构化建议</h2>
            </div>
            <span className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#626965]">
              保存前可编辑
            </span>
          </div>

          {!draft ? (
            <div className="mt-5 rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-6 text-sm leading-6 text-[#626965]">
              输入内容后点击 AI 整理，这里会出现实体、关系和任务草稿。
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              <EntitySection entities={draftEntities} onChange={updateDraftEntity} />
              <RelationshipSection draft={draft} draftEntities={draftEntities} setDraft={setDraft} />
              <TaskSection draft={draft} draftEntities={draftEntities} setDraft={setDraft} />
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function EntitySection({
  entities,
  onChange,
}: {
  entities: DraftEntity[];
  onChange: (clientId: string, patch: Partial<DraftEntity>) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[#1f2937]">实体</h3>
      <div className="mt-3 space-y-3">
        {entities.map((entity) => (
          <EntityEditor key={entity.clientId} entity={entity} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function RelationshipSection({
  draft,
  draftEntities,
  setDraft,
}: {
  draft: CaptureDraft;
  draftEntities: DraftEntity[];
  setDraft: React.Dispatch<React.SetStateAction<CaptureDraft | null>>;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[#1f2937]">关系</h3>
      <div className="mt-3 space-y-3">
        {draft.relationships.length === 0 ? (
          <p className="text-sm text-[#626965]">暂无关系建议。</p>
        ) : (
          draft.relationships.map((relationship) => (
            <div
              key={relationship.clientId}
              className="grid gap-2 rounded-[12px] border border-[#e5e5e4] p-3 md:grid-cols-3"
            >
              <Select
                value={relationship.fromClientId}
                options={draftEntities.map((entity) => [entity.clientId, entity.title])}
                onChange={(value) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          relationships: current.relationships.map((item) =>
                            item.clientId === relationship.clientId ? { ...item, fromClientId: value } : item,
                          ),
                        }
                      : current,
                  )
                }
              />
              <Select
                value={relationship.type}
                options={relationshipTypes.map((type) => [type, type])}
                onChange={(value) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          relationships: current.relationships.map((item) =>
                            item.clientId === relationship.clientId
                              ? { ...item, type: value as RelationshipType }
                              : item,
                          ),
                        }
                      : current,
                  )
                }
              />
              <Select
                value={relationship.toClientId}
                options={draftEntities.map((entity) => [entity.clientId, entity.title])}
                onChange={(value) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          relationships: current.relationships.map((item) =>
                            item.clientId === relationship.clientId ? { ...item, toClientId: value } : item,
                          ),
                        }
                      : current,
                  )
                }
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TaskSection({
  draft,
  draftEntities,
  setDraft,
}: {
  draft: CaptureDraft;
  draftEntities: DraftEntity[];
  setDraft: React.Dispatch<React.SetStateAction<CaptureDraft | null>>;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-[#1f2937]">任务</h3>
      <div className="mt-3 space-y-3">
        {draft.tasks.length === 0 ? (
          <p className="text-sm text-[#626965]">暂无任务建议。</p>
        ) : (
          draft.tasks.map((task) => (
            <div key={task.clientId} className="rounded-[12px] border border-[#e5e5e4] p-3">
              <input
                value={task.description}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          tasks: current.tasks.map((item) =>
                            item.clientId === task.clientId ? { ...item, description: event.target.value } : item,
                          ),
                        }
                      : current,
                  )
                }
                className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
              />
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <Select
                  value={task.ownerClientId}
                  options={draftEntities.map((entity) => [entity.clientId, entity.title])}
                  onChange={(value) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            tasks: current.tasks.map((item) =>
                              item.clientId === task.clientId ? { ...item, ownerClientId: value } : item,
                            ),
                          }
                        : current,
                    )
                  }
                />
                <Select
                  value={task.linkedToClientIds[0] ?? ''}
                  options={draftEntities.map((entity) => [entity.clientId, entity.title])}
                  onChange={(value) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            tasks: current.tasks.map((item) =>
                              item.clientId === task.clientId ? { ...item, linkedToClientIds: [value] } : item,
                            ),
                          }
                        : current,
                    )
                  }
                />
                <Select
                  value={task.status}
                  options={taskStatuses.map((status) => [status, status])}
                  onChange={(value) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            tasks: current.tasks.map((item) =>
                              item.clientId === task.clientId ? { ...item, status: value as TaskStatus } : item,
                            ),
                          }
                        : current,
                    )
                  }
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EntityEditor({
  entity,
  onChange,
}: {
  entity: DraftEntity;
  onChange: (clientId: string, patch: Partial<DraftEntity>) => void;
}) {
  return (
    <div className="rounded-[12px] border border-[#e5e5e4] p-3">
      <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)]">
        <Select
          value={entity.type}
          options={entityTypes.map((type) => [type, type])}
          onChange={(value) => onChange(entity.clientId, { type: value as EntityType })}
        />
        <input
          value={entity.title}
          onChange={(event) => onChange(entity.clientId, { title: event.target.value })}
          className="rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
        />
      </div>
      <textarea
        value={entity.summary}
        onChange={(event) => onChange(entity.clientId, { summary: event.target.value })}
        className="mt-2 min-h-20 w-full resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
      />
      <input
        value={entity.tags.join(', ')}
        onChange={(event) =>
          onChange(entity.clientId, {
            tags: event.target.value
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          })
        }
        className="mt-2 w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
        placeholder="标签，用英文逗号分隔"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {scenes.map((scene) => (
          <label
            key={scene}
            className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#4b5563]"
          >
            <input
              type="checkbox"
              checked={entity.scenes.includes(scene)}
              onChange={(event) =>
                onChange(entity.clientId, {
                  scenes: event.target.checked
                    ? [...entity.scenes, scene]
                    : entity.scenes.filter((item) => item !== scene),
                })
              }
            />
            {scene}
          </label>
        ))}
      </div>
    </div>
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
      className="rounded-[10px] border border-[#d9d9d6] bg-white px-3 py-2 text-sm outline-none focus:border-[#155eef]"
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}
