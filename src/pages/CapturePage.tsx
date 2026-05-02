import { Loader2, Plus, Save, Trash2, WandSparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
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
import { createIngestJob, processNextIngestJob } from '@/lib/ingest';
import { isSupportedImportFile } from '@/lib/import/fileText';
import { createRawAssetFromFile, processNextRawAsset } from '@/lib/rawAssets';
import { db } from '@/lib/db';
import type { EntityType, RawAssetStatus, RelationshipType, Scene, TaskStatus } from '@/types';

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

const rawAssetStatusLabel: Record<RawAssetStatus, string> = {
  raw: '待编译',
  extracting: '解析中',
  compiling: '编译中',
  compiled: '已入库',
  skipped: '已跳过',
  failed: '失败',
};

const assetKindLabel = {
  text: '文本',
  word: 'Word',
  pdf: 'PDF',
  image: '图片',
} as const;

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

type ProgressState = {
  active: boolean;
  percent: number;
  label: string;
  detail?: string;
};

export function CapturePage() {
  const organizeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSave, setLastSave] = useState<SaveResult | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [isQueueProcessing, setIsQueueProcessing] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [organizeProgress, setOrganizeProgress] = useState<ProgressState | null>(null);
  const [importProgress, setImportProgress] = useState<ProgressState | null>(null);
  const [queueProgress, setQueueProgress] = useState<ProgressState | null>(null);
  const [isRawDropActive, setIsRawDropActive] = useState(false);
  const ingestJobs = useLiveQuery(() => db.ingestJobs.orderBy('createdAt').reverse().limit(8).toArray(), [], []);
  const rawAssets = useLiveQuery(() => db.rawAssets.orderBy('createdAt').reverse().limit(10).toArray(), [], []);

  const draftEntities = useMemo(() => (draft ? getDraftEntities(draft) : []), [draft]);

  useEffect(() => {
    return () => {
      if (organizeTimerRef.current) {
        clearInterval(organizeTimerRef.current);
      }
    };
  }, []);

  function startOrganizeProgress() {
    if (organizeTimerRef.current) {
      clearInterval(organizeTimerRef.current);
    }
    setOrganizeProgress({ active: true, percent: 8, label: '准备 AI 整理', detail: '正在读取输入内容' });
    organizeTimerRef.current = setInterval(() => {
      setOrganizeProgress((current) => {
        if (!current?.active) return current;
        const next = current.percent < 35 ? current.percent + 4 : current.percent < 72 ? current.percent + 2 : current.percent + 1;
        return {
          ...current,
          percent: Math.min(next, 88),
          label: next < 40 ? '分析内容结构' : next < 76 ? '调用 AI 提取' : '整理结构化草稿',
        };
      });
    }, 700);
  }

  function finishOrganizeProgress(label: string) {
    if (organizeTimerRef.current) {
      clearInterval(organizeTimerRef.current);
      organizeTimerRef.current = null;
    }
    setOrganizeProgress({ active: false, percent: 100, label });
    window.setTimeout(() => setOrganizeProgress(null), 1200);
  }

  function stopOrganizeProgress(label: string) {
    if (organizeTimerRef.current) {
      clearInterval(organizeTimerRef.current);
      organizeTimerRef.current = null;
    }
    setOrganizeProgress({ active: false, percent: 100, label });
  }

  async function handleOrganize() {
    const trimmed = content.trim();
    if (!trimmed) return;

    setIsProcessing(true);
    setLastSave(null);
    setExtractError(null);
    setProviderLabel(null);
    startOrganizeProgress();

    try {
      const result = await extractCaptureDraft(trimmed);
      setDraft(result.draft);
      setProviderLabel(`${result.provider} · ${result.model}${result.mode === 'two-step' ? ' · 两步摄入' : ''}`);
      finishOrganizeProgress('AI 整理完成');
    } catch (error) {
      setDraft(null);
      setExtractError(error instanceof Error ? error.message : 'AI 提取失败');
      stopOrganizeProgress('AI 整理失败');
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

  async function handleQueueCurrent() {
    const trimmed = content.trim();
    if (!trimmed) return;
    await createIngestJob({ content: trimmed, source: 'text' });
    setQueueMessage('已加入摄入队列。');
  }

  async function handleImportFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    const selectedFiles = Array.from(files);
    let count = 0;
    let reused = 0;
    const errors: string[] = [];
    setImportProgress({
      active: true,
      percent: 0,
      label: '保存到 Raw Inbox',
      detail: `共 ${selectedFiles.length} 个文件`,
    });

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      const percent = Math.round(((index + 1) / selectedFiles.length) * 100);
      if (!isSupportedImportFile(file.name, file.type)) {
        errors.push(`${file.name}：格式暂不支持`);
        setImportProgress({
          active: true,
          percent,
          label: `跳过 ${file.name}`,
          detail: `${index + 1}/${selectedFiles.length}`,
        });
        continue;
      }

      try {
        const result = await createRawAssetFromFile(file);
        if (result.reused) reused += 1;
        else count += 1;
        setImportProgress({
          active: true,
          percent,
          label: result.reused ? `已存在 ${file.name}` : `已保存 ${file.name}`,
          detail: `${index + 1}/${selectedFiles.length}`,
        });
      } catch (error) {
        errors.push(`${file.name}：${error instanceof Error ? error.message : '保存失败'}`);
      }
    }

    setImportProgress({
      active: false,
      percent: 100,
      label: 'Raw Inbox 已接收',
      detail: `新增 ${count} 个，已存在 ${reused} 个，失败/跳过 ${errors.length} 个`,
    });
    setQueueMessage(
      count + reused > 0
        ? `已放入 Raw Inbox：新增 ${count} 个，已存在 ${reused} 个。可稍后点击“编译新材料”。${
            errors.length > 0 ? `未接收：${errors.slice(0, 3).join('；')}` : ''
          }`
        : `没有可接收的文件。${errors.slice(0, 3).join('；')}`,
    );
    window.setTimeout(() => setImportProgress(null), 1800);
  }

  async function handleProcessQueue() {
    setIsQueueProcessing(true);
    setQueueMessage(null);
    let processed = 0;
    try {
      const rawTotal =
        (await db.rawAssets.where('status').equals('raw').count()) +
        (await db.rawAssets.where('status').equals('failed').count());
      const ingestTotal = await db.ingestJobs.where('status').equals('pending').count();
      const total = rawTotal + ingestTotal;
      if (total === 0) {
        setQueueProgress({ active: false, percent: 100, label: '当前没有待编译材料' });
        setQueueMessage('当前没有待编译材料。');
        window.setTimeout(() => setQueueProgress(null), 1200);
        return;
      }

      setQueueProgress({ active: true, percent: 0, label: '开始编译新材料', detail: `0/${total}` });
      for (let index = 0; index < rawTotal; index += 1) {
        const result = await processNextRawAsset(undefined, (progress) => {
          setQueueProgress({
            active: true,
            percent: Math.min(99, Math.round(((processed + progress.percent / 100) / total) * 100)),
            label: progress.label,
            detail: `${processed}/${total}`,
          });
        });
        if (!result) break;
        processed += 1;
        setQueueProgress({
          active: true,
          percent: Math.round((processed / total) * 100),
          label: result.filename ? `已编译 ${result.filename}` : '已编译材料',
          detail: `${processed}/${total}`,
        });
      }

      for (let index = 0; index < ingestTotal; index += 1) {
        const result = await processNextIngestJob();
        if (!result) break;
        processed += 1;
        setQueueProgress({
          active: true,
          percent: Math.round((processed / total) * 100),
          label: result.filename ? `已处理 ${result.filename}` : '已处理文本队列项',
          detail: `${processed}/${total}`,
        });
      }

      setQueueMessage(processed > 0 ? `已编译 ${processed} 个材料。` : '当前没有待编译材料。');
      setQueueProgress({
        active: false,
        percent: 100,
        label: '编译完成',
        detail: `${processed}/${total}`,
      });
      window.setTimeout(() => setQueueProgress(null), 1500);
    } finally {
      setIsQueueProcessing(false);
    }
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
            <button
              type="button"
              onClick={handleQueueCurrent}
              disabled={!content.trim()}
              className="inline-flex items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#1f2937] disabled:cursor-not-allowed disabled:text-[#a0a0a0]"
            >
              <Plus size={16} />
              加入摄入队列
            </button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-4 py-2 text-sm font-medium text-[#1f2937]">
              <input
                type="file"
                multiple
                accept=".txt,.md,.markdown,.doc,.docx,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,text/plain,text/markdown,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                className="hidden"
                onChange={(event) => handleImportFiles(event.target.files)}
              />
              批量导入文件
            </label>
          </div>
          <div className="mt-4 space-y-3">
            {organizeProgress ? <ProgressBar progress={organizeProgress} /> : null}
            {importProgress ? <ProgressBar progress={importProgress} /> : null}
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
          <section className="mt-5 rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4">
            <div
              className={`rounded-[12px] border border-dashed px-3 py-3 transition ${
                isRawDropActive ? 'border-[#155eef] bg-[#eef5ff]' : 'border-[#d9d9d6] bg-white'
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsRawDropActive(true);
              }}
              onDragLeave={() => setIsRawDropActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsRawDropActive(false);
                void handleImportFiles(event.dataTransfer.files);
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#1f2937]">Raw Inbox</h3>
                  <p className="mt-1 text-xs text-[#626965]">
                    拖入文件先原样收进本地收件箱；解析、AI 提取和写入 Wiki 可异步批量执行。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleProcessQueue}
                  disabled={isQueueProcessing}
                  className="inline-flex items-center gap-2 rounded-full bg-[#155eef] px-3 py-1.5 text-xs font-medium text-white disabled:bg-[#a8b7d8]"
                >
                  {isQueueProcessing ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}
                  编译新材料
                </button>
              </div>
              <p className="mt-3 text-xs text-[#626965]">支持 Markdown、文本、Word、PDF 和图片。采集完成后可稍后统一编译。</p>
            </div>
            <div className="mt-3">
              {queueProgress ? (
                <div>
                  <ProgressBar progress={queueProgress} />
                </div>
              ) : null}
              {queueMessage ? <p className="mt-2 text-xs text-[#626965]">{queueMessage}</p> : null}
            </div>
            <div className="mt-3 grid gap-2">
              {rawAssets.length === 0 ? (
                <p className="text-xs text-[#626965]">暂无 Raw 文件。可以批量选择或拖入文件后先放入收件箱。</p>
              ) : (
                rawAssets.map((asset) => (
                  <div key={asset.id} className="rounded-[10px] border border-[#e5e5e4] bg-white px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-[#1f2937]">{asset.filename}</p>
                        <p className="mt-0.5 text-[#626965]">
                          {assetKindLabel[asset.kind]} · {formatBytes(asset.size)}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full border border-[#d9d9d6] px-2 py-0.5 text-[#626965]">
                        {rawAssetStatusLabel[asset.status]}
                      </span>
                    </div>
                    {asset.error ? <p className="mt-1 text-[#b42318]">{asset.error}</p> : null}
                  </div>
                ))
              )}
            </div>
            {ingestJobs.length > 0 ? (
              <p className="mt-3 text-xs text-[#626965]">
                文本摄入队列：{ingestJobs.filter((job) => job.status === 'pending').length} 个待处理， 最近{' '}
                {ingestJobs.length} 条有记录。
              </p>
            ) : null}
          </section>
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

function ProgressBar({ progress }: { progress: ProgressState }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  return (
    <div className="rounded-[10px] border border-[#d9d9d6] bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-[#1f2937]">{progress.label}</span>
        <span className="tabular-nums text-[#155eef]">{percent}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#eef2f7]">
        <div
          className="h-full rounded-full bg-[#155eef] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      {progress.detail ? <p className="mt-1 text-xs text-[#626965]">{progress.detail}</p> : null}
    </div>
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

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mt-2 block">
      <span className="mb-1 block text-xs font-medium text-[#626965]">{label}</span>
      {children}
    </label>
  );
}
