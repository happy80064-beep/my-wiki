import { CheckCircle2, Download, Info, RefreshCw, Sparkles } from 'lucide-react';
import {
  checkForUpdates,
  getAppUpdateConfig,
  getUpdateDownloadUrl,
  type UpdateStatus,
} from '@/lib/update/updateCheck';
import { openExternalUrl } from '@/lib/update/openExternalUrl';
import { hasAvailableUpdate, saveUpdateCheckState, useUpdateStore } from '@/lib/update/updateStore';

export function UpdateSettingsSection() {
  const updateStore = useUpdateStore();
  const config = getAppUpdateConfig();
  const available = hasAvailableUpdate(updateStore);
  const result = updateStore.lastResult;
  const sourceLabel = config.repo ? `GitHub Releases：${config.repo}` : '未配置更新源';
  const lastCheckedLabel = updateStore.lastCheckedAt ? formatCheckedAt(updateStore.lastCheckedAt) : '尚未检查';

  async function handleCheckNow() {
    if (useUpdateStore.getState().checking) return;
    useUpdateStore.getState().setChecking(true);
    const nextResult = await checkForUpdates(config);
    const now = Date.now();
    useUpdateStore.getState().setResult(nextResult, now);
    useUpdateStore.getState().setDismissed(null);
    saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: now,
      dismissedVersion: null,
    });
  }

  function handleDismiss() {
    const latest = useUpdateStore.getState().lastResult;
    if (latest?.kind !== 'available') return;
    useUpdateStore.getState().setDismissed(latest.remote);
    saveUpdateCheckState({
      enabled: useUpdateStore.getState().enabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt ?? Date.now(),
      dismissedVersion: latest.remote,
    });
  }

  function handleToggleAutoCheck() {
    const nextEnabled = !useUpdateStore.getState().enabled;
    useUpdateStore.getState().setEnabled(nextEnabled);
    saveUpdateCheckState({
      enabled: nextEnabled,
      lastCheckedAt: useUpdateStore.getState().lastCheckedAt,
      dismissedVersion: useUpdateStore.getState().dismissedVersion,
    });
  }

  async function handleOpenDownload() {
    const latest = useUpdateStore.getState().lastResult;
    if (latest?.kind !== 'available') return;
    const url = getUpdateDownloadUrl(latest.release, config.releaseUrl);
    try {
      await openExternalUrl(url);
    } catch {
      await copyUpdateUrlOrAlert(url);
    }
  }

  return (
    <section id="about" className="overflow-hidden rounded-[12px] border border-[#e5e5e4] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Info size={18} className="text-[#155eef]" />
            <h3 className="text-lg font-semibold text-[#1f2937]">关于 / 版本更新</h3>
            {available ? <span className="rounded-full bg-[#ef4444] px-2 py-0.5 text-[11px] font-medium text-white">有新版本</span> : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-[#626965]">
            当前 MVP 使用 GitHub Releases 做轻量版本提示：启动时自动检查，发现新版本后在顶部和关于页提示版本号与下载入口。
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-[8px] border border-[#d9d9d6] bg-white px-3 py-2 text-sm font-medium text-[#1f2937] hover:bg-[#f7f7f5] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void handleCheckNow()}
          disabled={updateStore.checking}
        >
          <RefreshCw size={15} className={updateStore.checking ? 'animate-spin' : ''} />
          {updateStore.checking ? '检查中' : '立即检查'}
        </button>
      </div>

      <div className="mt-4 grid gap-3 rounded-[10px] border border-[#e5e5e4] bg-[#fbfbfa] p-4 text-sm">
        <InfoRow label="当前版本" value={`v${config.currentVersion.replace(/^v/i, '')}`} mono />
        <InfoRow label="更新源" value={sourceLabel} mono />
        <InfoRow label="上次检查" value={lastCheckedLabel} />
      </div>

      <div className="mt-4">
        <UpdateResultPanel
          result={result}
          configuredReleaseUrl={config.releaseUrl}
          onOpenDownload={() => void handleOpenDownload()}
          onDismiss={handleDismiss}
        />
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm text-[#626965]">
        <input
          type="checkbox"
          className="size-4 rounded border-[#d9d9d6]"
          checked={updateStore.enabled}
          onChange={handleToggleAutoCheck}
        />
        应用启动时自动检查更新（每 1 小时最多一次）
      </label>
    </section>
  );
}

function UpdateResultPanel({
  result,
  configuredReleaseUrl,
  onOpenDownload,
  onDismiss,
}: {
  result: UpdateStatus | null;
  configuredReleaseUrl: string;
  onOpenDownload: () => void;
  onDismiss: () => void;
}) {
  if (!result) {
    return (
      <div className="rounded-[10px] border border-[#dbe7ff] bg-[#f5f8ff] px-3 py-2 text-sm leading-6 text-[#315078]">
        还没有检查结果。点击“立即检查”可以确认当前是否已有新版本。
      </div>
    );
  }

  if (result.kind === 'available') {
    const preview = formatReleasePreview(result.release.body);
    const downloadUrl = getUpdateDownloadUrl(result.release, configuredReleaseUrl);
    return (
      <div className="rounded-[10px] border border-[#bfdbfe] bg-[#eff6ff] p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#155eef]">
          <Sparkles size={16} />
          发现新版本 {formatVersion(result.remote)}
        </div>
        <p className="mt-1 text-xs text-[#4f678f]">
          当前版本 {formatVersion(result.local)}，下载页：{downloadUrl}
        </p>
        {result.release.name ? <p className="mt-2 text-sm font-medium text-[#1f2937]">{result.release.name}</p> : null}
        {preview ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-white/70 px-3 py-2 text-xs leading-5 text-[#475569]">
            {preview}
          </pre>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#155eef] px-3 py-2 text-sm font-medium text-white hover:bg-[#0f4bd1]"
            onClick={onOpenDownload}
          >
            <Download size={15} />
            打开更新下载页
          </button>
          <button
            type="button"
            className="rounded-[8px] px-3 py-2 text-sm font-medium text-[#4f678f] hover:bg-white/70"
            onClick={onDismiss}
          >
            稍后提醒
          </button>
        </div>
      </div>
    );
  }

  if (result.kind === 'up-to-date') {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-sm text-[#166534]">
        <CheckCircle2 size={16} />
        已是最新版本（远端 {formatVersion(result.remote)}）。
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-sm leading-6 text-[#8a4b00]">
      {result.message}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <span className="text-[#626965]">{label}</span>
      <span className={['min-w-0 break-words text-right text-[#1f2937]', mono ? 'font-mono text-xs' : 'text-sm'].join(' ')}>
        {value}
      </span>
    </div>
  );
}

function formatVersion(version: string) {
  return version.startsWith('v') ? version : `v${version}`;
}

function formatReleasePreview(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return trimmed.length > 520 ? `${trimmed.slice(0, 520)}...` : trimmed;
}

function formatCheckedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function copyUpdateUrlOrAlert(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    window.alert(`无法自动打开浏览器，更新链接已复制：\n${url}`);
  } catch {
    window.alert(`无法自动打开浏览器，请手动访问：\n${url}`);
  }
}
