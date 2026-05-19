import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  FileText,
  FileWarning,
  Info,
  Link2Off,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Unlink,
  Wrench,
  X,
} from 'lucide-react';
import { QueryAnswerRenderer } from '@/components/query/QueryAnswerRenderer';
import { db, updateEntity } from '@/lib/db';
import { getProviderConfigForRole, loadProviderSettings } from '@/lib/llm/providerSettings';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import {
  createTauriWorkspaceStorage,
  getDefaultWorkspaceRoot,
  initializeAndScanWorkspace,
  syncIndexedDbKnowledgeToDefaultWorkspace,
  useWorkspaceRuntimeStore,
} from '@/lib/workspace';
import { parseMarkdownFrontmatter, stringifyMarkdownFrontmatter } from '@/lib/wiki/frontmatter';
import { inferWikiTargetSpec } from '@/lib/wiki/markdownCompiler';
import {
  buildInitialBrowserEntityMarkdown,
  buildBrowserEntityMarkdownPatch,
} from '@/lib/wiki/browserWikiPageHelpers';
import { buildWikiPageMetadata } from '@/lib/wiki/pageMetadata';
import { normalizeWikiReferenceValue } from '@/lib/wiki/references';
import { normalizeWikiPageType } from '@/lib/wiki/schemaRules';
import {
  runStructuralWikiLint,
  type WikiLintContextMap,
  type WikiLintPage,
  type WikiLintResult,
  type WikiLintResultType,
} from '@/lib/wiki/lint';
import { runSemanticWikiLint } from '@/lib/wiki/lintClient';
import type { Entity } from '@/types';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type ActivityStatus = 'running' | 'done' | 'error';

type LintActivity = {
  title: string;
  status: ActivityStatus;
  detail: string;
};

type LintSessionSnapshot = {
  results: WikiLintResult[];
  selectedPageKey: string;
  runSemantic: boolean;
  hasRun: boolean;
  activity: LintActivity | null;
  previewOpen: boolean;
};

type LintGuideHighlight = {
  pagePath: string;
  resultId: string;
  terms: string[];
};

const lintSessionCache = new Map<string, LintSessionSnapshot>();

const typeConfig: Record<WikiLintResultType, { label: string; icon: typeof AlertTriangle }> = {
  orphan: { label: 'Orphan Page', icon: Unlink },
  'weakly-linked': { label: 'Weakly Linked Page', icon: Unlink },
  'broken-link': { label: 'Broken Link', icon: Link2Off },
  'no-outlinks': { label: 'No Outbound Links', icon: ArrowUpRight },
  frontmatter: { label: 'Schema / Frontmatter', icon: FileWarning },
  'redirect-cycle': { label: 'Redirect Cycle', icon: Link2Off },
  'knowledge-gap': { label: 'Knowledge Gap', icon: BrainCircuit },
  semantic: { label: 'Semantic Issue', icon: BrainCircuit },
};

export function LintPage() {
  const tauriRuntime = isTauriRuntime();
  const activeRoot = useWorkspaceRuntimeStore((state) => state.activeRoot);
  const setActiveWorkspace = useWorkspaceRuntimeStore((state) => state.setActiveWorkspace);
  const storage = useMemo(() => createTauriWorkspaceStorage(), []);

  const entities = useLiveQuery(() => db.entities.orderBy('updatedAt').reverse().toArray(), [], []);
  const browserPages = useMemo(() => buildBrowserLintPages(entities), [entities]);

  const [workspacePages, setWorkspacePages] = useState<WikiLintPage[]>([]);
  const [contextMap, setContextMap] = useState<WikiLintContextMap>({});
  const [workspaceIndexPath, setWorkspaceIndexPath] = useState('');
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState('');
  const [results, setResults] = useState<WikiLintResult[]>([]);
  const [selectedPageKey, setSelectedPageKey] = useState('');
  const [runSemantic, setRunSemantic] = useState(false);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [activity, setActivity] = useState<LintActivity | null>(null);
  const [fixStatus, setFixStatus] = useState('');
  const [previewOpen, setPreviewOpen] = useState(true);
  const [guideHighlight, setGuideHighlight] = useState<LintGuideHighlight | null>(null);

  const usingBrowserPages = !tauriRuntime || browserPages.length > 0;
  const pages = usingBrowserPages ? browserPages : workspacePages;
  const selectedPage = findLintPage(pages, selectedPageKey) ?? pages[0] ?? null;
  const warnings = results.filter((result) => result.severity === 'warning');
  const infos = results.filter((result) => result.severity === 'info');
  const lintSessionKey = useMemo(
    () => buildLintSessionKey({ tauriRuntime, usingBrowserPages, activeRoot, pages }),
    [activeRoot, pages, tauriRuntime, usingBrowserPages],
  );

  useEffect(() => {
    if (!tauriRuntime || browserPages.length > 0) {
      setLoadStatus('ready');
      return;
    }
    void loadWorkspacePages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoot, tauriRuntime, browserPages.length]);

  useEffect(() => {
    if (pages.length === 0) return;
    if (selectedPageKey && findLintPage(pages, selectedPageKey)) return;
    setSelectedPageKey(pages[0].path);
  }, [pages, selectedPageKey]);

  useEffect(() => {
    if (!lintSessionKey || pages.length === 0) return;
    const cached = lintSessionCache.get(lintSessionKey);
    if (!cached) {
      setResults([]);
      setHasRun(false);
      setActivity(null);
      setFixStatus('');
      setGuideHighlight(null);
      return;
    }

    setResults(cached.results);
    setHasRun(cached.hasRun);
    setActivity(cached.activity);
    setRunSemantic(cached.runSemantic);
    setPreviewOpen(cached.previewOpen);
    setGuideHighlight(null);
    setSelectedPageKey(cached.selectedPageKey && findLintPage(pages, cached.selectedPageKey) ? cached.selectedPageKey : pages[0].path);
  }, [lintSessionKey, pages]);

  useEffect(() => {
    if (!lintSessionKey) return;
    if (!hasRun && results.length === 0 && !activity) return;
    lintSessionCache.set(lintSessionKey, {
      results,
      selectedPageKey,
      runSemantic,
      hasRun,
      activity,
      previewOpen,
    });
  }, [activity, hasRun, lintSessionKey, previewOpen, results, runSemantic, selectedPageKey]);

  useEffect(() => {
    if (!guideHighlight || !selectedPageKey || guideHighlight.pagePath === selectedPageKey) return;
    setGuideHighlight(null);
  }, [guideHighlight, selectedPageKey]);

  async function loadWorkspacePages() {
    if (!tauriRuntime) return;
    setLoadStatus('loading');
    setLoadError('');
    try {
      const root = activeRoot || (await getDefaultWorkspaceRoot());
      const snapshot = await initializeAndScanWorkspace(storage, root, { outputLanguage: 'zh-CN' });
      const markdownByPath = await Promise.all(
        snapshot.pages.map(async (page) => ({
          page,
          markdown: await storage.readTextFile(page.absolutePath),
        })),
      );
      const nextContextMap = await readWorkspaceContextMap(storage, {
        purpose: snapshot.layout.purpose,
        schema: snapshot.layout.schema,
        index: snapshot.layout.wikiIndex,
        overview: snapshot.layout.wikiOverview,
        log: snapshot.layout.wikiLog,
      });
      setWorkspaceIndexPath(snapshot.layout.wikiIndex);
      setContextMap(nextContextMap);
      setWorkspacePages(
        markdownByPath.map(({ page, markdown }) => ({
          id: page.id,
          title: page.title,
          type: page.type,
          path: page.path,
          slug: page.slug,
          aliases: page.aliases,
          absolutePath: page.absolutePath,
          markdown,
          related: page.related,
          sources: page.sources,
          wikilinks: page.wikilinks,
        })),
      );
      setActiveWorkspace(snapshot.layout.root, snapshot);
      setLoadStatus('ready');
    } catch (error) {
      setLoadStatus('error');
      setLoadError(error instanceof Error ? error.message : '读取工作区失败');
    }
  }

  async function handleRunLint() {
    if (running) return;
    setRunning(true);
    setFixStatus('');
    setGuideHighlight(null);
    setResults([]);
    setHasRun(false);
    setActivity({ title: 'Wiki lint', status: 'running', detail: '正在检查结构、链接和 schema...' });

    try {
      const structural = runStructuralWikiLint(pages, contextMap);
      let allResults = structural;
      let semanticCount = 0;

      if (runSemantic) {
        setActivity({ title: 'Semantic wiki lint', status: 'running', detail: '正在调用 Review / Lint 模型做语义检查...' });
        const providerConfig = getProviderConfigForRole(loadProviderSettings(), 'review-lint');
        const semantic = await runSemanticWikiLint({
          pages,
          contextMap,
          providerConfig,
          outputLanguage: 'zh-CN',
        });
        semanticCount = semantic.results.length;
        allResults = [...structural, ...semantic.results];
      }

      setResults(allResults);
      setHasRun(true);
      const warningCount = allResults.filter((result) => result.severity === 'warning').length;
      const infoCount = allResults.length - warningCount;
      setActivity({
        title: runSemantic ? 'Semantic wiki lint' : 'Wiki lint',
        status: 'done',
        detail: runSemantic
          ? `Found ${semanticCount} semantic issue(s).`
          : `Found ${warningCount} warning(s) and ${infoCount} suggestion(s).`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Lint 运行失败';
      setHasRun(true);
      setResults(runStructuralWikiLint(pages, contextMap));
      setActivity({ title: runSemantic ? 'Semantic wiki lint' : 'Wiki lint', status: 'error', detail: message });
    } finally {
      setRunning(false);
    }
  }

  function openResult(result: WikiLintResult) {
    const reference = result.pagePath || result.affectedPages?.[0] || result.page;
    const target = findLintPage(pages, reference);
    if (target) setSelectedPageKey(target.path);
    setPreviewOpen(true);
    setGuideHighlight(null);
  }

  async function handleFix(result: WikiLintResult) {
    const target = findLintPage(pages, result.pagePath || result.page);
    if (target) setSelectedPageKey(target.path);
    setPreviewOpen(true);
    setFixStatus('');
    if (canAutoFixLintResult(result, { tauriRuntime, workspaceIndexPath, target })) {
      setGuideHighlight(null);
    } else {
      setGuideHighlight(buildLintGuideHighlight(result, target));
    }

    if (result.type === 'orphan' && tauriRuntime && target && workspaceIndexPath) {
      try {
        let indexContent = '';
        try {
          indexContent = await storage.readTextFile(workspaceIndexPath);
        } catch {
          indexContent = '# Wiki Index\n';
        }

        const entry = `- [[${target.slug ?? slugFromPath(target.path)}]]`;
        if (!indexContent.includes(entry)) {
          await storage.writeTextFile(workspaceIndexPath, `${indexContent.trimEnd()}\n${entry}\n`);
        }
        setResults((current) => current.filter((item) => item.id !== result.id));
        setFixStatus(`已把 ${target.title} 链接回 wiki/index.md。`);
        setActivity({ title: 'Wiki lint fix', status: 'done', detail: `Linked ${target.path} from index.md.` });
        await loadWorkspacePages();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : '修复失败';
        setFixStatus(message);
        setActivity({ title: 'Wiki lint fix', status: 'error', detail: message });
        return;
      }
    }

    if (result.type === 'frontmatter' && !tauriRuntime && target) {
      const entity = entities.find((item) => item.id === target.id);
      if (entity) {
        await repairBrowserFrontmatter(entity, target);
        setResults((current) => current.filter((item) => item.id !== result.id));
        setFixStatus(`已补齐 ${entity.title} 的基础 frontmatter。`);
        return;
      }
    }

    if (result.type === 'broken-link') {
      setFixStatus(
        '已在右侧打开包含断链的页面，并用黄色临时标出对应 [[...]]。如果目标页面已存在，把括号里的内容改成左侧页面名或 wiki 路径；如果目标页面不存在，先重新编译/创建对应页面；如果不需要跳转，删掉双方括号保留普通文字。保存后再运行 Lint。',
      );
      return;
    }

    setFixStatus('已在右侧打开相关页面，并尽量用黄色临时标出可能需要检查的位置；如果没有黄色标记，说明这是整页级建议。请按问题类型补链接、改标题/frontmatter、消除重定向循环，或重新编译该页面；保存后再运行 Lint。');
  }

  async function saveSelectedPageMarkdown(page: WikiLintPage, markdown: string) {
    if (tauriRuntime && page.absolutePath) {
      await storage.writeTextFile(page.absolutePath, markdown);
      setWorkspacePages((current) => current.map((item) => (item.path === page.path ? { ...item, markdown } : item)));
      setActivity({ title: 'Wiki page saved', status: 'done', detail: `Saved ${page.path}.` });
      setFixStatus('已保存右侧 Wiki 页面。再次运行 Lint 可以刷新问题列表。');
      setGuideHighlight(null);
      return;
    }

    const entity = entities.find((item) => item.id === page.id);
    if (!entity) throw new Error('没有找到对应的浏览器 Wiki 实体。');
    await updateEntity(entity.id, buildBrowserEntityMarkdownPatch(entity, markdown));
    await syncIndexedDbKnowledgeToDefaultWorkspace().catch(() => undefined);
    setActivity({ title: 'Wiki page saved', status: 'done', detail: `Saved ${page.title}.` });
    setFixStatus('已保存右侧 Wiki 页面。再次运行 Lint 可以刷新问题列表。');
    setGuideHighlight(null);
  }

  function lintActionLabel(result: WikiLintResult) {
    const target = findLintPage(pages, result.pagePath || result.page);
    return canAutoFixLintResult(result, { tauriRuntime, workspaceIndexPath, target }) ? 'Fix' : 'Guide';
  }

  return (
    <section className="mx-auto h-full max-w-[1500px] overflow-hidden px-5 py-6">
      <div
        className={[
          'grid h-full min-h-0 gap-4',
          previewOpen ? 'lg:grid-cols-[260px_minmax(420px,1fr)_420px]' : 'lg:grid-cols-[260px_minmax(420px,1fr)]',
        ].join(' ')}
      >
        <aside className="flex min-h-0 flex-col rounded-[12px] border border-[#e5e5e4] bg-white">
          <div className="border-b border-[#ececea] px-4 py-3">
            <p className="text-xs font-medium text-[#155eef]">Knowledge</p>
            <h2 className="mt-1 text-lg font-semibold text-[#1f2937]">Wiki Pages</h2>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loadStatus === 'loading' ? (
              <p className="flex items-center gap-2 px-2 py-3 text-sm text-[#626965]">
                <Loader2 size={14} className="animate-spin" />
                正在读取 Wiki...
              </p>
            ) : null}
            {loadStatus === 'error' ? <p className="px-2 py-3 text-sm leading-6 text-[#b42318]">{loadError}</p> : null}
            {pages.map((page) => (
              <button
                key={page.path}
                type="button"
                className={[
                  'mb-1 flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left text-sm transition',
                  selectedPage?.path === page.path
                    ? 'bg-[#eef4ff] text-[#155eef]'
                    : 'text-[#626965] hover:bg-[#f7f7f5] hover:text-[#1f2937]',
                ].join(' ')}
                onClick={() => {
                  setSelectedPageKey(page.path);
                  setPreviewOpen(true);
                  setGuideHighlight(null);
                }}
                title={page.path}
              >
                <FileText size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
              </button>
            ))}
            {pages.length === 0 && loadStatus !== 'loading' ? (
              <p className="px-2 py-4 text-sm leading-6 text-[#626965]">当前还没有可检查的 Wiki 页面。</p>
            ) : null}
          </div>

          <ActivityPanel activity={activity} />
        </aside>

        <main className="flex min-h-0 flex-col rounded-[12px] border border-[#e5e5e4] bg-white">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#ececea] px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#1f2937]">Wiki Lint</h2>
              {hasRun && results.length > 0 ? (
                <span className="rounded-full bg-[#fff2d6] px-2.5 py-1 text-xs font-medium text-[#a15c00]">
                  {warnings.length} warnings · {infos.length} suggestions
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {!previewOpen ? (
                <button
                  type="button"
                  className="rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs font-medium text-[#4b5563] hover:bg-[#f7f7f5]"
                  onClick={() => setPreviewOpen(true)}
                >
                  打开预览
                </button>
              ) : null}
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[#626965]">
                <input
                  type="checkbox"
                  className="size-3"
                  checked={runSemantic}
                  onChange={(event) => setRunSemantic(event.target.checked)}
                />
                Semantic (LLM)
              </label>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-[#111827] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0b1220] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleRunLint()}
                disabled={running || pages.length === 0 || loadStatus === 'loading'}
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {running ? 'Running...' : 'Run Lint'}
              </button>
            </div>
          </div>

          {fixStatus ? (
            <div className="mx-4 mt-3 rounded-[10px] border border-[#d9e9d0] bg-[#f5fff0] px-3 py-2 text-xs leading-5 text-[#276749]">
              {fixStatus}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!hasRun ? (
              <EmptyState
                icon={CheckCircle2}
                title="Run lint to check wiki health"
                detail="会检查孤立/弱连接页面、断链、无出链、frontmatter/schema、低凝聚知识群，以及可选的 LLM 语义问题。"
              />
            ) : results.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="All clear!" detail="没有发现明显问题。" success />
            ) : (
              <div className="grid gap-3">
                {warnings.length > 0 ? (
                  <SectionHeader icon={AlertTriangle} label="Warnings" count={warnings.length} tone="warning" />
                ) : null}
                {warnings.map((result) => (
                  <LintCard key={result.id} result={result} actionLabel={lintActionLabel(result)} onOpen={openResult} onFix={(item) => void handleFix(item)} />
                ))}
                {infos.length > 0 ? <SectionHeader icon={Info} label="Info" count={infos.length} tone="info" /> : null}
                {infos.map((result) => (
                  <LintCard key={result.id} result={result} actionLabel={lintActionLabel(result)} onOpen={openResult} onFix={(item) => void handleFix(item)} />
                ))}
              </div>
            )}
          </div>
        </main>

        {previewOpen ? (
          <aside className="flex min-h-0 flex-col rounded-[12px] border border-[#e5e5e4] bg-white">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#ececea] px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[#155eef]">Audit Preview</p>
                <h2 className="mt-1 truncate text-lg font-semibold text-[#1f2937]">
                  {selectedPage?.title ?? '未选择页面'}
                </h2>
                {selectedPage ? <p className="mt-1 truncate text-xs text-[#626965]">{selectedPage.path}</p> : null}
              </div>
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[#d9d9d6] text-[#626965] hover:bg-[#f7f7f5]"
                onClick={() => setPreviewOpen(false)}
                aria-label="关闭预览"
              >
                <X size={15} />
              </button>
            </div>
            <WikiLintPreview page={selectedPage} guideHighlight={guideHighlight} onSave={saveSelectedPageMarkdown} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function LintCard({
  result,
  actionLabel,
  onOpen,
  onFix,
}: {
  result: WikiLintResult;
  actionLabel: 'Fix' | 'Guide';
  onOpen: (result: WikiLintResult) => void;
  onFix: (result: WikiLintResult) => void;
}) {
  const config = typeConfig[result.type] ?? typeConfig.semantic;
  const Icon = config.icon;
  const tone = result.severity === 'warning' ? 'text-[#a15c00]' : 'text-[#155eef]';

  return (
    <article className="rounded-[12px] border border-[#e5e5e4] bg-white p-4 text-sm">
      <div className="mb-2 flex items-start gap-2">
        <Icon size={17} className={`mt-0.5 shrink-0 ${tone}`} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-[#1f2937]">{result.page}</h3>
          <p className="mt-0.5 text-xs text-[#626965]">{config.label}</p>
        </div>
      </div>
      <p className="text-xs leading-6 text-[#4b5563]">{result.detail}</p>
      {result.affectedPages?.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {result.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              className="rounded-full border border-[#d9d9d6] px-2 py-1 text-xs text-[#155eef] hover:bg-[#eef4ff]"
              onClick={() => onOpen({ ...result, pagePath: page })}
            >
              {page}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs font-medium text-[#1f2937] hover:bg-[#f7f7f5]"
          onClick={() => onOpen(result)}
        >
          Open
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs font-medium text-[#1f2937] hover:bg-[#f7f7f5]"
          onClick={() => onFix(result)}
        >
          <Wrench size={13} />
          {actionLabel}
        </button>
      </div>
    </article>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  tone,
}: {
  icon: typeof AlertTriangle;
  label: string;
  count: number;
  tone: 'warning' | 'info';
}) {
  return (
    <div className={`flex items-center gap-2 px-1 py-1 text-xs font-semibold ${tone === 'warning' ? 'text-[#a15c00]' : 'text-[#155eef]'}`}>
      <Icon size={15} />
      {label} ({count})
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
  success = false,
}: {
  icon: typeof CheckCircle2;
  title: string;
  detail: string;
  success?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[#626965]">
      <Icon size={34} className={success ? 'text-[#16a34a]' : 'text-[#c5c7c3]'} />
      <p className={success ? 'font-semibold text-[#276749]' : 'font-semibold text-[#1f2937]'}>{title}</p>
      <p className="max-w-md text-xs leading-5">{detail}</p>
    </div>
  );
}

function ActivityPanel({ activity }: { activity: LintActivity | null }) {
  if (!activity) return null;
  const Icon = activity.status === 'running' ? Loader2 : activity.status === 'done' ? CheckCircle2 : AlertTriangle;
  const tone =
    activity.status === 'done'
      ? 'text-[#16a34a]'
      : activity.status === 'error'
        ? 'text-[#b42318]'
        : 'text-[#155eef]';
  const statusText = activity.status === 'done' ? `Done: ${activity.title}` : activity.status === 'error' ? `Error: ${activity.title}` : `Running: ${activity.title}`;

  return (
    <div className="border-t border-[#ececea] bg-[#fbfbfa] p-3">
      <div className="flex items-center gap-2 text-xs text-[#626965]">
        <Icon size={14} className={`${tone} ${activity.status === 'running' ? 'animate-spin' : ''}`} />
        <span className="truncate">{statusText}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#1f2937]">{activity.detail}</p>
    </div>
  );
}

function canAutoFixLintResult(
  result: WikiLintResult,
  context: { tauriRuntime: boolean; workspaceIndexPath: string; target: WikiLintPage | null | undefined },
) {
  if (result.type === 'orphan') return context.tauriRuntime && Boolean(context.workspaceIndexPath) && Boolean(context.target);
  if (result.type === 'frontmatter') return !context.tauriRuntime && Boolean(context.target);
  return false;
}

function buildLintGuideHighlight(result: WikiLintResult, page: WikiLintPage | null | undefined): LintGuideHighlight | null {
  const pagePath = page?.path || result.pagePath || result.page;
  if (!pagePath) return null;
  const terms = collectLintGuideTerms(result, page);
  return { pagePath, resultId: result.id, terms };
}

function collectLintGuideTerms(result: WikiLintResult, page: WikiLintPage | null | undefined) {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string | undefined) => {
    const value = term?.trim();
    if (!value || value.length < 2) return;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(value);
  };

  for (const link of extractGuideWikilinks(result.detail)) {
    add(link);
    add(`[[${link}]]`);
    add(slugFromPath(link));
  }

  if (result.type === 'frontmatter') {
    add('---');
    add('type:');
    add('title:');
    add('updated:');
  }

  if (result.type === 'redirect-cycle') {
    for (const affectedPage of result.affectedPages ?? []) {
      add(slugFromPath(affectedPage));
    }
  }

  if (result.type === 'semantic' || result.type === 'knowledge-gap') {
    add(result.title);
    for (const affectedPage of result.affectedPages ?? []) {
      add(slugFromPath(affectedPage));
    }
  }

  if (result.type === 'orphan' || result.type === 'weakly-linked' || result.type === 'no-outlinks') {
    add(page?.title);
    add(slugFromPath(page?.path ?? result.pagePath ?? result.page));
  }

  return terms.sort((left, right) => right.length - left.length).slice(0, 12);
}

function extractGuideWikilinks(value: string) {
  return Array.from(value.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g))
    .map((match) => normalizeWikiReferenceValue(match[1]))
    .filter(Boolean);
}

function findFirstHighlightMatch(text: string, terms: string[]) {
  const lowerText = text.toLocaleLowerCase();
  let best: { index: number; length: number } | null = null;
  for (const term of terms) {
    const normalized = term.trim().toLocaleLowerCase();
    if (!normalized) continue;
    const index = lowerText.indexOf(normalized);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && normalized.length > best.length)) {
      best = { index, length: normalized.length };
    }
  }
  return best;
}

function WikiLintPreview({
  page,
  guideHighlight,
  onSave,
}: {
  page: WikiLintPage | null;
  guideHighlight?: LintGuideHighlight | null;
  onSave: (page: WikiLintPage, markdown: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const previewBodyRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeHighlightTerms = page && guideHighlight?.pagePath === page.path ? guideHighlight.terms : [];
  const highlightSignature = activeHighlightTerms.join('\u0000');

  useEffect(() => {
    setEditing(false);
    setDraft(page?.markdown ?? '');
    setError('');
  }, [page?.path, page?.markdown]);

  useEffect(() => {
    if (editing || !highlightSignature) return;
    const mark = previewBodyRef.current?.querySelector('[data-lint-highlight="true"]');
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [editing, highlightSignature, page?.path]);

  useEffect(() => {
    if (!editing || !highlightSignature) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const match = findFirstHighlightMatch(draft, activeHighlightTerms);
    if (!match) return;
    textarea.focus();
    textarea.setSelectionRange(match.index, match.index + match.length);
    textarea.scrollTop = Math.max(0, (match.index / Math.max(draft.length, 1)) * textarea.scrollHeight - textarea.clientHeight / 2);
  }, [editing, highlightSignature, page?.path]);

  if (!page) {
    return <p className="p-5 text-sm text-[#626965]">选择左侧页面或点击 Lint 问题的 Open。</p>;
  }
  const parsed = parseMarkdownFrontmatter(page.markdown);
  const metadata = buildWikiPageMetadata(page.markdown, { title: page.title, type: page.type as Entity['type'], tags: [] });
  const body = parsed.body.trim() || page.markdown.trim();

  async function saveDraft() {
    if (!page) return;
    setSaving(true);
    setError('');
    try {
      await onSave(page, draft);
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="border-b border-[#ececea] px-5 py-4">
        <div className="mb-3 flex items-center justify-end gap-2">
          {editing ? (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#4b5563] hover:bg-[#f7f7f5]"
                onClick={() => {
                  setEditing(false);
                  setDraft(page.markdown);
                  setError('');
                }}
                disabled={saving}
              >
                <X size={13} />
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full bg-[#155eef] px-3 py-1.5 text-xs font-medium text-white disabled:bg-[#a9b8e8]"
                onClick={() => void saveDraft()}
                disabled={saving}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                保存
              </button>
            </>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#4b5563] hover:bg-[#f7f7f5]"
              onClick={() => {
                setDraft(page.markdown);
                setEditing(true);
              }}
            >
              <Pencil size={13} />
              编辑
            </button>
          )}
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <Chip label={metadata.type || page.type} />
          {metadata.updated ? <Chip label={metadata.updated} /> : null}
          {metadata.tags.slice(0, 8).map((tag) => (
            <Chip key={tag} label={tag} />
          ))}
        </div>
        {metadata.description ? <p className="text-sm leading-6 text-[#4b5563]">{metadata.description}</p> : null}
        {error ? <p className="mt-3 rounded-[8px] border border-[#fecaca] bg-[#fffafa] px-3 py-2 text-xs text-[#b42318]">{error}</p> : null}
      </div>
      {editing ? (
        <div className="px-5 py-4">
          <textarea
            ref={textareaRef}
            className="min-h-[520px] w-full resize-none rounded-[10px] border border-[#d9d9d6] bg-[#fbfbfa] p-3 font-mono text-sm leading-6 text-[#1f2937] outline-none focus:border-[#155eef]"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        </div>
      ) : (
        <article ref={previewBodyRef} className="px-5 py-4">
          <QueryAnswerRenderer content={body} highlightTerms={activeHighlightTerms} />
        </article>
      )}
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#315078]">
      <span className="truncate">{label}</span>
    </span>
  );
}

function buildBrowserLintPages(entities: Entity[]): WikiLintPage[] {
  return entities.map((entity) => {
    const markdown = entity.wikiMarkdown?.trim() || buildInitialBrowserEntityMarkdown(entity);
    const metadata = buildWikiPageMetadata(markdown, entity);
    const fallbackTarget = inferWikiTargetSpec(entity);
    const type = normalizeWikiPageType(metadata.type) ?? fallbackTarget.type;
    const folder = browserTypeFolder(type);
    const slug = slugify(metadata.title || entity.title);
    return {
      id: entity.id,
      title: metadata.title || entity.title,
      type,
      path: `wiki/${folder}/${slug}.md`,
      slug,
      aliases: metadata.aliases,
      markdown,
      related: metadata.related,
      sources: metadata.sources,
    };
  });
}

async function readWorkspaceContextMap(
  storage: { readTextFile: (path: string) => Promise<string> },
  paths: Record<keyof WikiLintContextMap, string>,
): Promise<WikiLintContextMap> {
  const entries = await Promise.all(
    (Object.entries(paths) as Array<[keyof WikiLintContextMap, string]>).map(async ([key, path]) => {
      try {
        return [key, await storage.readTextFile(path)] as const;
      } catch {
        return [key, ''] as const;
      }
    }),
  );

  return Object.fromEntries(entries.filter(([, value]) => value.trim())) as WikiLintContextMap;
}

function browserTypeFolder(type: string) {
  const folders: Record<string, string> = {
    topic: 'concepts',
    concept: 'concepts',
    source: 'sources',
    project: 'projects',
    query: 'queries',
    comparison: 'comparisons',
    synthesis: 'synthesis',
    decision: 'decisions',
    meeting: 'meetings',
    stakeholder: 'stakeholders',
    methodology: 'methodology',
    finding: 'findings',
    thesis: 'thesis',
    goal: 'goals',
    habit: 'habits',
    reflection: 'reflections',
    journal: 'journal',
  };
  return folders[type] ?? 'entities';
}

function findLintPage(pages: WikiLintPage[], reference: string) {
  const referenceKeys = buildReferenceLookupKeys(reference);
  return pages.find((page) => {
    const keys = [
      page.path,
      page.path.replace(/^wiki\//i, ''),
      page.path.replace(/^wiki\//i, '').replace(/\.md$/i, ''),
      page.slug ?? '',
      page.title,
      ...(page.aliases ?? []),
      slugFromPath(page.path),
    ];
    const pageKeys = new Set(keys.flatMap(buildReferenceLookupKeys));
    return referenceKeys.some((key) => pageKeys.has(key));
  });
}

function buildLintSessionKey({
  tauriRuntime,
  usingBrowserPages,
  activeRoot,
  pages,
}: {
  tauriRuntime: boolean;
  usingBrowserPages: boolean;
  activeRoot: string | null;
  pages: WikiLintPage[];
}) {
  if (pages.length === 0) return '';
  const source = !tauriRuntime || usingBrowserPages ? 'browser' : `workspace:${activeRoot || 'default'}`;
  const paths = pages
    .map((page) => page.path)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    .join('\n');
  return `${source}:${stableHash(paths)}`;
}

async function repairBrowserFrontmatter(entity: Entity, page: WikiLintPage) {
  const parsed = parseMarkdownFrontmatter(page.markdown);
  const body = parsed.body.trim() || page.markdown.trim();
  const today = new Date().toISOString().slice(0, 10);
  const nextData = {
    type: page.type || entity.type,
    title: page.title || entity.title,
    tags: entity.tags,
    created: new Date(entity.createdAt).toISOString().slice(0, 10),
    updated: today,
    related: [],
    sources: entity.sourceEntries,
    ...parsed.data,
  };
  const nextMarkdown = `${stringifyMarkdownFrontmatter(nextData)}\n\n${body}`.trim();
  await updateEntity(entity.id, buildBrowserEntityMarkdownPatch(entity, nextMarkdown));
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'untitled';
}

function slugFromPath(path: string) {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.md$/i, '') ?? '';
}

function normalizeReference(value: string) {
  return normalizeWikiReferenceValue(value)
    .replace(/\\/g, '/')
    .replace(/^wiki\//i, '')
    .replace(/\.md$/i, '')
    .normalize('NFKC')
    .replace(/\s*([()[\]{}])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildReferenceLookupKeys(value: string) {
  const keys = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeReference(candidate);
    if (!normalized) return;
    keys.add(normalized);
  };
  const withoutWiki = value.replace(/\\/g, '/').replace(/^wiki\//i, '');

  add(value);
  add(slugFromPath(value));
  add(withoutWiki);
  add(withoutWiki.replace(/\.md$/i, ''));

  return Array.from(keys);
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
