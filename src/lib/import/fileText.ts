import type { EntrySource } from '@/types';

export type ImportFileKind = 'text' | 'word' | 'pdf' | 'image' | 'spreadsheet' | 'html';

export type ImportFileExtraction = {
  filename: string;
  kind: ImportFileKind;
  source: EntrySource;
  text: string;
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

const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'xml']);
const wordExtensions = new Set(['doc', 'docx']);
const spreadsheetExtensions = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods']);
const htmlExtensions = new Set(['html', 'htm']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

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
) {
  const kind = input.kind ?? getImportFileKind(input.filename, input.mimeType);
  if (!kind) {
    throw new Error(`${input.filename} 的格式暂不支持。`);
  }

  onProgress?.({ percent: 8, label: `读取 ${input.filename}` });

  if (kind === 'text' || kind === 'html') {
    const text = await readBlobAsText(input.blob);
    onProgress?.({ percent: 100, label: `${input.filename} 已读取` });
    return (kind === 'html' ? extractHtmlReadableText(text) : text).trim();
  }

  const dataBase64 = await readBlobAsBase64(input.blob, (percent) => {
    onProgress?.({
      percent: Math.min(42, 8 + Math.round(percent * 0.34)),
      label: `读取 ${input.filename}`,
    });
  });

  onProgress?.({ percent: 48, label: `解析 ${input.filename}` });
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
        dataBase64,
      }),
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

export function buildImportedContent(extraction: ImportFileExtraction) {
  return [
    `# 导入文件：${extraction.filename}`,
    '',
    `来源格式：${kindLabels[extraction.kind]}`,
    '',
    extraction.text,
  ].join('\n');
}

function readBlobAsBase64(blob: Blob, onProgress?: (percent: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
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

async function readBlobAsText(blob: Blob) {
  if (typeof blob.text === 'function') {
    return blob.text();
  }

  if (typeof blob.arrayBuffer === 'function') {
    return new TextDecoder().decode(await blob.arrayBuffer());
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(blob);
  });
}

function getExtension(filename: string) {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.at(-1) ?? '' : '';
}

const kindLabels: Record<ImportFileKind, string> = {
  text: '文本',
  word: 'Word',
  pdf: 'PDF',
  image: '图片解析',
  spreadsheet: '表格',
  html: '网页 HTML',
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
