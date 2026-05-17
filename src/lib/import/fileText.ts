import type { EntrySource } from '@/types';
import { isTauriRuntime } from '@/lib/runtime/tauri';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import pdfWorkerUrl from '../../../node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs?url';

export type ImportFileKind = 'text' | 'word' | 'pdf' | 'image' | 'spreadsheet' | 'html' | 'presentation';

export type ImportFileExtraction = {
  filename: string;
  kind: ImportFileKind;
  source: EntrySource;
  text: string;
};

export type ExtractedImportImage = {
  filename: string;
  mimeType: string;
  imageBase64: string;
  contentHash: string;
  origin: 'standalone' | 'docx' | 'pptx' | 'pdf-image' | 'pdf-page';
  pageNumber?: number;
};

export type FileExtractProgress = {
  percent: number;
  label: string;
};

export type ExtractImportBlobInput = {
  blob: Blob;
  filename: string;
  mimeType?: string;
  kind?: ImportFileKind;
};

export type ExtractImportImagesOptions = {
  includePdfPageScreenshots?: boolean;
  maxImages?: number;
  maxPdfPages?: number;
  signal?: AbortSignal;
};

export type ExtractImportBlobTextOptions = {
  signal?: AbortSignal;
};

const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'xml']);
const wordExtensions = new Set(['doc', 'docx']);
const spreadsheetExtensions = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods']);
const presentationExtensions = new Set(['ppt', 'pptx']);
const htmlExtensions = new Set(['html', 'htm']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']);
const imageMimeTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
let pdfWorkerConfigured = false;

export function getImportFileKind(filename: string, mimeType = ''): ImportFileKind | undefined {
  const extension = getExtension(filename);
  const normalizedMimeType = mimeType.toLowerCase();

  if (
    spreadsheetExtensions.has(extension) ||
    normalizedMimeType.includes('spreadsheet') ||
    normalizedMimeType.includes('excel') ||
    normalizedMimeType.includes('csv') ||
    normalizedMimeType.includes('tab-separated-values') ||
    normalizedMimeType.includes('opendocument.spreadsheet')
  ) {
    return 'spreadsheet';
  }
  if (
    presentationExtensions.has(extension) ||
    normalizedMimeType.includes('presentationml') ||
    normalizedMimeType.includes('powerpoint')
  ) {
    return 'presentation';
  }
  if (htmlExtensions.has(extension) || normalizedMimeType.includes('html')) return 'html';
  if (textExtensions.has(extension) || normalizedMimeType.startsWith('text/')) return 'text';
  if (
    wordExtensions.has(extension) ||
    normalizedMimeType.includes('wordprocessingml') ||
    normalizedMimeType === 'application/msword'
  ) {
    return 'word';
  }
  if (extension === 'pdf' || normalizedMimeType === 'application/pdf') return 'pdf';
  if (imageExtensions.has(extension) || normalizedMimeType.startsWith('image/')) return 'image';

  return undefined;
}

export function isSupportedImportFile(filename: string, mimeType = '') {
  return Boolean(getImportFileKind(filename, mimeType));
}

export async function extractImportFileText(
  file: File,
  onProgress?: (progress: FileExtractProgress) => void,
): Promise<ImportFileExtraction> {
  const kind = getImportFileKind(file.name, file.type);
  if (!kind) {
    throw new Error(`${file.name} 的格式暂不支持。`);
  }

  const text = await extractImportBlobText(
    {
      blob: file,
      filename: file.name,
      mimeType: file.type,
      kind,
    },
    onProgress,
  );

  return {
    filename: file.name,
    kind,
    source: kind === 'image' ? 'image' : 'file',
    text,
  };
}

export async function extractImportBlobText(
  input: ExtractImportBlobInput,
  onProgress?: (progress: FileExtractProgress) => void,
  options: ExtractImportBlobTextOptions = {},
) {
  throwIfAborted(options.signal);
  const kind = input.kind ?? getImportFileKind(input.filename, input.mimeType);
  if (!kind) {
    throw new Error(`${input.filename} 的格式暂不支持。`);
  }

  onProgress?.({ percent: 8, label: `读取 ${input.filename}` });

  if (kind === 'text' || kind === 'html') {
    const text = await readBlobAsText(input.blob, options.signal);
    throwIfAborted(options.signal);
    onProgress?.({ percent: 100, label: `${input.filename} 已读取` });
    return (kind === 'html' ? extractHtmlReadableText(text) : text).trim();
  }

  const arrayBuffer = await readBlobAsArrayBuffer(input.blob, (percent) => {
    onProgress?.({
      percent: Math.min(42, 8 + Math.round(percent * 0.34)),
      label: `读取 ${input.filename}`,
    });
  }, options.signal);

  onProgress?.({ percent: 48, label: `解析 ${input.filename}` });
  throwIfAborted(options.signal);
  let browserExtractionError: unknown;
  try {
    const browserText = await extractBrowserReadableText({
      arrayBuffer,
      filename: input.filename,
      mimeType: input.mimeType ?? input.blob.type,
      kind,
      onProgress,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (browserText.trim() || kind === 'image') {
      onProgress?.({ percent: 100, label: `${input.filename} 已解析` });
      return browserText.trim();
    }
  } catch (error) {
    browserExtractionError = error;
  }

  if (!import.meta.env.DEV && isTauriRuntime()) {
    const runtimeText = await extractTextWithTauriRuntime({
      filename: input.filename,
      mimeType: input.mimeType ?? input.blob.type,
      dataBase64: arrayBufferToBase64(arrayBuffer),
    });
    throwIfAborted(options.signal);
    if (runtimeText.trim()) {
      onProgress?.({ percent: 100, label: `${input.filename} 已解析` });
      return runtimeText.trim();
    }
    throw browserExtractionError instanceof Error
      ? browserExtractionError
      : new Error(`${input.filename} 没有提取到可用文本。`);
  }

  let simulatedPercent = 48;
  const timer = window.setInterval(() => {
    simulatedPercent = Math.min(92, simulatedPercent + 3);
    onProgress?.({ percent: simulatedPercent, label: `解析 ${input.filename}` });
  }, 800);

  let payload: { text?: string; error?: string };
  try {
    const response = await fetch('/api/import/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: input.filename,
        mimeType: input.mimeType ?? input.blob.type,
        dataBase64: arrayBufferToBase64(arrayBuffer),
      }),
      signal: options.signal,
    });

    payload = (await response.json()) as { text?: string; error?: string };
    if (!response.ok || !payload.text?.trim()) {
      throw new Error(payload.error || `${input.filename} 没有提取到可用文本。`);
    }
  } finally {
    window.clearInterval(timer);
  }

  onProgress?.({ percent: 100, label: `${input.filename} 已解析` });
  return payload.text.trim();
}

async function extractTextWithTauriRuntime(input: { filename: string; mimeType: string; dataBase64: string }) {
  const result = await tauriInvoke<{ text?: string }>('import_extract_text', {
    request: {
      filename: input.filename,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
    },
  });
  return result.text ?? '';
}

export function buildImportedContent(extraction: ImportFileExtraction) {
  return [
    `# 导入文件：${extraction.filename}`,
    '',
    `来源格式：${kindLabels[extraction.kind]}`,
    '',
    extraction.text,
  ].join('\n');
}

export async function extractImportBlobImages(
  input: ExtractImportBlobInput,
  options: ExtractImportImagesOptions = {},
): Promise<ExtractedImportImage[]> {
  throwIfAborted(options.signal);
  const kind = input.kind ?? getImportFileKind(input.filename, input.mimeType);
  if (!kind) return [];
  const maxImages = options.maxImages ?? 8;
  if (maxImages <= 0) return [];

  const arrayBuffer = await readBlobAsArrayBuffer(input.blob, undefined, options.signal);
  throwIfAborted(options.signal);
  if (kind === 'image') {
    const extension = getExtension(input.filename);
    const mimeType = input.mimeType || imageMimeTypes[extension] || 'image/png';
    return [
      await buildExtractedImage({
        bytes: new Uint8Array(arrayBuffer),
        filename: input.filename,
        mimeType,
        origin: 'standalone',
      }),
    ];
  }

  if (kind === 'word' || kind === 'presentation') {
    return extractOfficeEmbeddedImages(arrayBuffer, kind, maxImages);
  }

  if (kind === 'pdf') {
    return extractPdfImages(arrayBuffer, {
      includePdfPageScreenshots: options.includePdfPageScreenshots,
      maxImages,
      maxPdfPages: options.maxPdfPages ?? 4,
      signal: options.signal,
    });
  }

  return [];
}

function readBlobAsBase64(blob: Blob, onProgress?: (percent: number) => void, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    throwIfAborted(signal);
    const reader = new FileReader();
    signal?.addEventListener(
      'abort',
      () => {
        reader.abort();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.split(',').at(-1) ?? '' : result);
    };
    reader.readAsDataURL(blob);
  });
}

function readBlobAsArrayBuffer(blob: Blob, onProgress?: (percent: number) => void, signal?: AbortSignal) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    throwIfAborted(signal);
    const reader = new FileReader();
    signal?.addEventListener(
      'abort',
      () => {
        reader.abort();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function readBlobAsText(blob: Blob, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (typeof blob.text === 'function') {
    const text = await blob.text();
    throwIfAborted(signal);
    return text;
  }

  if (typeof blob.arrayBuffer === 'function') {
    const buffer = await blob.arrayBuffer();
    throwIfAborted(signal);
    return new TextDecoder().decode(buffer);
  }

  return new Promise<string>((resolve, reject) => {
    throwIfAborted(signal);
    const reader = new FileReader();
    signal?.addEventListener(
      'abort',
      () => {
        reader.abort();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(blob);
  });
}

function getExtension(filename: string) {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.at(-1) ?? '' : '';
}

async function extractBrowserReadableText(input: {
  arrayBuffer: ArrayBuffer;
  filename: string;
  mimeType: string;
  kind: ImportFileKind;
  onProgress?: (progress: FileExtractProgress) => void;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  if (input.kind === 'spreadsheet') {
    input.onProgress?.({ percent: 58, label: `读取表格 ${input.filename}` });
    return extractSpreadsheetText(input.arrayBuffer, input.filename, input.mimeType);
  }

  if (input.kind === 'word') {
    input.onProgress?.({ percent: 58, label: `读取 Word ${input.filename}` });
    return extractWordText(input.arrayBuffer, input.filename);
  }

  if (input.kind === 'pdf') {
    input.onProgress?.({ percent: 58, label: `读取 PDF ${input.filename}` });
    return extractPdfText(input.arrayBuffer);
  }

  if (input.kind === 'presentation') {
    input.onProgress?.({ percent: 58, label: `读取演示文稿 ${input.filename}` });
    return extractPresentationText(input.arrayBuffer, input.filename);
  }

  if (input.kind === 'image') {
    input.onProgress?.({ percent: 100, label: `${input.filename} 已保存，等待视觉描述` });
    return '';
  }

  return '';
}

async function extractSpreadsheetText(arrayBuffer: ArrayBuffer, filename: string, mimeType: string) {
  const XLSX = await import('xlsx');
  const extension = getExtension(filename);
  const workbook =
    extension === 'csv' || mimeType.toLowerCase().includes('csv')
      ? XLSX.read(new TextDecoder().decode(arrayBuffer), { type: 'string' })
      : extension === 'tsv' || mimeType.toLowerCase().includes('tab-separated-values')
        ? XLSX.read(new TextDecoder().decode(arrayBuffer), { type: 'string', FS: '\t' })
        : XLSX.read(arrayBuffer, { type: 'array', cellDates: true });

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

async function extractWordText(arrayBuffer: ArrayBuffer, filename: string) {
  if (getExtension(filename) === 'doc') {
    throw new Error('旧版 .doc 文件解析失败，请先另存为 .docx 后再导入。');
  }
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractOfficeEmbeddedImages(arrayBuffer: ArrayBuffer, kind: ImportFileKind, maxImages: number) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const prefix = kind === 'word' ? 'word/media/' : 'ppt/media/';
  const origin = kind === 'word' ? 'docx' : 'pptx';
  const files = Object.values(zip.files)
    .filter((file) => !file.dir && file.name.startsWith(prefix) && Boolean(imageMimeTypes[getExtension(file.name)]))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    .slice(0, maxImages);

  const images: ExtractedImportImage[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.async('arraybuffer'));
    images.push(
      await buildExtractedImage({
        bytes,
        filename: file.name.split('/').at(-1) ?? file.name,
        mimeType: imageMimeTypes[getExtension(file.name)] ?? 'image/png',
        origin,
      }),
    );
  }
  return images;
}

async function extractPdfText(arrayBuffer: ArrayBuffer) {
  const { PDFParse } = await import('pdf-parse');
  if (!pdfWorkerConfigured) {
    PDFParse.setWorker(pdfWorkerUrl);
    pdfWorkerConfigured = true;
  }
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractPdfImages(
  arrayBuffer: ArrayBuffer,
  options: { includePdfPageScreenshots?: boolean; maxImages: number; maxPdfPages: number; signal?: AbortSignal },
) {
  throwIfAborted(options.signal);
  const { PDFParse } = await import('pdf-parse');
  if (!pdfWorkerConfigured) {
    PDFParse.setWorker(pdfWorkerUrl);
    pdfWorkerConfigured = true;
  }
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const images: ExtractedImportImage[] = [];
    throwIfAborted(options.signal);
    const embedded = await parser.getImage({
      first: options.maxPdfPages,
      imageDataUrl: true,
      imageBuffer: true,
      imageThreshold: 96,
    });
    for (const page of embedded.pages) {
      throwIfAborted(options.signal);
      for (const image of page.images) {
        const fromDataUrl = image.dataUrl ? dataUrlToImage(image.dataUrl) : undefined;
        const bytes = image.data?.length ? image.data : fromDataUrl?.bytes;
        if (!bytes) continue;
        images.push(
          await buildExtractedImage({
            bytes,
            filename: `pdf-page-${page.pageNumber}-${image.name || `image-${images.length + 1}`}.png`,
            mimeType: fromDataUrl?.mimeType ?? 'image/png',
            origin: 'pdf-image',
            pageNumber: page.pageNumber,
          }),
        );
        if (images.length >= options.maxImages) return images;
      }
    }

    if (images.length < options.maxImages && options.includePdfPageScreenshots) {
      throwIfAborted(options.signal);
      const screenshots = await parser.getScreenshot({
        first: options.maxPdfPages,
        desiredWidth: 1280,
        imageDataUrl: true,
        imageBuffer: true,
      });
      for (const page of screenshots.pages) {
        throwIfAborted(options.signal);
        const fromDataUrl = page.dataUrl ? dataUrlToImage(page.dataUrl) : undefined;
        const bytes = page.data?.length ? page.data : fromDataUrl?.bytes;
        if (!bytes) continue;
        images.push(
          await buildExtractedImage({
            bytes,
            filename: `pdf-page-${page.pageNumber}.png`,
            mimeType: fromDataUrl?.mimeType ?? 'image/png',
            origin: 'pdf-page',
            pageNumber: page.pageNumber,
          }),
        );
        if (images.length >= options.maxImages) return images;
      }
    }

    return images;
  } finally {
    await parser.destroy();
  }
}

async function extractPresentationText(arrayBuffer: ArrayBuffer, filename: string) {
  if (getExtension(filename) === 'ppt') {
    throw new Error('旧版 .ppt 文件解析失败，请先另存为 .pptx 后再导入。');
  }

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const slideFiles = Object.values(zip.files)
    .filter((file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file.name))
    .sort((left, right) => getPptxSlideNumber(left.name) - getPptxSlideNumber(right.name));

  const sections: string[] = [];
  for (const file of slideFiles) {
    const xml = await file.async('string');
    const text = extractTextFromOfficeXml(xml);
    if (text) {
      sections.push(`## 幻灯片 ${getPptxSlideNumber(file.name)}\n\n${text}`);
    }
  }

  if (sections.length === 0) {
    throw new Error('PPTX 没有提取到可用文本，请检查文件内容或先导出为 PDF/文本后再导入。');
  }

  return sections.join('\n\n').trim();
}

function getPptxSlideNumber(path: string) {
  return Number(path.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

function extractTextFromOfficeXml(xml: string) {
  if (typeof DOMParser === 'undefined') {
    return '';
  }

  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = document.querySelector('parsererror');
  if (parseError) return '';

  const runs = Array.from(document.getElementsByTagName('*'))
    .filter((element) => element.localName === 't')
    .map((element) => normalizeWhitespace(element.textContent ?? ''))
    .filter(Boolean);

  return runs.join('\n').trim();
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function buildExtractedImage(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  origin: ExtractedImportImage['origin'];
  pageNumber?: number;
}): Promise<ExtractedImportImage> {
  return {
    filename: input.filename,
    mimeType: input.mimeType,
    imageBase64: bytesToBase64(input.bytes),
    contentHash: await hashBytes(input.bytes),
    origin: input.origin,
    pageNumber: input.pageNumber,
  };
}

function dataUrlToImage(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return undefined;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { mimeType: match[1], bytes };
}

async function hashBytes(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    return `fnv1a-${fnv1a(bytes)}`;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fnv1a(bytes: Uint8Array) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const kindLabels: Record<ImportFileKind, string> = {
  text: '文本',
  word: 'Word',
  pdf: 'PDF',
  image: '图片解析',
  spreadsheet: '表格',
  html: '网页 HTML',
  presentation: '演示文稿',
};

function extractHtmlReadableText(html: string) {
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll('script, style, noscript, svg').forEach((node) => node.remove());
    const title = document.title?.trim();
    const bodyText = document.body?.textContent ?? document.documentElement.textContent ?? '';
    return [title ? `# ${title}` : '', normalizeWhitespace(bodyText)].filter(Boolean).join('\n\n');
  }

  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
