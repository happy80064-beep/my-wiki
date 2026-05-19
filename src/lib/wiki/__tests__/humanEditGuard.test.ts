import { describe, expect, it } from 'vitest';
import {
  buildHumanEditedWikiPatch,
  mergeAiMarkdownWithHumanSuperseded,
  shouldQueueHumanEditReview,
} from '../humanEditGuard';
import { stripSupersededMarkdown } from '../superseded';
import type { Entity } from '@/types';

const currentMarkdown = [
  '---',
  'type: project',
  'title: "福瑞三期"',
  'tags: [项目]',
  'sources: ["old.xlsx"]',
  '---',
  '',
  '# 福瑞三期',
  '',
  '## 住宅建筑面积',
  '福瑞三期住宅建筑面积为 12 万平方米。',
  '',
  '## 摘要',
  '人工补充：这个项目有养老社区定位。',
].join('\n');

const proposedMarkdown = [
  '---',
  'type: project',
  'title: "福瑞三期"',
  'tags: [项目]',
  'sources: ["new.xlsx"]',
  '---',
  '',
  '# 福瑞三期',
  '',
  '## 住宅建筑面积',
  '福瑞三期住宅建筑面积为 14.2 万平方米。',
  '',
  '## 摘要',
  'AI 重新编译：项目定位包含康养社区和住宅配套。',
].join('\n');

describe('human edited wiki guard', () => {
  it('queues review when AI recompilation differs from a human-edited wiki page', () => {
    const entity = {
      id: 'project_1',
      clientId: 'test',
      type: 'project',
      title: '福瑞三期',
      summary: '',
      tags: ['项目'],
      scenes: ['work'],
      properties: { status: 'active' },
      sourceEntries: ['old-entry'],
      createdAt: 1,
      updatedAt: 1,
      wikiMarkdown: currentMarkdown,
      ...buildHumanEditedWikiPatch(currentMarkdown, 1000),
    } satisfies Entity;

    expect(shouldQueueHumanEditReview(entity, proposedMarkdown)).toBe(true);
  });

  it('merges accepted AI text and marks replaced human text as superseded', () => {
    const merged = mergeAiMarkdownWithHumanSuperseded({
      currentMarkdown,
      proposedMarkdown,
      reason: 'AI recompilation accepted by reviewer.',
      source: 'unit-test',
      now: Date.UTC(2026, 4, 18),
    });

    expect(merged.mode).toBe('section');
    expect(merged.markdown).toContain('14.2 万平方米');
    expect(merged.markdown).toContain('mywiki:superseded');
    expect(merged.markdown).toContain('~~福瑞三期住宅建筑面积为 12 万平方米。~~');

    const activeMarkdown = stripSupersededMarkdown(merged.markdown);
    expect(activeMarkdown).toContain('14.2 万平方米');
    expect(activeMarkdown).not.toContain('12 万平方米');
  });
});
