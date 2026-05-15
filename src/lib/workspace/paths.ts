export type WorkspaceLayout = {
  root: string;
  raw: string;
  rawSources: string;
  rawAssets: string;
  purpose: string;
  schema: string;
  wiki: string;
  wikiIndex: string;
  wikiOverview: string;
  wikiLog: string;
  state: string;
  sqlite: string;
  ingestQueue: string;
  ingestCache: string;
  reviewState: string;
  settings: string;
};

const controlChars = /[\0-\x1f]/;
const windowsDriveAbsolute = /^[A-Za-z]:\//;

export function normalizeWorkspacePath(value: string) {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');

  if (normalized === '/') return normalized;
  return normalized.replace(/\/$/, '');
}

export function joinWorkspacePath(first: string, ...rest: string[]) {
  const head = normalizeWorkspacePath(first);
  const tail = rest
    .map((part) => normalizeWorkspacePath(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return tail ? `${head}/${tail}` : head;
}

export function isWorkspaceAbsolutePath(value: string) {
  const normalized = normalizeWorkspacePath(value);
  return normalized.startsWith('/') || windowsDriveAbsolute.test(normalized);
}

export function assertSafeWorkspaceRelativePath(value: string, allowedRoots?: string[]) {
  if (controlChars.test(value)) {
    throw new Error(`Unsafe workspace path contains control characters: ${JSON.stringify(value)}`);
  }

  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized === '.') {
    throw new Error('Unsafe workspace path is empty.');
  }
  if (isWorkspaceAbsolutePath(normalized)) {
    throw new Error(`Unsafe workspace path must be relative: ${value}`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Unsafe workspace path cannot contain traversal: ${value}`);
  }

  if (allowedRoots?.length) {
    const first = segments[0];
    if (!allowedRoots.includes(first)) {
      throw new Error(`Workspace path must be under an allowed root: ${allowedRoots.join(', ')}`);
    }
  }

  return normalized;
}

export function resolveWorkspacePath(root: string, relativePath: string, allowedRoots?: string[]) {
  return joinWorkspacePath(root, assertSafeWorkspaceRelativePath(relativePath, allowedRoots));
}

export function isPathInsideWorkspace(root: string, candidate: string) {
  const normalizedRoot = normalizeWorkspacePath(root).toLowerCase();
  const normalizedCandidate = normalizeWorkspacePath(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function buildWorkspaceLayout(root: string): WorkspaceLayout {
  const normalizedRoot = normalizeWorkspacePath(root);
  const raw = joinWorkspacePath(normalizedRoot, 'raw');
  const wiki = joinWorkspacePath(normalizedRoot, 'wiki');
  const state = joinWorkspacePath(normalizedRoot, '.mywiki');

  return {
    root: normalizedRoot,
    raw,
    rawSources: joinWorkspacePath(raw, 'sources'),
    rawAssets: joinWorkspacePath(raw, 'assets'),
    purpose: joinWorkspacePath(normalizedRoot, 'purpose.md'),
    schema: joinWorkspacePath(normalizedRoot, 'schema.md'),
    wiki,
    wikiIndex: joinWorkspacePath(wiki, 'index.md'),
    wikiOverview: joinWorkspacePath(wiki, 'overview.md'),
    wikiLog: joinWorkspacePath(wiki, 'log.md'),
    state,
    sqlite: joinWorkspacePath(state, 'mywiki.sqlite'),
    ingestQueue: joinWorkspacePath(state, 'ingest-queue.json'),
    ingestCache: joinWorkspacePath(state, 'ingest-cache.json'),
    reviewState: joinWorkspacePath(state, 'review.json'),
    settings: joinWorkspacePath(state, 'settings.json'),
  };
}
