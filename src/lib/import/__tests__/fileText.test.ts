import { describe, expect, it } from 'vitest';
import { getImportFileKind, isSupportedImportFile } from '@/lib/import/fileText';

describe('import file kind detection', () => {
  it('detects text, word, spreadsheet, html, pdf, and image files', () => {
    expect(getImportFileKind('README.md')).toBe('text');
    expect(getImportFileKind('方案.docx')).toBe('word');
    expect(getImportFileKind('预算.xlsx')).toBe('spreadsheet');
    expect(getImportFileKind('客户.csv')).toBe('spreadsheet');
    expect(getImportFileKind('网页.html')).toBe('html');
    expect(getImportFileKind('扫描.pdf')).toBe('pdf');
    expect(getImportFileKind('截图.png')).toBe('image');
  });

  it('uses mime type as a fallback', () => {
    expect(getImportFileKind('untitled', 'application/pdf')).toBe('pdf');
    expect(getImportFileKind('untitled', 'image/jpeg')).toBe('image');
    expect(getImportFileKind('untitled', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'spreadsheet',
    );
    expect(getImportFileKind('untitled', 'text/html')).toBe('html');
    expect(isSupportedImportFile('archive.zip')).toBe(false);
  });
});
