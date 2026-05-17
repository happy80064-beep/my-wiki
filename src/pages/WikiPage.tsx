import { ArrowUpRight, Calendar, ChevronDown, ChevronRight, Download, Edit3, FileText, Layers, Loader2, RotateCcw, Save, Search, Sparkles, Tag, Trash2, Upload, UserRound, XCircle } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteEntity } from '@/lib/db';
import {
  restoreMarkdownExportZip,
  restoreMarkdownImportRecords,
  type MarkdownImportRecords,
} from '@/lib/export/importMarkdown';
import { buildMarkdownExportFiles, buildMarkdownZipBlob } from '@/lib/export/markdown';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import {
  cancelActiveRawAssetQueueTasks,
  cancelRawAssetQueueTask,
  clearTerminalRawAssetQueueTasks,
  createRawAssetFromFile,
  loadRawAssetWorkspaceQueue,
  processRawAssetQueue,
  reconcileInterruptedRawAssetQueueRun,
  retryRawAssetQueueTask,
  summarizeRawAssetWorkspaceQueue,
  subscribeRawAssetQueueStatus,
  type RawAssetQueueSnapshot,
  type RawAssetWorkspaceQueueTask,
} from '@/lib/rawAssets';
import { isSupportedImportFile } from '@/lib/import/fileText';
import {
  assertSafeWorkspaceRelativePath,
  canUseWorkspaceStorage,
  createWorkspaceStorage,
  getPersistedWorkspaceRoot,
  getWorkspaceDefaultRoot,
  initializeWorkspace,
  joinWorkspacePath,
  resolveActiveWorkspaceSchemaContext,
  syncIndexedDbKnowledgeToDefaultWorkspace,
  useWorkspaceRuntimeStore,
} from '@/lib/workspace';
import { resizeTriPaneLayout, type TriPaneLayout } from '@/lib/ui/triPaneLayout';
import { loadProviderSettings } from '@/lib/llm/providerSettings';
import { recompileBrowserEntityWikiPage } from '@/lib/wiki/browserRecompile';
import {
  isWikiBatchCompileRunning,
  subscribeWikiBatchCompileStatus,
  type WikiBatchCompileSnapshot,
} from '@/lib/wiki/batchCompileStatus';
import {
  getLatestRecoverableWikiBatchJob,
  reconcileInterruptedWikiBatchRun,
  recoverLegacyWikiBatchJob,
  resumeBrowserWikiBatchRecompile,
  startBrowserWikiBatchRecompile,
} from '@/lib/wiki/batchRecompileQueue';
import {
  buildBrowserEntityMarkdownPatch,
  buildBrowserEntityWikiRepairPatch,
  buildInitialBrowserEntityMarkdown,
  getWikiCompileProviderSummary,
} from '@/lib/wiki/browserWikiPageHelpers';
import { inferWikiTargetSpec } from '@/lib/wiki/markdownCompiler';
import { buildWikiPageMetadata, type WikiPageMetadata } from '@/lib/wiki/pageMetadata';
import { groupWikiPagesByType } from '@/lib/wiki/pageTree';
import { normalizeWikiReferenceValue } from '@/lib/wiki/references';
import { normalizeWikiPageType } from '@/lib/wiki/schemaRules';
import { WIKI_PAGE_TYPE_ORDER, type WikiPageIndexEntry, type WikiPageType } from '@/lib/wiki/scanner';
import type { Entity, Entry, RawAsset } from '@/types';

type BrowserWikiTreePage = WikiPageIndexEntry & { entity: Entity; wikiStatus: BrowserWikiEntityStatus };
type BrowserWikiEntityStatus = {
  state: 'complete' | 'draft' | 'structured';
  label: string;
  detail: string;
};
type BrowserWikiSearchDocument = {
  entity: Entity;
  title: string;
  path: string;
  type: WikiPageType;
  summary: string;
  body: string;
  updated?: string;
};
type BrowserWikiSearchResult = BrowserWikiSearchDocument & {
  matchedTerms: string[];
  score: number;
  snippet: string;
};
type BrowserSourceItem = {
  id: string;
  entryId?: string;
  rawAssetId?: string;
  title: string;
  summary: string;
};
type LocalRestorePayload = {
  records?: Partial<MarkdownImportRecords>;
};
const browserPaneStorageKey = 'mywiki:browser-pane-layout:v1';
const defaultBrowserPaneLayout: TriPaneLayout = { left: 22, center: 30, right: 48 };

export function WikiPage() {
  if (canUseWorkspaceStorage()) return <DesktopWikiPage />;

  return <BrowserIndexedDbWikiPage />;
}

function DesktopWikiPage() {
  const stats = useLiveQuery(
    async () => {
      const [entities, entries, rawAssets] = await Promise.all([db.entities.count(), db.entries.count(), db.rawAssets.count()]);
      return { entities, entries, rawAssets };
    },
    [],
    { entities: 0, entries: 0, rawAssets: 0 },
  );
  const hasCapturedKnowledge = stats.entities + stats.entries + stats.rawAssets > 0;

  useEffect(() => {
    if (!hasCapturedKnowledge) return;
    void syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
  }, [hasCapturedKnowledge]);

  return <BrowserIndexedDbWikiPage />;
}

export function BrowserIndexedDbWikiPage() {
  const rawImportInputRef = useRef<HTMLInputElement | null>(null);
  const backupImportInputRef = useRef<HTMLInputElement | null>(null);
  const repairRunningRef = useRef(false);
  const [importStatus, setImportStatus] = useState('');
  const [selected, setSelected] = useState<{ kind: 'entity'; id: string } | { kind: 'entry'; id: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [wikiSearchQuery, setWikiSearchQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [compileStatus, setCompileStatus] = useState('');
  const [restoreStatus, setRestoreStatus] = useState('');
  const [compilingEntityId, setCompilingEntityId] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<RawAssetQueueSnapshot | null>(null);
  const [workspaceQueueTasks, setWorkspaceQueueTasks] = useState<RawAssetWorkspaceQueueTask[]>([]);
  const [workspaceQueuePath, setWorkspaceQueuePath] = useState('');
  const [workspaceQueueActionStatus, setWorkspaceQueueActionStatus] = useState('');
  const [wikiBatchStatus, setWikiBatchStatus] = useState<WikiBatchCompileSnapshot | null>(null);
  const [dbOpenError, setDbOpenError] = useState('');
  const [activeWorkspaceSchema, setActiveWorkspaceSchema] = useState('');
  const activeWorkspaceRoot = useWorkspaceRuntimeStore((state) => state.activeRoot);
  const activeWorkspaceSnapshotRoot = useWorkspaceRuntimeStore((state) => state.snapshot?.layout.root);
  const searchParams = useMemo(
    () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
    [],
  );
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(
    new Set(['overview', 'project', 'entity', 'concept', 'source', 'query', 'synthesis', 'comparison']),
  );
  const paneGridRef = useRef<HTMLDivElement | null>(null);
  const [paneLayout, setPaneLayout] = useState<TriPaneLayout>(() => {
    try {
      const raw = window.localStorage.getItem(browserPaneStorageKey);
      return raw ? (JSON.parse(raw) as TriPaneLayout) : defaultBrowserPaneLayout;
    } catch {
      return defaultBrowserPaneLayout;
    }
  });
  const entitiesLive = useLiveQuery(() => db.entities.toArray(), []);
  const entriesLive = useLiveQuery(() => db.entries.orderBy('capturedAt').reverse().toArray(), []);
  const rawAssetCountLive = useLiveQuery(() => db.rawAssets.count().catch(() => 0), []);
  const rawAssetsLive = useLiveQuery(() => db.rawAssets.orderBy('createdAt').reverse().toArray(), []);
  const tasksLive = useLiveQuery(() => db.tasks.toArray(), []);
  const relationshipsLive = useLiveQuery(() => db.relationships.toArray(), []);
  const recoverableWikiBatchJob = useLiveQuery(() => getLatestRecoverableWikiBatchJob(), [], null);
  const entities = entitiesLive ?? [];
  const entries = entriesLive ?? [];
  const rawAssets = rawAssetsLive ?? [];
  const rawAssetCount = rawAssetCountLive ?? 0;
  const tasks = tasksLive ?? [];
  const relationships = relationshipsLive ?? [];
  const knowledgeDataLoaded =
    entitiesLive !== undefined &&
    entriesLive !== undefined &&
    rawAssetsLive !== undefined &&
    rawAssetCountLive !== undefined &&
    tasksLive !== undefined &&
    relationshipsLive !== undefined;
  const sortedEntities = useMemo(() => sortBrowserEntities(entities, activeWorkspaceSchema), [entities, activeWorkspaceSchema]);
  const browserWikiPages = useMemo(() => buildBrowserWikiTreePages(sortedEntities, activeWorkspaceSchema), [sortedEntities, activeWorkspaceSchema]);
  const deferredWikiSearchQuery = useDeferredValue(wikiSearchQuery);
  const browserWikiSearchDocuments = useMemo(
    () => buildBrowserWikiSearchDocuments(sortedEntities, activeWorkspaceSchema),
    [sortedEntities, activeWorkspaceSchema],
  );
  const browserWikiSearchResults = useMemo(
    () => searchBrowserWikiDocuments(browserWikiSearchDocuments, deferredWikiSearchQuery),
    [browserWikiSearchDocuments, deferredWikiSearchQuery],
  );
  const showingWikiSearchResults = deferredWikiSearchQuery.trim().length > 0;
  const browserWikiGroups = useMemo(() => groupWikiPagesByType(browserWikiPages), [browserWikiPages]);
  const browserWikiTypeStats = useMemo(
    () => browserWikiGroups.map((group) => ({ label: group.label, value: group.pages.length })),
    [browserWikiGroups],
  );
  const selectedEntity = selected?.kind === 'entity' ? sortedEntities.find((entity) => entity.id === selected.id) ?? null : null;
  const selectedEntry = selected?.kind === 'entry' ? entries.find((entry) => entry.id === selected.id) ?? null : null;
  const sourceItems = useMemo(() => buildBrowserSourceItems(entries, rawAssets), [entries, rawAssets]);
  const browserRuntimeOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const emptyBrowserCompat = !isTauriRuntime() && entities.length === 0 && entries.length === 0 && rawAssetCount === 0;
  const compatibilityNote = isTauriRuntime()
    ? '当前显示 Frog 和捕获页写入的本地知识库；编译成功后也会同步一份 Markdown 到文件工作区。'
    : '当前是浏览器 IndexedDB 兼容模式。v2 桌面版会读取统一 Markdown 工作区。';
  const showEmptyBrowserNotice = knowledgeDataLoaded && emptyBrowserCompat && !dbOpenError;
  const queueRunning = queueStatus?.stage === 'running';
  const wikiBatchRunning = isWikiBatchCompileRunning(wikiBatchStatus);
  const hasRecoverableWikiBatchJob = Boolean(recoverableWikiBatchJob && !wikiBatchRunning);
  const wikiBatchProgress = wikiBatchRunning ? wikiBatchStatus?.percent ?? 0 : 0;
  const wikiBatchButtonLabel = wikiBatchRunning
    ? `批量生成/更新中 ${wikiBatchProgress}%`
    : hasRecoverableWikiBatchJob
      ? '继续批量生成/更新wiki页'
      : '批量生成/更新wiki页';

  useEffect(() => {
    void reconcileInterruptedWikiBatchRun();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void resolveActiveWorkspaceSchemaContext()
      .then((context) => {
        if (!cancelled) setActiveWorkspaceSchema(context.schema);
      })
      .catch(() => {
        if (!cancelled) setActiveWorkspaceSchema('');
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceRoot, activeWorkspaceSnapshotRoot]);

  useEffect(() => {
    const handleOnline = () => {
      void getLatestRecoverableWikiBatchJob().then((job) => {
        if (!job || job.status !== 'paused' || !job.error?.includes('网络')) return;
        void resumeBrowserWikiBatchRecompile(job.id)
          .then(() => syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined))
          .catch((error) => {
            setCompileStatus(error instanceof Error ? error.message : 'Wiki 页面批量生成/更新恢复失败。');
          });
      });
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  useEffect(() => {
    if (!selected && browserWikiPages[0]) setSelected({ kind: 'entity', id: browserWikiPages[0].entity.id });
  }, [browserWikiPages, selected]);

  useEffect(() => {
    if (searchParams.get('restore') !== 'tmp-restore-export') return;
    let cancelled = false;

    void (async () => {
      setRestoreStatus('正在从 tmp-restore-export 恢复知识库...');
      try {
        const response = await fetch('/restore/mywiki-restore-payload.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`恢复载荷读取失败：HTTP ${response.status}`);

        const payload = (await response.json()) as LocalRestorePayload;
        const records = normalizeLocalRestoreRecords(payload);
        await restoreMarkdownImportRecords(records);
        if (cancelled) return;

        setSelected(null);
        setEditing(false);
        setDraftMarkdown('');
        setRestoreStatus(
          `已恢复：${records.entities.length} 个实体，${records.relationships.length} 条关系，${records.tasks.length} 条任务，${records.entries.length} 条原文。`,
        );
        window.history.replaceState(null, '', '/wiki');
      } catch (error) {
        if (!cancelled) setRestoreStatus(error instanceof Error ? error.message : '恢复失败。');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void db
      .open()
      .then(() => {
        if (!cancelled) setDbOpenError('');
      })
      .catch((error) => {
        if (cancelled) return;
        setDbOpenError(error instanceof Error ? error.message : 'IndexedDB open failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sourceReference = searchParams.get('source');
    const wikiReference = searchParams.get('ref');
    if (sourceReference) {
      const target = findBrowserEntryByReference(sourceReference, entries);
      if (!target) return;
      setSelected({ kind: 'entry', id: target.id });
      setEditing(false);
      setSaveStatus('');
      setCompileStatus('');
      return;
    }

    if (wikiReference) {
      const target = findBrowserEntityByReference(wikiReference, sortedEntities);
      if (!target) return;
      setSelected({ kind: 'entity', id: target.id });
      setEditing(false);
      setSaveStatus('');
      setCompileStatus('');
    }
  }, [entries, searchParams, sortedEntities]);

  useEffect(() => {
    if (!saveStatus) return undefined;
    const timer = window.setTimeout(() => setSaveStatus(''), 3200);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => {
    if (!compileStatus || compilingEntityId || queueRunning || wikiBatchRunning) return undefined;
    const timer = window.setTimeout(() => setCompileStatus(''), 7000);
    return () => window.clearTimeout(timer);
  }, [compileStatus, compilingEntityId, queueRunning, wikiBatchRunning]);

  useEffect(() => {
    window.localStorage.setItem(browserPaneStorageKey, JSON.stringify(paneLayout));
  }, [paneLayout]);

  useEffect(
    () =>
      subscribeRawAssetQueueStatus((snapshot) => {
        setQueueStatus(snapshot);
        if (!snapshot) return;
        if (snapshot.stage === 'running') {
          setCompileStatus(`${snapshot.owner === 'frog' ? 'Frog' : '知识库页面'}正在原文件结构化入库：${snapshot.label}`);
        } else if (Date.now() - snapshot.updatedAt < 5000) {
          setCompileStatus(snapshot.stage === 'failed' ? `原文件结构化入库完成，但有 ${snapshot.failed} 个失败。` : '原文件结构化入库完成。');
        }
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void reconcileInterruptedRawAssetQueueRun()
      .catch(() => 0)
      .then(() => loadRawAssetWorkspaceQueue())
      .then((snapshot) => {
        if (cancelled) return;
        setWorkspaceQueueTasks(snapshot?.tasks ?? []);
        setWorkspaceQueuePath(snapshot?.path ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaceQueueTasks([]);
        setWorkspaceQueuePath('');
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceRoot, activeWorkspaceSnapshotRoot, rawAssetCountLive, queueStatus?.updatedAt]);

  useEffect(
    () =>
      subscribeWikiBatchCompileStatus((snapshot) => {
        setWikiBatchStatus(snapshot);
        if (!snapshot) return;
        if (snapshot.stage === 'running') {
          setCompileStatus(`${snapshot.label}${snapshot.detail ? `：${snapshot.detail}` : ''}`);
        } else if (snapshot.stage === 'paused') {
          setCompileStatus(`${snapshot.label}${snapshot.detail ? `：${snapshot.detail}` : ''}`);
        } else if (Date.now() - snapshot.updatedAt < 5000) {
          setCompileStatus(
            snapshot.stage === 'failed'
              ? `批量生成/更新wiki页完成，但有 ${snapshot.failed} 个失败。`
              : '批量生成/更新wiki页完成。',
          );
        }
      }),
    [],
  );

  useEffect(() => {
    if (!sortedEntities.length || repairRunningRef.current) return;

    repairRunningRef.current = true;
    void (async () => {
      try {
        const patches = sortedEntities
          .map((entity) => ({ entity, patch: buildBrowserEntityWikiRepairPatch(entity) }))
          .filter((item): item is { entity: Entity; patch: NonNullable<ReturnType<typeof buildBrowserEntityWikiRepairPatch>> } => Boolean(item.patch));

        if (!patches.length) return;

        await db.transaction('rw', db.entities, async () => {
          for (const { entity, patch } of patches) {
            await db.entities.update(entity.id, patch);
          }
        });
      } finally {
        repairRunningRef.current = false;
      }
    })();
  }, [sortedEntities]);

  async function handleExportMarkdown() {
    const files = await buildMarkdownExportFiles();
    const blob = buildMarkdownZipBlob(files);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mywiki-export-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportMarkdown(file?: File) {
    if (!file) return;
    const confirmed = window.confirm(
      '导入备份会清空当前浏览器/桌面壳里的本地知识库，并用备份文件恢复。请确认你选择的是正确备份。',
    );
    if (!confirmed) {
      if (backupImportInputRef.current) backupImportInputRef.current.value = '';
      return;
    }

    setImportStatus('正在导入备份...');
    try {
      const records = await restoreMarkdownExportZip(file);
      setImportStatus(
        `导入完成：${records.entities.length} 个实体、${records.relationships.length} 条关系、${records.tasks.length} 条任务、${records.entries.length} 条原文。`,
      );
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : '导入失败，请确认文件来自 MyWiki Markdown 备份。');
    } finally {
      if (backupImportInputRef.current) backupImportInputRef.current.value = '';
    }
  }

  async function handleImportRawFile(file?: File) {
    if (!file) return;

    if (!isSupportedImportFile(file.name, file.type)) {
      setImportStatus(`${file.name} 的格式暂不支持。`);
      if (rawImportInputRef.current) rawImportInputRef.current.value = '';
      return;
    }

    setImportStatus(`正在导入原文件：${file.name}...`);
    try {
      const result = await createRawAssetFromFile(file);
      if (result.asset.entryId) {
        setSelected({ kind: 'entry', id: result.asset.entryId });
        setEditing(false);
      }
      setSaveStatus('');
      setCompileStatus('');
      setImportStatus(
        result.reused
          ? `原始材料已存在：${file.name}。可点击“原文件结构化入库”继续处理。`
          : `已导入原始材料：${file.name}。可点击“原文件结构化入库”生成知识树。`,
      );
      await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : `导入原文件失败：${file.name}`);
    } finally {
      if (rawImportInputRef.current) rawImportInputRef.current.value = '';
    }
  }

  function startEdit(entity: Entity) {
    setDraftMarkdown(buildInitialBrowserEntityMarkdown(entity, activeWorkspaceSchema));
    setSaveStatus('');
    setCompileStatus('');
    setEditing(true);
  }

  async function saveEntityDraft(entity: Entity) {
    const previousPath = inferWikiTargetSpec(entity, { schema: activeWorkspaceSchema }).path;
    const patch = buildBrowserEntityMarkdownPatch(entity, draftMarkdown);
    await db.entities.update(entity.id, patch);
    const updatedEntity = (await db.entities.get(entity.id)) ?? ({ ...entity, ...patch } as Entity);
    await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
    await deleteMovedWorkspaceWikiFile(previousPath, inferWikiTargetSpec(updatedEntity, { schema: activeWorkspaceSchema }).path).catch(() => undefined);
    setEditing(false);
    setSaveStatus('已保存页面。');
  }

  async function handleRecompileEntity(entity: Entity) {
    if (wikiBatchRunning || recoverableWikiBatchJob) {
      setCompileStatus(
        wikiBatchRunning
          ? 'Wiki 页面正在批量生成/更新中，请等待当前任务完成后再单独生成页面。'
          : '存在未完成的 Wiki 批量任务，请先继续或完成它，再单独生成页面。',
      );
      return;
    }

    const provider = getWikiCompileProviderSummary(loadProviderSettings());
    const providerLabel = provider ? `${provider.label} / ${provider.model}` : '当前 Wiki 模型';
    setCompileStatus(`正在使用 ${providerLabel} 生成/更新《${entity.title}》...`);
    setCompilingEntityId(entity.id);
    try {
      const result = await recompileBrowserEntityWikiPage(entity.id);
      await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
      setCompileStatus(`已完成《${entity.title}》的 v2 Wiki 页面生成/更新，使用模型：${result.provider} / ${result.model}。`);
    } catch (error) {
      setCompileStatus(error instanceof Error ? error.message : 'Wiki 页面生成/更新失败。');
    } finally {
      setCompilingEntityId(null);
    }
  }

  async function handleRecompileAll() {
    if (wikiBatchRunning) {
      setCompileStatus(
        wikiBatchStatus?.label
          ? `${wikiBatchStatus.label}${wikiBatchStatus.detail ? `：${wikiBatchStatus.detail}` : ''}`
          : 'Wiki 页面正在批量生成/更新中。',
      );
      return;
    }

    if (recoverableWikiBatchJob) {
      setCompileStatus(`正在继续未完成的 Wiki 批量任务：已处理 ${recoverableWikiBatchJob.processed}/${recoverableWikiBatchJob.total}。`);
      void resumeBrowserWikiBatchRecompile(recoverableWikiBatchJob.id)
        .then(() => syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined))
        .catch((error) => {
          setCompileStatus(error instanceof Error ? error.message : 'Wiki 页面批量生成/更新恢复失败。');
        });
      return;
    }

    const candidates = sortedEntities.filter((entity) => (entity.sourceEntries?.length ?? 0) > 0);
    if (!candidates.length) {
      setCompileStatus('没有找到可生成/更新的 Wiki 页面，至少需要 1 条来源原文。');
      return;
    }

    const legacyJob = await recoverLegacyWikiBatchJob(
      candidates.map((entity) => ({ id: entity.id, title: entity.title })),
      { owner: 'wiki' },
    );
    if (legacyJob && legacyJob.status === 'paused') {
      setCompileStatus(`已恢复刷新前的批量任务：已处理 ${legacyJob.processed}/${legacyJob.total}，正在继续。`);
      void resumeBrowserWikiBatchRecompile(legacyJob.id)
        .then(() => syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined))
        .catch((error) => {
          setCompileStatus(error instanceof Error ? error.message : 'Wiki 页面批量生成/更新恢复失败。');
        });
      return;
    }

    const provider = getWikiCompileProviderSummary(loadProviderSettings());
    const providerLabel = provider ? `${provider.label} / ${provider.model}` : '当前 Wiki 模型';
    const confirmed = window.confirm(
      `即将使用 ${providerLabel} 生成/更新 ${candidates.length} 个 Wiki 页面。这个过程会覆盖旧的 Wiki Markdown，是否继续？`,
    );
    if (!confirmed) return;

    setCompileStatus(`已启动 ${candidates.length} 个 Wiki 页面的批量生成/更新。`);
    void startBrowserWikiBatchRecompile(
      candidates.map((entity) => ({ id: entity.id, title: entity.title })),
      { owner: 'wiki' },
    )
      .then(() => syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined))
      .catch((error) => {
        setCompileStatus(error instanceof Error ? error.message : 'Wiki 页面批量生成/更新启动失败。');
      });
  }

  async function handleCompileRawQueue() {
    if (wikiBatchRunning || recoverableWikiBatchJob) {
      setCompileStatus(
        wikiBatchRunning
          ? 'Wiki 页面正在批量生成/更新中，请等待当前任务完成后再执行原文件入库并生成 Wiki。'
          : '存在未完成的 Wiki 批量任务，请先继续或完成它，再执行原文件入库并生成 Wiki。',
      );
      return;
    }

    setCompileStatus('正在执行原文件入库并生成 Wiki...');
    try {
      const result = await processRawAssetQueue({ owner: 'wiki', compileWiki: true });
      if (result.total === 0) {
        setCompileStatus('暂无需要处理的原文件；这个按钮只处理 Raw Inbox 中待解析、失败或 Wiki 生成失败的文件。');
      } else if (result.failed > 0) {
        setCompileStatus(`原文件入库并生成 Wiki 完成，但仍有 ${result.failed} 个材料失败。`);
      } else {
        setCompileStatus(`原文件入库并生成 Wiki 完成：成功处理 ${result.processed}/${result.total} 个材料。`);
      }
      await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
    } catch (error) {
      setCompileStatus(error instanceof Error ? error.message : '原文件入库并生成 Wiki 失败。');
    }
  }

  async function refreshWorkspaceQueueState() {
    const snapshot = await loadRawAssetWorkspaceQueue();
    setWorkspaceQueueTasks(snapshot?.tasks ?? []);
    setWorkspaceQueuePath(snapshot?.path ?? '');
    return snapshot;
  }

  async function handleRetryWorkspaceQueueTask(taskId: string) {
    setWorkspaceQueueActionStatus('正在重试队列任务...');
    try {
      const ok = await retryRawAssetQueueTask(taskId);
      await refreshWorkspaceQueueState();
      if (!ok) {
        setWorkspaceQueueActionStatus('未找到要重试的队列任务。');
        return;
      }
      setWorkspaceQueueActionStatus('已重新加入队列，开始处理。');
      if (!queueRunning && !wikiBatchRunning && !hasRecoverableWikiBatchJob && !compilingEntityId) {
        void handleCompileRawQueue();
      }
    } catch (error) {
      setWorkspaceQueueActionStatus(error instanceof Error ? error.message : '重试队列任务失败。');
    }
  }

  async function handleRetryFailedWorkspaceQueueTasks() {
    const failedTasks = workspaceQueueTasks.filter((task) => task.status === 'failed');
    if (!failedTasks.length) {
      setWorkspaceQueueActionStatus('没有失败队列任务需要重试。');
      return;
    }

    setWorkspaceQueueActionStatus(`正在重试 ${failedTasks.length} 个失败队列任务...`);
    try {
      let retried = 0;
      for (const task of failedTasks) {
        if (await retryRawAssetQueueTask(task.id)) retried += 1;
      }
      await refreshWorkspaceQueueState();
      setWorkspaceQueueActionStatus(retried > 0 ? `已重新加入队列 ${retried} 个任务，开始继续处理。` : '没有可重试的失败队列任务。');
      if (retried > 0 && !queueRunning && !wikiBatchRunning && !hasRecoverableWikiBatchJob && !compilingEntityId) {
        void handleCompileRawQueue();
      }
    } catch (error) {
      setWorkspaceQueueActionStatus(error instanceof Error ? error.message : '重试失败队列任务失败。');
    }
  }

  async function handleCancelWorkspaceQueueTask(taskId: string) {
    setWorkspaceQueueActionStatus('正在取消队列任务...');
    try {
      const ok = await cancelRawAssetQueueTask(taskId);
      await refreshWorkspaceQueueState();
      setWorkspaceQueueActionStatus(ok ? '已取消队列任务。' : '未找到要取消的队列任务。');
    } catch (error) {
      setWorkspaceQueueActionStatus(error instanceof Error ? error.message : '取消队列任务失败。');
    }
  }

  async function handleCancelActiveWorkspaceQueueTasks() {
    if (!window.confirm('确定取消所有排队中和正在处理的原文件入库任务？正在请求模型的任务会在当前请求返回后停止后续处理。')) return;
    setWorkspaceQueueActionStatus('正在取消活跃队列任务...');
    try {
      const count = await cancelActiveRawAssetQueueTasks();
      await refreshWorkspaceQueueState();
      setWorkspaceQueueActionStatus(count > 0 ? `已取消 ${count} 个队列任务。` : '没有可取消的队列任务。');
    } catch (error) {
      setWorkspaceQueueActionStatus(error instanceof Error ? error.message : '取消队列任务失败。');
    }
  }

  async function handleClearWorkspaceQueueTasks() {
    setWorkspaceQueueActionStatus('正在清理队列记录...');
    try {
      const count = await clearTerminalRawAssetQueueTasks();
      await refreshWorkspaceQueueState();
      setWorkspaceQueueActionStatus(count > 0 ? `已清理 ${count} 条队列记录。` : '没有可清理的队列记录。');
    } catch (error) {
      setWorkspaceQueueActionStatus(error instanceof Error ? error.message : '清理队列记录失败。');
    }
  }

  async function handleDeleteEntityPage(entity: Entity) {
    if (!window.confirm(`确定删除知识页“${entity.title}”？关联的原始材料不会被删除。`)) return;

    await deleteEntity(entity.id);
    if (selected?.kind === 'entity' && selected.id === entity.id) {
      setSelected(null);
      setEditing(false);
      setDraftMarkdown('');
    }
    setSaveStatus(`已删除知识页：${entity.title}`);
    await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
  }

  async function handleDeleteEntityTypeGroup(label: string, pages: BrowserWikiTreePage[]) {
    if (!pages.length) return;
    const ids = pages.map((page) => page.entity.id);
    if (!window.confirm(`确定删除“${label}”下的 ${ids.length} 个知识页？关联的原始材料不会被删除。`)) return;

    for (const id of ids) {
      await deleteEntity(id);
    }
    if (selected?.kind === 'entity' && ids.includes(selected.id)) {
      setSelected(null);
      setEditing(false);
      setDraftMarkdown('');
    }
    setSaveStatus(`已删除“${label}”下的 ${ids.length} 个知识页。`);
    await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
  }

  async function handleDeleteSourceItem(source: BrowserSourceItem) {
    if (!window.confirm(`确定删除原始材料“${source.title}”？已生成的知识页不会自动删除。`)) return;

    let relatedAssets: RawAsset[] = [];
    if (source.rawAssetId) {
      try {
        relatedAssets = (await db.rawAssets.bulkGet([source.rawAssetId])).filter((asset): asset is RawAsset => Boolean(asset));
      } catch {
        relatedAssets = [];
      }
    }
    const relatedJobIds = relatedAssets.map((asset) => asset.ingestJobId).filter((id): id is string => Boolean(id));

    await db.transaction('rw', [db.rawAssets, db.ingestJobs, db.entries, db.entities, db.ingestCache], async () => {
      if (relatedAssets.length) {
        await db.rawAssets.bulkDelete(relatedAssets.map((asset) => asset.id));
      }
      if (relatedJobIds.length) {
        await db.ingestJobs.bulkDelete(relatedJobIds);
      }
      if (source.entryId) {
        await db.entries.delete(source.entryId);
        await db.entities.toCollection().modify((entity) => {
          entity.sourceEntries = entity.sourceEntries.filter((entryId) => entryId !== source.entryId);
        });
        await db.ingestCache.toCollection().modify((cache) => {
          cache.entryIds = cache.entryIds.filter((entryId) => entryId !== source.entryId);
        });
      }
    });

    if (selected?.kind === 'entry' && selected.id === source.entryId) {
      setSelected(null);
      setEditing(false);
    }
    setSaveStatus(`已删除原始材料：${source.title}`);
    await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
  }

  function toggleExpandedType(type: string) {
    setExpandedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function startPaneResize(handle: 'left-center' | 'center-right', startX: number) {
    const initialLayout = paneLayout;
    const gridWidth = paneGridRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const resizableWidth = Math.max(1, gridWidth - 20);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let frame = 0;
    let latestDeltaPercent = 0;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const commitLayout = () => {
      frame = 0;
      setPaneLayout(resizeTriPaneLayout(initialLayout, handle, latestDeltaPercent));
    };

    const onMove = (event: MouseEvent) => {
      latestDeltaPercent = ((event.clientX - startX) / resizableWidth) * 100;
      if (frame === 0) frame = window.requestAnimationFrame(commitLayout);
    };
    const onUp = () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      setPaneLayout(resizeTriPaneLayout(initialLayout, handle, latestDeltaPercent));
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }

  function openEntityByReference(reference: string) {
    const target = findBrowserEntityByReference(reference, sortedEntities);
    if (!target) return;
    setSelected({ kind: 'entity', id: target.id });
    setEditing(false);
    setSaveStatus('');
    setCompileStatus('');
  }

  function openEntryByReference(reference: string) {
    const target = findBrowserEntryByReference(reference, entries);
    if (!target) return;
    setSelected({ kind: 'entry', id: target.id });
    setEditing(false);
    setSaveStatus('');
    setCompileStatus('');
  }

  const queueButtonLabel = queueRunning ? `入库并生成 Wiki 中 ${queueStatus?.percent ?? 0}%` : '原文件入库并生成 Wiki';
  const showRawQueuePanelStatus = Boolean(queueStatus && (queueRunning || Date.now() - queueStatus.updatedAt < 7000));
  const rawQueuePanelMessage = queueStatus
    ? queueStatus.stage === 'running'
      ? `原文件入库并生成 Wiki 中 ${queueStatus.percent}%：${queueStatus.label}${queueStatus.detail ? `（${queueStatus.detail}）` : ''}`
      : queueStatus.stage === 'failed'
        ? `原文件入库并生成 Wiki 完成，但有 ${queueStatus.failed} 个失败。${queueStatus.detail ? ` ${queueStatus.detail}` : ''}`
        : `原文件入库并生成 Wiki 完成。${queueStatus.detail ? ` ${queueStatus.detail}` : ''}`
    : '';
  const workspaceQueueSummary = useMemo(() => summarizeRawAssetWorkspaceQueue(workspaceQueueTasks), [workspaceQueueTasks]);
  const visibleWorkspaceQueueTasks = useMemo(
    () =>
      workspaceQueueTasks
        .filter((task) => task.status !== 'done' || Date.now() - (task.completedAt ?? task.updatedAt) < 10 * 60 * 1000)
        .sort((left, right) => left.addedAt - right.addedAt)
        .slice(0, 8),
    [workspaceQueueTasks],
  );
  const showWorkspaceQueueTasks =
    visibleWorkspaceQueueTasks.length > 0 &&
    (workspaceQueueSummary.pending + workspaceQueueSummary.processing + workspaceQueueSummary.failed + workspaceQueueSummary.cancelled > 0 || queueRunning);
  const workspaceQueueHasActive = workspaceQueueSummary.pending + workspaceQueueSummary.processing > 0;
  const workspaceQueueHasClearable = workspaceQueueSummary.done + workspaceQueueSummary.cancelled > 0;
  const workspaceQueueSummaryLabel = formatRawWorkspaceQueueSummary(workspaceQueueSummary);
  const canResumeWorkspaceQueue =
    workspaceQueueHasActive && !queueRunning && !wikiBatchRunning && !hasRecoverableWikiBatchJob && !compilingEntityId;
  const canRetryFailedWorkspaceQueue =
    workspaceQueueSummary.failed > 0 && !queueRunning && !wikiBatchRunning && !hasRecoverableWikiBatchJob && !compilingEntityId;
  const showWikiBatchPanelStatus = Boolean(wikiBatchStatus && (wikiBatchRunning || hasRecoverableWikiBatchJob || Date.now() - wikiBatchStatus.updatedAt < 7000));
  const wikiBatchPanelMessage = wikiBatchStatus
    ? wikiBatchStatus.stage === 'paused'
      ? `批量生成/更新已暂停：${wikiBatchStatus.detail ?? '可点击“继续批量生成/更新wiki页”恢复任务。'}`
      : wikiBatchStatus.stage === 'running'
      ? `批量生成/更新中 ${wikiBatchStatus.percent}%：${wikiBatchStatus.label}${wikiBatchStatus.detail ? `（${wikiBatchStatus.detail}）` : ''}`
      : wikiBatchStatus.stage === 'failed'
        ? `批量生成/更新完成，但有 ${wikiBatchStatus.failed} 个失败。${wikiBatchStatus.detail ? ` ${wikiBatchStatus.detail}` : ''}`
        : `批量生成/更新完成。${wikiBatchStatus.detail ? ` ${wikiBatchStatus.detail}` : ''}`
    : '';

  return (
    <section className="mx-auto max-w-[1440px] px-5 py-8">
      {dbOpenError ? (
        <div className="mb-4 rounded-[14px] border border-[#f0b7b7] bg-[#fff6f6] px-4 py-3 text-sm leading-6 text-[#9f1c1c]">
          当前浏览器知识库没有正常打开，页面显示为空更可能是本地 IndexedDB 迁移或恢复失败，而不是内容真的没了。当前
          origin：<code>{browserRuntimeOrigin || 'unknown'}</code>；数据库错误：<code>{dbOpenError}</code>
        </div>
      ) : null}
      {showEmptyBrowserNotice ? (
        <div className="mb-4 rounded-[14px] border border-[#f2d6a2] bg-[#fffaf0] px-4 py-3 text-sm leading-6 text-[#7c5a11]">
          当前浏览器模式下本地知识库是空的。若你之前在这里看过资料，更像是本地 IndexedDB 被重建了，或者历史库还没恢复回来。当前
          origin：<code>{browserRuntimeOrigin || 'unknown'}</code>
        </div>
      ) : null}
      {!knowledgeDataLoaded && !dbOpenError ? (
        <div className="mb-4 rounded-[14px] border border-[#dbe7ff] bg-[#f5f8ff] px-4 py-3 text-sm leading-6 text-[#315078]">
          正在读取本地 IndexedDB 知识库...
        </div>
      ) : null}
      <div className="mb-5 flex gap-3 overflow-x-auto pb-1">
        {(browserWikiTypeStats.length ? browserWikiTypeStats : [{ label: 'Wiki 页面', value: browserWikiPages.length }]).map((item) => (
          <StatCard key={item.label} label={item.label} value={item.value} />
        ))}
        <StatCard label="原始材料" value={sourceItems.length} />
        <StatCard label="关系" value={relationships.length} />
        <StatCard label="任务" value={tasks.length} />
      </div>

      <div
        ref={paneGridRef}
        className="grid min-h-[720px] min-w-0 gap-0"
        style={{
          gridTemplateColumns: `minmax(320px, ${paneLayout.left}fr) 10px minmax(280px, ${paneLayout.center}fr) 10px minmax(380px, ${paneLayout.right}fr)`,
        }}
      >
        <aside className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white">
          <BrowserPanelHeader
            eyebrow="Sources"
            title="原始材料"
            action={
              <div className="flex w-max items-center justify-start gap-2">
		                <button
		                  type="button"
		                  onClick={() => void handleCompileRawQueue()}
		                  disabled={Boolean(compilingEntityId) || queueRunning || wikiBatchRunning || hasRecoverableWikiBatchJob}
		                  className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-2.5 py-1 text-xs font-medium text-[#155eef] transition hover:bg-[#f4f8ff] disabled:cursor-not-allowed disabled:opacity-50"
		                  title={
		                    wikiBatchRunning || hasRecoverableWikiBatchJob
		                      ? '存在 Wiki 批量生成/更新任务'
	                      : queueRunning
	                        ? queueStatus?.label
	                        : '把 Frog、捕获页和上传文件暂存的原文件解析、结构化入库，并生成或更新相关 Wiki 页面'
	                  }
	                >
                  {queueRunning ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {queueButtonLabel}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportMarkdown()}
                  className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-2.5 py-1 text-xs font-medium text-[#155eef] transition hover:bg-[#f4f8ff]"
                >
                  <Download size={13} />
                  导出
                </button>
                <input
                  ref={rawImportInputRef}
                  data-testid="raw-file-import-input"
                  type="file"
                  className="hidden"
                  onChange={(event) => void handleImportRawFile(event.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => rawImportInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs font-medium text-[#1f2937] transition hover:bg-[#f7f7f5]"
                  title="选择任意单个原文件加入原始材料，之后可执行原文件结构化入库"
                >
                  <Upload size={13} />
                  导入原文件
                </button>
                <input
                  ref={backupImportInputRef}
                  data-testid="backup-import-input"
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(event) => void handleImportMarkdown(event.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => backupImportInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs font-medium text-[#1f2937] transition hover:bg-[#f7f7f5]"
                  title="导入 MyWiki 导出的 zip 备份，会先确认再恢复"
                >
                  <Upload size={13} />
                  导入备份
                </button>
              </div>
            }
          />
	          <div className="max-h-[660px] overflow-auto p-3">
	            {restoreStatus ? <p className="mb-3 rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] p-3 text-xs leading-5 text-[#315078]">{restoreStatus}</p> : null}
	            {importStatus ? <p className="mb-3 rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] p-3 text-xs leading-5 text-[#315078]">{importStatus}</p> : null}
	            {showRawQueuePanelStatus ? (
	              <p className="mb-3 rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] p-3 text-xs leading-5 text-[#315078]">{rawQueuePanelMessage}</p>
	            ) : null}
	            {showWorkspaceQueueTasks ? (
	              <div className="mb-3 rounded-[10px] border border-[#dbe7ff] bg-[#f8fbff] p-3 text-xs text-[#315078]">
	                <div className="mb-2 flex items-center justify-between gap-2">
	                  <span className="font-semibold">入库队列</span>
	                  <div className="flex shrink-0 items-center gap-1.5">
	                    <span className="text-[#626965]">{workspaceQueueSummaryLabel}</span>
	                    {canResumeWorkspaceQueue ? (
	                      <button
	                        type="button"
	                        onClick={() => void handleCompileRawQueue()}
	                        className="rounded-[7px] border border-[#155eef] px-1.5 py-0.5 text-[11px] font-medium text-[#155eef] hover:bg-[#eef4ff]"
	                        title="继续处理排队中的原文件入库任务"
	                      >
	                        继续
	                      </button>
	                    ) : null}
	                    {canRetryFailedWorkspaceQueue ? (
	                      <button
	                        type="button"
	                        onClick={() => void handleRetryFailedWorkspaceQueueTasks()}
	                        className="rounded-[7px] border border-[#155eef] px-1.5 py-0.5 text-[11px] font-medium text-[#155eef] hover:bg-[#eef4ff]"
	                        title="重试失败的原文件入库任务，并从未完成的 Wiki 词条继续生成"
	                      >
	                        重试失败项
	                      </button>
	                    ) : null}
	                    {workspaceQueueHasActive ? (
	                      <button
	                        type="button"
	                        onClick={() => void handleCancelActiveWorkspaceQueueTasks()}
	                        className="rounded-[7px] border border-[#f5b5ae] px-1.5 py-0.5 text-[11px] font-medium text-[#b42318] hover:bg-[#fff1f2]"
	                        title="取消所有排队中和正在处理的原文件入库任务"
	                      >
	                        取消全部
	                      </button>
	                    ) : null}
	                    {workspaceQueueHasClearable ? (
	                      <button
	                        type="button"
	                        onClick={() => void handleClearWorkspaceQueueTasks()}
	                        className="rounded-[7px] border border-[#d9d9d6] px-1.5 py-0.5 text-[11px] font-medium text-[#626965] hover:bg-[#f7f7f5]"
	                        title="清理已完成和已取消的队列记录"
	                      >
	                        清理
	                      </button>
	                    ) : null}
	                  </div>
	                </div>
	                {workspaceQueueActionStatus ? (
	                  <p className="mb-2 rounded-[8px] bg-white px-2 py-1 text-[11px] text-[#626965]">{workspaceQueueActionStatus}</p>
	                ) : null}
	                <div className="grid gap-1.5">
	                  {visibleWorkspaceQueueTasks.map((task) => (
	                    <div key={task.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-[8px] bg-white px-2 py-1.5">
	                      <span className={rawWorkspaceQueueStatusDotClass(task.status)} />
	                      <span className="min-w-0 truncate" title={task.sourcePath}>
	                        {task.filename}
	                      </span>
	                      <span className="shrink-0 text-[#626965]">{rawWorkspaceQueueTaskLabel(task)}</span>
	                      <span className="flex shrink-0 items-center gap-1">
	                        {task.status === 'failed' || task.status === 'cancelled' ? (
	                          <button
	                            type="button"
	                            onClick={() => void handleRetryWorkspaceQueueTask(task.id)}
	                            className="flex size-6 items-center justify-center rounded-[7px] text-[#155eef] hover:bg-[#eef4ff]"
	                            aria-label={`重试 ${task.filename}`}
	                            title="重试"
	                          >
	                            <RotateCcw size={13} />
	                          </button>
	                        ) : null}
	                        {task.status === 'pending' || task.status === 'processing' ? (
	                          <button
	                            type="button"
	                            onClick={() => void handleCancelWorkspaceQueueTask(task.id)}
	                            className="flex size-6 items-center justify-center rounded-[7px] text-[#b42318] hover:bg-[#fff1f2]"
	                            aria-label={`取消 ${task.filename}`}
	                            title="取消"
	                          >
	                            <XCircle size={13} />
	                          </button>
	                        ) : null}
	                      </span>
	                    </div>
	                  ))}
	                </div>
	                {workspaceQueuePath ? (
	                  <p className="mt-2 truncate text-[11px] text-[#8a8f89]" title={workspaceQueuePath}>
	                    {workspaceQueuePath}
	                  </p>
	                ) : null}
	              </div>
	            ) : null}
            {sourceItems.length === 0 ? (
              <p className="rounded-[10px] border border-[#e5e5e4] px-3 py-4 text-sm text-[#626965]">暂无原始材料。</p>
            ) : (
              <div className="grid gap-2">
                {sourceItems.map((source) => (
                  <article
                    key={source.id}
                    className={[
                      'group/source flex min-w-0 items-start gap-2 rounded-[10px] border p-3 transition',
                      selectedEntry?.id === source.id ? 'border-[#155eef] bg-[#f4f8ff]' : 'border-[#e5e5e4] bg-white hover:bg-[#fbfbfa]',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        if (!source.entryId) return;
                        setSelected({ kind: 'entry', id: source.entryId });
                        setEditing(false);
                        setSaveStatus('');
                        setCompileStatus('');
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <FileText size={15} className="mt-0.5 shrink-0 text-[#626965]" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-[#1f2937]">{source.title}</p>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#626965]">{source.summary}</p>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="pointer-events-none flex size-8 shrink-0 items-center justify-center rounded-[8px] text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/source:pointer-events-auto group-hover/source:opacity-100"
                      onClick={() => void handleDeleteSourceItem(source)}
                      aria-label={`删除原始材料 ${source.title}`}
                      title={`删除原始材料：${source.title}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </aside>

        <PaneResizer onMouseDown={(event) => startPaneResize('left-center', event.clientX)} />

        <main className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white">
          <BrowserPanelHeader
            eyebrow="Knowledge"
            title="知识树"
            action={
	              <button
	                type="button"
	                onClick={() => void handleRecompileAll()}
	                disabled={Boolean(compilingEntityId) || queueRunning || wikiBatchRunning}
	                className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs font-medium text-[#155eef] transition hover:bg-[#f4f8ff] disabled:cursor-not-allowed disabled:opacity-50"
		                title={
		                  wikiBatchRunning
		                    ? wikiBatchStatus?.detail ?? wikiBatchStatus?.label ?? 'Wiki 页面正在批量生成/更新中'
		                    : hasRecoverableWikiBatchJob
		                      ? `继续未完成任务：已处理 ${recoverableWikiBatchJob?.processed ?? 0}/${recoverableWikiBatchJob?.total ?? 0}`
		                    : '用当前已入库材料生成或更新所有已存在 Wiki 页面的 Markdown 内容'
		                }
	              >
	                {wikiBatchRunning ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
	                {wikiBatchButtonLabel}
	              </button>
            }
	          />
	          <div className="max-h-[660px] overflow-auto p-2">
	            {showWikiBatchPanelStatus ? (
	              <p className="mb-3 rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] p-3 text-xs leading-5 text-[#315078]">{wikiBatchPanelMessage}</p>
	            ) : null}
	            <div className="mb-3 rounded-[14px] border border-[#d9d9d6] bg-white px-3 py-2 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
              <label className="flex items-center gap-2 text-sm text-[#1f2937]">
                <Search size={16} className="shrink-0 text-[#8a8f89]" />
                <input
                  aria-label="搜索 Wiki 页面"
                  value={wikiSearchQuery}
                  onChange={(event) => setWikiSearchQuery(event.target.value)}
                  placeholder="搜索 Wiki 页面...（全文关键词检索）"
                  className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:font-normal placeholder:text-[#8a8f89]"
                />
              </label>
            </div>
            {showingWikiSearchResults ? (
              <BrowserWikiSearchResults
                query={deferredWikiSearchQuery}
                results={browserWikiSearchResults}
                selectedEntityId={selectedEntity?.id}
                onSelect={(result) => {
                  setSelected({ kind: 'entity', id: result.entity.id });
                  setEditing(false);
                  setSaveStatus('');
                  setCompileStatus('');
                }}
              />
            ) : (
              <>
                <p className="mb-2 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] px-3 py-2 text-xs leading-5 text-[#626965]">
                  {compatibilityNote}
                </p>
                {browserWikiGroups.map((group) => (
                  <BrowserWikiTreeGroup
                    key={group.type}
                    label={group.label}
                    type={group.type}
                    pages={group.pages as BrowserWikiTreePage[]}
                    expanded={expandedTypes.has(group.type)}
                    selectedEntityId={selectedEntity?.id}
                    onToggle={() => toggleExpandedType(group.type)}
                    onSelect={(page) => {
                      setSelected({ kind: 'entity', id: page.entity.id });
                      setEditing(false);
                      setSaveStatus('');
                      setCompileStatus('');
                    }}
                    onDeleteGroup={() => void handleDeleteEntityTypeGroup(group.label, group.pages as BrowserWikiTreePage[])}
                    onDeletePage={(page) => void handleDeleteEntityPage(page.entity)}
                  />
                ))}
              </>
            )}
          </div>
        </main>

        <PaneResizer onMouseDown={(event) => startPaneResize('center-right', event.clientX)} />

        <aside className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white">
          <BrowserPanelHeader
            eyebrow={selectedEntry ? 'Raw Preview' : 'Wiki Page'}
            title={selectedEntry?.fileMetadata?.filename ?? selectedEntity?.title ?? '未选择页面'}
            action={
              selectedEntity ? (
                editing ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-label="取消编辑"
                      className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#626965] hover:bg-[#f7f7f5]"
                      onClick={() => {
                        setEditing(false);
                        setSaveStatus('');
                        setCompileStatus('');
                      }}
                    >
                      <XCircle size={13} />
                      取消
                    </button>
                    <button
                      type="button"
                      aria-label="保存页面"
                      className="inline-flex items-center gap-1 rounded-full bg-[#155eef] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0f4bcc]"
                      onClick={() => void saveEntityDraft(selectedEntity)}
                    >
                      <Save size={13} />
                      保存
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
	                    <button
	                      type="button"
	                      aria-label="AI 生成/更新页面"
	                      disabled={compilingEntityId === selectedEntity.id || wikiBatchRunning || hasRecoverableWikiBatchJob}
	                      className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef] hover:bg-[#eef4ff] disabled:cursor-not-allowed disabled:opacity-50"
	                      onClick={() => void handleRecompileEntity(selectedEntity)}
	                    >
	                      {compilingEntityId === selectedEntity.id ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
	                      {compilingEntityId === selectedEntity.id
	                        ? '生成中'
	                        : wikiBatchRunning
	                          ? '批量生成中'
	                          : hasRecoverableWikiBatchJob
	                            ? '待继续批量任务'
	                            : 'AI 生成/更新'}
	                    </button>
                    <button
                      type="button"
                      aria-label="编辑页面"
                      className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef] hover:bg-[#eef4ff]"
                      onClick={() => startEdit(selectedEntity)}
                    >
                      <Edit3 size={13} />
                      编辑
                    </button>
                  </div>
                )
              ) : null
            }
          />
          {saveStatus ? <p className="mx-5 mt-4 inline-block rounded-full border border-[#b7e4c7] bg-[#f0fff4] px-3 py-1.5 text-xs text-[#276749]">{saveStatus}</p> : null}
          {compileStatus ? <p className="mx-5 mt-4 inline-block rounded-full border border-[#dbe7ff] bg-[#f5f8ff] px-3 py-1.5 text-xs text-[#315078]">{compileStatus}</p> : null}
          {selectedEntity ? (
            editing ? (
              <div className="grid gap-3 p-5">
                <label className="grid gap-2 text-sm font-medium text-[#1f2937]">
                  Markdown 全文
                  <textarea
                    aria-label="Markdown 全文"
                    className="h-[560px] resize-none rounded-[8px] border border-[#d9d9d6] bg-[#fbfbfa] px-3 py-3 font-mono text-sm leading-7 outline-none focus:border-[#155eef]"
                    value={draftMarkdown}
                    onChange={(event) => setDraftMarkdown(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <BrowserEntityPreview
                entity={selectedEntity}
                onOpenRelated={openEntityByReference}
                onOpenSource={openEntryByReference}
              />
            )
          ) : selectedEntry ? (
            <BrowserEntryPreview entry={selectedEntry} />
          ) : (
            <p className="p-5 text-sm text-[#626965]">请选择左侧 Wiki 页面或中间原始材料。</p>
          )}
        </aside>
      </div>
    </section>
  );
}

async function deleteMovedWorkspaceWikiFile(previousPath: string, nextPath: string) {
  if (!canUseWorkspaceStorage()) return;

  const previousRelativePath = assertSafeWorkspaceRelativePath(previousPath, ['wiki']);
  const nextRelativePath = assertSafeWorkspaceRelativePath(nextPath, ['wiki']);
  if (previousRelativePath === nextRelativePath) return;

  const storage = createWorkspaceStorage();
  if (!storage.deletePath) return;

  const root = getPersistedWorkspaceRoot() ?? (await getWorkspaceDefaultRoot());
  const initialized = await initializeWorkspace(storage, root, { outputLanguage: 'zh-CN' });
  const absolutePreviousPath = joinWorkspacePath(initialized.layout.root, previousRelativePath);
  const absoluteNextPath = joinWorkspacePath(initialized.layout.root, nextRelativePath);
  if (absolutePreviousPath === absoluteNextPath) return;
  if (!(await storage.exists(absolutePreviousPath))) return;

  await storage.deletePath(initialized.layout.root, absolutePreviousPath);
}

function formatRawWorkspaceQueueSummary(summary: ReturnType<typeof summarizeRawAssetWorkspaceQueue>) {
  const parts = [
    summary.pending > 0 ? `排队 ${summary.pending}` : '',
    summary.processing > 0 ? `处理中 ${summary.processing}` : '',
    summary.failed > 0 ? `失败 ${summary.failed}` : '',
    summary.cancelled > 0 ? `已取消 ${summary.cancelled}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '队列空闲';
}

function rawWorkspaceQueueTaskLabel(task: RawAssetWorkspaceQueueTask) {
  if (task.status === 'processing') {
    return task.stage === 'wiki' ? '生成 Wiki' : task.stage === 'structuring' ? '结构化' : '解析中';
  }
  if (task.status === 'pending') return task.retryCount > 0 ? `等待继续 ${task.retryCount}` : '排队';
  if (task.status === 'failed') return task.retryCount > 0 ? `失败 ${task.retryCount} 次` : '失败';
  if (task.status === 'cancelled') return '已取消';
  return '完成';
}

function rawWorkspaceQueueStatusDotClass(status: RawAssetWorkspaceQueueTask['status']) {
  const base = 'size-2 rounded-full';
  if (status === 'processing') return `${base} bg-[#155eef]`;
  if (status === 'pending') return `${base} bg-[#f59e0b]`;
  if (status === 'failed') return `${base} bg-[#d92d20]`;
  if (status === 'cancelled') return `${base} bg-[#8a8f89]`;
  return `${base} bg-[#039855]`;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[150px] rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <p className="truncate text-xs text-[#626965]" title={label}>{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[#1f2937]">{value}</p>
    </div>
  );
}

function BrowserPanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-3 border-b border-[#ececea] px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-[#155eef]">{eyebrow}</p>
        <h2 className="mt-1 truncate text-lg font-semibold text-[#1f2937]">{title}</h2>
      </div>
      <div className="flex min-h-8 min-w-0 items-center justify-start overflow-x-auto pb-1">
        {action ? <div className="min-w-max">{action}</div> : null}
      </div>
    </div>
  );
}

function BrowserWikiTreeGroup({
  label,
  type,
  pages,
  expanded,
  selectedEntityId,
  onToggle,
  onSelect,
  onDeleteGroup,
  onDeletePage,
}: {
  label: string;
  type: WikiPageType;
  pages: BrowserWikiTreePage[];
  expanded: boolean;
  selectedEntityId?: string;
  onToggle: () => void;
  onSelect: (page: BrowserWikiTreePage) => void;
  onDeleteGroup: () => void;
  onDeletePage: (page: BrowserWikiTreePage) => void;
}) {
  return (
    <section className="mb-1 min-w-0 rounded-[10px] border border-[#e5e5e4] bg-white">
      <div className="group/type-row flex min-w-0 items-center gap-1 border-b border-[#e5e5e4] hover:bg-[#f7f7f5]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={15} className="shrink-0 text-[#626965]" /> : <ChevronRight size={15} className="shrink-0 text-[#626965]" />}
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1f2937]">{label}</h3>
          <span className="rounded-full border border-[#d9d9d6] px-2 py-0.5 text-xs text-[#626965]">
            {pages.length}
          </span>
        </button>
        <button
          type="button"
          className="pointer-events-none mr-2 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/type-row:pointer-events-auto group-hover/type-row:opacity-100"
          onClick={onDeleteGroup}
          aria-label={`删除 ${label} 分组知识页`}
          title={`删除 ${label} 分组知识页`}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {!expanded ? null : pages.length === 0 ? (
        <p className="px-3 py-3 text-sm text-[#626965]">暂无记录。</p>
      ) : (
        <div className="grid min-w-0 gap-1 px-2 py-1.5">
          {pages.map((page) => (
            <div
              key={`${type}:${page.entity.id}`}
              className={[
                'group/tree-row flex min-w-0 items-center gap-1 rounded-[8px] transition',
                selectedEntityId === page.entity.id ? 'bg-[#eef4ff] text-[#155eef]' : 'text-[#626965] hover:bg-[#f7f7f5] hover:text-[#1f2937]',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => onSelect(page)}
                className="min-w-0 flex-1 px-2 py-1.5 text-left text-sm"
                title={page.title}
              >
                <span className="block truncate">{page.title}</span>
              </button>
              {page.wikiStatus.state === 'complete' ? null : (
                <span
                  className={[
                    'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                    page.wikiStatus.state === 'draft'
                      ? 'border-[#f2d08f] bg-[#fff8e6] text-[#8a5a00]'
                      : 'border-[#e5e5e4] bg-[#fbfbfa] text-[#626965]',
                  ].join(' ')}
                  title={page.wikiStatus.detail}
                >
                  {page.wikiStatus.state === 'draft' ? '草稿' : '未生成'}
                </span>
              )}
              <button
                type="button"
                className="pointer-events-none mr-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/tree-row:pointer-events-auto group-hover/tree-row:opacity-100"
                onClick={() => onDeletePage(page)}
                aria-label={`删除知识页 ${page.title}`}
                title={`删除知识页：${page.title}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BrowserEntityPreview({
  entity,
  onOpenSource,
  onOpenRelated,
}: {
  entity: Entity;
  onOpenSource?: (reference: string) => void;
  onOpenRelated?: (reference: string) => void;
}) {
  if (entity.wikiMarkdown) {
    const metadata = buildWikiPageMetadata(entity.wikiMarkdown, entity);
    const wikiStatus = getBrowserWikiEntityStatus(entity, metadata);
    const displayType = resolveBrowserWikiDisplayType(metadata, normalizeBrowserWikiPageType(metadata.type) ?? inferWikiTargetSpec(entity).type);
    return (
      <article className="max-h-[620px] overflow-auto px-6 py-5">
        <BrowserWikiHeaderCard
          metadata={metadata}
          displayType={displayType}
          wikiStatus={wikiStatus}
          compileModel={entity.wikiCompileModel}
          compiledAt={entity.wikiCompiledAt}
          onOpenSource={onOpenSource}
          onOpenRelated={onOpenRelated}
        />
        {wikiStatus.state === 'draft' ? <BrowserWikiStatusNotice status={wikiStatus} /> : null}
        <BrowserMarkdownPreview markdown={metadata.body} />
      </article>
    );
  }

  const metadata = buildWikiPageMetadata('', entity);
  const wikiStatus = getBrowserWikiEntityStatus(entity, metadata);
  const displayType = resolveBrowserWikiDisplayType(metadata, inferWikiTargetSpec(entity).type);
  return (
    <article className="max-h-[620px] overflow-auto px-6 py-5">
      <BrowserWikiHeaderCard
        metadata={metadata}
        displayType={displayType}
        wikiStatus={wikiStatus}
        onOpenSource={onOpenSource}
        onOpenRelated={onOpenRelated}
      />
      <BrowserWikiStatusNotice status={wikiStatus} />
      <section className="mt-5">
        <h2 className="text-lg font-semibold text-[#1f2937]">摘要</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[#1f2937]">{entity.summary || '暂无摘要。'}</p>
      </section>
      {entity.compiledProfile ? (
        <section className="mt-6 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-4">
          <h2 className="text-sm font-semibold text-[#1f2937]">编译档案</h2>
          <p className="mt-2 text-sm leading-7 text-[#1f2937]">{entity.compiledProfile.overview}</p>
        </section>
      ) : null}
      {entity.indicators?.length ? (
        <section className="mt-6">
          <h2 className="text-lg font-semibold text-[#1f2937]">指标</h2>
          <div className="mt-3 grid gap-2">
            {entity.indicators.map((indicator) => (
              <div key={indicator.id} className="rounded-[10px] border border-[#e5e5e4] p-3 text-sm">
                <p className="font-medium text-[#1f2937]">{indicator.name}</p>
                <p className="mt-1 text-[#626965]">
                  {indicator.value === null ? '未找到明确值' : `${indicator.rawValue ?? indicator.value}${indicator.unit ?? ''}`}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function BrowserWikiHeaderCard({
  metadata,
  displayType,
  wikiStatus,
  compileModel,
  compiledAt,
  onOpenSource,
  onOpenRelated,
}: {
  metadata: WikiPageMetadata;
  displayType?: WikiPageType;
  wikiStatus?: BrowserWikiEntityStatus;
  compileModel?: string;
  compiledAt?: number;
  onOpenSource?: (reference: string) => void;
  onOpenRelated?: (reference: string) => void;
}) {
  return (
    <section className="mb-7 overflow-hidden rounded-[18px] border border-[#e6e9ef] bg-gradient-to-br from-white via-[#fbfcff] to-[#f8fafc] p-5 shadow-[0_14px_36px_rgba(15,23,42,0.08)]">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[#e8f0ff] text-[#155eef]">
          <UserRound size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold leading-7 text-[#111827]">{metadata.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded bg-[#dbeafe] px-1.5 py-0.5 font-semibold uppercase tracking-wide text-[#155eef]">
              {displayType ?? metadata.type}
            </span>
            {wikiStatus ? <BrowserWikiStatusBadge status={wikiStatus} /> : null}
            {(metadata.updated ?? metadata.created) ? (
              <span className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[#626965]">
                <Calendar size={12} />
                {metadata.updated ?? metadata.created}
              </span>
            ) : null}
            {metadata.tags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[#626965]">
                <Tag size={12} />
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {metadata.description ? <p className="mt-3 text-sm leading-6 text-[#626965]">{metadata.description}</p> : null}

      {metadata.sources.length ? (
        <FrontmatterSection icon={<Layers size={14} />} label="Sources" count={metadata.sources.length}>
          {metadata.sources.map((source) => (
            <button
              key={source}
              type="button"
              className="max-w-full"
              onClick={() => onOpenSource?.(source)}
              disabled={!onOpenSource}
            >
              <span
                className={[
                  'inline-flex max-w-[240px] items-center gap-1 truncate rounded-[8px] border border-[#e5e5e4] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1f2937]',
                  onOpenSource ? 'cursor-pointer hover:border-[#155eef] hover:bg-[#eef4ff]' : '',
                ].join(' ')}
              >
                <FileText size={13} className="shrink-0 text-[#626965]" />
                <span className="truncate">{source}</span>
              </span>
            </button>
          ))}
        </FrontmatterSection>
      ) : null}

      {metadata.related.length ? (
        <FrontmatterSection icon={<ArrowUpRight size={14} />} label="Related" count={metadata.related.length}>
          {metadata.related.map((related) => (
            <button key={related} type="button" className="max-w-full" onClick={() => onOpenRelated?.(related)} disabled={!onOpenRelated}>
              <span
                className={[
                  'inline-flex items-center gap-1 rounded-full border border-[#e5e5e4] bg-white px-2.5 py-1 text-xs text-[#315078]',
                  onOpenRelated ? 'cursor-pointer hover:border-[#155eef] hover:bg-[#eef4ff]' : '',
                ].join(' ')}
              >
                <span className="truncate">{related}</span>
                <ArrowUpRight size={11} />
              </span>
            </button>
          ))}
        </FrontmatterSection>
      ) : null}

      {metadata.extras.length || compileModel || compiledAt ? (
        <div className="mt-4 rounded-[10px] border border-[#e5e5e4] bg-white/70 px-3 py-2 text-xs">
          <div className="mb-1 font-medium text-[#626965]">More</div>
          <div className="grid gap-1">
            {metadata.extras.map((item) => (
              <div key={item.key} className="flex gap-2">
                <span className="shrink-0 font-mono text-[#626965]">{item.key}:</span>
                <span className="text-[#1f2937]">{item.value}</span>
              </div>
            ))}
            {compileModel ? (
              <div className="flex gap-2">
                <span className="shrink-0 font-mono text-[#626965]">model:</span>
                <span className="text-[#1f2937]">{compileModel}</span>
              </div>
            ) : null}
            {compiledAt ? (
              <div className="flex gap-2">
                <span className="shrink-0 font-mono text-[#626965]">compiled:</span>
                <span className="text-[#1f2937]">{new Date(compiledAt).toLocaleString()}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FrontmatterSection({
  icon,
  label,
  count,
  children,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[#626965]">
        {icon}
        {label}
        <span className="text-[#9ca3af]">({count})</span>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

type BrowserMarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

function BrowserMarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = splitBrowserMarkdownBlocks(markdown);
  return (
    <div className="grid gap-4 text-[#1f2937]">
      {blocks.map((block, index) => renderBrowserMarkdownBlock(block, index))}
    </div>
  );
}

function renderBrowserMarkdownBlock(block: BrowserMarkdownBlock, index: number) {
  if (block.type === 'heading') {
    const className =
      block.level === 1
        ? 'mt-1 text-2xl font-semibold leading-9'
        : block.level === 2
          ? 'mt-4 text-lg font-semibold leading-8'
          : 'mt-3 text-base font-semibold leading-7';
    if (block.level === 1) return <h1 key={index} className={className}>{renderInlineMarkdown(block.text)}</h1>;
    if (block.level === 2) return <h2 key={index} className={className}>{renderInlineMarkdown(block.text)}</h2>;
    return <h3 key={index} className={className}>{renderInlineMarkdown(block.text)}</h3>;
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag key={index} className={['grid gap-2 pl-5 text-sm leading-7', block.ordered ? 'list-decimal' : 'list-disc'].join(' ')}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === 'table') {
    const [head, ...body] = block.rows;
    return (
      <div key={index} className="overflow-auto rounded-[10px] border border-[#e5e5e4]">
        <table className="min-w-full border-collapse text-sm">
          {head ? (
            <thead className="bg-[#f7f7f5]">
              <tr>
                {head.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border-b border-[#e5e5e4] px-3 py-2 text-left font-semibold">
                    {renderInlineMarkdown(cell)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white even:bg-[#fbfbfa]">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border-t border-[#ececea] px-3 py-2 align-top">
                    {renderInlineMarkdown(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <p key={index} className="whitespace-pre-wrap text-sm leading-7">
      {renderInlineMarkdown(block.text)}
    </p>
  );
}

function splitBrowserMarkdownBlocks(markdown: string): BrowserMarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: BrowserMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      const rows = tableLines
        .filter((item) => !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(item))
        .map((item) => item.split('|').slice(1, -1).map((cell) => cell.trim()));
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    const listMatch = line.match(/^(\d+\.|[-*])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^(\d+\.|[-*])\s+(.+)$/);
        if (!itemMatch || /^\d+\./.test(itemMatch[1]) !== ordered) break;
        items.push(itemMatch[2].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current || /^(#{1,6})\s+/.test(current) || current.startsWith('|') || /^(\d+\.|[-*])\s+/.test(current)) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('[[')) {
      parts.push(
        <span key={`${match.index}-${token}`} className="rounded-full border border-[#d9d9d6] bg-white px-1.5 py-0.5 text-xs text-[#155eef]">
          {token.slice(2, -2)}
        </span>,
      );
    } else {
      parts.push(<strong key={`${match.index}-${token}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function BrowserEntryPreview({ entry }: { entry: Entry }) {
  return (
    <article className="max-h-[620px] overflow-auto px-6 py-5">
      <div className="mb-4 flex flex-wrap gap-2">
        <BrowserChip label={entry.source} />
        {entry.fileMetadata?.filename ? <BrowserChip label={entry.fileMetadata.filename} /> : null}
      </div>
      <h1 className="text-xl font-semibold text-[#1f2937] [overflow-wrap:anywhere]">{entry.fileMetadata?.filename ?? '原始捕获'}</h1>
      <pre className="mt-5 whitespace-pre-wrap rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm leading-7 text-[#1f2937] [overflow-wrap:anywhere]">
        {entry.content || '暂无内容。'}
      </pre>
    </article>
  );
}

function BrowserChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#315078]">
      <span className="truncate">{label}</span>
    </span>
  );
}

function BrowserWikiSearchResults({
  query,
  results,
  selectedEntityId,
  onSelect,
}: {
  query: string;
  results: BrowserWikiSearchResult[];
  selectedEntityId?: string;
  onSelect: (result: BrowserWikiSearchResult) => void;
}) {
  return (
    <div className="grid gap-2">
      <p className="px-1 text-sm text-[#626965]">{results.length} pages</p>
      <div className="px-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#8a8f89]">Pages ({results.length})</div>
      {results.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-[#d9d9d6] bg-[#fbfbfa] px-4 py-5 text-sm leading-6 text-[#626965]">
          没有找到与“{query.trim()}”相关的 Wiki 页面。
        </div>
      ) : (
        results.map((result) => (
          <button
            key={result.entity.id}
            type="button"
            className={[
              'rounded-[14px] border bg-white p-4 text-left transition',
              selectedEntityId === result.entity.id ? 'border-[#155eef] bg-[#f4f8ff]' : 'border-[#e5e5e4] hover:border-[#bfd3ff] hover:bg-[#fbfdff]',
            ].join(' ')}
            onClick={() => onSelect(result)}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[#f5f7fb] text-[#626965]">
                <FileText size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className="text-lg font-semibold leading-7 text-[#111827]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(result);
                  }}
                >
                  {renderSearchHighlightedText(result.title, result.matchedTerms)}
                </p>
                <p className="mt-1 text-xs leading-5 text-[#7b8794]">{renderSearchHighlightedText(result.path, result.matchedTerms)}</p>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-[#4b5563]">
                  {renderSearchHighlightedText(result.snippet, result.matchedTerms)}
                </p>
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

function PaneResizer({ onMouseDown }: { onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group flex cursor-col-resize items-stretch justify-center"
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown(event);
      }}
    >
      <div className="w-px rounded-full bg-transparent transition group-hover:bg-[#c7d7ff]" />
    </div>
  );
}

function findBrowserEntityByReference(reference: string, entities: Entity[]) {
  const normalized = normalizeBrowserReference(reference);
  const normalizedStem = normalizeBrowserReference(stripBrowserExtension(slugFromBrowserReference(reference)));
  return (
    entities.find((entity) => buildBrowserEntityReferenceKeys(entity).some((key) => key === normalized || key === normalizedStem)) ??
    null
  );
}

function BrowserWikiStatusNotice({ status }: { status: BrowserWikiEntityStatus }) {
  return (
    <div
      className={[
        'mb-5 rounded-[12px] border p-3 text-sm leading-6',
        status.state === 'draft'
          ? 'border-[#f2d08f] bg-[#fff8e6] text-[#6f4a00]'
          : 'border-[#dbe7ff] bg-[#f5f8ff] text-[#315078]',
      ].join(' ')}
    >
      <p className="font-semibold">{status.label}</p>
      <p className="mt-1 text-xs leading-5">{status.detail}</p>
    </div>
  );
}

function BrowserWikiStatusBadge({ status }: { status: BrowserWikiEntityStatus }) {
  return (
    <span
      className={[
        'rounded px-1.5 py-0.5 font-medium',
        status.state === 'complete'
          ? 'bg-[#ecfdf3] text-[#027a48]'
          : status.state === 'draft'
            ? 'bg-[#fff8e6] text-[#8a5a00]'
            : 'bg-[#f2f4f7] text-[#475467]',
      ].join(' ')}
      title={status.detail}
    >
      {status.label}
    </span>
  );
}

function findBrowserEntryByReference(reference: string, entries: Entry[]) {
  const normalized = normalizeBrowserReference(reference);
  const normalizedStem = normalizeBrowserReference(stripBrowserExtension(reference));
  return (
    entries.find((entry) => normalizeBrowserReference(entry.id) === normalized) ??
    entries.find((entry) => normalizeBrowserReference(entry.fileMetadata?.filename ?? '') === normalized) ??
    entries.find((entry) => normalizeBrowserReference(entry.fileMetadata?.filename ?? '') === normalizedStem) ??
    entries.find((entry) => normalizeBrowserReference(stripBrowserExtension(entry.fileMetadata?.filename ?? '')) === normalizedStem) ??
    null
  );
}

function sortBrowserEntities(entities: Entity[], schema?: string) {
  return [...entities].sort((left, right) => {
    const leftTarget = inferWikiTargetSpec(left, { schema });
    const rightTarget = inferWikiTargetSpec(right, { schema });
    const typeOrder = wikiTypeSortOrder(leftTarget.type) - wikiTypeSortOrder(rightTarget.type);
    if (typeOrder !== 0) return typeOrder;

    const titleOrder = left.title.localeCompare(right.title, 'zh-Hans-CN', {
      numeric: true,
      sensitivity: 'base',
    });
    if (titleOrder !== 0) return titleOrder;

    return left.createdAt - right.createdAt;
  });
}

function buildBrowserWikiTreePages(entities: Entity[], schema?: string): BrowserWikiTreePage[] {
  return entities.map((entity) => {
    const markdown = entity.wikiMarkdown?.trim() || buildInitialBrowserEntityMarkdown(entity, schema);
    const metadata = buildWikiPageMetadata(markdown, entity);
    const fallbackTarget = inferWikiTargetSpec(entity, { schema });
    const type = resolveBrowserWikiDisplayType(metadata, fallbackTarget.type);
    const target = inferWikiTargetSpec(entity, { schema, preferredType: type });
    const path = target.path;
    const slug = path.split('/').pop()?.replace(/\.md$/i, '') || entity.id;

    return {
      id: entity.id,
      slug,
      path,
      absolutePath: path,
      type,
      title: metadata.title || entity.title,
      summary: metadata.description || entity.summary || '',
      tags: metadata.tags,
      aliases: metadata.aliases,
      related: metadata.related,
      sources: metadata.sources,
      updated: metadata.updated,
      frontmatter: {},
      wikilinks: extractBrowserWikiLinks(metadata.body),
      entity,
      wikiStatus: getBrowserWikiEntityStatus(entity, metadata),
    };
  });
}

function buildBrowserWikiSearchDocuments(entities: Entity[], schema?: string): BrowserWikiSearchDocument[] {
  return entities.map((entity) => {
    const markdown = entity.wikiMarkdown?.trim() || buildInitialBrowserEntityMarkdown(entity, schema);
    const metadata = buildWikiPageMetadata(markdown, entity);
    const fallbackTarget = inferWikiTargetSpec(entity, { schema });
    const type = resolveBrowserWikiDisplayType(metadata, fallbackTarget.type);
    const target = inferWikiTargetSpec(entity, { schema, preferredType: type });
    const summary = metadata.description || entity.summary || '';
    const body = buildBrowserSearchText([
      metadata.body,
      summary,
      metadata.tags.join(' '),
      metadata.related.join(' '),
      metadata.sources.join(' '),
    ]);

    return {
      entity,
      title: metadata.title || entity.title,
      path: target.path,
      type,
      summary,
      body,
      updated: metadata.updated,
    };
  });
}

function searchBrowserWikiDocuments(documents: BrowserWikiSearchDocument[], query: string): BrowserWikiSearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const terms = tokenizeBrowserSearchQuery(trimmedQuery);
  const uniqueTerms = Array.from(new Set(terms.filter(Boolean)));
  if (!uniqueTerms.length) return [];

  return documents
    .map((document) => {
      const score = scoreBrowserWikiSearchDocument(document, trimmedQuery, uniqueTerms);
      if (score.score <= 0) return null;
      return {
        ...document,
        matchedTerms: score.matchedTerms,
        score: score.score,
        snippet: buildBrowserWikiSearchSnippet(document, trimmedQuery, score.matchedTerms),
      } satisfies BrowserWikiSearchResult;
    })
    .filter((item): item is BrowserWikiSearchResult => Boolean(item))
    .sort((left, right) => right.score - left.score || right.entity.updatedAt - left.entity.updatedAt)
    .slice(0, 80);
}

function scoreBrowserWikiSearchDocument(document: BrowserWikiSearchDocument, query: string, terms: string[]) {
  const matchedTerms = new Set<string>();
  let score = 0;
  const normalizedTitle = normalizeBrowserSearchText(document.title);
  const normalizedPath = normalizeBrowserSearchText(document.path);
  const normalizedSummary = normalizeBrowserSearchText(document.summary);
  const normalizedBody = normalizeBrowserSearchText(document.body);
  const normalizedQuery = normalizeBrowserSearchText(query);

  if (normalizedQuery && normalizedTitle.includes(normalizedQuery)) {
    matchedTerms.add(query.trim());
    score += 320;
  }
  if (normalizedQuery && normalizedPath.includes(normalizedQuery)) {
    matchedTerms.add(query.trim());
    score += 120;
  }
  if (normalizedQuery && normalizedSummary.includes(normalizedQuery)) {
    matchedTerms.add(query.trim());
    score += 90;
  }
  if (normalizedQuery && normalizedBody.includes(normalizedQuery)) {
    matchedTerms.add(query.trim());
    score += 70;
  }

  for (const term of terms) {
    const normalizedTerm = normalizeBrowserSearchText(term);
    if (!normalizedTerm) continue;

    if (normalizedTitle.includes(normalizedTerm)) {
      matchedTerms.add(term);
      score += 120;
    }
    if (normalizedPath.includes(normalizedTerm)) {
      matchedTerms.add(term);
      score += 48;
    }
    if (normalizedSummary.includes(normalizedTerm)) {
      matchedTerms.add(term);
      score += 42;
    }
    if (normalizedBody.includes(normalizedTerm)) {
      matchedTerms.add(term);
      score += 28;
    }
  }

  return { score, matchedTerms: Array.from(matchedTerms) };
}

function buildBrowserWikiSearchSnippet(document: BrowserWikiSearchDocument, query: string, matchedTerms: string[]) {
  const source = document.body || document.summary || document.title;
  if (!source.trim()) return document.path;

  const candidates = [query.trim(), ...matchedTerms].filter(Boolean);
  const lowerSource = source.toLowerCase();
  let matchIndex = -1;
  let matchLength = 0;
  for (const candidate of candidates) {
    const nextIndex = lowerSource.indexOf(candidate.toLowerCase());
    if (nextIndex >= 0 && (matchIndex < 0 || nextIndex < matchIndex)) {
      matchIndex = nextIndex;
      matchLength = candidate.length;
    }
  }

  if (matchIndex < 0) {
    return source.length > 220 ? `${source.slice(0, 220).trim()}...` : source;
  }

  const start = Math.max(0, matchIndex - 54);
  const end = Math.min(source.length, matchIndex + Math.max(matchLength, 1) + 130);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < source.length ? '...' : '';
  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function buildBrowserSearchText(parts: string[]) {
  return parts
    .join('\n')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[`#>*_|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeBrowserSearchQuery(query: string) {
  const normalized = query.trim();
  if (!normalized) return [];
  const pieces = normalized.match(/[\u4e00-\u9fa5A-Za-z0-9._/-]+/g) ?? [];
  const compact = normalized.replace(/\s+/g, '');
  return Array.from(new Set([normalized, compact, ...pieces].filter((item) => item.length >= 2)));
}

function normalizeBrowserSearchText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderSearchHighlightedText(text: string, terms: string[]) {
  const cleanedTerms = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean)))
    .sort((left, right) => right.length - left.length);
  if (!cleanedTerms.length) return text;

  const pattern = new RegExp(`(${cleanedTerms.map((term) => escapeRegExp(term)).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return parts.map((part, index) => {
    const matched = cleanedTerms.some((term) => term.toLowerCase() === part.toLowerCase());
    if (!matched) return <span key={`${part}-${index}`}>{part}</span>;
    return (
      <mark key={`${part}-${index}`} className="rounded-[4px] bg-[#fff2a8] px-0.5 text-inherit">
        {part}
      </mark>
    );
  });
}

function normalizeBrowserWikiPageType(value: string | undefined): WikiPageType | undefined {
  return normalizeWikiPageType(value);
}

function resolveBrowserWikiDisplayType(metadata: WikiPageMetadata, fallback: WikiPageType): WikiPageType {
  const metadataType = normalizeBrowserWikiPageType(metadata.type);
  const tagType = metadata.tags
    .map((tag) => normalizeBrowserWikiPageType(tag))
    .find((type): type is WikiPageType => Boolean(type && !['schema', 'purpose', 'overview'].includes(type)));
  if (tagType && tagType !== metadataType) return tagType;
  return metadataType ?? tagType ?? fallback;
}

function getBrowserWikiEntityStatus(entity: Entity, metadata?: WikiPageMetadata): BrowserWikiEntityStatus {
  const markdown = entity.wikiMarkdown?.trim() ?? '';
  if (!markdown) {
    return {
      state: 'structured',
      label: '未生成 Wiki',
      detail: '当前仅展示结构化入库档案，不是完整 Wiki Markdown。可点击“AI 生成/更新”或“批量生成/更新wiki页”生成完整页面。',
    };
  }

  const sectionCount = (metadata?.body ?? markdown).match(/^##\s+/gm)?.length ?? 0;
  if (entity.wikiCompiledAt || entity.wikiCompileModel || (markdown.length >= 1200 && sectionCount >= 2)) {
    return {
      state: 'complete',
      label: '完整 Wiki',
      detail: entity.wikiCompileModel
        ? `已生成完整 Wiki，模型：${entity.wikiCompileModel}。`
        : '已有较完整的 Wiki Markdown 内容。',
    };
  }

  return {
    state: 'draft',
    label: 'Wiki 草稿',
    detail: '当前有 Markdown 内容，但没有完整生成记录，内容也偏短。建议点击“AI 生成/更新”补全为正式 Wiki 页面。',
  };
}

function normalizeLocalRestoreRecords(payload: LocalRestorePayload): MarkdownImportRecords {
  const records = payload.records;
  if (
    !records ||
    !Array.isArray(records.entries) ||
    !Array.isArray(records.entities) ||
    !Array.isArray(records.relationships) ||
    !Array.isArray(records.tasks)
  ) {
    throw new Error('恢复载荷格式不正确。');
  }

  return {
    entries: records.entries,
    entities: records.entities,
    relationships: records.relationships,
    tasks: records.tasks,
  };
}

function wikiTypeSortOrder(type: WikiPageType) {
  const index = WIKI_PAGE_TYPE_ORDER.indexOf(type);
  return index < 0 ? WIKI_PAGE_TYPE_ORDER.length : index;
}

function extractBrowserWikiLinks(body: string) {
  return Array.from(body.matchAll(/\[\[([^\]]+)\]\]/g), (match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 40);
}

function buildBrowserSourceItems(entries: Entry[], rawAssets: RawAsset[]): BrowserSourceItem[] {
  const assetItems = rawAssets.map((asset) => ({
    id: asset.entryId ?? asset.id,
    entryId: asset.entryId,
    rawAssetId: asset.id,
    title: asset.filename,
    summary: buildRawAssetSourceSummary(asset),
  }));
  const entryItems = entries.map((entry) => ({
    id: entry.id,
    entryId: entry.id,
    rawAssetId: undefined,
    title: entry.fileMetadata?.filename ?? (entry.content.slice(0, 36) || '原始捕获'),
    summary: entry.content.slice(0, 120) || `${entry.source} 捕获`,
  }));
  const seen = new Set<string>();
  return [...assetItems, ...entryItems].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function buildRawAssetSourceSummary(asset: RawAsset) {
  const parts = [rawAssetKindLabel(asset.kind), rawAssetStatusLabel(asset.status)];
  if (asset.status === 'wiki_failed') {
    parts.push('结构化内容已保留，Wiki 生成可重试');
  }
  if (asset.error) parts.push(asset.error);
  return parts.join(' · ');
}

function rawAssetKindLabel(kind: RawAsset['kind']) {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'word') return 'Word';
  if (kind === 'presentation') return 'PPT';
  if (kind === 'spreadsheet') return 'Excel';
  if (kind === 'image') return '图片';
  return '文本';
}

function rawAssetStatusLabel(status: RawAsset['status']) {
  switch (status) {
    case 'raw':
      return '待入库';
    case 'extracting':
      return '解析中';
    case 'compiling':
      return '结构化中';
    case 'compiled':
      return '已入库';
    case 'skipped':
      return '已复用缓存';
    case 'failed':
      return '入库失败';
    case 'cancelled':
      return '已取消';
    case 'wiki_compiling':
      return '生成 Wiki 中';
    case 'wiki_failed':
      return 'Wiki 生成失败';
    default:
      return status;
  }
}

function stripBrowserExtension(value: string) {
  const index = value.lastIndexOf('.');
  return index < 0 ? value : value.slice(0, index);
}

function normalizeBrowserReference(value: string) {
  return normalizeWikiReferenceValue(value).replace(/\\/g, '/').replace(/^wiki\//i, '').replace(/\.md$/i, '').trim().toLowerCase();
}

function slugFromBrowserReference(value: string) {
  return normalizeWikiReferenceValue(value)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim() ?? '';
}

function buildBrowserEntityReferenceKeys(entity: Entity) {
  const target = inferWikiTargetSpec(entity);
  const path = target.path;
  const relative = path.replace(/^wiki\//i, '');
  const withoutExtension = relative.replace(/\.md$/i, '');
  const slug = path.split('/').pop()?.replace(/\.md$/i, '') ?? '';
  return [entity.title, entity.id, path, relative, withoutExtension, slug].map(normalizeBrowserReference).filter(Boolean);
}
