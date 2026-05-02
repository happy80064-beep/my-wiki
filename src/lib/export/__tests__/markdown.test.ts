import { describe, expect, it } from 'vitest';
import {
  buildMarkdownExportFilesFromRecords,
  buildMarkdownZipArchive,
  isSafeExportPath,
  serializeMarkdownExportBundle,
} from '@/lib/export/markdown';
import type { Entity, Entry, Relationship, Task } from '@/types';

describe('markdown export', () => {
  it('exports a safe Obsidian-readable markdown bundle', () => {
    const now = Date.now();
    const entry: Entry = {
      id: 'entry_1',
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
      from: project.id,
      to: topic.id,
      type: 'related-to',
      evidence: [entry.id],
      createdAt: now,
    };
    const task: Task = {
      id: 'task_1',
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
        'index.md',
        'tasks/pending-tasks.md',
        'wiki/project/桌面数字生命体.md',
        'wiki/topic/唤醒方案.md',
        'raw/entries/entry_1.md',
      ]),
    );
    expect(bundle).toContain('<!-- FILE: wiki/project/桌面数字生命体.md -->');
    expect(bundle).toContain('[[wiki/topic/唤醒方案|唤醒方案]]');
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('rejects unsafe export paths', () => {
    expect(isSafeExportPath('../secret.md')).toBe(false);
    expect(isSafeExportPath('C:/secret.md')).toBe(false);
    expect(isSafeExportPath('wiki/project/demo.md')).toBe(true);
  });
});
