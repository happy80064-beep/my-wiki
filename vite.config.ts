import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { buildMiniMaxCapturePrompt, normalizeMiniMaxCaptureResponse } from './src/lib/ai/minimaxCapture';
import { buildQueryComposePrompt, type QueryComposePayload } from './src/lib/ai/queryComposer';
import {
  buildQueryPlanPrompt,
  normalizeQueryPlan,
  type QueryPlanRequest,
} from './src/lib/ai/queryPlanner';
import {
  buildCaptureAnalysisPrompt,
  buildCaptureDigestPrompt,
  buildWikiPatchPrompt,
  normalizeCaptureAnalysis,
  normalizeWikiPatchesToCaptureDraft,
  normalizeWikiPatchResponse,
  shouldUseCaptureDigest,
  splitCaptureContentIntoChunks,
} from './src/lib/ai/wikiPatch';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const minimaxApiKey = env.MINIMAX_API_KEY;
  const minimaxModel = normalizeMiniMaxModel(env.MINIMAX_MODEL);
  const minimaxBaseUrl = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/$/, '');
  const deepseekApiKeys = [env.DEEPSEEK_API_KEY, env.DEEPSEEK_API_KEY_FALLBACK].filter(Boolean);
  const deepseekModel = env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const deepseekBaseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'mywiki-minimax-api',
        configureServer(server) {
          server.middlewares.use('/api/capture/extract', async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'Method not allowed' });
              return;
            }

            try {
              const body = (await readJsonBody(req)) as { content?: string; entityIndex?: unknown[] };
              const content = body.content?.trim();
              if (!content) {
                sendJson(res, 400, { error: 'content is required.' });
                return;
              }

              const minimaxResult = minimaxApiKey
                ? await requestOpenAiCompatibleTwoStepCapture({
                    apiKey: minimaxApiKey,
                    baseUrl: minimaxBaseUrl,
                    model: minimaxModel,
                    providerName: 'MiniMax',
                    content,
                    entityIndex: body.entityIndex ?? [],
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
                  extraBody: {
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                  },
                });

                if (deepseekSingleStepResult.ok) {
                  try {
                    sendJson(res, 200, {
                      draft: assertUsableDraft(normalizeMiniMaxCaptureResponse(deepseekSingleStepResult.text), 'DeepSeek'),
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
                    maxTokens: 1200,
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
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
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
            content: buildMiniMaxCapturePrompt(content),
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
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
  entityIndex: unknown[];
  extraBody?: Record<string, unknown>;
}): Promise<{ ok: true; draft: ReturnType<typeof normalizeWikiPatchesToCaptureDraft> } | { ok: false; error: string }> {
  try {
    const structuredContentResult = await prepareContentForStructuredCapture({
      apiKey,
      baseUrl,
      model,
      providerName,
      content,
      extraBody,
    });

    if (!structuredContentResult.ok) return structuredContentResult;
    const structuredContent = structuredContentResult.content;

    const analysisResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureAnalysisPrompt(structuredContent, JSON.stringify(entityIndex.slice(0, 120), null, 2)),
      systemPrompt: '你是 MyWiki 摄入分析 Agent。只输出符合 schema 的 JSON 对象。',
      maxTokens: 2200,
      extraBody,
    });

    if (!analysisResult.ok) return analysisResult;

    const analysis = normalizeCaptureAnalysis(analysisResult.text);
    const patchResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildWikiPatchPrompt(structuredContent, analysis),
      systemPrompt: '你是 MyWiki WikiPatch 生成 Agent。只输出 JSON 对象。',
      maxTokens: 2600,
      extraBody,
    });

    if (!patchResult.ok) return patchResult;

    const patches = normalizeWikiPatchResponse(patchResult.text);
    if (patches.length === 0) {
      return { ok: false, error: `${providerName} did not return usable WikiPatch items.` };
    }

    return { ok: true, draft: normalizeWikiPatchesToCaptureDraft(patches, structuredContent) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${providerName} two-step capture failed.`,
    };
  }
}

async function prepareContentForStructuredCapture({
  apiKey,
  baseUrl,
  model,
  providerName,
  content,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  content: string;
  extraBody?: Record<string, unknown>;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!shouldUseCaptureDigest(content)) {
    return { ok: true, content };
  }

  const chunks = splitCaptureContentIntoChunks(content);
  const digests: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const digestResult = await requestOpenAiCompatibleText({
      apiKey,
      baseUrl,
      model,
      providerName,
      prompt: buildCaptureDigestPrompt(chunks[index], index + 1, chunks.length),
      systemPrompt: '你是 MyWiki 长文档阅读 Agent。只输出 Markdown 阅读摘要，不要输出 JSON。',
      maxTokens: 1600,
      extraBody: withoutJsonResponseFormat(extraBody),
    });

    if (!digestResult.ok) return digestResult;
    digests.push(`## 分块 ${index + 1}/${chunks.length}\n\n${digestResult.text}`);
  }

  return {
    ok: true,
    content: [
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

async function requestOpenAiCompatibleText({
  apiKey,
  baseUrl,
  model,
  providerName,
  prompt,
  systemPrompt,
  maxTokens,
  extraBody,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
  prompt: string;
  systemPrompt: string;
  maxTokens: number;
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

    const text = data.choices?.[0]?.message?.content?.trim();
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

function normalizeMiniMaxModel(model?: string) {
  const configuredModel = model || 'MiniMax-M2.7';
  if (configuredModel.toLowerCase().includes('highspeed')) {
    return 'MiniMax-M2.7';
  }
  return configuredModel;
}

function assertUsableDraft(draft: ReturnType<typeof normalizeMiniMaxCaptureResponse>, providerName: string) {
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
