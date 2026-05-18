export function extractHttpUrlsFromText(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const token of text.split(/\s+/)) {
    const normalized = normalizeHttpUrlForImport(trimUrlToken(token));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

export function normalizeHttpUrlForImport(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function buildWebImportFilename(url: string, title?: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, '');
  const pathParts = parsed.pathname
    .split('/')
    .map((part) => decodeURIComponentSafe(part))
    .filter(Boolean)
    .slice(-3);
  const titlePart = title ? slugifyFilename(title).slice(0, 48) : '';
  const pathPart = pathParts.map(slugifyFilename).filter(Boolean).join('-');
  const stem = [host, titlePart || pathPart || 'page'].map(slugifyFilename).filter(Boolean).join('-');
  return `web-${stem || 'page'}.md`;
}

function trimUrlToken(value: string) {
  return value.replace(/^[<("[\u300a\u300c\u201c]+/, '').replace(/[>)"\]\u300b\u300d\u201d,.;!?，。；！？]+$/, '');
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function slugifyFilename(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
