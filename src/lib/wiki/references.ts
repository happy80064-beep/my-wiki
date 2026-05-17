export function normalizeWikiReferenceValue(value: string) {
  let next = value.trim();
  if (!next) return '';

  for (let index = 0; index < 3; index += 1) {
    const unwrapped = next.match(/^\[\[([\s\S]+)\]\]$/)?.[1]?.trim();
    if (!unwrapped || unwrapped === next) break;
    next = unwrapped;
  }

  const pipeIndex = next.indexOf('|');
  if (pipeIndex >= 0) {
    next = next.slice(0, pipeIndex).trim();
  }

  return next.replace(/^\[+/, '').replace(/\]+$/, '').trim();
}

export function unwrapWikiReference(value: string): { target: string; label: string } {
  let raw = value.trim();
  if (!raw) return { target: '', label: '' };

  for (let index = 0; index < 3; index += 1) {
    const match = raw.match(/^\[\[([\s\S]+)\]\]$/);
    if (!match?.[1] || match[1] === raw) break;
    raw = match[1].trim();
  }

  raw = raw.replace(/^\[+/, '').replace(/\]+$/, '').trim();
  const pipeIndex = raw.indexOf('|');
  if (pipeIndex < 0) return { target: raw, label: raw };

  const target = raw.slice(0, pipeIndex).trim();
  const alias = raw.slice(pipeIndex + 1).trim();
  return { target, label: alias || target };
}
