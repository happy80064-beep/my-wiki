import { describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  fetchLatestRelease,
  getUpdateDownloadUrl,
  isNewerVersion,
  toLatestReleaseUrl,
  type GithubRelease,
} from '../updateCheck';

describe('updateCheck', () => {
  it('compares semver-like release tags', () => {
    expect(isNewerVersion('v0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('v0.1.0-beta.2', '0.1.0')).toBe(false);
  });

  it('normalizes GitHub release URLs to latest', () => {
    expect(toLatestReleaseUrl('https://github.com/happy80064-beep/my-wiki/releases/tag/v0.1.1')).toBe(
      'https://github.com/happy80064-beep/my-wiki/releases/latest',
    );
    expect(toLatestReleaseUrl('https://example.com/download')).toBe('https://example.com/download');
  });

  it('parses the latest GitHub release response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.1.1',
        name: 'MyWiki 0.1.1',
        body: '更新说明',
        html_url: 'https://github.com/happy80064-beep/my-wiki/releases/tag/v0.1.1',
        published_at: '2026-05-17T00:00:00Z',
      }),
    }));

    await expect(fetchLatestRelease('happy80064-beep/my-wiki', fetchImpl)).resolves.toMatchObject({
      tagName: 'v0.1.1',
      name: 'MyWiki 0.1.1',
      body: '更新说明',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/happy80064-beep/my-wiki/releases/latest', expect.any(Object));
  });

  it('reports available updates against the configured current version', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.1.2',
        html_url: 'https://github.com/happy80064-beep/my-wiki/releases/tag/v0.1.2',
      }),
    }));

    await expect(
      checkForUpdates(
        {
          currentVersion: '0.1.1',
          repo: 'happy80064-beep/my-wiki',
          releaseUrl: 'https://github.com/happy80064-beep/my-wiki/releases/latest',
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      kind: 'available',
      local: '0.1.1',
      remote: 'v0.1.2',
    });
  });

  it('explains when the repository has no published release yet', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    await expect(
      checkForUpdates(
        {
          currentVersion: '0.1.1',
          repo: 'happy80064-beep/my-wiki',
          releaseUrl: 'https://github.com/happy80064-beep/my-wiki/releases/latest',
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      kind: 'error',
      message: '当前 GitHub 仓库还没有已发布的 Release；发布完成后再检查。',
    });
  });

  it('uses a configured download page before the tag-specific release URL', () => {
    const release: GithubRelease = {
      tagName: 'v0.1.1',
      name: 'MyWiki 0.1.1',
      body: '',
      htmlUrl: 'https://github.com/happy80064-beep/my-wiki/releases/tag/v0.1.1',
      publishedAt: '',
    };

    expect(getUpdateDownloadUrl(release, 'https://example.com/mywiki')).toBe('https://example.com/mywiki');
    expect(getUpdateDownloadUrl(release)).toBe('https://github.com/happy80064-beep/my-wiki/releases/latest');
  });
});
