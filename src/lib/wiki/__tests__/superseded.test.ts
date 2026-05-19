import { describe, expect, it } from 'vitest';
import { buildSupersededBlock, hasSupersededMarkdown, stripSupersededMarkdown } from '../superseded';

describe('superseded wiki markdown blocks', () => {
  it('keeps old content visible in markdown while removing it from active text', () => {
    const markdown = [
      '# 福瑞三期',
      '',
      '## 住宅建筑面积',
      '住宅建筑面积为 14.2 万平方米。',
      '',
      buildSupersededBlock('住宅建筑面积为 12 万平方米。', {
        reason: 'AI update accepted after human review.',
        supersededAt: Date.UTC(2026, 4, 18),
        source: 'test-case',
      }),
    ].join('\n');

    expect(hasSupersededMarkdown(markdown)).toBe(true);
    expect(markdown).toContain('~~住宅建筑面积为 12 万平方米。~~');

    const activeMarkdown = stripSupersededMarkdown(markdown);
    expect(activeMarkdown).toContain('14.2 万平方米');
    expect(activeMarkdown).not.toContain('12 万平方米');
    expect(activeMarkdown).not.toContain('mywiki:superseded');
  });

  it('also ignores standalone fully struck lines', () => {
    const activeMarkdown = stripSupersededMarkdown(['# 页面', '现行结论。', '~~旧结论。~~'].join('\n'));

    expect(activeMarkdown).toContain('现行结论');
    expect(activeMarkdown).not.toContain('旧结论');
  });
});
