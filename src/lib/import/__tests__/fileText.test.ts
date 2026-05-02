import { describe, expect, it } from 'vitest';
import { getImportFileKind, isSupportedImportFile } from '@/lib/import/fileText';

describe('import file kind detection', () => {
  it('detects text, word, pdf, and image files', () => {
    expect(getImportFileKind('README.md')).toBe('text');
    expect(getImportFileKind('方案.docx')).toBe('word');
    expect(getImportFileKind('扫描.pdf')).toBe('pdf');
    expect(getImportFileKind('截图.png')).toBe('image');
  });

  it('uses mime type as a fallback', () => {
    expect(getImportFileKind('untitled', 'application/pdf')).toBe('pdf');
    expect(getImportFileKind('untitled', 'image/jpeg')).toBe('image');
    expect(isSupportedImportFile('archive.zip')).toBe(false);
  });
});
