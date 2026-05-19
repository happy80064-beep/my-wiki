import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWikiReviewItem, createEntity, createEntry, db, resetDatabase } from '@/lib/db';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  saveProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { recompileBrowserEntityWikiPage } from '../browserRecompile';
import { buildHumanEditedWikiPatch } from '../humanEditGuard';
import { stripSupersededMarkdown } from '../superseded';

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
  it('queues human-edited wiki conflicts for review and applies them without deleting old content', async () => {
    const entry = await createEntry({
      content: '新原文件显示福瑞三期住宅建筑面积为 14.2 万平方米。',
      source: 'file',
      fileMetadata: {
        filename: 'furui-new.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        url: 'raw://furui-new',
      },
    });
    const entity = await createEntity({
      type: 'project',
      title: '福瑞三期',
      summary: '人工版本',
      tags: ['项目'],
      sourceEntries: [entry.id],
    });
    const humanMarkdown = [
      '---',
      'type: project',
      'title: "福瑞三期"',
      'tags: [项目]',
      'sources: ["furui-old.xlsx"]',
      'related: []',
      '---',
      '',
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 12 万平方米。',
      '',
      '## 摘要',
      '人工补充：这个项目有养老社区定位。',
    ].join('\n');
    const aiMarkdown = [
      '---',
      'type: project',
      'title: "福瑞三期"',
      'tags: [项目]',
      'sources: ["furui-new.xlsx"]',
      'related: []',
      '---',
      '',
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '福瑞三期住宅建筑面积为 14.2 万平方米。',
      '',
      '## 摘要',
      'AI 重新编译：项目包含康养社区和住宅配套。',
    ].join('\n');
    await db.entities.update(entity.id, {
      wikiMarkdown: humanMarkdown,
      ...buildHumanEditedWikiPatch(humanMarkdown, 1000),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            markdown: aiMarkdown,
            summary: 'AI 重新编译：项目包含康养社区和住宅配套。',
            tags: ['项目'],
            provider: 'minimax-cn',
            model: 'MiniMax-M2.7',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await recompileBrowserEntityWikiPage(entity.id);
    const unchanged = await db.entities.get(entity.id);
    const reviews = await db.wikiReviewItems.where('entityId').equals(entity.id).toArray();

    expect(result.reviewQueued).toBe(true);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'pending', type: 'human-edit-conflict' });
    expect(unchanged?.wikiMarkdown).toContain('12 万平方米');
    expect(unchanged?.wikiMarkdown).not.toContain('14.2 万平方米');

    await applyWikiReviewItem(reviews[0]!.id);
    const applied = await db.entities.get(entity.id);
    const activeMarkdown = stripSupersededMarkdown(applied?.wikiMarkdown ?? '');

    expect(applied?.wikiMarkdown).toContain('14.2 万平方米');
    expect(applied?.wikiMarkdown).toContain('mywiki:superseded');
    expect(applied?.wikiMarkdown).toContain('~~福瑞三期住宅建筑面积为 12 万平方米。~~');
    expect(activeMarkdown).toContain('14.2 万平方米');
    expect(activeMarkdown).not.toContain('12 万平方米');
  });
});
