import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { buildMiniMaxCapturePrompt, normalizeMiniMaxCaptureResponse } from './src/lib/ai/minimaxCapture';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const minimaxApiKey = env.MINIMAX_API_KEY;
  const minimaxModel = env.MINIMAX_MODEL || 'MiniMax-M2.7';
  const minimaxBaseUrl = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/$/, '');

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
              if (!minimaxApiKey) {
                sendJson(res, 500, { error: 'MINIMAX_API_KEY is not configured.' });
                return;
              }

              const body = (await readJsonBody(req)) as { content?: string };
              const content = body.content?.trim();
              if (!content) {
                sendJson(res, 400, { error: 'content is required.' });
                return;
              }

              const response = await fetch(`${minimaxBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${minimaxApiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: minimaxModel,
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
                  response_format: { type: 'json_object' },
                }),
              });

              const data = (await response.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
                error?: { message?: string };
              };

              if (!response.ok || data.error) {
                sendJson(res, response.ok ? 502 : response.status, {
                  error: data.error?.message || 'MiniMax request failed.',
                });
                return;
              }

              const text = data.choices?.[0]?.message?.content;
              if (!text) {
                sendJson(res, 502, { error: 'MiniMax returned empty content.' });
                return;
              }

              sendJson(res, 200, {
                draft: normalizeMiniMaxCaptureResponse(text),
                provider: 'minimax',
                model: minimaxModel,
              });
            } catch (error) {
              sendJson(res, 500, {
                error: error instanceof Error ? error.message : 'AI extraction failed.',
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
