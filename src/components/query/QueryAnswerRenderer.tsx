import { useMemo, type ReactNode } from 'react';
import { stripHiddenAnswerParts } from '@/lib/query/chatHelpers';

type AnswerBlock =
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

export function QueryAnswerRenderer({ content, highlightTerms = [] }: { content: string; highlightTerms?: string[] }) {
  const blocks = useMemo(() => parseAnswerBlocks(stripHiddenAnswerParts(content)), [content]);
  const normalizedHighlightTerms = useMemo(() => normalizeHighlightTerms(highlightTerms), [highlightTerms]);

  return (
    <div className="query-answer space-y-3 text-sm leading-7 text-[#1f2937]">
      {blocks.map((block, index) => renderBlock(block, index, normalizedHighlightTerms))}
    </div>
  );
}

function renderBlock(block: AnswerBlock, index: number, highlightTerms: string[]) {
  if (block.type === 'heading') {
    const className = block.level === 2 ? 'text-base font-semibold text-[#111827]' : 'text-sm font-semibold text-[#1f2937]';
    if (block.level === 2) {
      return (
        <h2 key={index} className={`${className} pt-1`}>
          {renderInline(block.text, highlightTerms)}
        </h2>
      );
    }
    if (block.level === 3) {
      return (
        <h3 key={index} className={className}>
          {renderInline(block.text, highlightTerms)}
        </h3>
      );
    }
    return (
      <h4 key={index} className={className}>
        {renderInline(block.text, highlightTerms)}
      </h4>
    );
  }

  if (block.type === 'list') {
    const ListTag = block.ordered ? 'ol' : 'ul';
    return (
      <ListTag key={index} className={block.ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item, highlightTerms)}</li>
        ))}
      </ListTag>
    );
  }

  if (block.type === 'table') {
    const [header, ...body] = block.rows;
    return (
      <div key={index} className="overflow-x-auto rounded-[8px] border border-[#e5e5e4]">
        <table className="min-w-full border-collapse text-left text-xs leading-6">
          {header ? (
            <thead className="bg-[#f7f7f5] text-[#374151]">
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border-b border-r border-[#e5e5e4] px-3 py-2 font-semibold last:border-r-0">
                    {renderInline(cell, highlightTerms)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white even:bg-[#fbfbfa]">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border-r border-t border-[#ececeb] px-3 py-2 align-top last:border-r-0">
                    {renderInline(cell, highlightTerms)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <p key={index} className="whitespace-pre-wrap">
      {renderInline(block.text, highlightTerms)}
    </p>
  );
}

function parseAnswerBlocks(content: string): AnswerBlock[] {
  const lines = content.replace(/\r/g, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as 2 | 3 | 4, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index]?.includes('|')) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const rows = tableLines
        .filter((tableLine) => !isTableSeparator(tableLine))
        .map(parseTableRow)
        .filter((row) => row.length > 1);
      if (rows.length > 0) blocks.push({ type: 'table', rows });
      continue;
    }

    if (/^\d+[.、]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.trim().match(/^\d+[.、]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.trim().match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index]?.trim() ?? '';
      if (!next) break;
      if (/^#{2,4}\s+/.test(next) || /^\d+[.、]\s+/.test(next) || /^[-*]\s+/.test(next) || isTableStart(lines, index)) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

function isTableStart(lines: string[], index: number) {
  const current = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return current.includes('|') && isTableSeparator(next);
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderInline(text: string, highlightTerms: string[]): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|\[[0-9]+\]|\[\[[^\]]+\]\])/g)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{renderHighlightedText(part.slice(2, -2), highlightTerms, `${index}-strong`)}</strong>;
      }
      if (/^\[[0-9]+\]$/.test(part)) {
        return (
          <span key={index} className="font-medium text-[#155eef]">
            {part}
          </span>
        );
      }
      if (part.startsWith('[[') && part.endsWith(']]')) {
        const linkText = part.slice(2, -2);
        const highlighted = isHighlightMatch(part, highlightTerms) || isHighlightMatch(linkText, highlightTerms);
        return (
          <span key={index} className="font-medium text-[#155eef]">
            {highlighted ? <HighlightMark>{linkText}</HighlightMark> : linkText}
          </span>
        );
      }
      return <span key={index}>{renderHighlightedText(part, highlightTerms, `${index}-text`)}</span>;
    });
}

function normalizeHighlightTerms(terms: string[]) {
  return Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).sort((left, right) => right.length - left.length);
}

function renderHighlightedText(text: string, highlightTerms: string[], keyPrefix: string): ReactNode[] {
  if (highlightTerms.length === 0 || !text) return [text];

  const lowerText = text.toLocaleLowerCase();
  let cursor = 0;
  const nodes: ReactNode[] = [];

  while (cursor < text.length) {
    const match = findNextHighlight(lowerText, cursor, highlightTerms);
    if (!match) {
      nodes.push(text.slice(cursor));
      break;
    }
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(<HighlightMark key={`${keyPrefix}-${match.index}`}>{text.slice(match.index, match.index + match.length)}</HighlightMark>);
    cursor = match.index + match.length;
  }

  return nodes;
}

function findNextHighlight(lowerText: string, start: number, highlightTerms: string[]) {
  let best: { index: number; length: number } | null = null;
  for (const term of highlightTerms) {
    const index = lowerText.indexOf(term.toLocaleLowerCase(), start);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && term.length > best.length)) {
      best = { index, length: term.length };
    }
  }
  return best;
}

function isHighlightMatch(text: string, highlightTerms: string[]) {
  const normalized = text.toLocaleLowerCase();
  return highlightTerms.some((term) => normalized.includes(term.toLocaleLowerCase()));
}

function HighlightMark({ children }: { children: ReactNode }) {
  return (
    <mark
      data-lint-highlight="true"
      className="rounded-[4px] bg-[#fff2a8] px-1 py-0.5 text-[#111827] ring-1 ring-[#e7b008]/40"
    >
      {children}
    </mark>
  );
}
