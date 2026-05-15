export type FrontmatterPrimitive = string | number | boolean | null;
export type FrontmatterValue = FrontmatterPrimitive | FrontmatterPrimitive[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export type ParsedMarkdownFrontmatter = {
  data: FrontmatterData;
  body: string;
  raw: string;
};

const frontmatterPattern = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export function parseMarkdownFrontmatter(markdown: string): ParsedMarkdownFrontmatter {
  const normalizedMarkdown = markdown.replace(/^\uFEFF/, '').replace(/\r/g, '\n');
  const match = normalizedMarkdown.match(frontmatterPattern);
  if (!match) return { data: {}, body: normalizedMarkdown, raw: '' };

  const data: FrontmatterData = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!parsed) continue;
    data[parsed[1]] = parseFrontmatterValue(parsed[2].trim());
  }

  return {
    data,
    body: normalizedMarkdown.slice(match[0].length),
    raw: match[1],
  };
}

export function stringifyMarkdownFrontmatter(data: FrontmatterData) {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${stringifyFrontmatterValue(value)}`);
  return ['---', ...lines, '---'].join('\n');
}

function parseFrontmatterValue(raw: string): FrontmatterValue {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) return parseInlineArray(raw);
  return stripQuotes(raw);
}

function parseInlineArray(raw: string): FrontmatterPrimitive[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => normalizePrimitive(item));
  } catch {
    // Fall through to a permissive YAML-style inline list parser.
  }

  const body = raw.slice(1, -1).trim();
  if (!body) return [];
  return body.split(',').map((item) => stripQuotes(item.trim()));
}

function stringifyFrontmatterValue(value: FrontmatterValue) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return valueNeedsQuotes(value) ? JSON.stringify(value) : value;
  return String(value);
}

function stripQuotes(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const jsonCandidate = value.startsWith("'")
      ? `"${value.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : value;
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (typeof parsed === 'string') {
        return parsed.replace(/^"(.*)"$/, '$1');
      }
    } catch {
      // Fall through to permissive trimming below.
    }
  }

  return value
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1')
    .replace(/\\"/g, '"');
}

function normalizePrimitive(value: unknown): FrontmatterPrimitive {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as FrontmatterPrimitive;
  }
  return String(value);
}

function valueNeedsQuotes(value: string) {
  return value === '' || /^\s|\s$/.test(value) || /[:#,[\]{}]/.test(value);
}
