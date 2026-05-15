import { describe, expect, it } from 'vitest';
import {
  buildProjectRoot,
  buildTemplateWorkspaceFiles,
  getProjectTemplate,
  projectTemplates,
  sanitizeProjectDirectoryName,
} from '@/lib/workspace/projectTemplates';
import { buildWorkspaceLayout } from '@/lib/workspace/paths';

describe('project templates', () => {
  it('defaults to Chinese-friendly template content', () => {
    const layout = buildWorkspaceLayout('D:/Knowledge/My Research');
    const files = buildTemplateWorkspaceFiles(layout, 'general', 'zh-CN');

    expect([...files.keys()]).toEqual(['D:/Knowledge/My Research/purpose.md', 'D:/Knowledge/My Research/schema.md']);
    expect(files.get('D:/Knowledge/My Research/purpose.md')).toContain('简体中文');
    expect(files.get('D:/Knowledge/My Research/schema.md')).toContain('## Page Types');
    expect(files.get('D:/Knowledge/My Research/schema.md')).toContain('避免过度建模');
  });

  it('contains the template choices needed by the create project modal', () => {
    expect(projectTemplates.map((template) => template.id)).toEqual([
      'research',
      'reading',
      'personal-growth',
      'business',
      'general',
    ]);
    expect(getProjectTemplate('business').wikiDirectories).toContain('wiki/meetings');
  });

  it('sanitizes project names before joining with parent directory', () => {
    expect(sanitizeProjectDirectoryName(' my research/wiki:2026 ')).toBe('my-research-wiki-2026');
    expect(buildProjectRoot('D:\\Knowledge', ' my research/wiki:2026 ')).toBe('D:/Knowledge/my-research-wiki-2026');
  });
});
