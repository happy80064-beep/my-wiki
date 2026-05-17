const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(process.argv[2] || 'D:/MyWiki/LDJ-Wiki');
const sourceRoot = path.resolve(process.argv[3] || 'D:/MyWiki/tmp-restore-export');
const payloadPath = path.resolve(process.argv[4] || 'D:/MyWiki/public/restore/mywiki-restore-payload.json');

const today = new Date().toISOString().slice(0, 10);

const typeDirectoryMap = {
  entity: 'entities',
  concept: 'concepts',
  project: 'projects',
  query: 'queries',
  comparison: 'comparisons',
  synthesis: 'synthesis',
  stakeholder: 'stakeholders',
};

main();

function main() {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Restore export not found: ${sourceRoot}`);
  }
  if (!fs.existsSync(payloadPath)) {
    throw new Error(`Restore payload not found: ${payloadPath}`);
  }

  const records = JSON.parse(fs.readFileSync(payloadPath, 'utf8')).records;
  if (!records || !Array.isArray(records.entities) || !Array.isArray(records.entries)) {
    throw new Error('Restore payload records are invalid.');
  }

  const layout = buildLayout(workspaceRoot);
  ensureWorkspaceSkeleton(layout);

  const sourceWikiRoot = path.join(sourceRoot, 'wiki');
  const wikiFiles = listFiles(sourceWikiRoot).filter((file) => file.toLowerCase().endsWith('.md'));
  for (const file of wikiFiles) {
    const legacyType = path.basename(path.dirname(file));
    const original = fs.readFileSync(file, 'utf8');
    const targetType = inferTargetType(original, legacyType);
    const targetDirectory = typeDirectoryMap[targetType] || `${targetType}s`;
    const content = normalizeLegacyWikiMarkdown(original, targetType);
    writeText(path.join(layout.wiki, targetDirectory, path.basename(file)), content);
  }

  const rawEntriesRoot = path.join(sourceRoot, 'raw', 'entries');
  if (fs.existsSync(rawEntriesRoot)) {
    for (const file of listFiles(rawEntriesRoot).filter((item) => item.toLowerCase().endsWith('.md'))) {
      writeText(path.join(layout.rawSources, path.basename(file)), fs.readFileSync(file, 'utf8'));
    }
  }

  const taskFile = path.join(sourceRoot, 'tasks', 'pending-tasks.md');
  if (fs.existsSync(taskFile)) {
    writeText(path.join(layout.wiki, 'tasks', 'pending-tasks.md'), normalizeTaskMarkdown(fs.readFileSync(taskFile, 'utf8')));
  }

  writeText(path.join(workspaceRoot, 'README.md'), buildReadme(records));
  writeText(path.join(layout.wiki, 'index.md'), buildWikiIndex(records.entities));
  writeText(path.join(layout.wiki, 'overview.md'), buildOverview(records));
  writeText(path.join(layout.wiki, 'log.md'), buildLog());
  writeText(path.join(workspaceRoot, 'purpose.md'), buildPurpose());
  writeText(path.join(workspaceRoot, 'schema.md'), buildSchema());
  writeText(path.join(layout.state, 'restore-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeText(path.join(layout.state, 'settings.json'), `${JSON.stringify(
    {
      version: 1,
      activeWorkspaceSchema: 'mywiki-v2',
      outputLanguage: 'zh-CN',
      template: 'business',
      migratedFrom: normalizePath(sourceRoot),
      migratedAt: new Date().toISOString(),
      providers: [],
      modelRoles: {},
    },
    null,
    2,
  )}\n`);

  console.log(`Workspace migrated: ${normalizePath(workspaceRoot)}`);
  console.log(`Wiki pages: ${wikiFiles.length}`);
  console.log(`Raw entries: ${records.entries.length}`);
}

function buildLayout(root) {
  return {
    root,
    raw: path.join(root, 'raw'),
    rawSources: path.join(root, 'raw', 'sources'),
    rawAssets: path.join(root, 'raw', 'assets'),
    wiki: path.join(root, 'wiki'),
    state: path.join(root, '.mywiki'),
  };
}

function ensureWorkspaceSkeleton(layout) {
  [
    layout.raw,
    layout.rawSources,
    layout.rawAssets,
    layout.wiki,
    path.join(layout.wiki, 'entities'),
    path.join(layout.wiki, 'concepts'),
    path.join(layout.wiki, 'projects'),
    path.join(layout.wiki, 'sources'),
    path.join(layout.wiki, 'queries'),
    path.join(layout.wiki, 'comparisons'),
    path.join(layout.wiki, 'synthesis'),
    path.join(layout.wiki, 'decisions'),
    path.join(layout.wiki, 'meetings'),
    path.join(layout.wiki, 'stakeholders'),
    path.join(layout.wiki, 'tasks'),
    layout.state,
    path.join(layout.state, 'locks'),
    path.join(layout.state, 'queues'),
    path.join(layout.state, 'cache'),
    path.join(layout.state, 'conversations'),
    path.join(layout.state, 'lancedb'),
    path.join(layout.root, '.obsidian'),
  ].forEach((directory) => fs.mkdirSync(directory, { recursive: true }));

  writeIfMissing(path.join(layout.state, 'ingest-queue.json'), '[]\n');
  writeIfMissing(path.join(layout.state, 'ingest-cache.json'), '{}\n');
  writeIfMissing(path.join(layout.state, 'review.json'), '[]\n');
}

function inferTargetType(content, legacyType) {
  if (legacyType === 'project') return 'project';
  if (legacyType === 'person' || legacyType === 'event') return 'entity';

  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
  const text = `${title}\n${content}`;
  if (/query-insight|查询洞察|question:|[?？]\s*$/i.test(text)) return 'query';
  if (/(对比|比较|\bvs\b| versus )/i.test(text)) return 'comparison';
  if (/(总结|综述|汇总|复盘|路线图|计划|月报|周报|回顾|纪要总览|观察总览|脉络|全景|图谱|综合分析)/.test(text)) return 'synthesis';
  if (/(干系人|利益相关者|负责人|客户|团队|stakeholder)/i.test(text)) return 'stakeholder';
  return 'concept';
}

function normalizeLegacyWikiMarkdown(content, targetType) {
  let next = content.replace(/\r\n/g, '\n');
  next = next.replace(/^type:\s*"?(?:topic|person|event|project)"?\s*$/m, `type: ${targetType}`);

  if (!/^---\n[\s\S]*?\n---\n/.test(next)) {
    const title = next.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Untitled';
    next = ['---', `type: ${targetType}`, `title: "${escapeYamlString(title)}"`, `created: ${today}`, `updated: ${today}`, 'tags: []', 'sources: []', 'related: []', '---', '', next.trim(), ''].join('\n');
  } else {
    if (!/^title:/m.test(next)) {
      const title = next.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (title) next = next.replace(/^---\n/, `---\ntitle: "${escapeYamlString(title)}"\n`);
    }
    if (!/^created:/m.test(next)) next = next.replace(/^---\n/, `---\ncreated: ${today}\n`);
    if (!/^updated:/m.test(next)) next = next.replace(/^---\n/, `---\nupdated: ${today}\n`);
    if (!/^sources:/m.test(next)) next = next.replace(/^---\n/, '---\nsources: []\n');
    if (!/^related:/m.test(next)) next = next.replace(/^---\n/, '---\nrelated: []\n');
  }

  return `${next.trim()}\n`;
}

function normalizeTaskMarkdown(content) {
  if (content.startsWith('---')) return `${content.trim()}\n`;
  return ['---', 'type: synthesis', 'title: "任务清单"', `created: ${today}`, `updated: ${today}`, 'tags: [tasks]', 'sources: []', 'related: []', '---', '', content.trim(), ''].join('\n');
}

function buildReadme(records) {
  return [
    '# LDJ-Wiki',
    '',
    '这是从浏览器 IndexedDB 测试知识库平移出来的 MyWiki 项目文件夹。',
    '',
    '## 统计',
    '',
    `- Wiki 页面：${records.entities.length}`,
    `- 原始材料：${records.entries.length}`,
    `- 关系：${records.relationships.length}`,
    `- 任务：${records.tasks.length}`,
    '',
    '## 目录',
    '',
    '- `wiki/`：可读写的 Markdown Wiki 页面',
    '- `raw/sources/`：原始捕获材料',
    '- `.mywiki/`：应用状态、队列、缓存和迁移记录',
    '',
  ].join('\n');
}

function buildWikiIndex(entities) {
  const groups = new Map();
  for (const entity of entities) {
    const type = inferTargetType(entity.wikiMarkdown || `# ${entity.title}\n\n${entity.summary || ''}\n${(entity.tags || []).join(' ')}`, entity.type);
    const group = groups.get(type) || [];
    group.push(entity);
    groups.set(type, group);
  }

  const sections = [
    ['project', '项目', 'projects'],
    ['query', '查询', 'queries'],
    ['synthesis', '综合', 'synthesis'],
    ['comparison', '对比', 'comparisons'],
    ['stakeholder', '干系人', 'stakeholders'],
    ['concept', '概念', 'concepts'],
    ['entity', '实体', 'entities'],
  ];

  return [
    '---',
    'type: overview',
    'title: "知识目录"',
    `created: ${today}`,
    `updated: ${today}`,
    'tags: []',
    'sources: []',
    'related: []',
    '---',
    '',
    '# 知识目录',
    '',
    ...sections.flatMap(([type, label, directory]) => [
      `## ${label}`,
      '',
      ...(groups.get(type) || [])
        .slice()
        .sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
        .map((entity) => `- [[wiki/${directory}/${slugify(entity.title)}|${entity.title}]]`),
      '',
    ]),
  ].join('\n');
}

function buildOverview(records) {
  return [
    '---',
    'type: overview',
    'title: "LDJ-Wiki 总览"',
    `created: ${today}`,
    `updated: ${today}`,
    'tags: []',
    'sources: []',
    'related: []',
    '---',
    '',
    '# LDJ-Wiki 总览',
    '',
    '## 摘要',
    '',
    `当前项目由原浏览器 IndexedDB 测试库迁移而来，包含 ${records.entities.length} 个 Wiki 页面、${records.entries.length} 条原始材料、${records.relationships.length} 条关系和 ${records.tasks.length} 个任务。`,
    '',
    '## 重点',
    '',
    '- 页面刷新和更换浏览器后，知识库应优先读取这个项目文件夹。',
    '- 浏览器 IndexedDB 只作为兼容与导入来源，不再作为长期主存储。',
    '',
  ].join('\n');
}

function buildLog() {
  return ['# Wiki 日志', '', `## ${today}`, '', '- 从 tmp-restore-export 平移浏览器测试知识库到项目文件夹。', ''].join('\n');
}

function buildPurpose() {
  return [
    '---',
    'type: purpose',
    'title: "项目用途"',
    'template: business',
    'outputLanguage: zh-CN',
    '---',
    '',
    '# 项目用途',
    '',
    '这个项目用于承载原 MyWiki 本地测试知识库，重点验证文件夹项目、原始材料、Wiki 页面、查询和图谱之间的稳定联动。',
    '',
    '## MVP 边界',
    '',
    '- 项目文件夹是主数据源。',
    '- `raw/sources/` 保留原始材料。',
    '- `wiki/` 保留人类可读的 Markdown 页面。',
    '- `.mywiki/` 保留应用状态、队列和缓存。',
    '',
  ].join('\n');
}

function buildSchema() {
  return [
    '---',
    'type: schema',
    'title: "Wiki Schema — LDJ-Wiki"',
    'template: business',
    '---',
    '',
    '# Wiki Schema — LDJ-Wiki',
    '',
    '## Page Types',
    '',
    '| Type | Directory | Purpose |',
    '|------|-----------|---------|',
    '| project | wiki/projects/ | 项目、业务、课题或长期事项的结构化档案 |',
    '| entity | wiki/entities/ | 人物、机构、事件、产品、工具、组织等具名对象 |',
    '| concept | wiki/concepts/ | 方法、机制、模型、框架、主题和核心概念 |',
    '| source | wiki/sources/ | 论文、文档、网页、访谈、文件等来源说明 |',
    '| query | wiki/queries/ | 仍在调查中的问题、假设和追问 |',
    '| comparison | wiki/comparisons/ | 多个对象、方案或概念的并列比较 |',
    '| synthesis | wiki/synthesis/ | 跨来源、跨主题的综合结论和阶段性判断 |',
    '| overview | wiki/overview.md | 项目级总览 |',
    '| decision | wiki/decisions/ | 重要选择、原因、后果和状态 |',
    '| meeting | wiki/meetings/ | 会议纪要、议程、行动项和后续跟踪 |',
    '| stakeholder | wiki/stakeholders/ | 相关人员、团队、组织及其诉求/职责 |',
    '',
    '## Frontmatter',
    '',
    '所有 Wiki 页面应包含 `type`、`title`、`created`、`updated`、`tags`、`sources`、`related`。',
    '',
  ].join('\n');
}

function listFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(fullPath));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return;
  writeText(file, content);
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function slugify(value) {
  return String(value || 'untitled')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|#{}[\]^`]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96) || 'untitled';
}

function escapeYamlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
