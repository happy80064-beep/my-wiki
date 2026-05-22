import { describe, expect, it } from 'vitest';
import { buildFfmpegComponentDownloadUrls, type FfmpegComponentStatus } from '../ffmpegComponent';

describe('ffmpeg component client', () => {
  it('builds release-bound component download URLs', () => {
    const status: FfmpegComponentStatus = {
      supported: true,
      available: false,
      installed: false,
      source: 'missing',
      componentPath: '',
      installDir: '',
      componentVersion: '6.1.1',
      platform: 'windows',
      arch: 'x64',
      assetName: 'MyWiki_ffmpeg_0.1.7_windows_x64.zip',
    };

    expect(buildFfmpegComponentDownloadUrls(status)).toEqual({
      downloadUrl:
        'https://github.com/happy80064-beep/my-wiki/releases/download/v0.1.7/MyWiki_ffmpeg_0.1.7_windows_x64.zip',
      sha256Url:
        'https://github.com/happy80064-beep/my-wiki/releases/download/v0.1.7/MyWiki_ffmpeg_0.1.7_windows_x64.zip.sha256',
    });
  });

  it('returns null when the runtime status has no platform asset', () => {
    expect(
      buildFfmpegComponentDownloadUrls({
        supported: false,
        available: false,
        installed: false,
        source: 'browser',
        componentPath: '',
        installDir: '',
        componentVersion: '6.1.1',
        platform: 'browser',
        arch: 'browser',
      }),
    ).toBeNull();
  });
});
