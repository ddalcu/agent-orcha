import { logger } from '../logger.ts';

const TEXT_MEDIA_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.proto',
  '.toml', '.ini', '.cfg', '.env', '.properties',
]);

function isTextMediaType(mediaType: string): boolean {
  if (TEXT_MEDIA_TYPES.has(mediaType)) return true;
  if (mediaType.startsWith('text/')) return true;
  return false;
}

function isTextByFilename(fileName?: string): boolean {
  if (!fileName) return false;
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

export interface ExtractedDocument {
  text: string;
  format: string;
}

/**
 * Extract text content from a base64-encoded file attachment.
 * Returns the extracted text or throws with a user-friendly message.
 */
export async function extractDocumentText(
  base64Data: string,
  mediaType: string,
  fileName?: string,
): Promise<ExtractedDocument> {
  const buffer = Buffer.from(base64Data, 'base64');

  // Images should not go through text extraction
  if (mediaType.startsWith('image/')) {
    throw new Error('Image files should be sent as image content, not extracted as text');
  }

  // Text-based files: decode directly
  if (isTextMediaType(mediaType) || isTextByFilename(fileName)) {
    return { text: buffer.toString('utf-8'), format: 'text' };
  }

  // PDF
  if (mediaType === 'application/pdf') {
    try {
      // @ts-ignore - pdf-parse v1 has no type declarations
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      return { text: result?.text || '(No text content found in PDF)', format: 'pdf' };
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error('PDF support requires pdf-parse. Install it with: npm install pdf-parse');
      }
      throw new Error(`Failed to extract PDF text: ${err.message}`);
    }
  }

  // Word (.docx)
  if (
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName?.toLowerCase().endsWith('.docx')
  ) {
    try {
      // @ts-ignore - mammoth is an optional runtime dependency
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value, format: 'docx' };
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error('Word document support requires mammoth. Install it with: npm install mammoth');
      }
      throw new Error(`Failed to extract Word document text: ${err.message}`);
    }
  }

  // Excel (.xlsx)
  if (
    mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    fileName?.toLowerCase().endsWith('.xlsx')
  ) {
    try {
      // @ts-ignore - exceljs is an optional runtime dependency
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      // @ts-expect-error ExcelJS types expect Buffer but Node 25 Buffer<ArrayBuffer> is compatible at runtime
      await workbook.xlsx.load(buffer);
      const sheets: string[] = [];
      for (const worksheet of workbook.worksheets) {
        const rows: string[] = [];
        worksheet.eachRow((row) => {
          const values = Array.isArray(row.values) ? row.values.slice(1) : [];
          rows.push(values.map((v: any) => v ?? '').join(','));
        });
        sheets.push(`--- Sheet: ${worksheet.name} ---\n${rows.join('\n')}`);
      }
      return { text: sheets.join('\n\n'), format: 'xlsx' };
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error('Excel support requires exceljs. Install it with: npm install exceljs');
      }
      throw new Error(`Failed to extract Excel text: ${err.message}`);
    }
  }

  // PowerPoint (.pptx) — basic XML extraction without extra dependency
  if (
    mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    fileName?.toLowerCase().endsWith('.pptx')
  ) {
    try {
      // .pptx is a ZIP of XML files — extract text from slide XML
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buffer);
      const slides: string[] = [];
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort();

      for (const slideFile of slideFiles) {
        const xml = await zip.files[slideFile]!.async('text');
        // Extract text between <a:t> tags
        const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1]);
        if (texts.length > 0) {
          const slideNum = slideFile.match(/slide(\d+)/)?.[1];
          slides.push(`--- Slide ${slideNum} ---\n${texts.join(' ')}`);
        }
      }
      return { text: slides.join('\n\n') || '(No text content found in presentation)', format: 'pptx' };
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error('PowerPoint support requires jszip. Install it with: npm install jszip');
      }
      throw new Error(`Failed to extract PowerPoint text: ${err.message}`);
    }
  }

  // Try decoding as UTF-8 as a last resort
  try {
    const text = buffer.toString('utf-8');
    // Check if it looks like valid text (no excessive null bytes)
    const nullCount = text.split('\0').length - 1;
    if (nullCount < text.length * 0.01) {
      logger.warn(`[DocumentExtract] Unknown mediaType "${mediaType}", decoded as UTF-8`);
      return { text, format: 'unknown-text' };
    }
  } catch { /* not valid text */ }

  throw new Error(`Unsupported file type: ${mediaType}. Supported: images, PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and text-based files.`);
}
