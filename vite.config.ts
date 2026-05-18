import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile as readNodeFile, rm, stat, writeFile as writeNodeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CaptureDraft } from './src/lib/capture';
import { buildQueryComposePrompt, type QueryComposePayload } from './src/lib/ai/queryComposer';
import {
  buildQueryPlanPrompt,
  normalizeQueryPlan,
  type QueryPlanRequest,
} from './src/lib/ai/queryPlanner';
import {
  buildWikiMarkdownBatchCompilePrompt,
  buildWikiMarkdownCompilePrompt,
  normalizeWikiMarkdownBatchCompileResult,
  normalizeWikiMarkdownCompileResult,
  type WikiMarkdownBatchCompileInput,
  type WikiMarkdownCompileInput,
} from './src/lib/wiki/markdownCompiler';
import {
  buildQueryAnswerPrompt,
  normalizeQueryAnswerResponse,
  type QueryAnswerRequest,
} from './src/lib/query/queryAnswer';
import {
  buildSemanticWikiLintPrompt,
  normalizeSemanticWikiLintResponse,
  type SemanticWikiLintPayload,
} from './src/lib/wiki/lint';
import { validateLlmProviderConfig, type LlmProviderConfig } from './src/lib/llm/providers';
import {
  anthropicCompatibleRequiresBearerAuth,
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  buildOpenAiChatCompletionsUrl,
  buildProviderTextRequest,
} from './src/lib/llm/textProvider';
import {
  buildCaptureAnalysisFromMarkdownPrompt,
  buildCaptureAnalysisPrompt,
  buildCaptureAnalysisJsonRepairPrompt,
  buildCaptureAnalysisStructuredOutput,
  buildCaptureDigestPrompt,
  buildCaptureMarkdownAnalysisPrompt,
  buildCaptureSourceIdentityBlock,
  buildCaptureSourceForStructuredProcessing,
  buildStructuredCaptureExcerpt,
  buildWikiPatchPrompt,
  buildWikiPatchJsonRepairPrompt,
  normalizeCaptureAnalysisToCaptureDraft,
  normalizeCaptureAnalysis,
  normalizeWikiPatchesToCaptureDraft,
  normalizeWikiPatchResponse,
  resolveCaptureDigestThreshold,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
  type CaptureWorkspaceContext,
} from './src/lib/ai/wikiPatch';

const STRUCTURED_JSON_MAX_TOKENS = 8000;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const minimaxApiKey = env.MINIMAX_API_KEY;
  const minimaxModel = normalizeMiniMaxModel(env.MINIMAX_MODEL);
  const minimaxBaseUrl = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/$/, '');
  const deepseekApiKeys = [env.DEEPSEEK_API_KEY, env.DEEPSEEK_API_KEY_FALLBACK].filter(Boolean);
  const deepseekModel = env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const deepseekBaseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const packageMetadata = readPackageMetadata();
  const appVersion = env.MYWIKI_APP_VERSION || env.VITE_MYWIKI_APP_VERSION || packageMetadata.version || '0.0.0';
  const updateRepo =
    env.MYWIKI_UPDATE_REPO ||
    env.VITE_MYWIKI_UPDATE_REPO ||
    normalizeGithubRepo(packageMetadata.repository) ||
    'happy80064-beep/my-wiki';
  const releaseUrl =
    env.MYWIKI_RELEASE_URL ||
    env.VITE_MYWIKI_RELEASE_URL ||
    (updateRepo ? `https://github.com/${updateRepo}/releases/latest` : '');

  return {
    publicDir: false,
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __MYWIKI_UPDATE_REPO__: JSON.stringify(updateRepo),
      __MYWIKI_RELEASE_URL__: JSON.stringify(releaseUrl),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'mywiki-minimax-api',
        configureServer(server) {
          server.middlewares.use('/restore/mywiki-restore-payload.json', async (req, res, next) => {
            if (req.method !== 'GET') {
              next();
              return;
            }

            const restorePayloadPath = path.resolve(process.cwd(), 'public/restore/mywiki-restore-payload.json');
            try {
              const fileStat = await stat(restorePayloadPath);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.setHeader('Content-Length', String(fileStat.size));
              createReadStream(restorePayloadPath).pipe(res);
            } catch {
              sendJson(res, 404, { error: 'Restore payload not found.' });
            }
          });

          server.middlewares.use('/api/workspace/default-root', async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            sendJson(res, 200, normalizeDevFsPath(env.MYWIKI_WORKSPACE_ROOT || path.resolve(process.cwd(), 'LDJ-Wiki')));
          });

          server.middlewares.use('/api/workspace/ensure-dir', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { path?: string };
              await mkdir(requireDevFsPath(body.path, 'path'), { recursive: true });
              sendJson(res, 200, undefined);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to create directory.' });
            }
          });

          server.middlewares.use('/api/workspace/exists', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { path?: string };
              const target = requireDevFsPath(body.path, 'path');
              await stat(target);
              sendJson(res, 200, true);
            } catch {
              sendJson(res, 200, false);
            }
          });

          server.middlewares.use('/api/workspace/write-text-file', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { path?: string; content?: string };
              const target = requireDevFsPath(body.path, 'path');
              const content = typeof body.content === 'string' ? body.content : '';
              await mkdir(path.dirname(target), { recursive: true });
              await writeNodeFile(target, content, 'utf8');
              sendJson(res, 200, undefined);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to write file.' });
            }
          });

          server.middlewares.use('/api/workspace/write-binary-file', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { path?: string; dataBase64?: string };
              const target = requireDevFsPath(body.path, 'path');
              const raw = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
              const data = raw.includes(',') ? raw.split(',').at(-1) ?? '' : raw;
              await mkdir(path.dirname(target), { recursive: true });
              await writeNodeFile(target, Buffer.from(data, 'base64'));
              sendJson(res, 200, undefined);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to write binary file.' });
            }
          });

          server.middlewares.use('/api/workspace/read-text-file', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { path?: string };
              const content = await readNodeFile(requireDevFsPath(body.path, 'path'), 'utf8');
              sendJson(res, 200, content);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to read file.' });
            }
          });

          server.middlewares.use('/api/workspace/list-markdown-files', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { root?: string };
              const files = await collectDevWorkspaceFiles(requireDevFsPath(body.root, 'root'), (filePath) =>
                filePath.toLowerCase().endsWith('.md'),
              );
              sendJson(res, 200, files);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to list markdown files.' });
            }
          });

          server.middlewares.use('/api/workspace/list-files', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { root?: string };
              const files = await collectDevWorkspaceFiles(requireDevFsPath(body.root, 'root'));
              sendJson(res, 200, files);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to list files.' });
            }
          });

          server.middlewares.use('/api/workspace/delete-path', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { root?: string; path?: string };
              const root = requireDevFsPath(body.root, 'root');
              const target = requireDevFsPath(body.path, 'path');
              if (target === root) throw new Error('Refusing to delete the workspace root.');
              if (!isDevPathInside(root, target)) throw new Error('Refusing to delete a path outside the active workspace.');
              await rm(target, { recursive: true, force: true });
              sendJson(res, 200, undefined);
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to delete path.' });
            }
          });

          server.middlewares.use('/api/capture/extract', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as {
                content?: string;
                entityIndex?: unknown[];
                workspaceContext?: CaptureWorkspaceContext;
              };
              const content = body.content?.trim();
              if (!content) {
                sendJson(res, 400, { error: 'content is required.' });
                return;
              }
              const workspaceContext = normalizeCaptureWorkspaceContext(body.workspaceContext);

              const minimaxResult = minimaxApiKey
                ? await requestOpenAiCompatibleTwoStepCapture({
                    apiKey: minimaxApiKey,
                    baseUrl: minimaxBaseUrl,
                    model: minimaxModel,
                    providerName: 'MiniMax',
                    content,
                    entityIndex: body.entityIndex ?? [],
                    workspaceContext,
                    extraBody: { response_format: { type: 'json_object' } },
                  })
                : { ok: false as const, error: 'MINIMAX_API_KEY is not configured.' };

              let minimaxFailure = minimaxResult.ok ? '' : minimaxResult.error;
              if (minimaxResult.ok) {
                try {
                  sendJson(res, 200, {
                    draft: assertUsableDraft(minimaxResult.draft, 'MiniMax'),
                    provider: 'minimax',
                    model: minimaxModel,
                    fallbackFrom: minimaxResult.fallbackFrom,
                    mode: 'two-step',
                  });
                  return;
                } catch (error) {
                  minimaxFailure = error instanceof Error ? error.message : 'MiniMax returned invalid JSON.';
                }
              }

              let deepseekFailure = '';
              for (const deepseekApiKey of deepseekApiKeys) {
                const deepseekTwoStepResult = await requestOpenAiCompatibleTwoStepCapture({
                  apiKey: deepseekApiKey,
                  baseUrl: deepseekBaseUrl,
                  model: deepseekModel,
                  providerName: 'DeepSeek',
                  content,
                  entityIndex: body.entityIndex ?? [],
                  workspaceContext,
                  extraBody: {
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                  },
                });

                if (deepseekTwoStepResult.ok) {
                  try {
                    sendJson(res, 200, {
                      draft: assertUsableDraft(deepseekTwoStepResult.draft, 'DeepSeek'),
                      provider: 'deepseek',
                      model: deepseekModel,
                      fallbackFrom: minimaxFailure,
                      mode: 'two-step',
                    });
                    return;
                  } catch (error) {
                    deepseekFailure = error instanceof Error ? error.message : 'DeepSeek returned invalid JSON.';
                    continue;
                  }
                }

                const deepseekSingleStepResult = await requestOpenAiCompatibleCapture({
                  apiKey: deepseekApiKey,
                  baseUrl: deepseekBaseUrl,
                  model: deepseekModel,
                  providerName: 'DeepSeek',
                  content,
                  workspaceContext,
                  extraBody: {
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                  },
                });

                if (deepseekSingleStepResult.ok) {
                  try {
                    sendJson(res, 200, {
                      draft: assertUsableDraft(
                        normalizeCaptureAnalysisToCaptureDraft(
                          normalizeCaptureAnalysis(deepseekSingleStepResult.text),
                          content,
                          workspaceContext,
                        ),
                        'DeepSeek',
                      ),
                      provider: 'deepseek',
                      model: deepseekModel,
                      fallbackFrom: minimaxFailure,
                      mode: 'single-step',
                    });
                    return;
                  } catch (error) {
                    deepseekFailure = error instanceof Error ? error.message : 'DeepSeek returned invalid JSON.';
                    continue;
                  }
                }

                deepseekFailure = `${deepseekTwoStepResult.error}; single-step: ${deepseekSingleStepResult.error}`;
              }

              sendJson(res, 502, {
                error: `MiniMax failed: ${minimaxFailure}. DeepSeek fallback failed: ${
                  deepseekFailure || 'not configured'
                }.`,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'AI extraction failed.',
              });
            }
          });

          server.middlewares.use('/api/import/extract', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as {
                filename?: string;
                mimeType?: string;
                dataBase64?: string;
              };
              const filename = body.filename?.trim();
              const dataBase64 = body.dataBase64?.trim();
              if (!filename || !dataBase64) {
                sendJson(res, 400, { error: 'filename and dataBase64 are required.' });
                return;
              }

              const buffer = Buffer.from(dataBase64, 'base64');
              const text = await extractImportFileText({
                filename,
                mimeType: body.mimeType ?? '',
                buffer,
              });

              if (!text.trim()) {
                sendJson(res, 422, { error: `${filename} 没有提取到可用文本。` });
                return;
              }

              sendJson(res, 200, { text });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'File extraction failed.',
              });
            }
          });

          server.middlewares.use('/api/import/url', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { url?: string };
              const url = normalizeImportHttpUrl(body.url);
              const text = await extractImportUrlText(url);
              if (!text.trim()) {
                sendJson(res, 422, { error: 'URL extraction returned empty content.' });
                return;
              }
              sendJson(res, 200, { url, text });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'URL extraction failed.',
              });
            }
          });

          server.middlewares.use('/api/vision/caption', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as {
                imageBase64?: string;
                mimeType?: string;
                filename?: string;
                ocrText?: string;
                providerConfig?: LlmProviderConfig | null;
              };
              if (!payload.imageBase64?.trim() || !payload.mimeType?.trim()) {
                sendJson(res, 400, { error: 'imageBase64 and mimeType are required.' });
                return;
              }
              const providerConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!providerConfig) {
                sendJson(res, 400, { error: 'Vision provider is not configured.' });
                return;
              }

              const result = await requestConfiguredProviderVision({
                config: providerConfig,
                imageBase64: payload.imageBase64,
                mimeType: payload.mimeType,
                filename: payload.filename,
                ocrText: payload.ocrText,
              });
              if (!result.ok) {
                sendJson(res, 502, { error: `${result.providerName} failed: ${result.error}` });
                return;
              }
              sendJson(res, 200, {
                caption: normalizeCaption(result.text),
                provider: result.providerName,
                model: result.model,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Vision caption failed.',
              });
            }
          });

          server.middlewares.use('/api/research/search', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as {
                topic?: string;
                searchQueries?: string[];
                searchConfig?: { provider?: string; apiKey?: string; maxResults?: number };
              };
              const topic = payload.topic?.trim();
              if (!topic) {
                sendJson(res, 400, { error: 'topic is required.' });
                return;
              }
              const searchConfig = payload.searchConfig;
              if (searchConfig?.provider !== 'tavily' || !searchConfig.apiKey?.trim()) {
                sendJson(res, 400, { error: 'Tavily API key is required for deep research.' });
                return;
              }

              const queries = uniqueStrings(
                (payload.searchQueries?.length ? payload.searchQueries : [topic])
                  .map((query) => query.trim())
                  .filter(Boolean),
              ).slice(0, 4);
              const maxResults = Math.min(10, Math.max(1, Number(searchConfig.maxResults) || 5));
              const webResults = await runTavilySearches(queries, searchConfig.apiKey, maxResults);

              sendJson(res, 200, { webResults });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Deep research search failed.',
              });
            }
          });

          server.middlewares.use('/api/research/synthesize', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as {
                topic?: string;
                webResults?: DevWebSearchResult[];
                providerConfig?: LlmProviderConfig | null;
              };
              const topic = payload.topic?.trim();
              if (!topic) {
                sendJson(res, 400, { error: 'topic is required.' });
                return;
              }

              const webResults = Array.isArray(payload.webResults) ? payload.webResults : [];
              if (webResults.length === 0) {
                sendJson(res, 200, {
                  synthesis: buildNoWebResultsSynthesis(topic),
                  provider: '',
                  model: '',
                });
                return;
              }

              const providerConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!providerConfig) {
                sendJson(res, 400, { error: 'Deep research LLM provider is not configured.' });
                return;
              }

              const providerResult = await requestConfiguredProviderText({
                config: providerConfig,
                prompt: buildDeepResearchPrompt(topic, webResults),
                systemPrompt:
                  'You are MyWiki Deep Research. Synthesize web search results into a concise, cited Chinese wiki research note. Do not reveal chain-of-thought.',
                maxTokens: 3600,
              });
              if (!providerResult.ok) {
                sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                return;
              }

              sendJson(res, 200, {
                synthesis: stripThinking(providerResult.text),
                provider: providerResult.providerName,
                model: providerResult.model,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Deep research synthesis failed.',
              });
            }
          });

          server.middlewares.use('/api/research/run', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as {
                topic?: string;
                searchQueries?: string[];
                searchConfig?: { provider?: string; apiKey?: string; maxResults?: number };
                providerConfig?: LlmProviderConfig | null;
              };
              const topic = payload.topic?.trim();
              if (!topic) {
                sendJson(res, 400, { error: 'topic is required.' });
                return;
              }
              const providerConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!providerConfig) {
                sendJson(res, 400, { error: 'Deep research LLM provider is not configured.' });
                return;
              }
              const searchConfig = payload.searchConfig;
              if (searchConfig?.provider !== 'tavily' || !searchConfig.apiKey?.trim()) {
                sendJson(res, 400, { error: 'Tavily API key is required for deep research.' });
                return;
              }

              const queries = uniqueStrings(
                (payload.searchQueries?.length ? payload.searchQueries : [topic])
                  .map((query) => query.trim())
                  .filter(Boolean),
              ).slice(0, 4);
              const maxResults = Math.min(10, Math.max(1, Number(searchConfig.maxResults) || 5));
              const webResults = await runTavilySearches(queries, searchConfig.apiKey, maxResults);
              if (webResults.length === 0) {
                sendJson(res, 200, {
                  webResults: [],
                  synthesis: `# ${topic}\n\n没有检索到可用的外部来源。建议换一个更具体的主题或检查 Tavily 配置。`,
                  provider: providerConfig.providerId,
                  model: providerConfig.model,
                });
                return;
              }

              const prompt = buildDeepResearchPrompt(topic, webResults);
              const providerResult = await requestConfiguredProviderText({
                config: providerConfig,
                prompt,
                systemPrompt:
                  'You are MyWiki Deep Research. Synthesize web search results into a concise, cited Chinese wiki research note. Do not reveal chain-of-thought.',
                maxTokens: 3600,
              });
              if (!providerResult.ok) {
                sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                return;
              }

              sendJson(res, 200, {
                webResults,
                synthesis: stripThinking(providerResult.text),
                provider: providerResult.providerName,
                model: providerResult.model,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Deep research failed.',
              });
            }
          });

          server.middlewares.use('/api/query/compose', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as QueryComposePayload;
              if (!payload.question?.trim() || !payload.draftAnswer?.trim()) {
                sendJson(res, 400, { error: 'question and draftAnswer are required.' });
                return;
              }

              const prompt = buildQueryComposePrompt(payload);
              const minimaxResult = minimaxApiKey
                ? await requestOpenAiCompatibleText({
                    apiKey: minimaxApiKey,
                    baseUrl: minimaxBaseUrl,
                    model: minimaxModel,
                    providerName: 'MiniMax',
                    prompt,
                    systemPrompt: '你是严谨的中文知识库查询表达助手。只输出最终回答正文。',
                    maxTokens: 1200,
                  })
                : { ok: false as const, error: 'MINIMAX_API_KEY is not configured.' };

              const minimaxFailure = minimaxResult.ok ? '' : minimaxResult.error;
              if (minimaxResult.ok) {
                sendJson(res, 200, {
                  answer: normalizeComposedAnswer(minimaxResult.text, payload.draftAnswer),
                  provider: 'minimax',
                  model: minimaxModel,
                });
                return;
              }

              let deepseekFailure = '';
              for (const deepseekApiKey of deepseekApiKeys) {
                const deepseekResult = await requestOpenAiCompatibleText({
                  apiKey: deepseekApiKey,
                  baseUrl: deepseekBaseUrl,
                  model: deepseekModel,
                  providerName: 'DeepSeek',
                  prompt,
                  systemPrompt: '你是严谨的中文知识库查询表达助手。只输出最终回答正文。',
                  maxTokens: 1200,
                  extraBody: {
                    thinking: { type: 'disabled' },
                  },
                });

                if (deepseekResult.ok) {
                  sendJson(res, 200, {
                    answer: normalizeComposedAnswer(deepseekResult.text, payload.draftAnswer),
                    provider: 'deepseek',
                    model: deepseekModel,
                    fallbackFrom: minimaxFailure,
                  });
                  return;
                }

                deepseekFailure = deepseekResult.error;
              }

              sendJson(res, 502, {
                error: `MiniMax failed: ${minimaxFailure}. DeepSeek fallback failed: ${
                  deepseekFailure || 'not configured'
                }.`,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Query composition failed.',
              });
            }
          });

          server.middlewares.use('/api/query/answer', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as QueryAnswerRequest & {
                providerConfig?: LlmProviderConfig | null;
              };
              if (!payload.question?.trim() || !Array.isArray(payload.pages) || payload.pages.length === 0) {
                sendJson(res, 400, { error: 'question and pages are required.' });
                return;
              }

              const requestProviderConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!requestProviderConfig && !minimaxApiKey) {
                sendJson(res, 500, { error: 'MINIMAX_API_KEY is not configured.' });
                return;
              }

              const prompt = buildQueryAnswerPrompt(payload);
              const systemPrompt =
                '你是 MyWiki Query 2.0 的中文 Wiki 对话分析助手。请基于给定的编号 Wiki 页面进行高质量 Markdown 回答，禁止输出 <think>、思考过程或 JSON。必须在末尾追加一个形如 <!-- cited: 1,2 --> 的 HTML 注释。';

              if (requestProviderConfig) {
                const providerResult = await requestConfiguredProviderText({
                  config: requestProviderConfig,
                  prompt,
                  systemPrompt,
                  maxTokens: 3600,
                });

                if (!providerResult.ok) {
                  sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                  return;
                }

                const normalized = normalizeQueryAnswerResponse(
                  providerResult.text,
                  payload.structuredSupport?.draftAnswer || '现有 Wiki 页面还不能可靠回答这个问题。',
                );
                sendJson(res, 200, {
                  ...normalized,
                  provider: providerResult.providerName,
                  model: providerResult.model,
                });
                return;
              }

              const minimaxResult = await requestOpenAiCompatibleText({
                apiKey: minimaxApiKey,
                baseUrl: minimaxBaseUrl,
                model: minimaxModel,
                providerName: 'MiniMax',
                prompt,
                systemPrompt,
                maxTokens: 3600,
              });

              if (!minimaxResult.ok) {
                sendJson(res, 502, { error: `MiniMax failed: ${minimaxResult.error}` });
                return;
              }

              const normalized = normalizeQueryAnswerResponse(
                minimaxResult.text,
                payload.structuredSupport?.draftAnswer || '现有 Wiki 页面还不能可靠回答这个问题。',
              );
              sendJson(res, 200, {
                ...normalized,
                provider: 'minimax',
                model: minimaxModel,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Query answer generation failed.',
              });
            }
          });

          server.middlewares.use('/api/wiki/lint/semantic', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as SemanticWikiLintPayload & {
                providerConfig?: LlmProviderConfig | null;
              };
              if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
                sendJson(res, 400, { error: 'pages are required.' });
                return;
              }

              const requestProviderConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!requestProviderConfig && !minimaxApiKey) {
                sendJson(res, 500, { error: 'MINIMAX_API_KEY is not configured.' });
                return;
              }

              const prompt = buildSemanticWikiLintPrompt({
                pages: payload.pages.slice(0, 80),
                contextMap: payload.contextMap,
                outputLanguage: payload.outputLanguage ?? 'zh-CN',
              });
              const systemPrompt =
                'You are MyWiki Wiki Lint. Return only strict ---LINT--- blocks. Do not include markdown fences, JSON, or chain-of-thought.';

              if (requestProviderConfig) {
                const providerResult = await requestConfiguredProviderText({
                  config: requestProviderConfig,
                  prompt,
                  systemPrompt,
                  maxTokens: 2600,
                });

                if (!providerResult.ok) {
                  sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                  return;
                }

                sendJson(res, 200, {
                  results: normalizeSemanticWikiLintResponse(providerResult.text),
                  provider: providerResult.providerName,
                  model: providerResult.model,
                });
                return;
              }

              const minimaxResult = await requestOpenAiCompatibleText({
                apiKey: minimaxApiKey,
                baseUrl: minimaxBaseUrl,
                model: minimaxModel,
                providerName: 'MiniMax',
                prompt,
                systemPrompt,
                maxTokens: 2600,
              });

              if (!minimaxResult.ok) {
                sendJson(res, 502, { error: `MiniMax failed: ${minimaxResult.error}` });
                return;
              }

              sendJson(res, 200, {
                results: normalizeSemanticWikiLintResponse(minimaxResult.text),
                provider: 'minimax',
                model: minimaxModel,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Wiki semantic lint failed.',
              });
            }
          });

          server.middlewares.use('/api/wiki/recompile', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as WikiMarkdownCompileInput & {
                providerConfig?: LlmProviderConfig | null;
              };
              if (!payload.entity?.title) {
                sendJson(res, 400, { error: 'entity is required.' });
                return;
              }

              const requestProviderConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!requestProviderConfig && !minimaxApiKey) {
                sendJson(res, 500, { error: 'MINIMAX_API_KEY is not configured.' });
                return;
              }

              const today = new Date().toISOString().slice(0, 10);
              const prompt = buildWikiMarkdownCompilePrompt({ ...payload, today });
              const strictFileBlockSystemPrompt =
                '你是 MyWiki v2 的中文 Wiki 编译 Agent。完整回复必须且只能是一个 ---FILE: wiki/...--- 到 ---END FILE--- 的 FILE block。第一字符必须是 -。严禁输出 <think>、思考过程、分析过程、任务复述或任何 FILE block 外说明。';
              if (requestProviderConfig) {
                const providerResult = await requestConfiguredProviderText({
                  config: requestProviderConfig,
                  prompt,
                  systemPrompt: strictFileBlockSystemPrompt,
                  maxTokens: 4200,
                });

                if (!providerResult.ok) {
                  sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                  return;
                }

                const normalized = normalizeWikiMarkdownCompileResult(providerResult.text, payload.entity, today, {
                  requireFileBlock: true,
                });
                sendJson(res, 200, {
                  ...normalized,
                  provider: providerResult.providerName,
                  model: providerResult.model,
                });
                return;
              }

              const minimaxResult = await requestOpenAiCompatibleText({
                apiKey: minimaxApiKey,
                baseUrl: minimaxBaseUrl,
                model: minimaxModel,
                providerName: 'MiniMax',
                prompt,
                systemPrompt:
                  '你是 MyWiki v2 的中文 Wiki 编译 Agent。你的完整回复必须且只能是一个 ---FILE: wiki/...--- 到 ---END FILE--- 的 FILE block。第一字符必须是 -。严禁输出 <think>、思考过程、分析过程、任务复述或任何 FILE block 外说明。',
                maxTokens: 4200,
              });

              if (!minimaxResult.ok) {
                sendJson(res, 502, { error: `MiniMax failed: ${minimaxResult.error}` });
                return;
              }

              const normalized = normalizeWikiMarkdownCompileResult(minimaxResult.text, payload.entity, today, {
                requireFileBlock: true,
              });
              sendJson(res, 200, {
                ...normalized,
                provider: 'minimax',
                model: minimaxModel,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Wiki recompilation failed.',
              });
            }
          });

          server.middlewares.use('/api/wiki/recompile-source-batch', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as WikiMarkdownBatchCompileInput & {
                providerConfig?: LlmProviderConfig | null;
              };
              if (!payload.sourceEntry?.id || !Array.isArray(payload.entities) || payload.entities.length === 0) {
                sendJson(res, 400, { error: 'sourceEntry and entities are required.' });
                return;
              }

              const requestProviderConfig = normalizeRequestProviderConfig(payload.providerConfig);
              if (!requestProviderConfig && !minimaxApiKey) {
                sendJson(res, 500, { error: 'MINIMAX_API_KEY is not configured.' });
                return;
              }

              const today = new Date().toISOString().slice(0, 10);
              const prompt = buildWikiMarkdownBatchCompilePrompt({ ...payload, today });
              const systemPrompt =
                '你是 MyWiki v2 的文件级 Wiki 编译 Agent。完整回复必须且只能是多个 ---FILE: wiki/...--- 到 ---END FILE--- 的 FILE blocks。第一字符必须是 -。严禁输出 <think>、思考过程、分析过程、任务复述或任何 FILE block 外说明。';

              if (requestProviderConfig) {
                const providerResult = await requestConfiguredProviderText({
                  config: requestProviderConfig,
                  prompt,
                  systemPrompt,
                  maxTokens: 9000,
                });

                if (!providerResult.ok) {
                  sendJson(res, 502, { error: `${providerResult.providerName} failed: ${providerResult.error}` });
                  return;
                }

                const normalized = normalizeWikiMarkdownBatchCompileResult(providerResult.text, { ...payload, today });
                sendJson(res, 200, {
                  ...normalized,
                  provider: providerResult.providerName,
                  model: providerResult.model,
                });
                return;
              }

              const minimaxResult = await requestOpenAiCompatibleText({
                apiKey: minimaxApiKey,
                baseUrl: minimaxBaseUrl,
                model: minimaxModel,
                providerName: 'MiniMax',
                prompt,
                systemPrompt,
                maxTokens: 9000,
              });

              if (!minimaxResult.ok) {
                sendJson(res, 502, { error: `MiniMax failed: ${minimaxResult.error}` });
                return;
              }

              const normalized = normalizeWikiMarkdownBatchCompileResult(minimaxResult.text, { ...payload, today });
              sendJson(res, 200, {
                ...normalized,
                provider: 'minimax',
                model: minimaxModel,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Wiki batch recompilation failed.',
              });
            }
          });

          server.middlewares.use('/api/query/plan', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const payload = (await readJsonBody(req)) as QueryPlanRequest;
              if (!payload.question?.trim() || !Array.isArray(payload.index)) {
                sendJson(res, 400, { error: 'question and index are required.' });
                return;
              }

              const prompt = buildQueryPlanPrompt(payload);
              const minimaxResult = minimaxApiKey
                ? await requestOpenAiCompatibleText({
                    apiKey: minimaxApiKey,
                    baseUrl: minimaxBaseUrl,
                    model: minimaxModel,
                    providerName: 'MiniMax',
                    prompt,
                    systemPrompt: '你是 MyWiki Query Agent。只输出符合 schema 的 JSON 对象。',
                    maxTokens: STRUCTURED_JSON_MAX_TOKENS,
                    extraBody: { response_format: { type: 'json_object' } },
                  })
                : { ok: false as const, error: 'MINIMAX_API_KEY is not configured.' };

              const minimaxFailure = minimaxResult.ok ? '' : minimaxResult.error;
              if (minimaxResult.ok) {
                try {
                  sendJson(res, 200, normalizeQueryPlan(minimaxResult.text, payload));
                  return;
                } catch (error) {
                  // Fall through to DeepSeek.
                }
              }

              let deepseekFailure = '';
              for (const deepseekApiKey of deepseekApiKeys) {
                const deepseekResult = await requestOpenAiCompatibleText({
                  apiKey: deepseekApiKey,
                  baseUrl: deepseekBaseUrl,
                  model: deepseekModel,
                  providerName: 'DeepSeek',
                  prompt,
                  systemPrompt: '你是 MyWiki Query Agent。只输出符合 schema 的 JSON 对象。',
                  maxTokens: 1200,
                  extraBody: {
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                  },
                });

                if (deepseekResult.ok) {
                  try {
                    sendJson(res, 200, normalizeQueryPlan(deepseekResult.text, payload));
                    return;
                  } catch (error) {
                    deepseekFailure = error instanceof Error ? error.message : 'DeepSeek returned invalid query plan.';
                    continue;
                  }
                }

                deepseekFailure = deepseekResult.error;
              }

              sendJson(res, 502, {
                error: `MiniMax failed: ${minimaxFailure}. DeepSeek fallback failed: ${
                  deepseekFailure || 'not configured'
                }.`,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'Query planning failed.',
              });
            }
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    test: {
      environment: 'happy-dom',
      setupFiles: ['./vitest.setup.ts'],
      fileParallelism: false,
      globals: true,
    },
  };
});

async function requestOpenAiCompatibleCapture({
  apiKey,
  baseUrl,
  model,
  providerName,
  content,
  workspaceContext,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
  workspaceContext?: CaptureWorkspaceContext;
  extraBody?: Record<string, unknown>;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: '你只输出符合要求的 JSON 对象。',
          },
          {
            role: 'user',
            content: buildCaptureAnalysisPrompt(content, '[]', workspaceContext),
          },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 2048,
        ...extraBody,
      }),
    });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; type?: string };
    };

    if (!response.ok || data.error) {
      return {
        ok: false,
        error: data.error?.message || `${providerName} request failed with ${response.status}.`,
      };
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.` };
    }

    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} request failed.`,
    };
  }
}

async function requestOpenAiCompatibleTwoStepCapture({
  apiKey,
  baseUrl,
  model,
  providerName,
  content,
  entityIndex,
  workspaceContext,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
  entityIndex: unknown[];
  workspaceContext?: CaptureWorkspaceContext;
  extraBody?: Record<string, unknown>;
}): Promise<
  | { ok: true; draft: ReturnType<typeof normalizeWikiPatchesToCaptureDraft>; fallbackFrom?: string }
  | { ok: false; error: string }
> {
  try {
    const structuredContentResult = await prepareContentForStructuredCapture({
      apiKey,
      baseUrl,
      model,
      providerName,
      content,
      workspaceContext,
      extraBody,
    });

    if (!structuredContentResult.ok) return structuredContentResult;
    const structuredContent = structuredContentResult.content;

    const entityIndexJson = JSON.stringify(entityIndex.slice(0, 120), null, 2);
    const markdownAnalysisResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureMarkdownAnalysisPrompt(structuredContent, entityIndexJson, workspaceContext),
      systemPrompt: '你是 MyWiki 原文件阅读 Agent。只输出 Markdown 分析文本，不要输出 JSON。',
      maxTokens: 3200,
      extraBody: withoutJsonResponseFormat(extraBody),
    });

    if (!markdownAnalysisResult.ok) return markdownAnalysisResult;

    const analysisSourceExcerpt = buildStructuredCaptureExcerpt(structuredContent, 14000);
    const structuredAnalysisResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureAnalysisFromMarkdownPrompt({
        sourceExcerpt: analysisSourceExcerpt,
        markdownAnalysis: markdownAnalysisResult.text,
        entityIndexJson,
        workspaceContext,
      }),
      systemPrompt: '你是 MyWiki 结构化入库 Agent。只输出符合 schema 的 JSON 对象。',
      maxTokens: STRUCTURED_JSON_MAX_TOKENS,
      extraBody: withoutJsonResponseFormat(extraBody),
      structuredOutput: buildCaptureAnalysisStructuredOutput(),
    });

    if (!structuredAnalysisResult.ok) return structuredAnalysisResult;

    const analysis = await normalizeCaptureAnalysisWithOpenAiRepair({
      apiKey,
      baseUrl,
      model,
      providerName,
      structuredContent: analysisSourceExcerpt,
      entityIndexJson,
      rawText: structuredAnalysisResult.text,
      extraBody,
      workspaceContext,
    });
    return { ok: true, draft: normalizeCaptureAnalysisToCaptureDraft(analysis, structuredContent, workspaceContext) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} two-step capture failed.`,
    };
  }
}

async function normalizeCaptureAnalysisWithOpenAiRepair({
  apiKey,
  baseUrl,
  model,
  providerName,
  structuredContent,
  entityIndexJson,
  rawText,
  extraBody,
  workspaceContext,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  structuredContent: string;
  entityIndexJson: string;
  rawText: string;
  extraBody?: Record<string, unknown>;
  workspaceContext?: CaptureWorkspaceContext;
}) {
  try {
    return normalizeCaptureAnalysis(rawText);
  } catch (firstError) {
    const repairResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureAnalysisJsonRepairPrompt(rawText, structuredContent, entityIndexJson, workspaceContext),
      systemPrompt: '你是 MyWiki JSON 修复 Agent。只输出一个合法 JSON 对象，不要 Markdown。',
      maxTokens: STRUCTURED_JSON_MAX_TOKENS,
      extraBody: withoutJsonResponseFormat(extraBody),
      structuredOutput: buildCaptureAnalysisStructuredOutput('repair_capture_analysis'),
    });
    if (!repairResult.ok) {
      throw new Error(`模型返回的摄入分析 JSON 不合法，自动修复请求失败：${repairResult.error}`);
    }

    try {
      return normalizeCaptureAnalysis(repairResult.text);
    } catch (secondError) {
      throw new Error(
        `模型返回的摄入分析 JSON 不合法，自动修复后仍失败：${formatJsonRepairError(secondError, firstError)}`,
      );
    }
  }
}

async function normalizeWikiPatchResponseWithOpenAiRepair({
  apiKey,
  baseUrl,
  model,
  providerName,
  structuredContent,
  analysis,
  rawText,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  structuredContent: string;
  analysis: Parameters<typeof buildWikiPatchPrompt>[1];
  rawText: string;
  extraBody?: Record<string, unknown>;
}) {
  try {
    return normalizeWikiPatchResponse(rawText);
  } catch (firstError) {
    const repairResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildWikiPatchJsonRepairPrompt(rawText, structuredContent, analysis),
      systemPrompt: '你是 MyWiki WikiPatch JSON 修复 Agent。只输出一个合法 JSON 对象，不要 Markdown。',
      maxTokens: STRUCTURED_JSON_MAX_TOKENS,
      extraBody,
    });
    if (!repairResult.ok) {
      throw new Error(`模型返回的 WikiPatch JSON 不合法，自动修复请求失败：${repairResult.error}`);
    }

    try {
      return normalizeWikiPatchResponse(repairResult.text);
    } catch (secondError) {
      throw new Error(`模型返回的 WikiPatch JSON 不合法，自动修复后仍失败：${formatJsonRepairError(secondError, firstError)}`);
    }
  }
}

function formatJsonRepairError(error: unknown, previous?: unknown) {
  const current = error instanceof Error ? error.message : '未知错误';
  const earlier = previous instanceof Error ? previous.message : '';
  return earlier && earlier !== current ? `${current}；首次错误：${earlier}` : current;
}

async function prepareContentForStructuredCapture({
  apiKey,
  baseUrl,
  model,
  providerName,
  content,
  workspaceContext,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
  workspaceContext?: CaptureWorkspaceContext;
  extraBody?: Record<string, unknown>;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const structuredSource = buildCaptureSourceForStructuredProcessing(content);
  if (!shouldUseCaptureDigest(structuredSource, resolveCaptureDigestThreshold(200000))) {
    return { ok: true, content: structuredSource };
  }

  const chunks = splitCaptureContentIntoChunks(structuredSource);
  const sourceIdentity = buildCaptureSourceIdentityBlock(structuredSource);
  const digests: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const digestResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureDigestPrompt(chunks[index], index + 1, chunks.length, workspaceContext),
      systemPrompt: '你是 MyWiki 长文档阅读 Agent。只输出 Markdown 阅读摘要，不要输出 JSON。',
      maxTokens: 1600,
      extraBody: withoutJsonResponseFormat(extraBody),
    });

    if (!digestResult.ok) {
      return { ok: false, error: `${providerName} long document digest failed: ${digestResult.error}` };
    }
    digests.push(`## 分块 ${index + 1}/${chunks.length}\n\n${digestResult.text}`);
  }

  return {
    ok: true,
    content: [
      ...(sourceIdentity ? [sourceIdentity, ''] : []),
      '# 长文档 Markdown 阅读摘要',
      '',
      '以下内容由 MyWiki 长文档阅读 Agent 从原始材料分块整理而来。结构化 WikiPatch 只能基于这些摘要生成；完整原文已保存在原始 Entry 中。',
      '',
      ...digests,
    ].join('\n'),
  };
}

function withoutJsonResponseFormat(extraBody?: Record<string, unknown>) {
  if (!extraBody) return undefined;
  const { response_format: _responseFormat, ...rest } = extraBody;
  return rest;
}

function normalizeCaptureWorkspaceContext(input: unknown): CaptureWorkspaceContext | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as CaptureWorkspaceContext;
  const context: CaptureWorkspaceContext = {
    purpose: typeof raw.purpose === 'string' ? raw.purpose : undefined,
    schema: typeof raw.schema === 'string' ? raw.schema : undefined,
    templateId: typeof raw.templateId === 'string' ? raw.templateId : undefined,
  };
  return context.purpose?.trim() || context.schema?.trim() || context.templateId?.trim() ? context : undefined;
}

function normalizeRequestProviderConfig(input: LlmProviderConfig | null | undefined): LlmProviderConfig | null {
  if (!input) return null;
  const config = { ...input, enabled: true };
  const errors = validateLlmProviderConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
  return config;
}

type DevWebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

async function runTavilySearches(queries: string[], apiKey: string, maxResults: number): Promise<DevWebSearchResult[]> {
  const seen = new Set<string>();
  const merged: DevWebSearchResult[] = [];
  for (const query of queries) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
        include_answer: false,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
      error?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(data.error || data.message || `Tavily search failed with ${response.status}.`);
    }
    for (const item of data.results ?? []) {
      const url = item.url?.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push({
        title: item.title?.trim() || 'Untitled',
        url,
        snippet: item.content?.trim() || '',
        source: safeHost(url),
      });
    }
  }
  return merged.slice(0, Math.max(maxResults, 1) * Math.max(queries.length, 1));
}

function buildDeepResearchPrompt(topic: string, webResults: DevWebSearchResult[]) {
  const sources = webResults
    .map((result, index) => [`[${index + 1}] ${result.title}`, `URL: ${result.url}`, `摘要: ${result.snippet}`].join('\n'))
    .join('\n\n');
  return [
    `研究主题：${topic}`,
    '',
    '请基于下面的网页搜索结果生成可写入 Wiki 的中文研究条目：',
    '- 先给出结论摘要',
    '- 分主题整理事实、数据、争议和未知项',
    '- 使用 [1]、[2] 这样的编号引用来源',
    '- 明确指出还需要补充验证的内容',
    '- 保持中性、可复用、适合进入知识库',
    '',
    '## Web Search Results',
    '',
    sources,
  ].join('\n');
}

function buildNoWebResultsSynthesis(topic: string) {
  return `# ${topic}\n\n没有检索到可用的外部来源。建议换一个更具体的主题或检查 Tavily 配置。`;
}

async function requestConfiguredProviderVision({
  config,
  imageBase64,
  mimeType,
  filename,
  ocrText,
}: {
  config: LlmProviderConfig;
  imageBase64: string;
  mimeType: string;
  filename?: string;
  ocrText?: string;
}): Promise<{ ok: true; text: string; providerName: string; model: string } | { ok: false; error: string; providerName: string; model: string }> {
  const providerName = config.providerId;
  try {
    const request = buildProviderVisionRequest(config, {
      prompt: buildVisionPrompt(filename, ocrText),
      imageBase64,
      mimeType,
      maxTokens: 900,
    });
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    const data = (await response.json()) as unknown;
    if (!response.ok) {
      return {
        ok: false,
        error: extractProviderError(data) || `${providerName} request failed with ${response.status}.`,
        providerName,
        model: config.model,
      };
    }
    const text = extractProviderText(data, config.apiMode);
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.`, providerName, model: config.model };
    }
    return { ok: true, text, providerName, model: config.model };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} vision request failed.`,
      providerName,
      model: config.model,
    };
  }
}

function buildProviderVisionRequest(
  config: LlmProviderConfig,
  input: { prompt: string; imageBase64: string; mimeType: string; maxTokens: number },
) {
  if (config.apiMode === 'anthropic-compatible') {
    const url = buildAnthropicMessagesUrl(config.endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (anthropicCompatibleRequiresBearerAuth(url)) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    } else if (config.apiKey.trim()) {
      headers['x-api-key'] = config.apiKey.trim();
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url,
      headers,
      body: {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: input.mimeType,
                  data: input.imageBase64,
                },
              },
            ],
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: input.maxTokens,
      },
    };
  }

  if (config.apiMode === 'gemini-native') {
    return {
      url: buildGeminiGenerateContentUrl(config),
      headers: { 'Content-Type': 'application/json' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: input.prompt },
              { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: input.maxTokens,
        },
      },
    };
  }

  return {
    url: buildOpenAiChatCompletionsUrl(config.endpoint),
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    body: {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            {
              type: 'image_url',
              image_url: { url: buildOpenAiVisionImageUrl(config, input) },
            },
          ],
        },
      ],
      stream: false,
      temperature: 0,
      max_tokens: input.maxTokens,
    },
  };
}

function buildOpenAiVisionImageUrl(
  config: LlmProviderConfig,
  input: { imageBase64: string; mimeType: string },
) {
  if (config.providerId === 'zhipu') return input.imageBase64;
  return `data:${input.mimeType};base64,${input.imageBase64}`;
}

function buildVisionPrompt(filename?: string, ocrText?: string) {
  return [
    '请为知识库索引客观描述这张图片。包含可见文字原文、图表坐标轴和值、结构图的框线箭头标签、关键视觉元素。',
    '不要猜测，不要评价。输出 2 到 4 句纯文本，不要 Markdown。',
    filename ? `文件名：${filename}` : '',
    ocrText?.trim() ? `已有 OCR 文本，可用于校对但不要机械复述：\n${ocrText.trim().slice(0, 1200)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function normalizeCaption(text: string) {
  return stripThinking(text)
    .replace(/```(?:text|markdown)?/g, '')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function stripThinking(text: string) {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
    .trim();
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function requestConfiguredProviderText({
  config,
  prompt,
  systemPrompt,
  maxTokens,
}: {
  config: LlmProviderConfig;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
}): Promise<{ ok: true; text: string; providerName: string; model: string } | { ok: false; error: string; providerName: string; model: string }> {
  const providerName = config.providerId;
  try {
    const request = buildProviderTextRequest(config, { prompt, systemPrompt, maxTokens });
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    const data = (await response.json()) as unknown;

    if (!response.ok) {
      return {
        ok: false,
        error: extractProviderError(data) || `${providerName} request failed with ${response.status}.`,
        providerName,
        model: config.model,
      };
    }

    const text = extractProviderText(data, request.responseApiMode);
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.`, providerName, model: config.model };
    }
    return { ok: true, text, providerName, model: config.model };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} request failed.`,
      providerName,
      model: config.model,
    };
  }
}

async function requestOpenAiCompatibleText({
  apiKey,
  baseUrl,
  model,
  providerName,
  prompt,
  systemPrompt,
  maxTokens,
  extraBody,
  structuredOutput,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  extraBody?: Record<string, unknown>;
  structuredOutput?: ReturnType<typeof buildCaptureAnalysisStructuredOutput>;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let lastRetryableError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestOpenAiCompatibleTextOnce({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt,
      systemPrompt,
      maxTokens,
      extraBody,
      structuredOutput,
    });
    if (result.ok || !isRetryableProviderError(result.error) || attempt === 3) return result;
    lastRetryableError = result.error;
    await sleep(retryDelayMs(attempt));
  }
  return { ok: false, error: lastRetryableError || `${providerName} request failed.` };
}

async function requestOpenAiCompatibleTextOnce({
  apiKey,
  baseUrl,
  model,
  providerName,
  prompt,
  systemPrompt,
  maxTokens,
  extraBody,
  structuredOutput,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
  extraBody?: Record<string, unknown>;
  structuredOutput?: ReturnType<typeof buildCaptureAnalysisStructuredOutput>;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const structuredTool = structuredOutput
      ? {
          type: 'function',
          function: {
            name: structuredOutput.name,
            description: structuredOutput.description,
            parameters: structuredOutput.schema,
          },
        }
      : null;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: maxTokens,
        ...(structuredTool
          ? {
              tools: [structuredTool],
              tool_choice: { type: 'function', function: { name: structuredOutput?.name } },
            }
          : {}),
        ...extraBody,
      }),
    });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
      error?: { message?: string; type?: string };
    };

    if (!response.ok || data.error) {
      return {
        ok: false,
        error: data.error?.message || `${providerName} request failed with ${response.status}.`,
      };
    }

    const text =
      data.choices?.[0]?.message?.tool_calls?.find((call) => call.function?.arguments)?.function?.arguments?.trim() ||
      data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return { ok: false, error: `${providerName} returned empty content.` };
    }

    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} request failed.`,
    };
  }
}

function extractProviderText(data: unknown, apiMode: LlmProviderConfig['apiMode']) {
  if (!data || typeof data !== 'object') return '';
  const payload = data as Record<string, unknown>;

  if (apiMode === 'anthropic-compatible') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
  }

  if (apiMode === 'gemini-native') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const first = candidates[0] as { content?: { parts?: Array<{ text?: string; thought?: boolean }> } } | undefined;
    return (first?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: string } } | undefined;
  return first?.message?.content?.trim() ?? '';
}

function extractProviderError(data: unknown) {
  if (!data || typeof data !== 'object') return '';
  const payload = data as { error?: string | { message?: string; type?: string }; message?: string };
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error?.message) return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}

function isRetryableProviderError(error: string) {
  return /(429|rate.?limit|too many requests|timeout|timed out|temporarily|overloaded|503|502|504|500|ECONNRESET|ECONNREFUSED|network|fetch failed|socket|TLS|connection)/i.test(
    error,
  );
}

function retryDelayMs(attempt: number) {
  return 1200 * attempt * attempt;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readJsonBody(req: import('node:http').IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function requireDevFsPath(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const resolved = path.resolve(value);
  if (resolved.includes('\0')) throw new Error(`${label} contains an invalid character.`);
  return resolved;
}

function normalizeDevFsPath(value: string) {
  return path.resolve(value).replace(/\\/g, '/');
}

async function collectDevWorkspaceFiles(
  root: string,
  includeFile: (filePath: string) => boolean = () => true,
): Promise<string[]> {
  const output: string[] = [];
  await walkDevWorkspaceFiles(root, output, includeFile);
  return output.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

async function walkDevWorkspaceFiles(
  directory: string,
  output: string[],
  includeFile: (filePath: string) => boolean,
) {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDevWorkspaceFiles(filePath, output, includeFile);
    } else if (entry.isFile() && includeFile(filePath)) {
      output.push(normalizeDevFsPath(filePath));
    }
  }
}

function isDevPathInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function extractImportFileText({
  filename,
  mimeType,
  buffer,
}: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}) {
  const extension = filename.toLowerCase().split('.').at(-1) ?? '';
  const normalizedMimeType = mimeType.toLowerCase();

  const markitdownText = await tryMarkItDownExtract({ filename, buffer });
  if (markitdownText?.trim()) {
    return markitdownText;
  }

  if (
    ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'].includes(extension) ||
    normalizedMimeType.includes('spreadsheet') ||
    normalizedMimeType.includes('excel') ||
    normalizedMimeType.includes('csv') ||
    normalizedMimeType.includes('tab-separated-values') ||
    normalizedMimeType.includes('opendocument.spreadsheet')
  ) {
    return extractSpreadsheetText(buffer, filename, normalizedMimeType);
  }

  if (
    ['ppt', 'pptx'].includes(extension) ||
    normalizedMimeType.includes('presentationml') ||
    normalizedMimeType.includes('powerpoint')
  ) {
    throw new Error('演示文稿解析需要启用可选 MarkItDown 后端：设置环境变量 MARKITDOWN_ENABLED=1，并安装 python -m pip install markitdown。');
  }

  if (extension === 'zip' || normalizedMimeType.includes('zip')) {
    return extractZipText(buffer, filename);
  }

  if (['html', 'htm'].includes(extension) || normalizedMimeType.includes('html')) {
    return extractHtmlText(buffer.toString('utf8'));
  }

  if (['txt', 'md', 'markdown', 'json', 'jsonl', 'xml'].includes(extension) || normalizedMimeType.startsWith('text/')) {
    return buffer.toString('utf8');
  }

  if (
    ['doc', 'docx'].includes(extension) ||
    normalizedMimeType.includes('wordprocessingml') ||
    normalizedMimeType === 'application/msword'
  ) {
    return extractWordText(buffer, filename);
  }

  if (extension === 'pdf' || normalizedMimeType === 'application/pdf') {
    return extractPdfText(buffer);
  }

  if (
    ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'].includes(extension) ||
    normalizedMimeType.startsWith('image/')
  ) {
    return extractImageText(buffer);
  }

  throw new Error(`暂不支持 ${filename} 的文件格式。`);
}

async function extractImportUrlText(url: string) {
  const markitdownText = await tryMarkItDownUrlExtract(url);
  if (markitdownText?.trim() && isUsefulImportedWebText(markitdownText)) {
    return markitdownText.trim();
  }
  const fetchedText = await fetchUrlReadableText(url);
  if (!isUsefulImportedWebText(fetchedText)) {
    throw new Error('URL extraction did not return useful page content. The site may require verification, login, or block automated access.');
  }
  return fetchedText;
}

async function tryMarkItDownExtract({ filename, buffer }: { filename: string; buffer: Buffer }) {
  if (process.env.MARKITDOWN_ENABLED !== '1') return null;
  const extension = filename.toLowerCase().split('.').at(-1) ?? 'bin';
  if (!['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'html', 'htm', 'zip'].includes(extension)) return null;

  const tempDir = await mkdtemp(path.join(tmpdir(), 'mywiki-markitdown-'));
  const inputPath = path.join(tempDir, sanitizeTempFilename(filename));
  try {
    await writeNodeFile(inputPath, buffer);
    const commands = [
      ['python', ['-m', 'markitdown', inputPath]],
      ['py', ['-m', 'markitdown', inputPath]],
      ['markitdown', [inputPath]],
    ] as const;

    for (const [command, args] of commands) {
      const result = await runCommand(command, args).catch(() => null);
      if (result?.ok && result.stdout.trim()) {
        return result.stdout.trim();
      }
    }
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function tryMarkItDownUrlExtract(url: string) {
  if (process.env.MARKITDOWN_ENABLED !== '1') return null;
  const commands = [
    ['python', ['-m', 'markitdown', url]],
    ['py', ['-m', 'markitdown', url]],
    ['markitdown', [url]],
  ] as const;

  for (const [command, args] of commands) {
    const result = await runCommand(command, args).catch(() => null);
    if (result?.ok && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return null;
}

async function fetchUrlReadableText(url: string) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MyWiki/0.1 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
  });
  if (!response.ok) {
    throw new Error(`URL fetch failed with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await response.text();
  const trimmed = body.trimStart().toLowerCase();
  if (contentType.includes('html') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    return extractHtmlText(body);
  }
  return body
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeImportHttpUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('url is required.');
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) URLs are supported.');
  }
  return parsed.toString();
}

function isUsefulImportedWebText(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return (
    normalized.length >= 80 &&
    !/(环境异常|完成验证|去验证|访问验证|安全验证|验证码|滑块验证|captcha|verify you are human|server error|521)/i.test(
      normalized,
    )
  );
}

function runCommand(command: string, args: readonly string[]) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, [...args], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: `${command} timed out.` });
    }, 45000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function sanitizeTempFilename(filename: string) {
  const sanitized = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return sanitized || 'input.bin';
}

async function extractWordText(buffer: Buffer, filename: string) {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    if (filename.toLowerCase().endsWith('.doc')) {
      throw new Error('旧版 .doc 文件解析失败，请先另存为 .docx 后再导入。');
    }
    throw error;
  }
}

async function extractPdfText(buffer: Buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractImageText(buffer: Buffer) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['chi_sim', 'eng']);
  try {
    const result = await worker.recognize(buffer);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

async function extractSpreadsheetText(buffer: Buffer, filename: string, mimeType: string) {
  const XLSX = await import('xlsx');
  const extension = filename.toLowerCase().split('.').at(-1) ?? '';
  const workbook =
    extension === 'csv' || mimeType.includes('csv')
      ? XLSX.read(buffer.toString('utf8'), { type: 'string' })
      : extension === 'tsv' || mimeType.includes('tab-separated-values')
        ? XLSX.read(buffer.toString('utf8'), { type: 'string', FS: '\t' })
        : XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const sections: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: '',
    });
    if (rows.length === 0) continue;

    const table = rows
      .slice(0, 500)
      .map((row) =>
        row
          .map((cell) => String(cell ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | '),
      )
      .filter(Boolean)
      .join('\n');

    if (table) {
      const truncated = rows.length > 500 ? `\n\n...该工作表还有 ${rows.length - 500} 行，已保留前 500 行用于编译。` : '';
      sections.push(`## 工作表：${sheetName}\n\n${table}${truncated}`);
    }
  }

  return sections.join('\n\n').trim();
}

async function extractZipText(buffer: Buffer, filename: string) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.values(zip.files)
    .filter((file) => !file.dir)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const sections: string[] = [`# 压缩包：${filename}`];
  let extracted = 0;
  let skipped = 0;

  for (const file of files) {
    if (extracted >= 40) {
      skipped += 1;
      continue;
    }
    const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
    if (!['txt', 'md', 'markdown', 'json', 'jsonl', 'xml', 'html', 'htm', 'csv', 'tsv'].includes(extension)) {
      skipped += 1;
      continue;
    }
    const rawText = await file.async('string');
    const text = extension === 'html' || extension === 'htm' ? extractHtmlText(rawText) : normalizeTextBlock(rawText);
    if (!text) continue;
    extracted += 1;
    sections.push(`## ${file.name}`, '', text.slice(0, 12000));
  }

  if (skipped > 0) {
    sections.push('', `...压缩包中还有 ${skipped} 个未展开文件或超出上限文件。`);
  }
  if (extracted === 0) {
    throw new Error(`${filename} 没有提取到可读文本文件。`);
  }
  return sections.join('\n\n').trim();
}

function extractHtmlText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTextBlock(value: string) {
  return value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMiniMaxModel(model?: string) {
  const configuredModel = model || 'MiniMax-M2.7';
  if (configuredModel.toLowerCase().includes('highspeed')) {
    return 'MiniMax-M2.7';
  }
  return configuredModel;
}

function readPackageMetadata() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
      version?: string;
      repository?: string | { url?: string };
    };
  } catch {
    return {};
  }
}

function normalizeGithubRepo(repository?: string | { url?: string }) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return '';
  const match = raw.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/i);
  return match?.[1] ?? '';
}

function assertUsableDraft(draft: CaptureDraft, providerName: string) {
  const text = `${draft.primaryEntity.title} ${draft.primaryEntity.summary}`;
  const lowQuality = /(无法识别|乱码|无效字符|无意义字符|未命名实体|^未知\s)/.test(text);
  if (lowQuality) {
    throw new Error(`${providerName} returned a low-quality extraction.`);
  }
  return draft;
}

function normalizeComposedAnswer(text: string, fallback: string) {
  const answer = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:text|markdown)?/g, '')
    .replace(/```/g, '')
    .trim();
  if (!answer || answer.length < 6) return fallback;
  return answer;
}
