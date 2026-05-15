import { scanWikiPages, type WikiPageIndexEntry } from '@/lib/wiki/scanner';
import { buildWorkspaceLayout, joinWorkspacePath } from './paths';
import { buildProjectRoot, type ProjectOutputLanguage, type ProjectTemplateId } from './projectTemplates';
import { initializeWorkspace, type WorkspaceStorageAdapter } from './workspace';
import type { WorkspaceLayout } from './paths';

export type WorkspaceProject = {
  name: string;
  root: string;
  layout: WorkspaceLayout;
  templateId: ProjectTemplateId;
  outputLanguage: ProjectOutputLanguage;
  createdDirectories: string[];
  createdFiles: string[];
  pages: WikiPageIndexEntry[];
};

export type CreateWorkspaceProjectInput = {
  projectName: string;
  parentDirectory: string;
  templateId: ProjectTemplateId;
  outputLanguage?: ProjectOutputLanguage;
};

export async function createWorkspaceProject(
  storage: WorkspaceStorageAdapter & {
    readTextFile: (path: string) => Promise<string>;
    listMarkdownFiles: (wikiRoot: string) => Promise<string[]>;
  },
  input: CreateWorkspaceProjectInput,
): Promise<WorkspaceProject> {
  const projectName = input.projectName.trim();
  const parentDirectory = input.parentDirectory.trim();
  const outputLanguage = input.outputLanguage ?? 'zh-CN';

  if (!projectName) {
    throw new Error('请输入项目名称。');
  }
  if (!parentDirectory) {
    throw new Error('请输入父目录。');
  }

  const root = buildProjectRoot(parentDirectory, projectName);
  const layout = buildWorkspaceLayout(root);
  const existingSettingsPath = joinWorkspacePath(layout.state, 'settings.json');

  if (await storage.exists(existingSettingsPath)) {
    throw new Error('该目录已经是 MyWiki 工作区，请换一个项目名或打开已有工作区。');
  }

  const initialized = await initializeWorkspace(storage, root, {
    templateId: input.templateId,
    outputLanguage,
  });
  const pages = await scanWikiPages(storage, initialized.layout.root);

  return {
    name: projectName,
    root: initialized.layout.root,
    layout: initialized.layout,
    templateId: input.templateId,
    outputLanguage,
    createdDirectories: initialized.createdDirectories,
    createdFiles: initialized.createdFiles,
    pages,
  };
}
