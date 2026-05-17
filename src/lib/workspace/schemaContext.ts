import { buildWorkspaceLayout, joinWorkspacePath } from './paths';
import { getProjectTemplate, type ProjectTemplateId } from './projectTemplates';
import { loadWorkspaceRegistry, sameWorkspaceRoot } from './registry';
import { canUseWorkspaceStorage, createWorkspaceStorage } from './storage';
import { useWorkspaceRuntimeStore } from './store';

export type WorkspaceSchemaContext = {
  purpose: string;
  schema: string;
  templateId: ProjectTemplateId;
  root?: string;
};

export async function resolveActiveWorkspaceSchemaContext(): Promise<WorkspaceSchemaContext> {
  if (typeof window === 'undefined') return fallbackWorkspaceSchemaContext('general');

  const state = useWorkspaceRuntimeStore.getState();
  const root = state.snapshot?.layout.root ?? state.activeRoot ?? undefined;
  const registry = state.knownWorkspaces.length ? state.knownWorkspaces : loadWorkspaceRegistry();
  const registryItem = registry.find((item) => sameWorkspaceRoot(item.root, root));

  let filePurpose = '';
  let fileSchema = '';
  let settingsTemplateId: ProjectTemplateId | undefined;

  if (root && canUseWorkspaceStorage()) {
    const storage = createWorkspaceStorage();
    const layout = state.snapshot?.layout ?? buildWorkspaceLayout(root);
    const [purposeResult, schemaResult, legacyPurposeResult, legacySchemaResult, settingsResult] = await Promise.all([
      readOptionalText(storage, layout.purpose),
      readOptionalText(storage, layout.schema),
      readOptionalText(storage, joinWorkspacePath(layout.wiki, 'purpose.md')),
      readOptionalText(storage, joinWorkspacePath(layout.wiki, 'schema.md')),
      readOptionalText(storage, layout.settings),
    ]);

    filePurpose = purposeResult || legacyPurposeResult;
    fileSchema = schemaResult || legacySchemaResult;
    settingsTemplateId = parseWorkspaceSettingsTemplateId(settingsResult);
  }

  const templateId = settingsTemplateId ?? registryItem?.templateId ?? 'general';
  const fallback = fallbackWorkspaceSchemaContext(templateId, root);
  return {
    root,
    templateId,
    purpose: filePurpose.trim() || fallback.purpose,
    schema: fileSchema.trim() || fallback.schema,
  };
}

export function fallbackWorkspaceSchemaContext(templateId: ProjectTemplateId = 'general', root?: string): WorkspaceSchemaContext {
  const template = getProjectTemplate(templateId);
  return {
    root,
    templateId,
    purpose: template.purpose,
    schema: template.schema,
  };
}

async function readOptionalText(
  storage: { readTextFile: (path: string) => Promise<string> },
  path: string,
) {
  try {
    return await storage.readTextFile(path);
  } catch {
    return '';
  }
}

function parseWorkspaceSettingsTemplateId(value: string): ProjectTemplateId | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as { template?: unknown };
    return normalizeTemplateId(parsed.template);
  } catch {
    return undefined;
  }
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
