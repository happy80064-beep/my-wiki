import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Database, FolderOpen, Loader2, Plus, RefreshCw, Repeat2 } from 'lucide-react';
import { CreateProjectDialog } from './CreateProjectDialog';
import {
  canUseWorkspaceStorage,
  createWorkspaceProject,
  createWorkspaceStorage,
  getWorkspaceDefaultRoot,
  initializeAndScanWorkspace,
  projectTemplates,
  sameWorkspaceRoot,
  switchIndexedDbKnowledgeWorkspace,
  useWorkspaceRuntimeStore,
  type ProjectTemplateId,
  type WorkspaceRegistryItem,
  type WorkspaceSnapshot,
} from '@/lib/workspace';

type Status = 'idle' | 'loading' | 'ready' | 'browser' | 'error';

export function WorkspaceStatusCard() {
  const [status, setStatus] = useState<Status>('idle');
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [message, setMessage] = useState('');
  const [templateId, setTemplateId] = useState<ProjectTemplateId>('general');
  const [defaultParentDirectory, setDefaultParentDirectory] = useState('');
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [isSwitchOpen, setSwitchOpen] = useState(false);
  const [switchRoot, setSwitchRoot] = useState('');
  const [switchingRoot, setSwitchingRoot] = useState('');
  const [isCreating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const activeRoot = useWorkspaceRuntimeStore((state) => state.activeRoot);
  const knownWorkspaces = useWorkspaceRuntimeStore((state) => state.knownWorkspaces);
  const setActiveWorkspace = useWorkspaceRuntimeStore((state) => state.setActiveWorkspace);

  const template = useMemo(() => projectTemplates.find((item) => item.id === templateId), [templateId]);
  const activeWorkspace = useMemo(
    () => knownWorkspaces.find((item) => sameWorkspaceRoot(item.root, snapshot?.layout.root ?? activeRoot)) ?? null,
    [activeRoot, knownWorkspaces, snapshot?.layout.root],
  );
  const visibleWorkspaces = useMemo(() => {
    const currentRoot = snapshot?.layout.root ?? activeRoot;
    return knownWorkspaces.filter((item) => !sameWorkspaceRoot(item.root, currentRoot));
  }, [activeRoot, knownWorkspaces, snapshot?.layout.root]);

  useEffect(() => {
    if (!canUseWorkspaceStorage()) {
      setStatus('browser');
      setMessage('当前浏览器环境不能直接读写本地文件夹。请在桌面壳中使用文件工作区，或通过 localhost:5173 开发服务测试。');
      return;
    }
    void refreshWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshWorkspace() {
    if (!canUseWorkspaceStorage()) {
      setStatus('browser');
      return;
    }

    setStatus('loading');
    setMessage('正在读取默认工作区...');
    try {
      const root = activeRoot || (await getWorkspaceDefaultRoot());
      setDefaultParentDirectory(parentDirectoryOf(root));
      const nextSnapshot = await initializeAndScanWorkspace(createWorkspaceStorage(), root, {
        templateId,
        outputLanguage: 'zh-CN',
      });
      setSnapshot(nextSnapshot);
      setActiveWorkspace(nextSnapshot.layout.root, nextSnapshot, { templateId });
      setStatus('ready');
      setMessage(nextSnapshot.createdFiles.length > 0 ? '工作区已初始化，默认页面已创建。' : '工作区已连接。');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : '工作区连接失败。');
    }
  }

  async function handleCreateProject(input: Parameters<typeof createWorkspaceProject>[1]) {
    if (!canUseWorkspaceStorage()) {
      setCreateError('创建文件工作区需要桌面壳，或 localhost:5173 开发服务。');
      return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const project = await createWorkspaceProject(createWorkspaceStorage(), input);
      const switched = await switchIndexedDbKnowledgeWorkspace(project.root);
      setSnapshot(switched.workspace);
      setActiveWorkspace(switched.workspace.layout.root, switched.workspace, {
        name: project.name,
        templateId: project.templateId,
        outputLanguage: project.outputLanguage,
      });
      setTemplateId(project.templateId);
      setDefaultParentDirectory(parentDirectoryOf(project.root));
      setMessage(`已创建并切换到知识库：${project.name}。`);
      setStatus('ready');
      setCreateOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建工作区失败。');
    } finally {
      setCreating(false);
    }
  }

  async function handleSwitchWorkspace(root: string, workspace?: WorkspaceRegistryItem) {
    const targetRoot = root.trim();
    if (!targetRoot) {
      setSwitchError('请输入或选择知识库路径。');
      return;
    }
    if (sameWorkspaceRoot(targetRoot, snapshot?.layout.root ?? activeRoot)) {
      setSwitchOpen(false);
      await refreshWorkspace();
      return;
    }

    setSwitchingRoot(targetRoot);
    setSwitchError('');
    setStatus('loading');
    setMessage('正在保存当前知识库并切换...');
    try {
      const switched = await switchIndexedDbKnowledgeWorkspace(targetRoot);
      setSnapshot(switched.workspace);
      setActiveWorkspace(switched.workspace.layout.root, switched.workspace, {
        name: workspace?.name,
        templateId: workspace?.templateId,
        outputLanguage: workspace?.outputLanguage,
      });
      if (workspace?.templateId) setTemplateId(workspace.templateId);
      setDefaultParentDirectory(parentDirectoryOf(switched.workspace.layout.root));
      setMessage(buildSwitchMessage(workspace?.name ?? basenameOf(switched.workspace.layout.root), switched.restore.mode));
      setStatus('ready');
      setSwitchOpen(false);
      setSwitchRoot('');
    } catch (error) {
      setStatus('error');
      setSwitchError(error instanceof Error ? error.message : '切换知识库失败。');
      setMessage(error instanceof Error ? error.message : '切换知识库失败。');
    } finally {
      setSwitchingRoot('');
    }
  }

  return (
    <section className="mt-8 rounded-[12px] border border-[#d7ded8] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-[10px] bg-[#eef6ff] text-[#155eef]">
            <Database size={18} />
          </div>
          <div>
            <p className="text-xs font-medium text-[#155eef]">工作区</p>
            <h3 className="mt-1 text-lg font-semibold text-[#1f2937]">v2 文件工作区</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#626965]">
              新版本会把 Raw Inbox、Wiki Markdown 和本地索引统一到一个工作区里，避免桌面壳和浏览器各自维护一套知识库。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-[#d9d9d6] bg-white px-3 text-sm font-medium text-[#1f2937] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              setSwitchError('');
              setSwitchOpen((open) => !open);
            }}
            disabled={status === 'loading' || status === 'browser'}
            title={status === 'browser' ? '切换文件知识库需要桌面壳，或 localhost:5173 开发服务。' : undefined}
          >
            <Repeat2 size={15} />
            切换知识库
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-full bg-[#111827] px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              setCreateError('');
              setCreateOpen(true);
            }}
            disabled={status === 'loading' || status === 'browser'}
            title={status === 'browser' ? '创建文件工作区需要桌面壳，或 localhost:5173 开发服务。' : undefined}
          >
            <Plus size={15} />
            新建知识库
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-[#155eef] bg-white px-3 text-sm font-medium text-[#155eef] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void refreshWorkspace()}
            disabled={status === 'loading' || status === 'browser'}
          >
            {status === 'loading' ? <Loader2 size={15} className="animate-spin" /> : snapshot ? <RefreshCw size={15} /> : <Plus size={15} />}
            {snapshot ? '刷新状态' : '初始化工作区'}
          </button>
        </div>
      </div>

      {isSwitchOpen ? (
        <div className="mt-4 rounded-[12px] border border-[#e5e5e4] bg-[#fbfbfa] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[#155eef]">当前知识库</p>
              <p className="mt-1 max-w-3xl truncate text-sm font-semibold text-[#1f2937]" title={snapshot?.layout.root ?? activeRoot ?? ''}>
                {activeWorkspace?.name ?? basenameOf(snapshot?.layout.root ?? activeRoot ?? '')}
              </p>
              <p className="mt-1 max-w-3xl truncate text-xs text-[#626965]" title={snapshot?.layout.root ?? activeRoot ?? ''}>
                {snapshot?.layout.root ?? activeRoot ?? '尚未连接'}
              </p>
            </div>
          </div>

          <div className="mt-3 grid gap-2">
            {visibleWorkspaces.length > 0 ? (
              visibleWorkspaces.map((workspace) => (
                <button
                  key={workspace.root}
                  type="button"
                  className="grid gap-1 rounded-[10px] border border-[#e5e5e4] bg-white px-3 py-2 text-left hover:border-[#155eef] disabled:opacity-60"
                  onClick={() => void handleSwitchWorkspace(workspace.root, workspace)}
                  disabled={Boolean(switchingRoot)}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold text-[#1f2937]">
                    <span className="min-w-0 truncate">{workspace.name}</span>
                    <span className="shrink-0 text-xs font-normal text-[#155eef]">
                      {switchingRoot === workspace.root ? '切换中...' : `${workspace.pageCount ?? 0} 页`}
                    </span>
                  </span>
                  <span className="truncate text-xs text-[#626965]">{workspace.root}</span>
                </button>
              ))
            ) : (
              <p className="rounded-[10px] border border-[#e5e5e4] bg-white px-3 py-2 text-xs leading-5 text-[#626965]">
                还没有其他已记录的知识库。可以新建一个，或在下面输入已有 MyWiki 工作区路径。
              </p>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-[8px] border border-[#d9d9d6] bg-white px-3 text-sm outline-none focus:border-[#155eef]"
              value={switchRoot}
              onChange={(event) => setSwitchRoot(event.target.value)}
              placeholder="输入已有知识库路径，例如 D:/MyWikiProjects/业务知识库"
              disabled={Boolean(switchingRoot)}
            />
            <button
              type="button"
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[8px] bg-[#111827] px-3 text-sm font-medium text-white disabled:opacity-60"
              onClick={() => void handleSwitchWorkspace(switchRoot)}
              disabled={Boolean(switchingRoot)}
            >
              {switchingRoot === switchRoot.trim() ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
              打开
            </button>
          </div>

          {switchError ? (
            <div className="mt-3 rounded-[8px] border border-[#fecaca] bg-[#fff5f5] px-3 py-2 text-sm leading-6 text-[#b42318]">
              {switchError}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <StatusItem
          label="当前路径"
          value={snapshot?.layout.root ?? (status === 'browser' ? '浏览器预览' : '等待连接')}
          icon={<FolderOpen size={15} />}
        />
        <StatusItem label="Wiki 页面" value={`${snapshot?.pages.length ?? 0} 个`} icon={<CheckCircle2 size={15} />} />
        <StatusItem label="初始化文件" value={`${snapshot?.createdFiles.length ?? 0} 个新建`} icon={<Database size={15} />} />
      </div>

      <div
        className={[
          'mt-4 rounded-[10px] border px-3 py-2 text-sm leading-6',
          status === 'error'
            ? 'border-[#fecaca] bg-[#fff5f5] text-[#b42318]'
            : status === 'browser'
              ? 'border-[#fed7aa] bg-[#fff7ed] text-[#8a4b00]'
              : 'border-[#dbe7ff] bg-[#f5f8ff] text-[#315078]',
        ].join(' ')}
      >
        {template ? `当前模板：${template.icon} ${template.name}。` : null}
        {message}
      </div>

      <CreateProjectDialog
        open={isCreateOpen}
        defaultParentDirectory={defaultParentDirectory || 'D:/MyWikiProjects'}
        creating={isCreating}
        error={createError}
        onClose={() => {
          if (!isCreating) setCreateOpen(false);
        }}
        onCreate={(input) => void handleCreateProject(input)}
      />
    </section>
  );
}

function parentDirectoryOf(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function basenameOf(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).at(-1) || 'MyWiki 知识库';
}

function buildSwitchMessage(name: string, mode: 'snapshot' | 'markdown' | 'empty') {
  const sourceLabel = mode === 'snapshot' ? '完整快照' : mode === 'markdown' ? 'Markdown 页面' : '空白工作区';
  return `已切换到知识库：${name}。已加载${sourceLabel}，后续知识库、图谱、审核、巡检和查询会读取当前知识库。`;
}

function StatusItem({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#626965]">
        {icon}
        {label}
      </div>
      <div className="truncate text-sm font-semibold text-[#1f2937]" title={value}>
        {value}
      </div>
    </div>
  );
}
