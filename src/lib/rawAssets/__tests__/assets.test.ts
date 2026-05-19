import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createLocalCaptureDraft } from '@/lib/capture';
import { createEntity, db, resetDatabase } from '@/lib/db';
import {
  RAW_ASSET_STALE_MS,
  buildCaptureInputExcerpt,
  compileRawAssetWikiPages,
  createRawAssetFromFile,
  createRawAssetFromUrl,
  processNextRawAsset,
  processRawAsset,
  processRawAssetQueue,
  resetInvalidCompiledVisionAssets,
  resetStaleRawAssets,
  shouldCapturePdfPageScreenshots,
} from '@/lib/rawAssets';

vi.mock('@/lib/llm/providerSettings', () => ({
  loadProviderSettings: () => ({}),
  getProviderConfigForRole: () => null,
  resolveProviderConfigForRole: (_settings: unknown, role: string) => {
    const config =
      role === 'vision'
        ? {
            providerId: 'custom-openai',
            enabled: true,
            apiMode: 'openai-compatible',
            endpoint: 'https://example.test/v1',
            apiKey: 'test-key',
            model: 'vision-test',
            contextWindow: 8000,
          }
        : null;
    return { config, source: config ? 'assigned' : 'none' };
  },
}));

describe('raw assets', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('stores files in Raw Inbox without compiling immediately', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'openmaic.md', { type: 'text/markdown' });

    const result = await createRawAssetFromFile(file);
    const rawEntry = result.asset.entryId ? await db.entries.get(result.asset.entryId) : undefined;

    expect(result.reused).toBe(false);
    expect(result.asset.status).toBe('raw');
    expect(await db.entries.count()).toBe(1);
    expect(rawEntry?.processed).toBe(false);
    expect(rawEntry?.content).toContain('原始文件：openmaic.md');
    expect(await db.ingestJobs.count()).toBe(0);
  });

  it('accepts spreadsheet files into Raw Inbox before compilation', async () => {
    const file = new File(['项目,收入\n福瑞三期,4.22亿元'], 'revenue.csv', { type: 'text/csv' });

    const result = await createRawAssetFromFile(file);

    expect(result.reused).toBe(false);
    expect(result.asset.kind).toBe('spreadsheet');
    expect(result.asset.status).toBe('raw');
    expect(await db.entries.count()).toBe(1);
  });

  it('deduplicates raw files by content hash', async () => {
    const first = new File(['重复内容'], 'a.md', { type: 'text/markdown' });
    const second = new File(['重复内容'], 'b.md', { type: 'text/markdown' });

    await createRawAssetFromFile(first);
    const duplicated = await createRawAssetFromFile(second);

    expect(duplicated.reused).toBe(true);
    expect(await db.rawAssets.count()).toBe(1);
  });

  it('imports webpage URLs by extracting page markdown before creating the raw asset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('/api/import/url');
        expect(JSON.parse(String(init?.body ?? '{}')).url).toBe('https://example.com/report');
        return new Response(
          JSON.stringify({
            url: 'https://example.com/report',
            text:
              '# Example Report\n\nThis is the extracted webpage body, not just the pasted URL. It contains enough useful article text for structured import.',
          }),
          { status: 200 },
        );
      }),
    );

    const { asset } = await createRawAssetFromUrl('https://example.com/report');
    const rawText = new TextDecoder().decode(Uint8Array.from(atob(asset.dataBase64 ?? ''), (char) => char.charCodeAt(0)));

    expect(asset.filename).toMatch(/^web-example\.com-Example-Report/);
    expect(asset.kind).toBe('text');
    expect(rawText).toContain('https://example.com/report');
    expect(rawText).toContain('This is the extracted webpage body');
  });

  it('rejects webpage URL imports when extraction only returns a verification page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            url: 'https://example.com/protected',
            text: '# 环境异常\n\n当前环境异常，完成验证后即可继续访问。去验证。',
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(createRawAssetFromUrl('https://example.com/protected')).rejects.toThrow('网页正文没有被正常提取');
    expect(await db.rawAssets.count()).toBe(0);
  });

  it('versions raw files when the same filename is imported with different content', async () => {
    const first = new File(['first content'], 'work-history.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const second = new File(['second content'], 'work-history.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const firstResult = await createRawAssetFromFile(first);
    const secondResult = await createRawAssetFromFile(second);

    expect(firstResult.asset.filename).toBe('work-history.docx');
    expect(secondResult.asset.filename).toMatch(/^work-history-\d{8}\.docx$/);
    expect(await db.rawAssets.count()).toBe(2);
  });

  it('compiles a raw text file asynchronously', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'openmaic.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.status).toBe('compiled');
    expect(compiled?.entryId).toBeTruthy();
    expect(await db.entries.count()).toBe(1);
    expect((await db.entries.get(compiled!.entryId!))?.processed).toBe(true);
  });

  it('fails imported files instead of creating a fake source summary when AI JSON is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid model json' }), { status: 502 })),
    );
    const file = new File(['# 导入文件：report.pdf\n\n来源格式：PDF\n\n一份很长的 PDF 解析文本。'], 'report.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id);

    expect(compiled?.status).toBe('failed');
    expect(compiled?.entryId).toBeTruthy();
    expect(await db.entries.count()).toBe(1);
    expect(await db.entities.count()).toBe(0);
    expect(compiled?.error).toContain('invalid model json');
  });

  it('sends full raw content into the capture pipeline so long documents can use the digest stage', async () => {
    let capturedContent = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { content?: string };
        capturedContent = body.content ?? '';
        return new Response(
          JSON.stringify({
            draft: createLocalCaptureDraft('OpenMaic is an open source project.'),
            provider: 'minimax',
            model: 'test',
            mode: 'two-step',
          }),
          { status: 200 },
        );
      }),
    );
    const marker = 'UNIQUE_TAIL_MARKER_FOR_LONG_RAW_DOCUMENT';
    const file = new File([`${'long document paragraph\n'.repeat(2500)}\n${marker}`], 'long-report.md', {
      type: 'text/markdown',
    });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id);

    expect(compiled?.status).toBe('compiled');
    expect(capturedContent).toContain(marker);
  });

  it('requests PDF page screenshots when extracted text only contains page markers', () => {
    expect(shouldCapturePdfPageScreenshots('\n\n-- 1 of 15 --\n\n-- 2 of 15 --\n\n-- 3 of 15 --')).toBe(true);
    expect(
      shouldCapturePdfPageScreenshots(
        '商业方案汇报 高端人群整合健康管理项目 创新服务模式与市场机遇 睡眠健康管理 益生菌应用 个性化营养方案。'.repeat(3),
      ),
    ).toBe(false);
  });

  it('treats capture fallback as failed raw compilation instead of a normal success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            draft: createLocalCaptureDraft('fallback draft'),
            provider: 'minimax',
            model: 'test',
            fallbackFrom: 'patch JSON was invalid',
            mode: 'two-step',
          }),
          { status: 200 },
        ),
      ),
    );
    const file = new File(['OpenMaic is an open source project.'], 'fallback.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id);

    expect(compiled?.status).toBe('failed');
    expect(compiled?.error).toContain('patch JSON was invalid');
    expect(await db.entities.count()).toBe(0);
  });

  it('fails simple imported text when AI extraction is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid model json' }), { status: 502 })),
    );
    const file = new File(['普通文本。'], 'note.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id);

    expect(compiled?.status).toBe('failed');
    expect(await db.entities.count()).toBe(0);
    expect(compiled?.error).toContain('invalid model json');
  });

  it('adds multimodal captions to image content before compilation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ caption: '图中是一张项目总览截图，包含收入、面积和任务节点。' }), { status: 200 })),
    );
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'overview.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));
    const entry = compiled?.entryId ? await db.entries.get(compiled.entryId) : undefined;

    expect(compiled?.status).toBe('compiled');
    expect(entry?.content).toContain('## 视觉描述');
    expect(entry?.content).toContain('项目总览截图');
    expect(entry?.source).toBe('image');
  });

  it('keeps OCR text as usable image content when the vision provider is temporarily busy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/import/extract')) {
          return new Response(JSON.stringify({ text: 'OCR 文本：福瑞健康科技园三期项目总投资 12 亿元。' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: '该模型当前访问量过大，请您稍后再试' }), { status: 429 });
      }),
    );
    const file = new File([new Uint8Array([137, 80, 78, 71, 8])], 'ocr-only.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));
    const entry = compiled?.entryId ? await db.entries.get(compiled.entryId) : undefined;

    expect(compiled?.status).toBe('compiled');
    expect(entry?.content).toContain('## OCR 文本');
    expect(entry?.content).toContain('福瑞健康科技园三期项目总投资');
    expect(entry?.content).toContain('## 视觉描述待重试');
  });

  it('adds multimodal captions for embedded presentation images before compilation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/import/extract')) {
          return new Response(JSON.stringify({ text: '图片 OCR 中出现“项目进度 85%”。' }), { status: 200 });
        }
        return new Response(JSON.stringify({ caption: '内嵌图展示项目进度仪表盘和关键节点。' }), { status: 200 });
      }),
    );

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>项目汇报</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
    zip.file('ppt/media/image1.png', new Uint8Array([137, 80, 78, 71, 9]));
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    const file = new File([buffer], 'deck.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));
    const entry = compiled?.entryId ? await db.entries.get(compiled.entryId) : undefined;

    expect(compiled?.status).toBe('compiled');
    expect(entry?.content).toContain('## 文档内嵌图片描述');
    expect(entry?.content).toContain('内嵌图展示项目进度仪表盘');
    expect(entry?.content).toContain('图片 OCR 中出现');
  });

  it('fails image compilation when the vision model says it cannot see the image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ caption: '抱歉，我目前无法直接访问或查看此图片。' }), { status: 200 })),
    );
    const file = new File([new Uint8Array([137, 80, 78, 71, 2])], 'bad-vision.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.status).toBe('failed');
    expect(compiled?.error).toContain('没有真正读取图片');
  });

  it('fails image compilation when the vision model asks the user to upload the image again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ caption: '请上传对应的图片文件，以便我进行客观描述。' }), { status: 200 })),
    );
    const file = new File([new Uint8Array([137, 80, 78, 71, 4])], 'needs-upload.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);

    const compiled = await processRawAsset(asset.id, async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.status).toBe('failed');
    expect(compiled?.error).toContain('没有真正读取图片');
  });

  it('recovers old compiled image entries whose caption was a vision refusal', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71, 3])], 'old-bad-vision.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);
    await db.rawAssets.update(asset.id, {
      status: 'compiled',
      extractedText: '抱歉，我目前无法直接访问或查看此图片。',
    });
    await db.entries.update(asset.entryId!, {
      processed: true,
      content: '# 图片内容捕获\n\n抱歉，我目前无法直接访问或查看此图片。',
    });

    const recovered = await resetInvalidCompiledVisionAssets();
    const updated = await db.rawAssets.get(asset.id);
    const entry = await db.entries.get(asset.entryId!);

    expect(recovered).toBe(1);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toContain('无效');
    expect(entry?.processed).toBe(false);
  });

  it('recovers old compiled image entries whose caption asks for a separate upload', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71, 5])], 'old-needs-upload.png', { type: 'image/png' });
    const { asset } = await createRawAssetFromFile(file);
    await db.rawAssets.update(asset.id, {
      status: 'compiled',
      extractedText: '请上传对应的图片文件，以便我进行客观描述。',
    });
    await db.entries.update(asset.entryId!, {
      processed: true,
      content: '# 图片内容捕获\n\n请上传对应的图片文件，以便我进行客观描述。',
    });

    const recovered = await resetInvalidCompiledVisionAssets();
    const updated = await db.rawAssets.get(asset.id);
    const entry = await db.entries.get(asset.entryId!);

    expect(recovered).toBe(1);
    expect(updated?.status).toBe('failed');
    expect(entry?.processed).toBe(false);
  });

  it('recovers stale compiling raw assets so they can be retried', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'stale.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    const now = Date.now();
    await db.rawAssets.update(asset.id, {
      status: 'compiling',
      updatedAt: now - RAW_ASSET_STALE_MS - 1000,
    });

    const recovered = await resetStaleRawAssets(now);
    const reset = await db.rawAssets.get(asset.id);

    expect(recovered).toBe(1);
    expect(reset?.status).toBe('failed');
    expect(reset?.error).toContain('可重试');
  });

  it('processes recovered stale raw assets from the queue', async () => {
    const file = new File(['OpenMaic 是开源项目。'], 'recover.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    await db.rawAssets.update(asset.id, {
      status: 'compiling',
      updatedAt: Date.now() - RAW_ASSET_STALE_MS - 1000,
    });

    const compiled = await processNextRawAsset(async (content) => ({
      draft: createLocalCaptureDraft(content),
    }));

    expect(compiled?.id).toBe(asset.id);
    expect(compiled?.status).toBe('compiled');
  });

  it('processes each queued raw asset once even when one item fails', async () => {
    const first = new File(['第一个材料会失败。'], 'first.md', { type: 'text/markdown' });
    const second = new File(['第二个材料会成功。'], 'second.md', { type: 'text/markdown' });
    const firstResult = await createRawAssetFromFile(first);
    const secondResult = await createRawAssetFromFile(second);

    let calls = 0;
    const result = await processRawAssetQueue({
      extractor: async (content) => {
        calls += 1;
        if (content.includes('first.md')) {
          throw new Error('model request failed');
        }
        return { draft: createLocalCaptureDraft(content) };
      },
    });

    const firstAsset = await db.rawAssets.get(firstResult.asset.id);
    const secondAsset = await db.rawAssets.get(secondResult.asset.id);

    expect(result).toEqual({ total: 2, processed: 2, failed: 1 });
    expect(calls).toBe(2);
    expect(firstAsset?.status).toBe('failed');
    expect(secondAsset?.status).toBe('compiled');
  });

  it('can continue from raw compilation into related wiki page generation', async () => {
    const file = new File(['OpenMaic is an open source project.'], 'openmaic.md', { type: 'text/markdown' });
    await createRawAssetFromFile(file);

    const result = await processRawAssetQueue({
      compileWiki: true,
      extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      wikiCompiler: async (entityId) => {
        const entity = await db.entities.get(entityId);
        await db.entities.update(entityId, {
          wikiMarkdown: buildUsefulWikiMarkdown(entity?.title ?? entityId),
          wikiCompiledAt: Date.now(),
          wikiCompileModel: 'test:mock',
        });
      },
    });
    const asset = await db.rawAssets.orderBy('createdAt').first();
    const entity = await db.entities.orderBy('createdAt').first();

    expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
    expect(asset?.status).toBe('compiled');
    expect(entity?.wikiMarkdown).toContain('source-backed detail');
  });

  it('does not count short wiki markdown as a completed raw-to-wiki generation', async () => {
    const file = new File(['OpenMaic is an open source project.'], 'openmaic-short.md', { type: 'text/markdown' });
    await createRawAssetFromFile(file);

    const result = await processRawAssetQueue({
      compileWiki: true,
      extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      wikiCompiler: async (entityId) => {
        const entity = await db.entities.get(entityId);
        await db.entities.update(entityId, {
          wikiMarkdown: `# ${entity?.title ?? entityId}\n\nToo short.`,
          wikiCompiledAt: Date.now(),
          wikiCompileModel: 'test:mock',
        });
      },
    });
    const asset = await db.rawAssets.orderBy('createdAt').first();

    expect(result).toMatchObject({ total: 1, processed: 1, failed: 1 });
    expect(asset?.status).toBe('wiki_failed');
    expect(asset?.error).toContain('incomplete content');
  });

  it('marks only the wiki stage as failed when related wiki generation fails', async () => {
    const file = new File(['OpenMaic is an open source project.'], 'openmaic.md', { type: 'text/markdown' });
    await createRawAssetFromFile(file);

    const result = await processRawAssetQueue({
      compileWiki: true,
      extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      wikiCompiler: async () => {
        throw new Error('wiki model unavailable');
      },
    });
    const asset = await db.rawAssets.orderBy('createdAt').first();

    expect(result).toMatchObject({ total: 1, processed: 1, failed: 1 });
    expect(asset?.status).toBe('wiki_failed');
    expect(asset?.error).toContain('wiki model unavailable');
    expect(await db.entities.count()).toBeGreaterThan(0);
  });

  it('resumes raw wiki generation by skipping pages already compiled in a previous attempt', async () => {
    const file = new File(['Source text for a multi-entity report.'], 'report.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    const entryId = asset.entryId!;
    const first = await createEntity({
      type: 'topic',
      title: 'First topic',
      sourceEntries: [entryId],
    });
    const second = await createEntity({
      type: 'topic',
      title: 'Second topic',
      sourceEntries: [entryId],
    });
    await db.entries.update(entryId, {
      processed: true,
      derivedEntities: [first.id, second.id],
      content: 'Source text for a multi-entity report.',
    });
    await db.rawAssets.update(asset.id, { status: 'compiled' });

    const firstAttemptCalls: string[] = [];
    await compileRawAssetWikiPages(asset.id, async (entityId) => {
      firstAttemptCalls.push(entityId);
      if (entityId === second.id) throw new Error('wiki model unavailable');
      await db.entities.update(entityId, {
        wikiMarkdown: buildUsefulWikiMarkdown('First topic'),
        wikiCompiledAt: Date.now(),
        wikiCompileModel: 'test:mock',
      });
    });
    expect(firstAttemptCalls).toEqual([first.id, second.id]);
    expect((await db.rawAssets.get(asset.id))?.status).toBe('wiki_failed');

    const retryCalls: string[] = [];
    await compileRawAssetWikiPages(asset.id, async (entityId) => {
      retryCalls.push(entityId);
      await db.entities.update(entityId, {
        wikiMarkdown: buildUsefulWikiMarkdown('Second topic'),
        wikiCompiledAt: Date.now(),
        wikiCompileModel: 'test:mock',
      });
    });

    expect(retryCalls).toEqual([second.id]);
    expect((await db.rawAssets.get(asset.id))?.status).toBe('compiled');
  });

  it('includes already structured raw assets when wiki pages are still missing', async () => {
    const file = new File(['Source text for a structured-only report.'], 'structured.md', { type: 'text/markdown' });
    const { asset } = await createRawAssetFromFile(file);
    const entryId = asset.entryId!;
    const entity = await createEntity({
      type: 'topic',
      title: 'Structured-only topic',
      sourceEntries: [entryId],
    });
    await db.entries.update(entryId, {
      processed: true,
      derivedEntities: [entity.id],
      content: 'Source text for a structured-only report.',
    });
    await db.rawAssets.update(asset.id, { status: 'compiled' });

    const calls: string[] = [];
    const result = await processRawAssetQueue({
      compileWiki: true,
      extractor: async () => {
        throw new Error('extractor should not be called for an already structured asset');
      },
      wikiCompiler: async (entityId) => {
        calls.push(entityId);
        await db.entities.update(entityId, {
          wikiMarkdown: buildUsefulWikiMarkdown('Structured-only topic'),
          wikiCompiledAt: Date.now(),
          wikiCompileModel: 'test:mock',
        });
      },
    });

    expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
    expect(calls).toEqual([entity.id]);
  });

  it('publishes the retry queue ids so Frog can mark failed rows as compiling during retry', async () => {
    const first = new File(['第一个材料。'], 'first.md', { type: 'text/markdown' });
    const second = new File(['第二个材料。'], 'second.md', { type: 'text/markdown' });
    const firstResult = await createRawAssetFromFile(first);
    const secondResult = await createRawAssetFromFile(second);
    await db.rawAssets.update(firstResult.asset.id, { status: 'failed', error: 'previous failure' });
    await db.rawAssets.update(secondResult.asset.id, { status: 'failed', error: 'previous failure' });

    const snapshots: Array<{ currentAssetId?: string; queuedAssetIds?: string[] }> = [];
    await processRawAssetQueue({
      extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      onStatus: (snapshot) => {
        if (snapshot.stage === 'running') {
          snapshots.push({
            currentAssetId: snapshot.currentAssetId,
            queuedAssetIds: snapshot.queuedAssetIds,
          });
        }
      },
    });

    expect(snapshots[0]?.queuedAssetIds?.sort()).toEqual([firstResult.asset.id, secondResult.asset.id].sort());
    expect(snapshots.some((snapshot) => snapshot.currentAssetId === firstResult.asset.id)).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.queuedAssetIds?.includes(secondResult.asset.id))).toBe(true);
  });

  it('builds a bounded excerpt for long raw content before sending it to AI', () => {
    const longContent = [
      '# 导入文件：report.pdf',
      '开头内容'.repeat(5000),
      '## 关键建议\n下一阶段需要完成任务规划和风险处理。',
      '结尾内容'.repeat(5000),
    ].join('\n');

    const excerpt = buildCaptureInputExcerpt(longContent, 1200);

    expect(excerpt.length).toBeLessThanOrEqual(1420);
    expect(excerpt).toContain('原文较长');
    expect(excerpt).toContain('下一阶段需要完成任务规划和风险处理');
    expect(excerpt).toContain('--- 结尾 ---');
  });
});

function buildUsefulWikiMarkdown(title: string) {
  return [
    '---',
    'type: topic',
    `title: "${title}"`,
    'created: 2026-05-17',
    'updated: 2026-05-17',
    'tags: [test]',
    'sources: [entry_test]',
    'related: []',
    '---',
    '',
    `# ${title}`,
    '',
    '## 摘要',
    'This compiled wiki page is intentionally long enough to be treated as a useful completed page during a retry.',
    '',
    '## 关键事实',
    '- Fact one with source-backed detail.',
    '- Fact two with source-backed detail.',
    '',
    '## 来源与证据',
    'The source entry was used to compile this page.',
    '',
    '## 未确认与待补充',
    'No open questions in this test fixture.',
    '',
    'Additional detail. '.repeat(60),
  ].join('\n');
}
