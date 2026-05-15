import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  saveProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { recompileBrowserEntityWikiPage } from '../browserRecompile';

describe('browser wiki recompilation', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('sends entity sources and the role-selected provider config to the server, then stores returned markdown', async () => {
    const entry = await createEntry({
      content: '项目预计年均营收 4.22 亿元。',
      source: 'file',
      fileMetadata: {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        url: 'raw://report',
      },
    });
    const entity = await createEntity({
      type: 'project',
      title: '福瑞健康科技园三期项目',
      summary: '旧摘要',
      tags: ['旧标签'],
      sourceEntries: [entry.id],
    });

    let providerSettings = createDefaultProviderSettings();
    providerSettings = updateProviderConfig(providerSettings, 'minimax-cn', {
      apiKey: 'sk-mini',
      model: 'MiniMax-M2.7',
    });
    providerSettings = updateProviderConfig(providerSettings, 'deepseek', {
      apiKey: 'sk-deep',
      model: 'deepseek-v4-pro',
    });
    providerSettings = activateProvider(providerSettings, 'deepseek');
    providerSettings = assignModelRole(providerSettings, 'wiki-compile', 'minimax-cn');
    saveProviderSettings(providerSettings);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          markdown:
            '---\ntype: project\ntitle: "福瑞健康科技园三期项目"\ntags: [产业园区]\nsources: ["report.pdf"]\nrelated: []\n---\n\n# 福瑞健康科技园三期项目\n\n## 摘要\n新摘要。',
          summary: '新摘要。',
          tags: ['产业园区'],
          provider: 'minimax-cn',
          model: 'MiniMax-M2.7',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await recompileBrowserEntityWikiPage(entity.id);
    const updated = await db.entities.get(entity.id);

    expect(fetchMock).toHaveBeenCalledWith('/api/wiki/recompile', expect.objectContaining({ method: 'POST' }));
    const firstCall = fetchMock.mock.calls.at(0) as [string, RequestInit] | undefined;
    const requestInit = firstCall?.[1];
    const payload = JSON.parse(String(requestInit?.body));
    expect(payload.providerConfig).toMatchObject({
      providerId: 'minimax-cn',
      enabled: true,
      apiKey: 'sk-mini',
      model: 'MiniMax-M2.7',
    });

    expect(updated?.summary).toBe('新摘要。');
    expect(updated?.tags).toContain('产业园区');
    expect(updated?.wikiMarkdown).toContain('## 摘要');
    expect(updated?.wikiCompileModel).toBe('minimax-cn:MiniMax-M2.7');
  });
});
