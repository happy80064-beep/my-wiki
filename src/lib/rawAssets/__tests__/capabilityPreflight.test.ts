import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  saveProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { validateRawAssetQueueModelCapabilities } from '@/lib/rawAssets/assets';
import type { RawAsset } from '@/types';

describe('raw asset model capability preflight', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('fails before processing images when the configured vision model cannot satisfy the role', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'zhipu', { apiKey: 'sk-zhipu', model: 'glm-4.6' });
    settings = activateProvider(settings, 'zhipu');
    settings = assignModelRole(settings, 'vision', 'zhipu');
    saveProviderSettings(settings);

    expect(() =>
      validateRawAssetQueueModelCapabilities([createAsset('raw_image', 'image.png', 'image')], { requireWikiCompile: true }),
    ).toThrow(/模型能力检查失败.*视觉/);
  });

  it('allows text-only raw assets when the wiki compile role has text capability', () => {
    let settings = createDefaultProviderSettings();
    settings = updateProviderConfig(settings, 'minimax-cn', { apiKey: 'sk-mini', model: 'MiniMax-M2.7' });
    settings = activateProvider(settings, 'minimax-cn');
    saveProviderSettings(settings);

    expect(() =>
      validateRawAssetQueueModelCapabilities([createAsset('raw_text', 'notes.md', 'text')], { requireWikiCompile: true }),
    ).not.toThrow();
  });

  it('fails clearly when the wiki compile role is not configured', () => {
    saveProviderSettings(createDefaultProviderSettings());

    expect(() =>
      validateRawAssetQueueModelCapabilities([createAsset('raw_text', 'notes.md', 'text')], { requireWikiCompile: true }),
    ).toThrow(/Wiki 编译模型/);
  });
});

function createAsset(id: string, filename: string, kind: RawAsset['kind']): RawAsset {
  return {
    id,
    clientId: 'client-test',
    filename,
    mimeType: kind === 'image' ? 'image/png' : 'text/markdown',
    kind,
    size: 12,
    contentHash: `hash-${id}`,
    blob: new Blob(['test']),
    status: 'raw',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
