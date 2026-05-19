export const supersededStartPattern = /<!--\s*mywiki:superseded\b[^>]*-->/gi;
export const supersededEndPattern = /<!--\s*\/mywiki:superseded\s*-->/gi;

export type SupersededBlockMeta = {
  reason: string;
  supersededAt: number;
  source?: string;
};

export function buildSupersededBlock(content: string, meta: SupersededBlockMeta) {
  const cleaned = content.trim();
  if (!cleaned) return '';

  const attrs = [
    `reason="${escapeHtmlAttribute(meta.reason)}"`,
    `supersededAt="${new Date(meta.supersededAt).toISOString()}"`,
    meta.source ? `source="${escapeHtmlAttribute(meta.source)}"` : '',
  ].filter(Boolean);

  return [
    `<!-- mywiki:superseded ${attrs.join(' ')} -->`,
    strikeMarkdownBlock(cleaned),
    '<!-- /mywiki:superseded -->',
  ].join('\n');
}

export function stripSupersededMarkdown(markdown: string) {
  let output = markdown;
  let previous = '';

  while (output !== previous) {
    previous = output;
    output = output.replace(
      /<!--\s*mywiki:superseded\b[^>]*-->[\s\S]*?<!--\s*\/mywiki:superseded\s*-->/gi,
      '',
    );
  }

  return output
    .split('\n')
    .filter((line) => !/^~~[\s\S]*~~$/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasSupersededMarkdown(markdown: string) {
  supersededStartPattern.lastIndex = 0;
  return supersededStartPattern.test(markdown);
}

function strikeMarkdownBlock(markdown: string) {
  return markdown
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (/^#{1,6}\s+/.test(trimmed)) return line;
      if (trimmed.startsWith('~~') && trimmed.endsWith('~~')) return line;
      return `~~${line}~~`;
    })
    .join('\n');
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
