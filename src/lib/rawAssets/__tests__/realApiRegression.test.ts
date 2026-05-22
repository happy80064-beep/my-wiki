import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import {
  buildCaptureAnalysisFromMarkdownPrompt,
  buildCaptureAnalysisStructuredOutput,
  buildCaptureMarkdownAnalysisPrompt,
  normalizeCaptureAnalysis,
  normalizeCaptureAnalysisToCaptureDraft,
} from '@/lib/ai/wikiPatch';
import { requestConfiguredProviderText, requestConfiguredProviderTextStream } from '@/lib/llm/runtimeProvider';
import { createRawAssetFromFile, processRawAssetQueue } from '@/lib/rawAssets';
import { createLocalCaptureDraft } from '@/lib/capture';
import { db, resetDatabase } from '@/lib/db';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  loadProviderSettings,
  saveProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { saveMultimodalSettings } from '@/lib/multimodal/settings';
import { inferWikiTargetSpec, normalizeWikiMarkdownCompileResult } from '@/lib/wiki/markdownCompiler';
import { getDraftEntities } from '@/lib/capture/draft';
import type { Entity } from '@/types';

const localEnv = await loadLocalEnvFile();
const runRealApi = getEnv('RUN_REAL_API') === '1';
const realApiBase = getEnv('REAL_API_BASE') || 'http://127.0.0.1:5188';

const pngBase64 =
  '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';

describe.skipIf(!runRealApi)('real API Frog-style raw asset compilation', () => {
  beforeEach(async () => {
    await resetDatabase();
    window.localStorage.clear();
    configureMiniMaxTextFromEnv();
    if (getEnv('GLM_API_KEY')) configureGlmVisionFromEnv();
    saveMultimodalSettings({ enabled: false, captionStandaloneImages: false, includeOcrText: false });
    rewriteRelativeApiFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it(
    'requests MiniMax markdown-first structured capture successfully when settings use Anthropic-compatible mode',
    async () => {
      const apiKey = getEnv('MINIMAX_API_KEY');
      if (!apiKey) throw new Error('MINIMAX_API_KEY is required for RUN_REAL_API=1.');

      const content = [
        '# 导入文件：项目测算20260514.pdf',
        '',
        '来源格式：PDF',
        '',
        '福瑞健康科技园三期项目可行性研究报告。',
        '项目包含医疗与健康中心、文旅与科普园和智算中心三类业态。',
        '预计总收入 40307 万元，其中医疗与健康中心 18059 万元，智算中心 21648 万元。',
      ].join('\n');
      const markdownResult = await requestConfiguredProviderText(
        {
          providerId: 'minimax-cn',
          enabled: true,
          apiMode: 'anthropic-compatible',
          endpoint: 'https://api.minimaxi.com/anthropic',
          apiKey,
          model: getEnv('MINIMAX_MODEL') || 'MiniMax-M2.7',
          contextWindow: 200000,
        },
        {
          prompt: buildCaptureMarkdownAnalysisPrompt(content, '[]'),
          systemPrompt: '你是 MyWiki 原文件阅读 Agent。只输出 Markdown 分析文本，不要输出 JSON。',
          maxTokens: 1600,
        },
      );
      expect(markdownResult.ok).toBe(true);
      if (!markdownResult.ok) throw new Error(markdownResult.error);

      const result = await requestConfiguredProviderText(
        {
          providerId: 'minimax-cn',
          enabled: true,
          apiMode: 'anthropic-compatible',
          endpoint: 'https://api.minimaxi.com/anthropic',
          apiKey,
          model: getEnv('MINIMAX_MODEL') || 'MiniMax-M2.7',
          contextWindow: 200000,
        },
        {
          prompt: buildCaptureAnalysisFromMarkdownPrompt({
            sourceExcerpt: content,
            markdownAnalysis: markdownResult.text,
            entityIndexJson: '[]',
          }),
          systemPrompt: '你是 MyWiki 结构化入库 Agent。只输出符合 schema 的 JSON 对象。',
          maxTokens: 2200,
          responseFormat: 'json_object',
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const analysis = normalizeCaptureAnalysis(result.text);
      expect(analysis.entities.length).toBeGreaterThan(0);
      expect(analysis.entities.some((entity) => ['project', 'topic'].includes(entity.type))).toBe(true);
      expect(analysis.recommendedUpdates.length).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    'runs the raw source button path into default wiki generation for a small source',
    async () => {
      await createRawAssetFromFile(
        new File(
          [[
            '# MyWiki Raw Source Button Regression',
            '',
            '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园、智算中心三个板块。',
            '项目预计总收入 40307 万元，其中医疗与健康中心 18059 万元，智算中心 21648 万元。',
            '当前风险包括个人刑事风险防范、关键假设确认、跨境合规与全球资产配置。',
          ].join('\n')],
          'raw-source-button-regression.md',
          { type: 'text/markdown' },
        ),
      );

      const result = await processRawAssetQueue({
        owner: 'wiki',
        compileWiki: true,
        extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      });
      const rawAsset = await db.rawAssets.orderBy('createdAt').first();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const wikiReadyEntities = entities.filter((entity) => hasUsefulRealApiWikiMarkdown(entity.wikiMarkdown));
      console.info(
        JSON.stringify(
          {
            rawSourceButtonPath: {
              result,
              rawAsset: rawAsset
                ? {
                    filename: rawAsset.filename,
                    status: rawAsset.status,
                    error: rawAsset.error,
                    entryId: rawAsset.entryId,
                  }
                : null,
              entries: entries.map((entry) => ({
                id: entry.id,
                processed: entry.processed,
                derivedEntities: entry.derivedEntities,
                contentLength: entry.content.length,
              })),
              entities: entities.map((entity) => ({
                id: entity.id,
                title: entity.title,
                type: entity.type,
                sourceEntries: entity.sourceEntries,
                wikiCompiledAt: entity.wikiCompiledAt,
                wikiLength: entity.wikiMarkdown?.length ?? 0,
              })),
              wikiReadyCount: wikiReadyEntities.length,
            },
          },
          null,
          2,
        ),
      );

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(rawAsset?.status).toBe('compiled');
      expect(rawAsset?.error).toBeUndefined();
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(wikiReadyEntities.length).toBe(entities.length);
    },
    300_000,
  );

  it(
    'runs already structured raw sources into default wiki generation',
    async () => {
      await createRawAssetFromFile(
        new File(
          [[
            '# MyWiki Already Structured Regression',
            '',
            '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园、智算中心三个板块。',
            '项目风险包括关键假设确认、个人刑事风险防范、跨境合规与全球资产配置。',
          ].join('\n')],
          'already-structured-regression.md',
          { type: 'text/markdown' },
        ),
      );

      const ingestOnly = await processRawAssetQueue({
        owner: 'wiki',
        compileWiki: false,
        extractor: async (content) => ({ draft: createLocalCaptureDraft(content) }),
      });
      expect(ingestOnly).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect((await db.rawAssets.orderBy('createdAt').first())?.status).toBe('compiled');
      expect((await db.entities.toArray()).filter((entity) => hasUsefulRealApiWikiMarkdown(entity.wikiMarkdown)).length).toBe(0);

      const result = await processRawAssetQueue({
        owner: 'wiki',
        compileWiki: true,
      });
      const rawAsset = await db.rawAssets.orderBy('createdAt').first();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const wikiReadyEntities = entities.filter((entity) => hasUsefulRealApiWikiMarkdown(entity.wikiMarkdown));
      console.info(
        JSON.stringify(
          {
            alreadyStructuredRawSourceButtonPath: {
              result,
              rawAsset: rawAsset
                ? {
                    filename: rawAsset.filename,
                    status: rawAsset.status,
                    error: rawAsset.error,
                    entryId: rawAsset.entryId,
                  }
                : null,
              entries: entries.map((entry) => ({
                id: entry.id,
                processed: entry.processed,
                derivedEntities: entry.derivedEntities,
                contentLength: entry.content.length,
              })),
              entities: entities.map((entity) => ({
                id: entity.id,
                title: entity.title,
                type: entity.type,
                sourceEntries: entity.sourceEntries,
                wikiCompiledAt: entity.wikiCompiledAt,
                wikiLength: entity.wikiMarkdown?.length ?? 0,
              })),
              wikiReadyCount: wikiReadyEntities.length,
            },
          },
          null,
          2,
        ),
      );

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(rawAsset?.status).toBe('compiled');
      expect(rawAsset?.error).toBeUndefined();
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(wikiReadyEntities.length).toBe(entities.length);
    },
    300_000,
  );

  it(
    'compiles a small source with configured DeepSeek, GLM and MiniMax models without fallback',
    async () => {
      const providers = buildConfiguredTextProvidersFromEnv().filter((provider) => {
        const only = getEnv('REAL_PROVIDER').trim().toLowerCase();
        return !only || provider.providerId.toLowerCase() === only || provider.model.toLowerCase().includes(only);
      });
      if (providers.length === 0) throw new Error('At least one API key is required for the configured provider smoke test.');

      const summaries = [];
      for (const providerConfig of providers) {
        const startedAt = Date.now();
        await resetDatabase();
        window.localStorage.clear();
        saveMultimodalSettings({ enabled: false, captionStandaloneImages: false, includeOcrText: false });

        const source = [
          '# 导入文件：configured-provider-smoke.md',
          '',
          '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园、智算中心三个板块。',
          '项目预计总收入 40307 万元，其中医疗与健康中心 18059 万元，智算中心 21648 万元。',
          '关键风险包括个人刑事风险防范、关键假设确认、跨境合规与全球资产配置。',
        ].join('\n');
        const extraction = await runConfiguredProviderStructuredSmoke(providerConfig, source);
        const extractedEntities = getDraftEntities(extraction.draft);
        expect(extractedEntities.length, `${providerConfig.providerId} should produce entities`).toBeGreaterThan(0);
        const entity = buildSmokeEntity(extractedEntities[0]);
        const compiled = await compileSmallSmokeWiki(providerConfig, entity, source);

        summaries.push({
          provider: providerConfig.providerId,
          model: providerConfig.model,
          elapsedMs: Date.now() - startedAt,
          entityCount: extractedEntities.length,
          pageTypes: Array.from(new Set(extractedEntities.map((item) => inferWikiTargetSpec(buildSmokeEntity(item)).type))),
          firstWikiTitle: entity.title,
          firstWikiExcerpt: compiled.markdown.slice(0, 260),
        });
        console.info(JSON.stringify({ configuredProviderSmokeStep: summaries.at(-1) }, null, 2));

        expect(hasUsefulRealApiWikiMarkdown(compiled.markdown), `${providerConfig.providerId} useful wiki`).toBe(true);
      }

      console.info(JSON.stringify({ configuredProviderSmoke: summaries }, null, 2));
    },
    900_000,
  );

  it(
    'runs the raw asset queue with the selected real configured model on a small markdown source',
    async () => {
      const providerConfig = buildConfiguredTextProvidersFromEnv().find((provider) => {
        const only = getEnv('REAL_PROVIDER').trim().toLowerCase();
        return !only || provider.providerId.toLowerCase() === only || provider.model.toLowerCase().includes(only);
      });
      if (!providerConfig) throw new Error('REAL_PROVIDER did not match a configured API key.');

      await resetDatabase();
      window.localStorage.clear();
      saveMultimodalSettings({ enabled: false, captionStandaloneImages: false, includeOcrText: false });
      let settings = createDefaultProviderSettings();
      settings = updateProviderConfig(settings, providerConfig.providerId, providerConfig);
      settings = activateProvider(settings, providerConfig.providerId);
      settings = assignModelRole(settings, 'wiki-compile', providerConfig.providerId);
      saveProviderSettings(settings);

      await createRawAssetFromFile(
        new File(
          [
            [
              '# 福瑞健康科技园三期项目小样本',
              '',
              '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园、智算中心三个板块。',
              '项目预计总收入 40307 万元，其中医疗与健康中心 18059 万元，智算中心 21648 万元。',
              '关键风险包括个人刑事风险防范、关键假设确认、跨境合规与全球资产配置。',
            ].join('\n'),
          ],
          `real-queue-${providerConfig.providerId}.md`,
          { type: 'text/markdown' },
        ),
      );

      const startedAt = Date.now();
      const result = await processRawAssetQueue({
        owner: 'wiki',
        compileWiki: true,
        extractor: async (content) => runConfiguredProviderStructuredSmoke(providerConfig, content),
        wikiCompiler: async (entityId, _asset) => {
          const entity = await db.entities.get(entityId);
          if (!entity) throw new Error(`Missing entity ${entityId}`);
          const compiled = await compileSmallSmokeWiki(providerConfig, entity, [
            '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园、智算中心三个板块。',
            '项目预计总收入 40307 万元，其中医疗与健康中心 18059 万元，智算中心 21648 万元。',
            '关键风险包括个人刑事风险防范、关键假设确认、跨境合规与全球资产配置。',
          ].join('\n'));
          await db.entities.update(entityId, {
            wikiMarkdown: compiled.markdown,
            summary: compiled.summary,
            tags: compiled.tags,
            wikiCompiledAt: Date.now(),
            updatedAt: Date.now(),
          });
        },
      });
      const rawAsset = await db.rawAssets.orderBy('createdAt').first();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const wikiReadyEntities = entities.filter((entity) => hasUsefulRealApiWikiMarkdown(entity.wikiMarkdown));
      const summary = {
        provider: providerConfig.providerId,
        model: providerConfig.model,
        elapsedMs: Date.now() - startedAt,
        result,
        rawStatus: rawAsset?.status,
        rawError: rawAsset?.error,
        entryCount: entries.length,
        entityCount: entities.length,
        wikiReadyCount: wikiReadyEntities.length,
        firstWikiTitle: wikiReadyEntities[0]?.title,
        firstWikiExcerpt: wikiReadyEntities[0]?.wikiMarkdown?.slice(0, 260),
      };
      console.info(JSON.stringify({ realQueueSmoke: summary }, null, 2));

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(rawAsset?.status).toBe('compiled');
      expect(rawAsset?.error).toBeUndefined();
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThan(0);
      expect(wikiReadyEntities.length).toBeGreaterThan(0);
    },
    420_000,
  );

  it(
    'compiles the reported managed-care markdown with DeepSeek through structured ingest without fallback',
    async () => {
      const sourcePath = resolveReportedManagedCareMarkdownPath();
      const providerConfig = buildConfiguredTextProvidersFromEnv().find((provider) => provider.providerId === 'deepseek');
      if (!providerConfig) throw new Error('DEEPSEEK_API_KEY is required for the reported managed-care regression test.');

      const content = await readFile(sourcePath, 'utf8');
      expect(content.length).toBeGreaterThan(5000);

      const extraction = await runConfiguredProviderStructuredSmoke(providerConfig, content);
      const extractedEntities = getDraftEntities(extraction.draft);
      console.info(
        JSON.stringify(
          {
            reportedManagedCareDeepSeek: {
              sourcePath,
              provider: providerConfig.providerId,
              model: providerConfig.model,
              sourceLength: content.length,
              entityCount: extractedEntities.length,
              titles: extractedEntities.slice(0, 8).map((entity) => entity.title),
            },
          },
          null,
          2,
        ),
      );

      expect(extraction.mode).toBe('two-step');
      expect(extractedEntities.length).toBeGreaterThan(0);
      expect(extractedEntities.some((entity) => /管理式医疗|医疗|肝病|福瑞/.test(`${entity.title} ${entity.summary}`))).toBe(true);
    },
    420_000,
  );

  it(
    'compiles the real 149-page project PDF through raw ingest and wiki generation without fallback',
    async () => {
      const pdfPath = resolveReal149PdfPath();
      const bytes = await readFile(pdfPath);
      await createRawAssetFromFile(
        new File([bytes], '22014-【修改稿V6】福瑞健康科技园三期项目可研报告20260310.pdf', { type: 'application/pdf' }),
      );

      const startedAt = Date.now();
      const extractionModes: string[] = [];
      const statusLog: string[] = [];
      let capturedFullContentLength = 0;
      let capturedPageMarkers = false;
      const result = await processRawAssetQueue({
        owner: 'frog',
        compileWiki: true,
        onStatus: (snapshot) => {
          statusLog.push(`${snapshot.percent}% ${snapshot.label} ${snapshot.detail ?? ''}`.trim());
        },
        extractor: async (content) => {
          capturedFullContentLength = content.length;
          capturedPageMarkers = /--\s*1\s+of\s+149\s*--/i.test(content) && /--\s*149\s+of\s+149\s*--/i.test(content);
          expect(content.length).toBeGreaterThan(50_000);
          expect(capturedPageMarkers).toBe(true);
          const extraction = await extractCaptureDraft(content);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected Wiki compile fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });

      const elapsedMs = Date.now() - startedAt;
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));
      const wikiReadyEntities = entities.filter((entity) => hasUsefulRealApiWikiMarkdown(entity.wikiMarkdown));
      const rawAssetDebug = rawAssets.map((asset) => ({
        filename: asset.filename,
        status: asset.status,
        error: asset.error,
        extractedTextLength: asset.extractedText?.length ?? 0,
      }));
      console.info(
        JSON.stringify(
          {
            real149Pdf: {
              elapsedMs,
              capturedFullContentLength,
              capturedPageMarkers,
              extractionModes,
              rawAssetDebug,
              entityCount: entities.length,
              wikiReadyCount: wikiReadyEntities.length,
              pageTypes: [...pageTypes],
              lastStatuses: statusLog.slice(-8),
            },
          },
          null,
          2,
        ),
      );

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(extractionModes).toEqual(['two-step']);
      expect(rawAssetDebug).toEqual([
        expect.objectContaining({
          filename: '22014-【修改稿V6】福瑞健康科技园三期项目可研报告20260310.pdf',
          status: 'compiled',
          error: undefined,
        }),
      ]);
      expect(rawAssetDebug[0].extractedTextLength).toBeGreaterThan(50_000);
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThanOrEqual(6);
      expect(wikiReadyEntities.length).toBeGreaterThanOrEqual(6);
      expect(pageTypes.has('source')).toBe(true);
      expect([...pageTypes].some((type) => ['project', 'concept', 'entity'].includes(type))).toBe(true);
    },
    2_700_000,
  );

  it(
    'compiles a real PDF asset without JSON fallback or failed raw assets',
    async () => {
      const pdfPath = resolveRealPdfPath();
      const bytes = await readFile(pdfPath);
      await createRawAssetFromFile(new File([bytes], 'real-pdf-regression.pdf', { type: 'application/pdf' }));

      const extractionModes: string[] = [];
      const result = await processRawAssetQueue({
        owner: 'frog',
        extractor: async (content) => {
          expect(content.length).toBeGreaterThan(1000);
          const extraction = await extractCaptureDraft(content);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected Wiki compile fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(extractionModes).toEqual(['two-step']);
      expect(rawAssets.map((asset) => ({ filename: asset.filename, status: asset.status, error: asset.error }))).toEqual([
        expect.objectContaining({ filename: 'real-pdf-regression.pdf', status: 'compiled', error: undefined }),
      ]);
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThanOrEqual(2);
      expect(pageTypes.has('source')).toBe(true);
      expect([...pageTypes].some((type) => ['project', 'concept', 'entity'].includes(type))).toBe(true);
    },
    600_000,
  );

  it(
    'compiles a long PDF asset through the markdown digest pipeline without JSON fallback',
    async () => {
      await createRawAssetFromFile(buildLongPdfFile());

      let capturedFullContentLength = 0;
      const extractionModes: string[] = [];
      const result = await processRawAssetQueue({
        owner: 'frog',
        extractor: async (content) => {
          capturedFullContentLength = content.length;
          expect(content).toContain('Long PDF Regression Knowledge Platform 2026');
          expect(content.length).toBeGreaterThan(50_000);
          const extraction = await extractCaptureDraft(content);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected Wiki compile fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(capturedFullContentLength).toBeGreaterThan(50_000);
      expect(extractionModes).toEqual(['two-step']);
      expect(rawAssets.map((asset) => ({ filename: asset.filename, status: asset.status, error: asset.error }))).toEqual([
        expect.objectContaining({ filename: 'long-pdf-regression.pdf', status: 'compiled', error: undefined }),
      ]);
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThanOrEqual(2);
      expect(pageTypes.has('source')).toBe(true);
      expect([...pageTypes].some((type) => ['project', 'concept', 'entity'].includes(type))).toBe(true);
    },
    900_000,
  );

  it(
    'compiles the real project spreadsheet without JSON fallback or failed raw assets',
    async () => {
      const spreadsheetPath = resolveRealSpreadsheetPath();
      const bytes = await readFile(spreadsheetPath);
      await createRawAssetFromFile(
        new File([bytes], 'real-spreadsheet-regression.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );

      const extractionModes: string[] = [];
      const result = await processRawAssetQueue({
        owner: 'frog',
        extractor: async (content) => {
          expect(content.length).toBeGreaterThan(500);
          const extraction = await extractCaptureDraft(content);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected Wiki compile fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));

      expect(result).toMatchObject({ total: 1, processed: 1, failed: 0 });
      expect(extractionModes).toEqual(['two-step']);
      expect(rawAssets.map((asset) => ({ filename: asset.filename, status: asset.status, error: asset.error }))).toEqual([
        expect.objectContaining({ filename: 'real-spreadsheet-regression.xlsx', status: 'compiled', error: undefined }),
      ]);
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThanOrEqual(2);
      expect(pageTypes.has('source')).toBe(true);
      expect([...pageTypes].some((type) => ['project', 'concept', 'entity'].includes(type))).toBe(true);
    },
    600_000,
  );

  it(
    'compiles spreadsheet and image assets without JSON fallback or failed raw assets',
    async () => {
      await createRawAssetFromFile(buildSpreadsheetFile());
      await createRawAssetFromFile(buildImageFile());

      const extractionModes: string[] = [];
      const result = await processRawAssetQueue({
        owner: 'frog',
        extractor: async (content) => {
          const extraction = await extractCaptureDraft(content);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected Wiki compile fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));

      expect(result).toMatchObject({ total: 2, processed: 2, failed: 0 });
      expect(extractionModes).toEqual(['two-step', 'two-step']);
      expect(rawAssets.map((asset) => ({ filename: asset.filename, status: asset.status, error: asset.error }))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filename: '项目测算20260514.xlsx', status: 'compiled', error: undefined }),
          expect.objectContaining({ filename: 'mywiki-frog-vision-test.png', status: 'compiled', error: undefined }),
        ]),
      );
      expect(entries.every((entry) => entry.processed && entry.derivedEntities.length > 0)).toBe(true);
      expect(entities.length).toBeGreaterThanOrEqual(3);
      expect(pageTypes.has('source')).toBe(true);
      expect([...pageTypes].some((type) => ['project', 'concept', 'entity'].includes(type))).toBe(true);
      expect(entries.some((entry) => /视觉描述|MyWiki Frog Vision Test|2026-05-14/.test(entry.content))).toBe(true);
    },
    600_000,
  );
});

function rewriteRelativeApiFetch() {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/')) {
      return realFetch(`${realApiBase}${url}`, init);
    }
    return realFetch(input, init);
  });
}

async function loadLocalEnvFile() {
  const candidates = ['.env.local', '.env'];
  const loaded: Record<string, string> = {};
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = await readFile(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
      if (!(key in process.env)) process.env[key] = value;
      loaded[key] = process.env[key] ?? value;
    }
  }
  return loaded;
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getEnv(key: string) {
  return process.env[key] ?? localEnv[key] ?? '';
}

function configureGlmVisionFromEnv() {
  const glmApiKey = getEnv('GLM_API_KEY');
  if (!glmApiKey) throw new Error('GLM_API_KEY is required for RUN_REAL_API=1.');
  let settings = loadProviderSettings();
  settings = updateProviderConfig(settings, 'zhipu', {
    apiKey: glmApiKey,
    endpoint: getEnv('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4',
    model: getEnv('GLM_MODEL') || 'glm-4.6v',
    contextWindow: 8000,
  });
  settings = assignModelRole(settings, 'vision', 'zhipu');
  saveProviderSettings(settings);
}

function configureMiniMaxTextFromEnv() {
  const apiKey = getEnv('MINIMAX_API_KEY');
  if (!apiKey) throw new Error('MINIMAX_API_KEY is required for RUN_REAL_API=1.');
  let settings = createDefaultProviderSettings();
  settings = updateProviderConfig(settings, 'minimax-cn', {
    apiKey,
    enabled: true,
    apiMode: 'anthropic-compatible',
    endpoint: getEnv('MINIMAX_ANTHROPIC_BASE_URL') || 'https://api.minimaxi.com/anthropic',
    model: getEnv('MINIMAX_MODEL') || 'MiniMax-M2.7',
    contextWindow: 200000,
  });
  settings = activateProvider(settings, 'minimax-cn');
  settings = assignModelRole(settings, 'wiki-compile', 'minimax-cn');
  saveProviderSettings(settings);
}

function buildConfiguredTextProvidersFromEnv() {
  const providers = [];
  if (getEnv('MINIMAX_API_KEY')) {
    providers.push({
      providerId: 'minimax-cn' as const,
      enabled: true,
      apiMode: 'anthropic-compatible' as const,
      endpoint: getEnv('MINIMAX_ANTHROPIC_BASE_URL') || 'https://api.minimaxi.com/anthropic',
      apiKey: getEnv('MINIMAX_API_KEY'),
      model: getEnv('MINIMAX_MODEL') || 'MiniMax-M2.7',
      contextWindow: 200000,
      reasoningMode: 'auto' as const,
    });
  }
  if (getEnv('DEEPSEEK_API_KEY')) {
    providers.push({
      providerId: 'deepseek' as const,
      enabled: true,
      apiMode: 'openai-compatible' as const,
      endpoint: getEnv('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com',
      apiKey: getEnv('DEEPSEEK_API_KEY'),
      model: getEnv('DEEPSEEK_MODEL') || 'deepseek-v4-pro',
      contextWindow: 128000,
      reasoningMode: 'auto' as const,
    });
  }
  if (getEnv('GLM_API_KEY')) {
    providers.push({
      providerId: 'zhipu' as const,
      enabled: true,
      apiMode: 'openai-compatible' as const,
      endpoint: getEnv('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: getEnv('GLM_API_KEY'),
      model: getEnv('GLM_TEXT_MODEL') || 'glm-4.6',
      contextWindow: 128000,
      reasoningMode: 'auto' as const,
    });
  }
  return providers;
}

async function runConfiguredProviderStructuredSmoke(
  providerConfig: ReturnType<typeof buildConfiguredTextProvidersFromEnv>[number],
  content: string,
) {
  const markdownResult = await requestConfiguredProviderText(providerConfig, {
    prompt: buildCaptureMarkdownAnalysisPrompt(content, '[]'),
    systemPrompt: '你是 MyWiki 原文件阅读 Agent。只输出 Markdown 分析文本，不要输出 JSON。',
    maxTokens: 1600,
    reasoningMode: 'disabled',
  }, { signal: timeoutSignal(providerStageTimeoutMs(providerConfig.providerId, 'markdown'), `${providerConfig.providerId} markdown analysis`) });
  if (!markdownResult.ok) throw new Error(markdownResult.error);
  expect(markdownResult.ok, `${providerConfig.providerId} markdown analysis`).toBe(true);

  const structuredResult = await requestConfiguredStructuredCapture(providerConfig, {
    prompt: buildCaptureAnalysisFromMarkdownPrompt({
      sourceExcerpt: content,
      markdownAnalysis: markdownResult.text,
      entityIndexJson: '[]',
    }),
    signal: timeoutSignal(providerStageTimeoutMs(providerConfig.providerId, 'structured'), `${providerConfig.providerId} structured analysis`),
  });
  if (!structuredResult.ok) throw new Error(structuredResult.error);
  expect(structuredResult.ok, `${providerConfig.providerId} structured analysis`).toBe(true);

  const analysis = normalizeCaptureAnalysis(structuredResult.text);
  return {
    draft: normalizeCaptureAnalysisToCaptureDraft(analysis, content),
    provider: providerConfig.providerId,
    model: providerConfig.model,
    mode: 'two-step' as const,
  };
}

async function compileSmallSmokeWiki(
  providerConfig: ReturnType<typeof buildConfiguredTextProvidersFromEnv>[number],
  entity: Entity,
  source: string,
) {
  const today = new Date().toISOString().slice(0, 10);
  const target = inferWikiTargetSpec(entity);
  const result = await requestConfiguredProviderText(providerConfig, {
    prompt: [
      '你是 MyWiki v2 的 Wiki 编译 Agent。把原文件编译成一篇人类可读、Query Agent 可直接读取的中文 Wiki Markdown 页面。',
      '',
      '## 当前目标实体',
      JSON.stringify({ id: entity.id, type: entity.type, title: entity.title, summary: entity.summary, tags: entity.tags }, null, 2),
      '',
      '## 原始来源材料',
      source,
      '',
      '## 输出要求',
      '- 整个回复只能包含一个 FILE block，不能有任何 block 外文本。',
      '- 第一字符必须是 `-`，也就是 `---FILE:` 的开头。',
      `- FILE block 路径必须是：${target.path}`,
      '- 严禁输出 `<think>`、思考过程、分析过程、任务复述或任何 FILE block 外前言。',
      '- FILE 内容第一行必须是 `---`，并包含合法 YAML frontmatter。',
      '- frontmatter 必须包含：type、title、created、updated、tags、sources、related。',
      '- 正文必须是中文；重要数字必须保留完整单位和证据语境；没有指标时写“当前来源未提供明确指标”。',
      '',
      '建议正文结构：',
      '# 标题',
      '## 摘要',
      '## 项目概述 / 主题概述',
      '## 关键事实',
      '## 结构与板块',
      '## 关键指标',
      '## 来源与证据',
      '## 未确认与待补充',
      '',
      '## 输出格式',
      '```',
      `---FILE: ${target.path}---`,
      '---',
      `type: ${target.type}`,
      `title: "${entity.title.replace(/"/g, '\\"')}"`,
      `created: ${today}`,
      `updated: ${today}`,
      'tags: [smoke-test]',
      'sources: [configured-provider-smoke.md]',
      'related: []',
      '---',
      '',
      `# ${entity.title}`,
      '',
      '## 摘要',
      '正文内容。',
      '',
      '---END FILE---',
      '```',
    ].join('\n'),
    systemPrompt: '你是 MyWiki Wiki 编译 Agent。只输出一个完整 FILE block，不要解释。',
    maxTokens: 4200,
    reasoningMode: 'disabled',
  }, { signal: timeoutSignal(providerStageTimeoutMs(providerConfig.providerId, 'wiki'), `${providerConfig.providerId} wiki compile`) });
  expect(result.ok, `${providerConfig.providerId} wiki compile`).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const normalized = normalizeWikiMarkdownCompileResult(
    result.text,
    {
      title: entity.title,
      type: entity.type,
      summary: entity.summary,
      tags: entity.tags,
    },
    today,
    { requireFileBlock: true },
  );
  expect(hasUsefulRealApiWikiMarkdown(normalized.markdown), `${providerConfig.providerId} useful wiki`).toBe(true);
  return normalized;
}

function resolveReal149PdfPath() {
  const candidates = [
    getEnv('REAL_149_PDF_PATH'),
    'D:\\MyWiki-MVP\\ldj-wiki-002\\raw\\sources\\22014-【修改稿V6】福瑞健康科技园三期项目可研报告20260310.pdf',
    getEnv('REAL_PDF_PATH'),
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error('REAL_149_PDF_PATH is required for the real 149-page PDF regression test.');
  }
  return found;
}

function requestConfiguredStructuredCapture(
  providerConfig: ReturnType<typeof buildConfiguredTextProvidersFromEnv>[number],
  input: { prompt: string; signal: AbortSignal },
) {
  const common = {
    prompt: input.prompt,
    systemPrompt: '你是 MyWiki 结构化入库 Agent。只输出符合 schema 的 JSON 对象。',
    maxTokens: 4200,
    reasoningMode: 'disabled' as const,
  };
  if (providerConfig.providerId === 'deepseek' || /deepseek/i.test(providerConfig.endpoint)) {
    return requestConfiguredProviderTextStream(
      providerConfig,
      { ...common, responseFormat: 'json_object' },
      { signal: input.signal, onToken: () => undefined },
    );
  }
  return requestConfiguredProviderText(
    providerConfig,
    { ...common, structuredOutput: buildCaptureAnalysisStructuredOutput() },
    { signal: input.signal },
  );
}

function resolveReportedManagedCareMarkdownPath() {
  const candidates = [
    getEnv('REAL_MANAGED_CARE_MD_PATH'),
    'D:\\MyWiki-MVP\\工作-wiki-2026\\raw\\sources\\管理式医疗.md',
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error('REAL_MANAGED_CARE_MD_PATH is required for the reported managed-care markdown regression test.');
  }
  return found;
}

function hasUsefulRealApiWikiMarkdown(markdown?: string) {
  const text = markdown?.trim() ?? '';
  if (text.length < 700) return false;
  if (!text.startsWith('---') || !/^#\s+/m.test(text)) return false;
  const sectionCount = text.match(/^##\s+/gm)?.length ?? 0;
  return sectionCount >= 3;
}

function timeoutSignal(ms: number, label: string) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException(`${label} timed out after ${ms}ms`, 'AbortError')), ms);
  return controller.signal;
}

function providerStageTimeoutMs(providerId: string, stage: 'markdown' | 'structured' | 'wiki') {
  if (providerId === 'zhipu') {
    return stage === 'wiki' ? 240_000 : 180_000;
  }
  if (providerId === 'deepseek') {
    return stage === 'wiki' ? 210_000 : 150_000;
  }
  return stage === 'wiki' ? 180_000 : 120_000;
}

function buildSmokeEntity(entity: ReturnType<typeof getDraftEntities>[number]): Entity {
  const now = Date.now();
  const base = {
    id: `smoke-${entity.clientId}`,
    clientId: entity.clientId,
    type: entity.type,
    title: entity.title,
    summary: entity.summary,
    tags: entity.tags,
    scenes: entity.scenes,
    categories: entity.categories?.map((category) => ({ ...category, updatedAt: now })),
    indicators: entity.indicators?.map((indicator, index) => ({
      ...indicator,
      id: `indicator-${index}`,
      extractedAt: now,
      updatedAt: now,
    })),
    sourceEntries: ['configured-provider-smoke.md'],
    createdAt: now,
    updatedAt: now,
  };
  if (entity.type === 'project') {
    return { ...base, type: 'project', properties: { status: 'active' } } as Entity;
  }
  if (entity.type === 'person') {
    return { ...base, type: 'person', properties: {} } as Entity;
  }
  if (entity.type === 'event') {
    return { ...base, type: 'event', properties: { occurredAt: now } } as Entity;
  }
  return { ...base, type: 'topic', properties: { isPersonal: false, autoCollectedSnippets: [] } } as Entity;
}

function resolveRealPdfPath() {
  const candidates = [
    getEnv('REAL_PDF_PATH'),
    'C:\\Users\\xxjsb\\Downloads\\1935929208546869248.pdf',
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error('REAL_PDF_PATH is required for the real PDF regression test.');
  }
  return found;
}

function resolveRealSpreadsheetPath() {
  const candidates = [
    getEnv('REAL_XLSX_PATH'),
    'C:\\Users\\xxjsb\\Desktop\\三期汇报\\bp\\项目测算20260420（更新版）V1.xlsx',
    'C:\\Users\\xxjsb\\Desktop\\三期汇报\\bp\\项目测算20260420.xlsx',
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error('REAL_XLSX_PATH is required for the real spreadsheet regression test.');
  }
  return found;
}

function buildSpreadsheetFile() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['项目', '医疗与健康中心', '文旅与科普园', '智算中心', '项目公共与财务', '项目整体汇总'],
    ['一、营业总收入（Total Revenue）', 18059, 600, 21648, 0, 40307],
    ['1. 医疗与健康服务（FMT/细胞等）', 14671, '', '', '', 14671],
    ['2. 相关商品销售收入', 1440, '', '', '', 1440],
    ['3. 酒店餐饮/物业/租金/分成', 1948, 600, '', '', 2548],
    ['4. 租赁服务', '', '', 21648, '', 21648],
    ['说明', '福瑞健康科技园三期项目包含医疗与健康中心、文旅与科普园和智算中心三类业态。'],
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, '利润表（预计）');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buffer], '项目测算20260514.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function buildImageFile() {
  const bytes = new Uint8Array(Buffer.from(pngBase64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  return new File([bytes], 'mywiki-frog-vision-test.png', { type: 'image/png' });
}

function buildLongPdfFile() {
  const lines: string[] = [];
  for (let index = 0; index < 480; index += 1) {
    lines.push(
      `Long PDF Regression Knowledge Platform 2026 line ${index}: project objective, market segment, revenue model, risk control, implementation milestone, source evidence.`,
    );
  }
  return new File([buildSimplePdfBytes(lines)], 'long-pdf-regression.pdf', { type: 'application/pdf' });
}

function buildSimplePdfBytes(lines: string[]) {
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 34) {
    pages.push(lines.slice(index, index + 34));
  }

  const objects: string[] = [];
  const addObject = (value: string) => {
    objects.push(value);
    return objects.length;
  };

  const catalogId = addObject('');
  const pagesId = addObject('');
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];

  for (const pageLines of pages) {
    const streamLines = ['BT', '/F1 9 Tf', '40 780 Td', '12 TL'];
    for (const line of pageLines) {
      streamLines.push(`(${escapePdfText(line)}) Tj T*`);
    }
    streamLines.push('ET');
    const stream = streamLines.join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
