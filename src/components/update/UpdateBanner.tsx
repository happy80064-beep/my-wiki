import { Download, Sparkles, X } from 'lucide-react';
import { getAppUpdateConfig, getUpdateDownloadUrl } from '@/lib/update/updateCheck';
import { openExternalUrl } from '@/lib/update/openExternalUrl';
import {
  saveUpdateCheckState,
  shouldShowUpdateBanner,
  useUpdateStore,
} from '@/lib/update/updateStore';

export function UpdateBanner() {
  const visible = useUpdateStore((state) => shouldShowUpdateBanner(state));
  const result = useUpdateStore((state) => state.lastResult);
  const enabled = useUpdateStore((state) => state.enabled);
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);

  if (!visible || result?.kind !== 'available') return null;

  const updateUrl = getUpdateDownloadUrl(result.release, getAppUpdateConfig().releaseUrl);

  function dismiss() {
    if (result?.kind !== 'available') return;
    useUpdateStore.getState().setDismissed(result.remote);
    saveUpdateCheckState({
      enabled,
      lastCheckedAt: lastCheckedAt ?? Date.now(),
      dismissedVersion: result.remote,
    });
  }

  async function openDownload() {
    try {
      await openExternalUrl(updateUrl);
    } catch {
      await copyOrAlert(updateUrl);
    }
  }

  return (
    <div className="shrink-0 border-b border-[#bfd4ff] bg-[#eff6ff] text-[#173b73]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Sparkles size={16} className="shrink-0 text-[#155eef]" />
          <span className="font-medium">发现 MyWiki 新版本 {formatVersion(result.remote)}</span>
          <span className="text-[#4f678f]">当前版本 {formatVersion(result.local)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#155eef] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0f4bd1]"
            onClick={() => void openDownload()}
          >
            <Download size={14} />
            打开更新下载页
          </button>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[8px] text-[#4f678f] hover:bg-white/70"
            aria-label="稍后提醒"
            onClick={dismiss}
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function formatVersion(version: string) {
  return version.startsWith('v') ? version : `v${version}`;
}

async function copyOrAlert(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    window.alert(`无法自动打开浏览器，更新链接已复制：\n${url}`);
  } catch {
    window.alert(`无法自动打开浏览器，请手动访问：\n${url}`);
  }
}
