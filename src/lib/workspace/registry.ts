import { normalizeWorkspacePath } from './paths';
import type { ProjectOutputLanguage, ProjectTemplateId } from './projectTemplates';
import type { WorkspaceSnapshot } from './service';

export const workspaceRegistryStorageKey = 'mywiki:workspace-registry:v1';

export type WorkspaceRegistryItem = {
  root: string;
  name: string;
  templateId?: ProjectTemplateId;
  outputLanguage?: ProjectOutputLanguage;
  pageCount?: number;
  createdAt: number;
  lastOpenedAt: number;
};

export type WorkspaceRegistryInput = {
  root: string;
  name?: string;
  templateId?: ProjectTemplateId;
  outputLanguage?: ProjectOutputLanguage;
  pageCount?: number;
  createdAt?: number;
  lastOpenedAt?: number;
};

export function loadWorkspaceRegistry(): WorkspaceRegistryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(workspaceRegistryStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return dedupeRegistry(
      parsed
        .map(normalizeRegistryItem)
        .filter((item): item is WorkspaceRegistryItem => Boolean(item)),
    );
  } catch {
    return [];
  }
}

export function saveWorkspaceRegistry(items: WorkspaceRegistryItem[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(workspaceRegistryStorageKey, JSON.stringify(dedupeRegistry(items)));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function upsertWorkspaceRegistryItem(input: WorkspaceRegistryInput) {
  const now = Date.now();
  const root = normalizeWorkspacePath(input.root);
  const existingItems = loadWorkspaceRegistry();
  const existing = existingItems.find((item) => sameWorkspaceRoot(item.root, root));
  const nextItem: WorkspaceRegistryItem = {
    root,
    name: input.name?.trim() || existing?.name || inferWorkspaceName(root),
    templateId: input.templateId ?? existing?.templateId,
    outputLanguage: input.outputLanguage ?? existing?.outputLanguage,
    pageCount: input.pageCount ?? existing?.pageCount,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    lastOpenedAt: input.lastOpenedAt ?? now,
  };
  const nextItems = [
    nextItem,
    ...existingItems.filter((item) => !sameWorkspaceRoot(item.root, root)),
  ];
  saveWorkspaceRegistry(nextItems);
  return nextItems;
}

export function removeWorkspaceRegistryItem(root: string) {
  const normalized = normalizeWorkspacePath(root);
  const nextItems = loadWorkspaceRegistry().filter((item) => !sameWorkspaceRoot(item.root, normalized));
  saveWorkspaceRegistry(nextItems);
  return nextItems;
}

export function buildWorkspaceRegistryInputFromSnapshot(
  root: string,
  snapshot: WorkspaceSnapshot,
  meta: Partial<WorkspaceRegistryInput> = {},
): WorkspaceRegistryInput {
  return {
    root,
    name: meta.name,
    templateId: meta.templateId,
    outputLanguage: meta.outputLanguage,
    pageCount: snapshot.pages.length,
  };
}

export function inferWorkspaceName(root: string) {
  const normalized = normalizeWorkspacePath(root);
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) || 'MyWiki 知识库';
}

export function sameWorkspaceRoot(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  return normalizeWorkspacePath(left).toLowerCase() === normalizeWorkspacePath(right).toLowerCase();
}

function normalizeRegistryItem(value: unknown): WorkspaceRegistryItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WorkspaceRegistryItem>;
  if (typeof raw.root !== 'string' || !raw.root.trim()) return null;
  const root = normalizeWorkspacePath(raw.root);
  const now = Date.now();
  return {
    root,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : inferWorkspaceName(root),
    templateId: normalizeTemplateId(raw.templateId),
    outputLanguage: raw.outputLanguage === 'en-US' || raw.outputLanguage === 'zh-CN' ? raw.outputLanguage : undefined,
    pageCount: typeof raw.pageCount === 'number' && Number.isFinite(raw.pageCount) ? raw.pageCount : undefined,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    lastOpenedAt: typeof raw.lastOpenedAt === 'number' && Number.isFinite(raw.lastOpenedAt) ? raw.lastOpenedAt : now,
  };
}

function normalizeTemplateId(value: unknown): ProjectTemplateId | undefined {
  return value === 'research' ||
    value === 'reading' ||
    value === 'personal-growth' ||
    value === 'business' ||
    value === 'general'
    ? value
    : undefined;
}

function dedupeRegistry(items: WorkspaceRegistryItem[]) {
  const seen = new Set<string>();
  return items
    .slice()
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .filter((item) => {
      const key = normalizeWorkspacePath(item.root).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
