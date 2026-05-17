export interface GithubRelease {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

export type UpdateStatus =
  | { kind: 'available'; local: string; remote: string; release: GithubRelease }
  | { kind: 'up-to-date'; local: string; remote: string }
  | { kind: 'not-configured'; local: string; message: string }
  | { kind: 'error'; local: string; message: string };

export type UpdateCheckConfig = {
  currentVersion: string;
  repo: string;
  releaseUrl: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

export const UPDATE_CHECK_CACHE_MS = 60 * 60 * 1000;

export function getAppUpdateConfig(): UpdateCheckConfig {
  const repo = __MYWIKI_UPDATE_REPO__.trim();
  return {
    currentVersion: __APP_VERSION__.trim() || '0.0.0',
    repo,
    releaseUrl: (__MYWIKI_RELEASE_URL__.trim() || (repo ? `https://github.com/${repo}/releases/latest` : '')).trim(),
  };
}

export function isNewerVersion(remote: string, local: string): boolean {
  const [remoteMajor, remoteMinor, remotePatch] = parseVersion(remote);
  const [localMajor, localMinor, localPatch] = parseVersion(local);
  if (remoteMajor !== localMajor) return remoteMajor > localMajor;
  if (remoteMinor !== localMinor) return remoteMinor > localMinor;
  return remotePatch > localPatch;
}

export function toLatestReleaseUrl(url: string): string {
  const match = url.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/releases(?:\/.*)?$/i);
  if (!match) return url;
  return `${match[1]}/releases/latest`;
}

export function getUpdateDownloadUrl(release: GithubRelease, configuredReleaseUrl = ''): string {
  return toLatestReleaseUrl(configuredReleaseUrl.trim() || release.htmlUrl);
}

export async function fetchLatestRelease(repo: string, fetchImpl: FetchLike = fetch): Promise<GithubRelease | null> {
  const normalizedRepo = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (!normalizedRepo || !normalizedRepo.includes('/')) return null;

  const response = await fetchImpl(`https://api.github.com/repos/${normalizedRepo}/releases/latest`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return null;

  const data = (await response.json()) as unknown;
  if (!isObject(data) || typeof data.tag_name !== 'string' || typeof data.html_url !== 'string') return null;
  return {
    tagName: data.tag_name,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : data.tag_name,
    body: typeof data.body === 'string' ? data.body : '',
    htmlUrl: data.html_url,
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
  };
}

export async function checkForUpdates(
  config: UpdateCheckConfig = getAppUpdateConfig(),
  fetchImpl?: FetchLike,
): Promise<UpdateStatus> {
  const currentVersion = config.currentVersion.trim() || '0.0.0';
  if (!config.repo.trim()) {
    return {
      kind: 'not-configured',
      local: currentVersion,
      message: '尚未配置更新源。请在打包前配置 MYWIKI_UPDATE_REPO 或 VITE_MYWIKI_UPDATE_REPO。',
    };
  }

  try {
    const release = await fetchLatestRelease(config.repo, fetchImpl);
    if (!release) {
      return {
        kind: 'error',
        local: currentVersion,
        message: '暂时无法连接 GitHub Releases 更新源，稍后可以手动重试。',
      };
    }

    if (isNewerVersion(release.tagName, currentVersion)) {
      return {
        kind: 'available',
        local: currentVersion,
        remote: release.tagName,
        release,
      };
    }

    return {
      kind: 'up-to-date',
      local: currentVersion,
      remote: release.tagName,
    };
  } catch (error) {
    return {
      kind: 'error',
      local: currentVersion,
      message: error instanceof Error ? error.message : '更新检查失败。',
    };
  }
}

function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .trim()
    .replace(/^v/i, '')
    .split(/[+-]/)[0]
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  return [major, minor, patch];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
