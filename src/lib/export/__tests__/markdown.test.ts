import { describe, expect, it } from 'vitest';
import {
  buildMarkdownExportFilesFromRecords,
  buildMarkdownZipArchive,
  isSafeExportPath,
  serializeMarkdownExportBundle,
} from '@/lib/export/markdown';
import { parseMarkdownExportFileRecords, parseMarkdownExportZip } from '@/lib/export/importMarkdown';
import type { Entity, Entry, Relationship, Task } from '@/types';

describe('markdown export', () => {
  it('exports a safe Obsidian-readable markdown bundle', () => {
    const now = Date.now();
    const entry: Entry = {
      id: 'entry_1',
      clientId: 'test-client',
      content: '桌面生命体的唤醒词是小林。',
      source: 'text',
      capturedAt: now,
      processed: true,
      derivedEntities: ['project_1', 'topic_1'],
      derivedTasks: ['task_1'],
      derivedRelationships: ['rel_1'],
    };
    const project = {
      id: 'project_1',
      clientId: 'test-client',
      type: 'project',
      title: '桌面数字生命体',
      summary: '运行在 Windows 桌面的 AI 生命体。',
      tags: ['AI'],
      scenes: ['work'],
      properties: { status: 'active', wakeWord: '小林' } as unknown as Entity['properties'],
      sourceEntries: [entry.id],
      createdAt: now,
      updatedAt: now,
    } as unknown as Entity;
    const topic: Entity = {
      id: 'topic_1',
      clientId: 'test-client',
      type: 'topic',
      title: '唤醒方案',
      summary: '本地语音唤醒方案。',
      tags: [],
      scenes: ['work'],
      properties: { isPersonal: false, autoCollectedSnippets: [entry.id] },
      sourceEntries: [entry.id],
      createdAt: now,
      updatedAt: now,
    };
    const relationship: Relationship = {
      id: 'rel_1',
      clientId: 'test-client',
      from: project.id,
      to: topic.id,
      type: 'related-to',
      evidence: [entry.id],
      createdAt: now,
    };
    const task: Task = {
      id: 'task_1',
      clientId: 'test-client',
      description: '继续优化唤醒稳定性',
      owner: project.id,
      linkedTo: [topic.id],
      status: 'pending',
      source: entry.id,
      createdAt: now,
    };

    const files = buildMarkdownExportFilesFromRecords({
      entries: [entry],
      entities: [project, topic],
      relationships: [relationship],
      tasks: [task],
    });
    const bundle = serializeMarkdownExportBundle(files);
    const zip = buildMarkdownZipArchive(files, new Date('2026-05-02T00:00:00Z'));

    expect(files.every((file) => isSafeExportPath(file.path))).toBe(true);
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'README.md',
        'wiki/index.md',
        'tasks/pending-tasks.md',
        'wiki/projects/桌面数字生命体.md',
        'wiki/concepts/唤醒方案.md',
        'raw/entries/entry_1.md',
      ]),
    );
    expect(bundle).toContain('<!-- FILE: wiki/projects/桌面数字生命体.md -->');
    expect(bundle).toContain('[[wiki/concepts/唤醒方案|唤醒方案]]');
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('rejects unsafe export paths', () => {
    expect(isSafeExportPath('../secret.md')).toBe(false);
    expect(isSafeExportPath('C:/secret.md')).toBe(false);
    expect(isSafeExportPath('wiki/project/demo.md')).toBe(true);
  });

  it('marks structured-only fallback pages so they are not confused with generated wiki', () => {
    const now = Date.now();
    const entity: Entity = {
      id: 'project_status',
      clientId: 'test-client',
      type: 'project',
      title: '结构化档案页',
      summary: '只有结构化摘要。',
      tags: ['project'],
      scenes: ['work'],
      properties: { status: 'active' },
      sourceEntries: [],
      createdAt: now,
      updatedAt: now,
    };

    const files = buildMarkdownExportFilesFromRecords({
      entries: [],
      entities: [entity],
      relationships: [],
      tasks: [],
    });
    const page = files.find((file) => file.path.includes('结构化档案页'))?.content ?? '';

    expect(page).toContain('mywiki_status: "structured_only"');
    expect(page).toContain('未生成完整 Wiki');
  });

  it('writes source-tagged entities into wiki source pages and the wiki index', () => {
    const now = Date.now();
    const entry: Entry = {
      id: 'entry_source',
      clientId: 'test-client',
      content: '# 导入文件：调研报告.pdf\n\n福瑞三期包含医疗业态。',
      source: 'file',
      capturedAt: now,
      processed: true,
      derivedEntities: ['topic_source'],
      derivedTasks: [],
      derivedRelationships: [],
    };
    const sourceEntity: Entity = {
      id: 'topic_source',
      clientId: 'test-client',
      type: 'topic',
      title: '调研报告',
      summary: '调研报告的来源摘要。',
      tags: ['source', '来源'],
      scenes: ['work'],
      properties: { isPersonal: false, autoCollectedSnippets: [entry.id] },
      sourceEntries: [entry.id],
      createdAt: now,
      updatedAt: now,
    };

    const files = buildMarkdownExportFilesFromRecords({
      entries: [entry],
      entities: [sourceEntity],
      relationships: [],
      tasks: [],
    });
    const paths = files.map((file) => file.path);
    const index = files.find((file) => file.path === 'wiki/index.md')?.content ?? '';
    const sourcePage = files.find((file) => file.path === 'wiki/sources/调研报告.md')?.content ?? '';

    expect(paths).toContain('wiki/sources/调研报告.md');
    expect(index).toContain('## 来源');
    expect(index).toContain('[[wiki/sources/调研报告|调研报告]]');
    expect(sourcePage).toContain('type: "source"');
  });

  it('exports manually edited pages to the folder declared by frontmatter type', () => {
    const now = Date.now();
    const entity: Entity = {
      id: 'project_publication',
      clientId: 'test-client',
      type: 'project',
      title: '出版业',
      summary: '旧摘要。',
      tags: ['项目', '产业链', '出版'],
      scenes: ['work'],
      properties: { status: 'active' },
      sourceEntries: [],
      createdAt: now,
      updatedAt: now,
      wikiMarkdown: [
        '---',
        'type: concept',
        'title: 出版业',
        'tags: ["项目","产业链","出版"]',
        '---',
        '',
        '# 出版业',
        '',
        '## 摘要',
        '出版业应归入概念目录。',
      ].join('\n'),
    };

    const files = buildMarkdownExportFilesFromRecords({
      entries: [],
      entities: [entity],
      relationships: [],
      tasks: [],
    });
    const paths = files.map((file) => file.path);
    const index = files.find((file) => file.path === 'wiki/index.md')?.content ?? '';

    expect(paths).toContain('wiki/concepts/出版业.md');
    expect(paths).not.toContain('wiki/projects/出版业.md');
    expect(index).toContain('## 概念');
    expect(index).toContain('[[wiki/concepts/出版业|出版业]]');
  });

  it('parses a MyWiki markdown zip backup back into records', async () => {
    const now = Date.now();
    const entry: Entry = {
      id: 'entry_restore',
      clientId: 'test-client',
      content: '福瑞三期稳定运营期年均收入为 4.22 亿元。',
      source: 'text',
      capturedAt: now,
      processed: true,
      derivedEntities: ['project_restore'],
      derivedTasks: [],
      derivedRelationships: [],
    };
    const project: Entity = {
      id: 'project_restore',
      clientId: 'test-client',
      type: 'project',
      title: '福瑞三期',
      summary: '福瑞三期项目。',
      tags: ['园区'],
      scenes: ['work'],
      properties: { status: 'active' },
      sourceEntries: [entry.id],
      createdAt: now,
      updatedAt: now,
    };

    const files = buildMarkdownExportFilesFromRecords({
      entries: [entry],
      entities: [project],
      relationships: [],
      tasks: [],
    });
    const zip = buildMarkdownZipArchive(files, new Date('2026-05-02T00:00:00Z'));
    const records = await parseMarkdownExportZip(new Blob([zip], { type: 'application/zip' }));

    expect(records.entries).toHaveLength(1);
    expect(records.entities).toHaveLength(1);
    expect(records.entities[0]).toEqual(expect.objectContaining({ id: project.id, title: project.title }));
    expect(records.entries[0]?.derivedEntities).toContain(project.id);
  });

  it('preserves wiki markdown and source links when restoring from a workspace folder', () => {
    const records = parseMarkdownExportFileRecords([
      {
        path: 'raw/entries/entry_report.md',
        content: [
          '---',
          'id: "entry_report"',
          'type: "raw-entry"',
          'source: "file"',
          'capturedAt: 1779859967907',
          'processed: true',
          '---',
          '',
          '# 捕获原文 entry_report',
          '',
          '## 原文',
          '',
          '# 导入文件：report.pdf',
          '',
          '来源格式：PDF',
          '',
          '福瑞三期项目原文。',
        ].join('\n'),
      },
      {
        path: 'wiki/projects/福瑞三期.md',
        content: [
          '---',
          'id: "project_furui"',
          'type: project',
          'title: "福瑞三期"',
          'created: 2026-05-27',
          'updated: 2026-05-28',
          'tags: ["project"]',
          'sources: ["report.pdf"]',
          'related: ["concepts/价值医疗"]',
          '---',
          '',
          '# 福瑞三期',
          '',
          '## 摘要',
          '这是已经生成的 Wiki 正文。',
        ].join('\n'),
      },
      {
        path: 'wiki/concepts/价值医疗.md',
        content: [
          '---',
          'id: "concept_value"',
          'type: concept',
          'title: "价值医疗"',
          'tags: ["concept"]',
          '---',
          '',
          '# 价值医疗',
          '',
          '## 摘要',
          '价值医疗正文。',
        ].join('\n'),
      },
    ]);

    const project = records.entities.find((entity) => entity.id === 'project_furui');
    expect(project?.wikiMarkdown).toContain('这是已经生成的 Wiki 正文。');
    expect(project?.sourceEntries).toEqual(['entry_report']);
    expect(records.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'project_furui', to: 'concept_value', type: 'related-to' }),
      ]),
    );
  });
});
