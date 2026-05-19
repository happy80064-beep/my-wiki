const sentenceEndPattern = /[。！？!?；;]/g;
const softBreakPattern = /[，,、：:]/g;

export function compactWikiSummaryText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted || compacted.length <= maxLength) return compacted;

  const hardBoundary = findLastBoundary(compacted, maxLength, sentenceEndPattern);
  if (hardBoundary >= Math.floor(maxLength * 0.45)) {
    return `${compacted.slice(0, hardBoundary + 1).trim()}...`;
  }

  const softBoundary = findLastBoundary(compacted, maxLength, softBreakPattern);
  if (softBoundary >= Math.floor(maxLength * 0.6)) {
    return `${compacted.slice(0, softBoundary).trim()}...`;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function findLastBoundary(text: string, maxLength: number, pattern: RegExp) {
  pattern.lastIndex = 0;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= maxLength) break;
    last = match.index;
  }
  return last;
}
