import { Loader2, Plus, Save, Trash2, WandSparkles } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  type CaptureDraft,
  type DraftEntity,
  type DraftRelationship,
  type DraftTask,
  createLocalCaptureDraft,
  createDraftId,
  getDraftEntities,
  persistCaptureDraft,
} from '@/lib/capture';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import type { EntityType, RelationshipType, Scene, TaskStatus } from '@/types';

const entityTypes: EntityType[] = ['person', 'project', 'event', 'topic'];
const scenes: Scene[] = ['work', 'life', 'social', 'personal'];
const relationshipTypes: RelationshipType[] = [
  'owner',
  'participant',
  'depends-on',
  'attendee',
  'about',
  'mentions',
  'relevant-to',
  'related-to',
];
const taskStatuses: TaskStatus[] = ['pending', 'done', 'overdue', 'cancelled'];
const relationshipLabels: Record<RelationshipType, string> = {
  owner: '负责人',
  participant: '参与事项',
  stakeholder: '干系人',
  'decision-maker': '决策人',
  attendee: '参加互动',
  organizer: '组织互动',
  'mentioned-in': '被提及于',
  colleague: '同事',
  friend: '朋友',
  family: '家人',
  mentor: '导师',
  'reports-to': '汇报给',
  'parent-of': '父事项',
  'depends-on': '依赖',
  'related-to': '相关',
  about: '关于',
  'kicked-off': '启动',
  'relevant-to': '关联主题',
  mentions: '提及',
};

type SaveResult = {
  entities: number;
  relationships: number;
  tasks: number;
  createdEntities: number;
  reusedEntities: number;
  updatedPeople: number;
  updatedTopics: number;
  createdRelationships: number;
  updatedRelationships: number;
  queuedCompileSuggestions: number;
};

export function CapturePage() {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSave, setLastSave] = useState<SaveResult | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);

  const draftEntities = useMemo(() => (draft ? getDraftEntities(draft) : []), [draft]);

  async function handleOrganize() {
    const trimmed = content.trim();
    if (!trimmed) return;

    setIsProcessing(true);
    setLastSave(null);
    setExtractError(null);
    setProviderLabel(null);

    try {
      const result = await extractCaptureDraft(trimmed);
      setDraft(result.draft);
      setProviderLabel(`${result.provider} · ${result.model}${result.mode === 'two-step' ? ' · 两步摄入' : ''}`);
    } catch (error) {
      setDraft(null);
      setExtractError(error instanceof Error ? error.message : 'AI 提取失败');
    } finally {
      setIsProcessing(false);
    }
  }

  function handleLocalFallback() {
    const trimmed = content.trim();
    if (!trimmed) return;
    setDraft(createLocalCaptureDraft(trimmed));
    setProviderLabel('local mock');
    setExtractError(null);
  }

  async function handleSave() {
    if (!draft || !content.trim()) return;

    setIsSaving(true);
    const result = await persistCaptureDraft(content.trim(), draft, 'text');
    setLastSave({
      entities: result.entities.length,
      relationships: result.relationships.length,
      tasks: result.tasks.length,
      createdEntities: result.compilation.createdEntities,
      reusedEntities: result.compilation.reusedEntities,
      updatedPeople: result.compilation.updatedPeople,
      updatedTopics: result.compilation.updatedTopics,
      createdRelationships: result.compilation.createdRelationships,
      updatedRelationships: result.compilation.updatedRelationships,
      queuedCompileSuggestions: result.compilation.queuedCompileSuggestions,
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

  function addDraftEntity() {
    setDraft((current) => {
      if (!current) return current;
      const entity: DraftEntity = {
        clientId: createDraftId('entity'),
        type: 'topic',
        title: '新实体',
        summary: '',
        tags: [],
        scenes: ['work'],
      };
      return { ...current, relatedEntities: [...current.relatedEntities, entity] };
    });
  }

  function removeDraftEntity(clientId: string) {
    setDraft((current) => {
      if (!current || current.primaryEntity.clientId === clientId) return current;
      const fallbackId = current.primaryEntity.clientId;
      return {
        ...current,
        relatedEntities: current.relatedEntities.filter((entity) => entity.clientId !== clientId),
        relationships: current.relationships.filter(
          (relationship) => relationship.fromClientId !== clientId && relationship.toClientId !== clientId,
        ),
        tasks: current.tasks.map((task) => ({
          ...task,
          ownerClientId: task.ownerClientId === clientId ? fallbackId : task.ownerClientId,
          linkedToClientIds: task.linkedToClientIds.filter((linkedId) => linkedId !== clientId),
        })),
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
            <div className="mt-4 rounded-[10px] border border-[#b7e4c7] bg-[#f0fff4] px-3 py-2 text-sm leading-6 text-[#276749]">
              <p>
                已保存：{lastSave.entities} 个实体、{lastSave.relationships} 条关系、{lastSave.tasks} 个任务。
              </p>
              <p className="text-xs">
                编译影响：新建 {lastSave.createdEntities} 个实体，复用 {lastSave.reusedEntities} 个实体，更新{' '}
                {lastSave.updatedPeople} 个人员、{lastSave.updatedTopics} 个主题；关系新建{' '}
                {lastSave.createdRelationships} 条，合并证据 {lastSave.updatedRelationships} 条；待编译{' '}
                {lastSave.queuedCompileSuggestions} 条。
              </p>
            </div>
          ) : null}
          {extractError ? (
            <div className="mt-4 rounded-[10px] border border-[#fecaca] bg-[#fff5f5] px-3 py-2 text-sm leading-6 text-[#b42318]">
              <p>MiniMax 提取失败：{extractError}</p>
              <button type="button" onClick={handleLocalFallback} className="mt-2 text-[#155eef]">
                使用本地 mock 继续测试页面
              </button>
            </div>
          ) : null}
        </section>

        <section className="rounded-[12px] border border-[#e5e5e4] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[#155eef]">Review</p>
              <h2 className="mt-2 text-xl font-semibold text-[#1f2937]">结构化建议</h2>
            </div>
            <span className="rounded-full border border-[#d9d9d6] px-3 py-1 text-xs text-[#626965]">
              {providerLabel ?? '保存前可编辑'}
            </span>
          </div>

          {!draft ? (
            <div className="mt-5 rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] p-6 text-sm leading-6 text-[#626965]">
              输入内容后点击 AI 整理，这里会出现实体、关系和任务草稿。
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              <EntitySection
                draft={draft}
                entities={draftEntities}
                onAdd={addDraftEntity}
                onChange={updateDraftEntity}
                onRemove={removeDraftEntity}
              />
              <RelationshipSection draft={draft} draftEntities={draftEntities} setDraft={setDraft} />
              <TaskSection draft={draft} draftEntities={draftEntities} setDraft={setDraft} />
              <CompileSuggestionSection draft={draft} />
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function CompileSuggestionSection({ draft }: { draft: CaptureDraft }) {
  const suggestions = draft.compileSuggestions ?? [];

  if (suggestions.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-[#1f2937]">待编译建议</h3>
      <div className="mt-3 space-y-2">
        {suggestions.map((suggestion) => (
          <div key={suggestion.clientId} className="rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-3 text-xs leading-5">
            <div className="font-medium text-[#1f2937]">{suggestion.entityTitle}</div>
            <div className="text-[#626965]">
              {suggestion.propertyLabel}：<span className="text-[#1f2937]">{suggestion.propertyValue}</span>
            </div>
            <div className="mt-1 rounded-[8px] border border-[#e5e5e4] bg-white px-3 py-2 text-[#626965]">
              证据：{suggestion.evidenceSnippet}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EntitySection({
  draft,
  entities,
  onAdd,
  onChange,
  onRemove,
}: {
  draft: CaptureDraft;
  entities: DraftEntity[];
  onAdd: () => void;
  onChange: (clientId: string, patch: Partial<DraftEntity>) => void;
  onRemove: (clientId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">实体</h3>
        <IconButton label="新增实体" onClick={onAdd}>
          <Plus size={15} />
        </IconButton>
      </div>
      <div className="mt-3 space-y-3">
        {entities.map((entity) => (
          <EntityEditor
            key={entity.clientId}
            entity={entity}
            canRemove={entity.clientId !== draft.primaryEntity.clientId}
            onChange={onChange}
            onRemove={onRemove}
          />
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
  function addRelationship() {
    if (draftEntities.length < 2) return;
    const relationship: DraftRelationship = {
      clientId: createDraftId('rel'),
      fromClientId: draftEntities[0].clientId,
      toClientId: draftEntities[1].clientId,
      type: 'mentions',
    };
    setDraft((current) => (current ? { ...current, relationships: [...current.relationships, relationship] } : current));
  }

  function removeRelationship(clientId: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            relationships: current.relationships.filter((relationship) => relationship.clientId !== clientId),
          }
        : current,
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">关系</h3>
        <IconButton label="新增关系" onClick={addRelationship} disabled={draftEntities.length < 2}>
          <Plus size={15} />
        </IconButton>
      </div>
      <div className="mt-3 space-y-3">
        {draft.relationships.length === 0 ? (
          <p className="text-sm text-[#626965]">暂无关系建议。</p>
        ) : (
          draft.relationships.map((relationship) => (
            <div
              key={relationship.clientId}
              className="grid gap-2 rounded-[12px] border border-[#e5e5e4] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <Field label="起点实体">
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
              </Field>
              <Field label="关系类型">
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
              </Field>
              <Field label="终点实体">
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
              </Field>
              <div className="flex items-end justify-end">
                <IconButton label="删除关系" onClick={() => removeRelationship(relationship.clientId)}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
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
  function addTask() {
    if (draftEntities.length === 0) return;
    const defaultEntityId = draftEntities[0].clientId;
    const task: DraftTask = {
      clientId: createDraftId('task'),
      description: '新任务',
      ownerClientId: defaultEntityId,
      linkedToClientIds: [defaultEntityId],
      status: 'pending',
    };
    setDraft((current) => (current ? { ...current, tasks: [...current.tasks, task] } : current));
  }

  function removeTask(clientId: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.filter((task) => task.clientId !== clientId),
          }
        : current,
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1f2937]">任务</h3>
        <IconButton label="新增任务" onClick={addTask} disabled={draftEntities.length === 0}>
          <Plus size={15} />
        </IconButton>
      </div>
      <div className="mt-3 space-y-3">
        {draft.tasks.length === 0 ? (
          <p className="text-sm text-[#626965]">暂无任务建议。</p>
        ) : (
          draft.tasks.map((task) => (
            <div key={task.clientId} className="rounded-[12px] border border-[#e5e5e4] p-3">
              <div className="flex items-start gap-2">
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
                <IconButton label="删除任务" onClick={() => removeTask(task.clientId)}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-4">
                <Field label="负责人">
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
                </Field>
                <Field label="关联实体">
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
                </Field>
                <Field label="状态">
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
                </Field>
                <Field label="截止">
                  <input
                    value={task.dueDate ?? ''}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              tasks: current.tasks.map((item) =>
                                item.clientId === task.clientId
                                  ? { ...item, dueDate: event.target.value || undefined }
                                  : item,
                              ),
                            }
                          : current,
                      )
                    }
                    className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
                  />
                </Field>
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
  canRemove,
  onChange,
  onRemove,
}: {
  entity: DraftEntity;
  canRemove: boolean;
  onChange: (clientId: string, patch: Partial<DraftEntity>) => void;
  onRemove: (clientId: string) => void;
}) {
  return (
    <div className="rounded-[12px] border border-[#e5e5e4] p-3">
      <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_auto]">
        <Field label="类型">
          <Select
            value={entity.type}
            options={entityTypes.map((type) => [type, type])}
            onChange={(value) => onChange(entity.clientId, { type: value as EntityType })}
          />
        </Field>
        <Field label="标题">
          <input
            value={entity.title}
            onChange={(event) => onChange(entity.clientId, { title: event.target.value })}
            className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
          />
        </Field>
        <div className="flex items-end justify-end">
          <IconButton label="删除实体" onClick={() => onRemove(entity.clientId)} disabled={!canRemove}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      <Field label="摘要">
        <textarea
          value={entity.summary}
          onChange={(event) => onChange(entity.clientId, { summary: event.target.value })}
          className="min-h-20 w-full resize-y rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#155eef]"
        />
      </Field>
      <Field label="标签">
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
          className="w-full rounded-[10px] border border-[#d9d9d6] px-3 py-2 text-sm outline-none focus:border-[#155eef]"
          placeholder="标签，用英文逗号分隔"
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="text-xs font-medium text-[#626965]">场景</span>
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

function IconButton({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] bg-white text-[#4b5563] transition hover:border-[#155eef] hover:text-[#155eef] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
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
          {relationshipLabels[label as RelationshipType] ?? label}
        </option>
      ))}
    </select>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mt-2 block">
      <span className="mb-1 block text-xs font-medium text-[#626965]">{label}</span>
      {children}
    </label>
  );
}
