/**
 * KB Chunker Service
 *
 * Handles text extraction from various file formats and chunking
 * into smaller pieces suitable for embedding and vector search.
 */

let pdfParse;
let mammoth;
let XLSX;

// Lazy-load heavy dependencies
function getPdfParse() {
  if (!pdfParse) pdfParse = require('pdf-parse');
  return pdfParse;
}

function getMammoth() {
  if (!mammoth) mammoth = require('mammoth');
  return mammoth;
}

function getXLSX() {
  if (!XLSX) XLSX = require('xlsx');
  return XLSX;
}

/**
 * Extract plain text from a file buffer based on its type.
 * @param {Buffer} buffer - File content
 * @param {string} fileName - Original file name
 * @param {string} [mimeType] - MIME type
 * @returns {Promise<{ text: string, pages?: number }>}
 */
async function extractText(buffer, fileName, mimeType) {
  const ext = fileName.split('.').pop().toLowerCase();

  // PDF
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    const pdf = getPdfParse();
    const result = await pdf(buffer);
    return { text: result.text, pages: result.numpages };
  }

  // DOCX
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const m = getMammoth();
    const result = await m.extractRawText({ buffer });
    return { text: result.value };
  }

  // XLSX / XLS
  if (ext === 'xlsx' || ext === 'xls' || mimeType?.includes('spreadsheet')) {
    const xlsx = getXLSX();
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const parts = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(sheet);
      if (csv.trim()) {
        parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
    }
    return { text: parts.join('\n\n') };
  }

  // CSV
  if (ext === 'csv' || mimeType === 'text/csv') {
    return { text: buffer.toString('utf-8') };
  }

  // TXT / MD / JSON / other text formats
  if (['txt', 'md', 'json', 'html', 'xml', 'rtf', 'log'].includes(ext) || mimeType?.startsWith('text/')) {
    return { text: buffer.toString('utf-8') };
  }

  // Fallback: try to read as text
  const text = buffer.toString('utf-8');
  if (text && !text.includes('\ufffd')) {
    return { text };
  }

  throw new Error(`Unsupported file type: ${ext} (${mimeType})`);
}

/**
 * Split text into overlapping chunks using a recursive character splitter.
 * @param {string} text - Full text to split
 * @param {Object} [options]
 * @param {number} [options.chunkSize=1000] - Target chunk size in characters
 * @param {number} [options.chunkOverlap=200] - Overlap between chunks
 * @returns {Array<{ text: string, chunkIndex: number, charStart: number, charEnd: number }>}
 */
function chunkText(text, options = {}) {
  const { chunkSize = 1000, chunkOverlap = 200 } = options;

  if (!text || text.trim().length === 0) return [];
  if (text.length <= chunkSize) {
    return [{ text: text.trim(), chunkIndex: 0, charStart: 0, charEnd: text.length }];
  }

  // Separators in priority order (try to split on larger boundaries first)
  const separators = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // If we're not at the end, try to find a good break point
    if (end < text.length) {
      let bestBreak = -1;

      for (const sep of separators) {
        // Look for the last occurrence of separator within the chunk
        const searchRegion = text.substring(start, end);
        const lastIdx = searchRegion.lastIndexOf(sep);
        if (lastIdx > chunkSize * 0.3) { // Don't break too early
          bestBreak = start + lastIdx + sep.length;
          break;
        }
      }

      if (bestBreak > start) {
        end = bestBreak;
      }
    }

    const chunkContent = text.substring(start, end).trim();
    if (chunkContent.length > 0) {
      chunks.push({
        text: chunkContent,
        chunkIndex: chunks.length,
        charStart: start,
        charEnd: end,
      });
    }

    // Move start forward by (end - overlap), but at least 1 char to avoid infinite loops
    start = Math.max(start + 1, end - chunkOverlap);
  }

  return chunks;
}

/**
 * Full pipeline: extract text from file and split into chunks.
 * @param {Buffer} buffer - File content
 * @param {string} fileName - File name
 * @param {string} [mimeType] - MIME type
 * @param {Object} [options]
 * @param {number} [options.chunkSize=1000] - Chunk size in characters
 * @param {number} [options.chunkOverlap=200] - Overlap in characters
 * @returns {Promise<{ extractedText: string, pages?: number, chunks: Array<{ text: string, chunkIndex: number, charStart: number, charEnd: number }>, stats: { totalChunks: number, avgChunkLength: number, totalCharacters: number } }>}
 */
async function processFile(buffer, fileName, mimeType, options = {}) {
  const { text, pages } = await extractText(buffer, fileName, mimeType);
  const chunks = chunkText(text, options);

  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const stats = {
    totalChunks: chunks.length,
    avgChunkLength: chunks.length > 0 ? Math.round(totalChars / chunks.length) : 0,
    totalCharacters: text.length,
  };

  return { extractedText: text, pages, chunks, stats };
}

module.exports = {
  extractText,
  chunkText,
  processFile,
};
