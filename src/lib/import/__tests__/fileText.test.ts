import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractImportBlobImages, getImportFileKind, isSupportedImportFile } from '@/lib/import/fileText';

const tinyPng = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
);

describe('import file kind detection', () => {
  it('detects text, word, spreadsheet, html, pdf, and image files', () => {
    expect(getImportFileKind('README.md')).toBe('text');
    expect(getImportFileKind('方案.docx')).toBe('word');
    expect(getImportFileKind('预算.xlsx')).toBe('spreadsheet');
    expect(getImportFileKind('客户.csv')).toBe('spreadsheet');
    expect(getImportFileKind('网页.html')).toBe('html');
    expect(getImportFileKind('扫描.pdf')).toBe('pdf');
    expect(getImportFileKind('路演.pptx')).toBe('presentation');
    expect(getImportFileKind('截图.png')).toBe('image');
  });

  it('uses mime type as a fallback', () => {
    expect(getImportFileKind('untitled', 'application/pdf')).toBe('pdf');
    expect(getImportFileKind('untitled', 'image/jpeg')).toBe('image');
    expect(getImportFileKind('untitled', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'spreadsheet',
    );
    expect(getImportFileKind('untitled', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(
      'presentation',
    );
    expect(getImportFileKind('untitled', 'text/html')).toBe('html');
    expect(isSupportedImportFile('archive.zip')).toBe(false);
  });

  it('extracts embedded images from docx and pptx containers', async () => {
    const docx = new JSZip();
    docx.file('word/media/image1.png', tinyPng);
    const docxBuffer = await docx.generateAsync({ type: 'arraybuffer' });

    const pptx = new JSZip();
    pptx.file('ppt/media/image1.png', tinyPng);
    const pptxBuffer = await pptx.generateAsync({ type: 'arraybuffer' });

    const docxImages = await extractImportBlobImages({
      blob: new Blob([docxBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      filename: 'audit.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'word',
    });
    const pptxImages = await extractImportBlobImages({
      blob: new Blob([pptxBuffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
      filename: 'audit.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      kind: 'presentation',
    });

    expect(docxImages[0]).toMatchObject({ filename: 'image1.png', mimeType: 'image/png', origin: 'docx' });
    expect(pptxImages[0]).toMatchObject({ filename: 'image1.png', mimeType: 'image/png', origin: 'pptx' });
    expect(docxImages[0]?.contentHash).toBe(pptxImages[0]?.contentHash);
  });
});
