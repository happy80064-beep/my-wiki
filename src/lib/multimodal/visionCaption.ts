import { loadProviderSettings, resolveProviderConfigForRole } from '@/lib/llm/providerSettings';
import { requestConfiguredProviderVision, stripThinking } from '@/lib/llm/runtimeProvider';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { loadMultimodalSettings } from './settings';

export const CAPTION_PROMPT =
  '请为知识库索引客观描述这张图片。需要包含：可见文字原文、图表坐标轴和值、流程图/结构图的框线箭头标签、关键视觉元素。不要猜测，不要评价。输出 2 到 4 句纯文本，不要 Markdown。';

type CaptionImageInput = {
  imageBase64: string;
  mimeType: string;
  filename?: string;
  contentHash?: string;
  ocrText?: string;
};

type CaptionCacheEntry = {
  caption: string;
  capturedAt: string;
  model?: string;
  provider?: string;
};

const cacheKey = 'mywiki.v2.imageCaptionCache';
const ocrCacheKey = 'mywiki.v2.imageOcrCache';

export async function captionImageForWiki(input: CaptionImageInput) {
  const settings = loadMultimodalSettings();
  if (!settings.enabled || !settings.captionStandaloneImages) return undefined;
  const providerResolution = resolveProviderConfigForRole(loadProviderSettings(), 'vision');
  if (providerResolution.error) throw new Error(providerResolution.error);
  const providerConfig = providerResolution.config;
  if (!providerConfig) {
    throw new Error('请先在设置里开启默认 LLM，或为“图片/多模态模型”选择支持 Vision 的模型。');
  }

  const cacheId = input.contentHash || (await sha256Base64(input.imageBase64));
  const cache = readCache();
  const hit = cache[cacheId];
  if (hit?.caption) return hit.caption;

  const result = await requestCaptionWithRetry(input, providerConfig);
  const caption = normalizeCaption(result.caption);
  assertUsableCaption(caption);

  cache[cacheId] = {
    caption,
    capturedAt: new Date().toISOString(),
    provider: result.provider,
    model: result.model,
  };
  writeCache(cache);
  return caption;
}

async function requestCaptionWithRetry(input: CaptionImageInput, providerConfig: NonNullable<ReturnType<typeof resolveProviderConfigForRole>['config']>) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await requestCaptionOnce(input, providerConfig);
      if (result.caption.trim()) return result;
      lastError = '图片视觉描述为空。';
    } catch (error) {
      lastError = error instanceof Error ? error.message : '图片视觉描述失败。';
    }

    if (attempt === 0 && isTransientVisionProviderError(lastError)) {
      await wait(900);
      continue;
    }
    break;
  }

  throw new Error(normalizeVisionProviderError(lastError));
}

async function requestCaptionOnce(input: CaptionImageInput, providerConfig: NonNullable<ReturnType<typeof resolveProviderConfigForRole>['config']>) {
  if (!import.meta.env.DEV && isTauriRuntime()) {
    const result = await requestConfiguredProviderVision(providerConfig, {
      prompt: buildVisionPrompt(input.filename, input.ocrText),
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      maxTokens: 900,
    });
    if (!result.ok) {
      throw new Error(result.error || '图片视觉描述失败。');
    }
    return { caption: result.text, provider: result.providerName, model: result.model };
  }

  const response = await fetch('/api/vision/caption', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      filename: input.filename,
      ocrText: input.ocrText,
      providerConfig,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { caption?: string; provider?: string; model?: string; error?: string };
  if (!response.ok || !body.caption) {
    throw new Error(body.error || '图片视觉描述失败。');
  }
  return { caption: body.caption, provider: body.provider, model: body.model };
}

export async function ocrImageForWiki(input: CaptionImageInput) {
  const settings = loadMultimodalSettings();
  if (!settings.enabled || !settings.includeOcrText) return '';

  const cacheId = input.contentHash || (await sha256Base64(input.imageBase64));
  const cache = readTextCache(ocrCacheKey);
  const hit = cache[cacheId];
  if (hit) return hit;

  let text = '';
  if (!import.meta.env.DEV && isTauriRuntime()) {
    text = await runLocalImageOcr(input).catch(() => '');
  } else {
    text = await requestDevImageOcr(input).catch(() => '');
  }

  const normalized = normalizeOcrText(text);
  if (normalized) {
    cache[cacheId] = normalized;
    writeTextCache(ocrCacheKey, cache);
  }
  return normalized;
}

function buildVisionPrompt(filename?: string, ocrText?: string) {
  return [
    CAPTION_PROMPT,
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

function normalizeOcrText(text: string) {
  return stripThinking(text)
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);
}

function assertUsableCaption(caption: string) {
  if (!caption) throw new Error('图片视觉描述为空。');
  if (isVisionRefusalCaption(caption)) {
    throw new Error('当前图片/多模态模型没有真正读取图片，请换用支持 Vision 的模型或检查该 Provider 的多模态接口格式。');
  }
}

export function isVisionRefusalCaption(value: string) {
  const caption = stripThinking(value).replace(/\s+/g, ' ').trim();
  const directRefusal =
    /(无法|不能|看不到|查看|访问).{0,12}(图片|图像|文件|内容)|提供图片内容|无法直接访问/i.test(caption);
  if (directRefusal) return true;

  const asksForUpload =
    /(请(?:您)?|需要|需).{0,12}(上传|提供|发送|附上).{0,16}(图片|图像|文件)|(?:上传|提供|发送|附上).{0,16}(对应的)?(图片|图像|文件).{0,16}(以便|才能)/i.test(
      caption,
    );
  if (!asksForUpload) return false;

  return !/(图中|图片中|图像中|画面|截图|可见|显示|包含|可以看到|这张图|该图)/i.test(caption);
}

function isTransientVisionProviderError(message: string) {
  return /(访问量|繁忙|忙|拥堵|稍后|重试|rate.?limit|too many requests|temporar|timeout|timed out|429|503|502|504)/i.test(
    message,
  );
}

function normalizeVisionProviderError(message: string) {
  if (!message) return '图片视觉描述失败。';
  if (isTransientVisionProviderError(message)) {
    return `图片/多模态模型服务繁忙或限流，可稍后重试：${message}`;
  }
  return message;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function buildImageKnowledgeMarkdown(input: {
  filename: string;
  caption?: string;
  ocrText?: string;
  rawUrl?: string;
}) {
  const sections = [`# 图片内容捕获：${input.filename}`, ''];
  if (input.rawUrl) {
    sections.push(`![${sanitizeAlt(input.caption || input.filename)}](${input.rawUrl})`, '');
  }
  if (input.caption) {
    sections.push('## 视觉描述', '', input.caption.trim(), '');
  }
  if (input.ocrText?.trim()) {
    sections.push('## OCR 文本', '', input.ocrText.trim(), '');
  }
  sections.push('## 知识库编译提示', '', '以上视觉描述和 OCR 文本应作为图片的可检索内容进入 Wiki 编译链路。');
  return sections.join('\n').trim();
}

function readCache(): Record<string, CaptionCacheEntry> {
  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CaptionCacheEntry>) {
  window.localStorage.setItem(cacheKey, JSON.stringify(cache, null, 2));
}

function readTextCache(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeTextCache(key: string, cache: Record<string, string>) {
  window.localStorage.setItem(key, JSON.stringify(cache, null, 2));
}

function sanitizeAlt(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/]/g, ')').trim();
}

async function sha256Base64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestDevImageOcr(input: CaptionImageInput) {
  const response = await fetch('/api/import/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: input.filename || 'image.png',
      mimeType: input.mimeType,
      dataBase64: input.imageBase64,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { text?: string };
  return response.ok ? body.text ?? '' : '';
}

async function runLocalImageOcr(input: CaptionImageInput) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    workerPath: assetUrl('/tesseract/worker.min.js'),
    corePath: assetUrl('/tesseract-core'),
    langPath: assetUrl('/tessdata'),
    gzip: false,
  });
  try {
    const result = await worker.recognize(`data:${input.mimeType};base64,${input.imageBase64}`);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

function assetUrl(pathname: string) {
  return new URL(pathname, window.location.href).toString().replace(/\/$/, '');
}
