import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractImportBlobImages, extractImportBlobText, getImportFileKind, isSupportedImportFile } from '@/lib/import/fileText';

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
    expect(getImportFileKind('archive.zip')).toBe('archive');
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
    expect(getImportFileKind('untitled', 'application/zip')).toBe('archive');
    expect(isSupportedImportFile('archive.zip')).toBe(true);
  });

  it('extracts readable text from HTML, CSV, JSON, XML and ZIP imports', async () => {
    const html = await extractImportBlobText({
      blob: new Blob(['<html><head><title>Report</title></head><body><h1>Revenue</h1><p>Growth 42%</p></body></html>'], {
        type: 'text/html',
      }),
      filename: 'report.html',
      mimeType: 'text/html',
    });
    const csv = await extractImportBlobText({
      blob: new Blob(['name,value\nrevenue,42'], { type: 'text/csv' }),
      filename: 'metrics.csv',
      mimeType: 'text/csv',
    });
    const json = await extractImportBlobText({
      blob: new Blob(['{"project":"MyWiki","status":"ok"}'], { type: 'application/json' }),
      filename: 'data.json',
      mimeType: 'application/json',
    });
    const xml = await extractImportBlobText({
      blob: new Blob(['<root><project>MyWiki</project><status>ok</status></root>'], { type: 'application/xml' }),
      filename: 'data.xml',
      mimeType: 'application/xml',
    });
    const zip = new JSZip();
    zip.file('notes.md', '# Notes\n\nStructured archive content');
    zip.file('data.json', '{"archived":true}');
    zip.file('page.html', '<h1>Archive HTML</h1><p>Readable body</p>');
    const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const archive = await extractImportBlobText({
      blob: new Blob([zipBuffer], { type: 'application/zip' }),
      filename: 'archive.zip',
      mimeType: 'application/zip',
    });

    expect(html).toContain('Growth 42%');
    expect(csv).toContain('revenue | 42');
    expect(json).toContain('MyWiki');
    expect(xml).toContain('<project>MyWiki</project>');
    expect(archive).toContain('notes.md');
    expect(archive).toContain('Structured archive content');
    expect(archive).toContain('Archive HTML');
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
