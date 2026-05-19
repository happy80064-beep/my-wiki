import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { extractCaptureDraft } from '@/lib/ai/captureClient';
import { db, resetDatabase } from '@/lib/db';
import {
  activateProvider,
  assignModelRole,
  createDefaultProviderSettings,
  saveProviderSettings,
  updateProviderConfig,
} from '@/lib/llm/providerSettings';
import { saveMultimodalSettings } from '@/lib/multimodal/settings';
import { createRawAssetFromFile, processRawAssetQueue } from '@/lib/rawAssets';
import { inferWikiTargetSpec } from '@/lib/wiki/markdownCompiler';

vi.mock('@/lib/wiki/browserRecompile', () => ({
  recompileBrowserEntityWikiPage: async () => undefined,
}));

const runReal149Pdf = process.env.RUN_REAL_149_PDF === '1';
const realApiBase = process.env.REAL_API_BASE || 'http://127.0.0.1:5273';
const real149PdfFilename = '22014-【修改稿V6】福瑞健康科技园三期项目可研报告20260310.pdf';

describe.skipIf(!runReal149Pdf)('real 149-page PDF ingestion regression', () => {
  beforeEach(async () => {
    appendReal149Log('beforeEach:start');
    await resetDatabase();
    window.localStorage.clear();
    configureMiniMaxTextFromEnv();
    saveMultimodalSettings({ enabled: false, captionStandaloneImages: false, includeOcrText: false });
    rewriteRelativeApiFetch();
    appendReal149Log('beforeEach:done');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it(
    'compiles raw PDF extraction, structured ingest and wiki pages without fallback',
    async () => {
      const pdfPath = resolveReal149PdfPath();
      appendReal149Log(`read:start:${pdfPath}`);
      const bytes = await readFile(pdfPath);
      appendReal149Log(`read:done:${bytes.length}`);
      await createRawAssetFromFile(new File([bytes], real149PdfFilename, { type: 'application/pdf' }));
      appendReal149Log('raw:create:done');

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
          appendReal149Log(`status:${snapshot.percent}:${snapshot.label}:${snapshot.detail ?? ''}`);
        },
        extractor: async (content) => {
          appendReal149Log(`extractor:start:${content.length}`);
          capturedFullContentLength = content.length;
          capturedPageMarkers = /--\s*1\s+of\s+149\s*--/i.test(content) && /--\s*149\s+of\s+149\s*--/i.test(content);
          expect(content.length).toBeGreaterThan(50_000);
          expect(capturedPageMarkers).toBe(true);

          const extraction = await extractCaptureDraft(content);
          appendReal149Log(`extractor:llm:done:${extraction.mode ?? 'unknown'}:${extraction.provider}:${extraction.model}`);
          if (extraction.fallbackFrom) {
            throw new Error(`Unexpected structured ingest fallback: ${extraction.fallbackFrom}`);
          }
          extractionModes.push(extraction.mode ?? 'unknown');
          return { draft: extraction.draft };
        },
      });
      appendReal149Log(`queue:done:${Date.now() - startedAt}`);

      const elapsedMs = Date.now() - startedAt;
      const rawAssets = await db.rawAssets.orderBy('createdAt').toArray();
      const entries = await db.entries.toArray();
      const entities = await db.entities.toArray();
      const pageTypes = new Set(entities.map((entity) => inferWikiTargetSpec(entity).type));
      const wikiReadyEntities = entities.filter((entity) => hasUsefulWikiMarkdown(entity.wikiMarkdown));
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
              lastStatuses: statusLog.slice(-10),
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
          filename: real149PdfFilename,
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

function configureMiniMaxTextFromEnv() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY is required for RUN_REAL_149_PDF=1.');

  let settings = createDefaultProviderSettings();
  settings = updateProviderConfig(settings, 'minimax-cn', {
    apiKey,
    enabled: true,
    apiMode: 'anthropic-compatible',
    endpoint: process.env.MINIMAX_ANTHROPIC_BASE_URL || 'https://api.minimaxi.com/anthropic',
    model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
    contextWindow: 200000,
  });
  settings = activateProvider(settings, 'minimax-cn');
  settings = assignModelRole(settings, 'wiki-compile', 'minimax-cn');
  saveProviderSettings(settings);
}

function resolveReal149PdfPath() {
  const candidates = [
    process.env.REAL_149_PDF_PATH,
    'D:\\MyWiki-MVP\\ldj-wiki-002\\raw\\sources\\22014-【修改稿V6】福瑞健康科技园三期项目可研报告20260310.pdf',
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error('REAL_149_PDF_PATH is required for the real 149-page PDF regression test.');
  }
  return found;
}

function hasUsefulWikiMarkdown(markdown?: string) {
  const text = markdown?.trim() ?? '';
  if (text.length < 700) return false;
  if (!text.startsWith('---') || !/^#\s+/m.test(text)) return false;
  const sectionCount = text.match(/^##\s+/gm)?.length ?? 0;
  return sectionCount >= 3;
}

function appendReal149Log(message: string) {
  const target = 'D:\\MyWiki\\tmp-real-api-logs\\real-149-stage.log';
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${new Date().toISOString()} ${message}\n`, 'utf8');
}
