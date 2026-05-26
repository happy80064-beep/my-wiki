import { buildWorkspaceLayout, joinWorkspacePath, type WorkspaceLayout } from './paths';
import {
  buildTemplateWorkspaceFiles,
  getProjectTemplate,
  type ProjectOutputLanguage,
  type ProjectTemplateId,
} from './projectTemplates';

export type WorkspaceStorageAdapter = {
  ensureDir: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  writeTextFile: (path: string, content: string) => Promise<void>;
  writeBinaryFile?: (path: string, dataBase64: string) => Promise<void>;
};

export type WorkspaceFileStorageAdapter = WorkspaceStorageAdapter & {
  readTextFile: (path: string) => Promise<string>;
  readBinaryFileBase64?: (path: string) => Promise<{ dataBase64: string; size: number }>;
  listFiles: (root: string) => Promise<string[]>;
  deletePath?: (root: string, path: string) => Promise<void>;
};

export type InitializeWorkspaceResult = {
  layout: WorkspaceLayout;
  createdDirectories: string[];
  createdFiles: string[];
};

export type InitializeWorkspaceOptions = {
  templateId?: ProjectTemplateId;
  outputLanguage?: ProjectOutputLanguage;
};

const wikiPageDirectories = [
  'entities',
  'concepts',
  'projects',
  'sources',
  'queries',
  'comparisons',
  'synthesis',
  'decisions',
  'meetings',
  'stakeholders',
] as const;

export async function initializeWorkspace(
  storage: WorkspaceStorageAdapter,
  root: string,
  options: InitializeWorkspaceOptions = {},
): Promise<InitializeWorkspaceResult> {
  const layout = buildWorkspaceLayout(root);
  const templateId = options.templateId ?? 'general';
  const outputLanguage = options.outputLanguage ?? 'zh-CN';
  const template = getProjectTemplate(templateId);
  const directories = Array.from(new Set([
    layout.raw,
    layout.rawSources,
    layout.rawAssets,
    layout.wiki,
    ...wikiPageDirectories.map((dir) => joinWorkspacePath(layout.wiki, dir)),
    ...template.wikiDirectories.map((dir) => joinWorkspacePath(layout.root, dir)),
    layout.state,
    joinWorkspacePath(layout.state, 'locks'),
  ]));

  const createdDirectories: string[] = [];
  for (const directory of directories) {
    await storage.ensureDir(directory);
    createdDirectories.push(directory);
  }

  const createdFiles: string[] = [];
  for (const [path, content] of defaultWorkspaceFiles(layout, templateId, outputLanguage)) {
    if (await storage.exists(path)) continue;
    await storage.writeTextFile(path, content);
    createdFiles.push(path);
  }

  return { layout, createdDirectories, createdFiles };
}

function defaultWorkspaceFiles(
  layout: WorkspaceLayout,
  templateId: ProjectTemplateId,
  outputLanguage: ProjectOutputLanguage,
): Array<[string, string]> {
  return [
    [layout.wikiIndex, defaultWikiIndex()],
    [layout.wikiOverview, defaultOverviewPage()],
    [layout.wikiLog, defaultLogPage()],
    ...buildTemplateWorkspaceFiles(layout, templateId, outputLanguage),
    [layout.ingestQueue, '[]\n'],
    [layout.ingestCache, '{}\n'],
    [layout.reviewState, '[]\n'],
    [layout.settings, defaultSettings(templateId, outputLanguage)],
  ];
}

function defaultWikiIndex() {
  return [
    '# Wiki 目录',
    '',
    '## 项目',
    '',
    '## 实体',
    '',
    '## 概念',
    '',
    '## 来源',
    '',
    '## 查询',
    '',
    '## 对比',
    '',
    '## 综合',
    '',
    '## 决策',
    '',
    '## 会议',
    '',
    '## 干系人',
    '',
  ].join('\n');
}

function defaultOverviewPage() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    '---',
    'type: overview',
    'title: MyWiki 总览',
    `created: ${today}`,
    `updated: ${today}`,
    'tags: []',
    'related: []',
    'sources: []',
    '---',
    '',
    '# MyWiki 总览',
    '',
    '## 摘要',
    '',
    '这里会逐步沉淀这个知识库的整体概览。',
    '',
  ].join('\n');
}

function defaultLogPage() {
  return ['# Wiki 日志', '', `## ${new Date().toISOString().slice(0, 10)}`, '', '- 工作区已初始化。', ''].join('\n');
}

function defaultSettings(templateId: ProjectTemplateId, outputLanguage: ProjectOutputLanguage) {
  return `${JSON.stringify(
    {
      version: 1,
      activeWorkspaceSchema: 'mywiki-v2',
      outputLanguage,
      template: templateId,
      providers: [],
      modelRoles: {},
    },
    null,
    2,
  )}\n`;
}
