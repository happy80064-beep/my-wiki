import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
  Tags,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  canUseWorkspaceStorage,
  createWorkspaceStorage,
  getWorkspaceDefaultRoot,
  initializeAndScanWorkspace,
  useWorkspaceRuntimeStore,
} from '@/lib/workspace';
import { resizeTriPaneLayout, type TriPaneLayout } from '@/lib/ui/triPaneLayout';
import { parseMarkdownFrontmatter } from '@/lib/wiki/frontmatter';
import { sanitizeWikiMarkdownOutput } from '@/lib/wiki/markdownCompiler';
import { groupWikiPagesByType } from '@/lib/wiki/pageTree';
import type { WikiPageIndexEntry } from '@/lib/wiki/scanner';
import {
  buildWorkspaceFileEntries,
  filterRawSourceEntries,
  findMatchingSourcePage,
  findWikiPageByReference,
  findWorkspaceSourceEntryByLabel,
  workspaceAreaLabel,
  type WorkspaceFileEntry,
} from '@/lib/wiki/workbench';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type SelectedTarget =
  | { kind: 'wiki'; path: string }
  | { kind: 'source'; path: string }
  | null;

const defaultPaneLayout: TriPaneLayout = { left: 26, center: 30, right: 44 };
const paneStorageKey = 'mywiki:workspace-pane-layout:v1';

export function WorkspaceWikiExplorer() {
  const activeRoot = useWorkspaceRuntimeStore((state) => state.activeRoot);
  const snapshot = useWorkspaceRuntimeStore((state) => state.snapshot);
  const setActiveWorkspace = useWorkspaceRuntimeStore((state) => state.setActiveWorkspace);

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<SelectedTarget>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(['overview', 'project', 'entity', 'concept', 'source']));
  const [searchParams] = useSearchParams();
  const [paneLayout, setPaneLayout] = useState<TriPaneLayout>(() => {
    if (typeof window === 'undefined') return defaultPaneLayout;
    try {
      const raw = window.localStorage.getItem(paneStorageKey);
      return raw ? (JSON.parse(raw) as TriPaneLayout) : defaultPaneLayout;
    } catch {
      return defaultPaneLayout;
    }
  });

  const storage = useMemo(() => (canUseWorkspaceStorage() ? createWorkspaceStorage() : null), []);
  const pages = snapshot?.pages ?? [];
  const sourceEntries = useMemo(() => filterRawSourceEntries(workspaceFiles), [workspaceFiles]);
  const selectedPage = selected?.kind === 'wiki' ? pages.find((page) => page.absolutePath === selected.path) ?? null : null;
  const selectedSource =
    selected?.kind === 'source' ? sourceEntries.find((entry) => entry.absolutePath === selected.path) ?? null : null;
  const groups = useMemo(() => groupWikiPagesByType(pages), [pages]);
  const typeStats = useMemo(() => groups.map((group) => ({ label: group.label, count: group.pages.length })), [groups]);
  const workspaceRoot = snapshot?.layout.root ?? activeRoot ?? '';

  useEffect(() => {
    if (!canUseWorkspaceStorage()) return;
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoot]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(paneStorageKey, JSON.stringify(paneLayout));
  }, [paneLayout]);

  useEffect(() => {
    if (selected || pages.length === 0) return;
    setSelected({ kind: 'wiki', path: pages[0].absolutePath });
  }, [pages, selected]);

  useEffect(() => {
    const sourceReference = searchParams.get('source');
    const wikiReference = searchParams.get('ref');

    if (sourceReference) {
      const sourceEntry = findWorkspaceSourceEntryByLabel(sourceReference, sourceEntries);
      if (sourceEntry) {
        setSelected({ kind: 'source', path: sourceEntry.absolutePath });
        setEditing(false);
        setSaveStatus('');
        return;
      }

      const sourcePage = findWikiPageByReference(sourceReference, pages);
      if (sourcePage) {
        setSelected({ kind: 'wiki', path: sourcePage.absolutePath });
        setEditing(false);
        setSaveStatus('');
      }
      return;
    }

    if (wikiReference) {
      const page = findWikiPageByReference(wikiReference, pages);
      if (!page) return;
      setSelected({ kind: 'wiki', path: page.absolutePath });
      setEditing(false);
      setSaveStatus('');
    }
  }, [pages, searchParams, sourceEntries]);

  useEffect(() => {
    if (!selected || !storage) {
      setContent('');
      setDraft('');
      return;
    }

    if (selected.kind === 'source' && selectedSource && !selectedSource.isTextLike) {
      setEditing(false);
      setSaveStatus('');
      setContent('');
      setDraft('');
      return;
    }

    setEditing(false);
    setSaveStatus('');
    const target = selected.path;
    storage
      .readTextFile(target)
      .then((nextContent) => {
        setContent(nextContent);
        setDraft(nextContent);
      })
      .catch((readError) => {
        const message = `读取文件失败：${readError instanceof Error ? readError.message : '未知错误'}`;
        setContent(message);
        setDraft(message);
      });
  }, [selected, selectedSource, storage]);

  async function loadWorkspace() {
    if (!canUseWorkspaceStorage() || !storage) return;
    setStatus('loading');
    setError('');
    try {
      const root = activeRoot || (await getWorkspaceDefaultRoot());
      const nextSnapshot = await initializeAndScanWorkspace(storage, root, {
        outputLanguage: 'zh-CN',
      });
      const files = await storage.listFiles(nextSnapshot.layout.root);
      setWorkspaceFiles(buildWorkspaceFileEntries(nextSnapshot.layout.root, files));
      setActiveWorkspace(nextSnapshot.layout.root, nextSnapshot);
      setSelected((current) => current ?? (nextSnapshot.pages[0] ? { kind: 'wiki', path: nextSnapshot.pages[0].absolutePath } : null));
      setStatus('ready');
    } catch (loadError) {
      setStatus('error');
      setError(loadError instanceof Error ? loadError.message : '读取工作区失败。');
    }
  }

  async function saveDraft() {
    if (!selectedPage || !storage) return;
    setSaving(true);
    setSaveStatus('');
    try {
      await storage.writeTextFile(selectedPage.absolutePath, draft);
      setContent(draft);
      setEditing(false);
      setSaveStatus('已保存');
      await loadWorkspace();
      setSelected({ kind: 'wiki', path: selectedPage.absolutePath });
    } catch (saveError) {
      setSaveStatus(saveError instanceof Error ? saveError.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  async function deleteWorkspacePath(path: string, label: string) {
    if (!workspaceRoot || !storage?.deletePath) {
      setError('当前桌面运行时不支持删除工作区文件。');
      return;
    }
    if (!window.confirm(`确定删除“${label}”？此操作会从当前工作区移除对应文件。`)) return;

    try {
      await storage.deletePath(workspaceRoot, path);
      if (selected?.path === path) {
        setSelected(null);
        setContent('');
        setDraft('');
      }
      setSaveStatus('已删除');
      await loadWorkspace();
    } catch (deleteError) {
      setSaveStatus(deleteError instanceof Error ? deleteError.message : '删除失败。');
    }
  }

  async function deleteWikiTypeGroup(type: string, groupPages: WikiPageIndexEntry[]) {
    if (!workspaceRoot || !storage?.deletePath || groupPages.length === 0) return;
    if (!window.confirm(`确定删除“${type}”分组下的 ${groupPages.length} 个 Wiki 页面？原始材料不会被删除。`)) return;

    try {
      for (const page of groupPages) {
        await storage.deletePath(workspaceRoot, page.absolutePath);
      }
      if (selected?.kind === 'wiki' && groupPages.some((page) => page.absolutePath === selected.path)) {
        setSelected(null);
        setContent('');
        setDraft('');
      }
      setSaveStatus(`已删除 ${groupPages.length} 个页面`);
      await loadWorkspace();
    } catch (deleteError) {
      setSaveStatus(deleteError instanceof Error ? deleteError.message : '删除分组失败。');
    }
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
    const onMove = (event: MouseEvent) => {
      const deltaPercent = ((event.clientX - startX) / window.innerWidth) * 100;
      setPaneLayout(resizeTriPaneLayout(initialLayout, handle, deltaPercent));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function openWikiPage(path: string) {
    setSelected({ kind: 'wiki', path });
    setEditing(false);
    setSaveStatus('');
  }

  function openRelatedWiki(reference: string) {
    const target = findWikiPageByReference(reference, pages);
    if (!target) return;
    openWikiPage(target.absolutePath);
  }

  function openSourceReference(reference: string) {
    const sourceEntry = findWorkspaceSourceEntryByLabel(reference, sourceEntries);
    if (sourceEntry) {
      setSelected({ kind: 'source', path: sourceEntry.absolutePath });
      setEditing(false);
      setSaveStatus('');
      return;
    }

    const wikiSourcePage = findWikiPageByReference(reference, pages);
    if (wikiSourcePage) {
      openWikiPage(wikiSourcePage.absolutePath);
    }
  }

  if (!canUseWorkspaceStorage()) {
    return (
      <section className="rounded-[12px] border border-[#fed7aa] bg-[#fff7ed] p-4 text-sm leading-6 text-[#8a4b00]">
        当前环境不能直接读取文件工作区。请使用桌面壳，或通过 localhost:5173 开发服务测试项目文件夹。
      </section>
    );
  }

  return (
    <>
      <div className="mb-5 flex gap-3 overflow-x-auto pb-1">
        {(typeStats.length ? typeStats : [{ label: 'Wiki 页面', count: pages.length }]).map((item) => (
          <WorkspaceStatCard key={item.label} label={item.label} value={item.count} />
        ))}
        <WorkspaceStatCard label="原始材料" value={sourceEntries.length} />
      </div>

      <section
        className="grid min-h-[560px] min-w-0 gap-0"
        style={{
          height: 'clamp(560px, calc(100vh - 320px), 720px)',
          gridTemplateColumns: `${paneLayout.left}fr 10px ${paneLayout.center}fr 10px ${paneLayout.right}fr`,
        }}
      >
      <aside className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white" style={{ gridColumn: 3, gridRow: 1 }}>
        <PanelHeader
          eyebrow="Knowledge"
          title="知识树"
          action={
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-full border border-[#d9d9d6] text-[#626965] hover:bg-[#f7f7f5]"
              onClick={() => void loadWorkspace()}
              aria-label="刷新工作区"
              disabled={status === 'loading'}
            >
              {status === 'loading' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
          }
        />
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {status === 'error' ? <p className="px-2 py-3 text-sm leading-6 text-[#b42318]">{error}</p> : null}
          {status === 'loading' ? (
            <p className="flex items-center gap-2 px-2 py-3 text-sm text-[#626965]">
              <Loader2 size={14} className="animate-spin" />
              正在扫描工作区...
            </p>
          ) : null}
          {groups.length === 0 && status !== 'loading' ? (
            <p className="px-2 py-4 text-sm leading-6 text-[#626965]">当前工作区还没有 Wiki 页面。</p>
          ) : null}

          {groups.map((group) => {
            const expanded = expandedTypes.has(group.type);
            return (
              <div key={group.type} className="mb-1 min-w-0">
                <div className="group/type-row flex min-w-0 items-center gap-1 rounded-[8px] hover:bg-[#f7f7f5]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2 py-2 text-sm"
                    onClick={() => toggleExpandedType(group.type)}
                  >
                    {expanded ? <ChevronDown size={15} className="shrink-0" /> : <ChevronRight size={15} className="shrink-0" />}
                    <BookOpen size={15} className="shrink-0 text-[#155eef]" />
                    <span className="min-w-0 flex-1 truncate text-left font-medium text-[#1f2937]">{group.label}</span>
                    <span className="shrink-0 text-xs text-[#626965]">{group.pages.length}</span>
                  </button>
                  <button
                    type="button"
                    className="pointer-events-none mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/type-row:pointer-events-auto group-hover/type-row:opacity-100"
                    onClick={() => void deleteWikiTypeGroup(group.label, group.pages)}
                    aria-label={`删除 ${group.label} 分组页面`}
                    title={`删除 ${group.label} 分组页面`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {expanded ? (
                  <div className="ml-5 grid min-w-0 gap-1 overflow-hidden">
                    {group.pages.map((page) => (
                      <div
                        key={page.absolutePath}
                        className={[
                          'group/page flex min-w-0 items-center gap-1 rounded-[8px] transition',
                          selectedPage?.absolutePath === page.absolutePath
                            ? 'bg-[#eef4ff] text-[#155eef]'
                            : 'text-[#626965] hover:bg-[#f7f7f5] hover:text-[#1f2937]',
                        ].join(' ')}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 overflow-hidden px-2 py-1.5 text-left text-sm"
                          onClick={() => openWikiPage(page.absolutePath)}
                          title={page.title}
                        >
                          <span className="block max-w-full truncate">{page.title}</span>
                        </button>
                        <button
                          type="button"
                          className="pointer-events-none mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/page:pointer-events-auto group-hover/page:opacity-100"
                          onClick={() => void deleteWorkspacePath(page.absolutePath, page.title)}
                          aria-label={`删除 ${page.title}`}
                          title="删除页面"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </aside>

      <PaneResizer style={{ gridColumn: 2, gridRow: 1 }} onMouseDown={(event) => startPaneResize('left-center', event.clientX)} />

      <main className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white" style={{ gridColumn: 1, gridRow: 1 }}>
        <PanelHeader
          eyebrow="Sources"
          title="原始材料"
          action={<span className="rounded-full border border-[#d9d9d6] px-2.5 py-1 text-xs text-[#626965]">{sourceEntries.length}</span>}
        />
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-3 rounded-[10px] border border-dashed border-[#cbd5c9] bg-[#fbfdfa] p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#1f2937]">
              <FolderOpen size={15} className="text-[#155eef]" />
              Raw Inbox / Sources
            </div>
            <p className="mt-1 text-xs leading-5 text-[#626965]">
              这里展示统一工作区里的原始材料。选中来源后，可以查看文本类文件，或跳转到已编译的来源 Wiki 页面。
            </p>
          </div>

          {sourceEntries.length === 0 ? (
            <p className="rounded-[10px] border border-[#e5e5e4] px-3 py-4 text-sm text-[#626965]">
              暂无原始材料。可以从 Froggy 或捕获页投喂文件。
            </p>
          ) : (
            <div className="grid gap-2">
              {sourceEntries.map((source) => {
                const matchedPage = findMatchingSourcePage(source, pages);
                const selectedSourceActive = selectedSource?.absolutePath === source.absolutePath;
                return (
                  <article
                    key={source.absolutePath}
                    className={[
                      'group/source rounded-[10px] border p-3 transition',
                      selectedSourceActive ? 'border-[#155eef] bg-[#f4f8ff]' : 'border-[#e5e5e4] bg-white hover:bg-[#fbfbfa]',
                    ].join(' ')}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected({ kind: 'source', path: source.absolutePath })}>
                        <div className="flex items-start gap-2">
                          <FileText size={15} className="mt-0.5 shrink-0 text-[#626965]" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-[#1f2937]">{source.name}</p>
                            <p className="mt-1 truncate text-xs text-[#626965]">{source.relativePath}</p>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="pointer-events-none flex size-8 shrink-0 items-center justify-center rounded-[8px] text-[#8a8f8b] opacity-0 transition hover:bg-[#fff1f2] hover:text-[#b42318] focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/source:pointer-events-auto group-hover/source:opacity-100"
                        onClick={() => void deleteWorkspacePath(source.absolutePath, source.name)}
                        aria-label={`删除原始材料 ${source.name}`}
                        title={`删除原始材料：${source.name}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Chip label={workspaceAreaLabel(source.area)} />
                      {source.extension ? <Chip label={source.extension.toUpperCase()} /> : null}
                      {matchedPage ? (
                        <button
                          type="button"
                          className="rounded-full border border-[#155eef] px-2.5 py-1 text-xs text-[#155eef] hover:bg-[#eef4ff]"
                          onClick={() => openWikiPage(matchedPage.absolutePath)}
                        >
                          打开编译页
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <PaneResizer style={{ gridColumn: 4, gridRow: 1 }} onMouseDown={(event) => startPaneResize('center-right', event.clientX)} />

      <aside className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white" style={{ gridColumn: 5, gridRow: 1 }}>
        <PanelHeader
          eyebrow={selectedSource ? 'Raw Preview' : 'Wiki Page'}
          title={selectedSource?.name ?? selectedPage?.title ?? '未选择页面'}
          action={
            selectedPage ? (
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border border-[#d9d9d6] px-3 py-1.5 text-xs text-[#626965] hover:bg-[#f7f7f5]"
                      onClick={() => {
                        setDraft(content);
                        setEditing(false);
                      }}
                    >
                      <XCircle size={13} />
                      取消
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full bg-[#155eef] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0f4bcc]"
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
                    className="inline-flex items-center gap-1 rounded-full border border-[#155eef] px-3 py-1.5 text-xs font-medium text-[#155eef] hover:bg-[#eef4ff]"
                    onClick={() => setEditing(true)}
                  >
                    <Edit3 size={13} />
                    编辑
                  </button>
                )}
              </div>
            ) : null
          }
        />

        {saveStatus ? (
          <div className="mx-5 mt-4 inline-flex items-center gap-2 rounded-full border border-[#b7e4c7] bg-[#f0fff4] px-3 py-1.5 text-xs text-[#276749]">
            <CheckCircle2 size={13} />
            {saveStatus}
          </div>
        ) : null}

        {selectedPage ? <MetadataCard page={selectedPage} onOpenRelated={openRelatedWiki} onOpenSource={openSourceReference} /> : null}

        {selectedPage ? (
          editing ? (
            <textarea
              className="mt-4 h-[520px] w-full resize-none border-0 border-t border-[#ececea] bg-[#fbfbfa] px-6 py-5 font-mono text-sm leading-7 text-[#1f2937] outline-none"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaveStatus('');
              }}
              aria-label="Markdown 编辑器"
            />
          ) : (
            <MarkdownPreview markdown={content} />
          )
        ) : selectedSource ? (
          <SourcePreview source={selectedSource} content={content} />
        ) : (
          <p className="p-5 text-sm text-[#626965]">请选择左侧原始材料或中间 Wiki 页面。</p>
        )}
      </aside>
      </section>
    </>
  );
}

function WorkspaceStatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[150px] rounded-[12px] border border-[#e5e5e4] bg-white p-4">
      <p className="truncate text-xs text-[#626965]" title={label}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-[#1f2937]">{value}</p>
    </div>
  );
}

function PanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[#ececea] px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-[#155eef]">{eyebrow}</p>
        <h2 className="mt-1 truncate text-lg font-semibold text-[#1f2937]">{title}</h2>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function MetadataCard({
  page,
  onOpenRelated,
  onOpenSource,
}: {
  page: WikiPageIndexEntry;
  onOpenRelated: (reference: string) => void;
  onOpenSource: (reference: string) => void;
}) {
  return (
    <div className="border-b border-[#ececea] px-5 py-4">
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Chip label={page.type} />
        {page.updated ? <Chip label={page.updated} /> : null}
        {page.tags.map((tag) => (
          <Chip key={tag} label={tag} icon={<Tags size={12} />} />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <MetaSection title={`来源 (${page.sources.length})`} items={page.sources} onOpenItem={onOpenSource} />
        <MetaSection title={`关联 (${page.related.length + page.wikilinks.length})`} items={[...page.related, ...page.wikilinks]} onOpenItem={onOpenRelated} />
      </div>
      {page.summary ? (
        <div className="mt-3 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
          <p className="mb-1 text-xs font-semibold text-[#626965]">摘要</p>
          <p className="line-clamp-3 text-sm leading-6 text-[#1f2937]">{page.summary}</p>
        </div>
      ) : null}
    </div>
  );
}

function MetaSection({
  title,
  items,
  onOpenItem,
}: {
  title: string;
  items: string[];
  onOpenItem?: (item: string) => void;
}) {
  const unique = Array.from(new Set(items)).slice(0, 10);
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#1f2937]">
        <GitBranch size={13} className="text-[#626965]" />
        {title}
      </div>
      {unique.length === 0 ? (
        <p className="text-xs text-[#626965]">暂无记录。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {unique.map((item) => (
            <button key={item} type="button" className="max-w-full" onClick={() => onOpenItem?.(item)} disabled={!onOpenItem}>
              <Chip label={item} interactive={Boolean(onOpenItem)} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SourcePreview({ source, content }: { source: WorkspaceFileEntry; content: string }) {
  if (!source.isTextLike) {
    return (
      <div className="p-6">
        <div className="rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4">
          <p className="text-sm font-semibold text-[#1f2937]">暂不直接预览此格式</p>
          <p className="mt-2 text-sm leading-6 text-[#626965]">
            {source.name} 已经放入 Raw Inbox。后续编译器会读取它并生成 Wiki 页面；这里先保留文件入口。
          </p>
          <p className="mt-3 break-all text-xs text-[#626965]">{source.absolutePath}</p>
        </div>
      </div>
    );
  }

  return (
    <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap border-t border-[#ececea] bg-[#fbfbfa] px-6 py-5 text-sm leading-7 text-[#1f2937]">
      {content || '暂无内容。'}
    </pre>
  );
}

function Chip({ label, icon, interactive = false }: { label: string; icon?: ReactNode; interactive?: boolean }) {
  return (
    <span
      className={[
        'inline-flex max-w-full items-center gap-1 rounded-full border border-[#d9d9d6] bg-white px-2.5 py-1 text-xs text-[#315078]',
        interactive ? 'cursor-pointer hover:border-[#155eef] hover:bg-[#eef4ff]' : '',
      ].join(' ')}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function PaneResizer({
  onMouseDown,
  style,
}: {
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  style?: CSSProperties;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group flex cursor-col-resize items-stretch justify-center"
      style={style}
      onMouseDown={onMouseDown}
    >
      <div className="w-px rounded-full bg-transparent transition group-hover:bg-[#c7d7ff]" />
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  if (!markdown.trim()) {
    return <p className="p-5 text-sm text-[#626965]">暂无内容。</p>;
  }

  const body = parseMarkdownFrontmatter(sanitizeWikiMarkdownOutput(markdown)).body;
  const lines = body.split(/\r?\n/);
  return (
    <article className="max-h-[560px] overflow-auto px-6 py-5">
      {lines.map((line, index) => renderMarkdownLine(line, index))}
    </article>
  );
}

function renderMarkdownLine(line: string, index: number) {
  if (!line.trim()) return <div key={index} className="h-3" />;
  if (line.startsWith('# ')) {
    return (
      <h1 key={index} className="mb-4 mt-2 text-2xl font-semibold text-[#1f2937]">
        {line.slice(2)}
      </h1>
    );
  }
  if (line.startsWith('## ')) {
    return (
      <h2 key={index} className="mb-3 mt-6 text-lg font-semibold text-[#1f2937]">
        {line.slice(3)}
      </h2>
    );
  }
  if (line.startsWith('### ')) {
    return (
      <h3 key={index} className="mb-2 mt-4 text-base font-semibold text-[#1f2937]">
        {line.slice(4)}
      </h3>
    );
  }
  if (/^[-*]\s+/.test(line)) {
    return (
      <p key={index} className="pl-4 text-sm leading-7 text-[#1f2937]">
        • {line.replace(/^[-*]\s+/, '')}
      </p>
    );
  }
  if (line.trim().startsWith('|')) {
    return (
      <pre key={index} className="overflow-x-auto rounded-[8px] bg-[#f7f7f5] px-3 py-2 text-xs text-[#1f2937]">
        {line}
      </pre>
    );
  }
  return (
    <p key={index} className="text-sm leading-7 text-[#1f2937]">
      {line}
    </p>
  );
}
