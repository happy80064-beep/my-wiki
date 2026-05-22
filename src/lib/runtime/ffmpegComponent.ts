import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauri';

export type FfmpegComponentStatus = {
  supported: boolean;
  available: boolean;
  installed: boolean;
  source: 'component' | 'system' | 'missing' | 'broken' | string;
  version?: string | null;
  executablePath?: string | null;
  componentPath: string;
  installDir: string;
  componentVersion: string;
  platform: string;
  arch: string;
  assetName?: string | null;
  message?: string | null;
};

export type InstallFfmpegComponentRequest = {
  downloadUrl: string;
  sha256Url?: string;
  expectedSha256?: string;
};

export function buildFfmpegComponentDownloadUrls(status: FfmpegComponentStatus) {
  const assetName = status.assetName?.trim();
  if (!assetName) return null;
  const repo = __MYWIKI_UPDATE_REPO__.trim();
  if (!repo) return null;
  const tag = normalizedReleaseTag();
  const base = `https://github.com/${repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '')}/releases/download/${tag}`;
  return {
    downloadUrl: `${base}/${encodeURIComponent(assetName)}`,
    sha256Url: `${base}/${encodeURIComponent(`${assetName}.sha256`)}`,
  };
}

export async function getFfmpegComponentStatus(): Promise<FfmpegComponentStatus> {
  if (!isTauriRuntime()) {
    return {
      supported: false,
      available: false,
      installed: false,
      source: 'browser',
      componentPath: '',
      installDir: '',
      componentVersion: '6.1.1',
      platform: 'browser',
      arch: 'browser',
      message: '浏览器开发模式不支持安装音视频解析组件；请在桌面安装版中使用。',
    };
  }
  return invoke<FfmpegComponentStatus>('ffmpeg_component_status');
}

export async function installFfmpegComponent(request: InstallFfmpegComponentRequest): Promise<FfmpegComponentStatus> {
  return invoke<FfmpegComponentStatus>('ffmpeg_component_install', { request });
}

export async function removeFfmpegComponent(): Promise<FfmpegComponentStatus> {
  return invoke<FfmpegComponentStatus>('ffmpeg_component_remove');
}

function normalizedReleaseTag() {
  const version = __APP_VERSION__.trim() || '0.1.7';
  return version.startsWith('v') ? version : `v${version}`;
}
