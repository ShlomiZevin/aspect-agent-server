/**
 * Load CSV Data to PostgreSQL Script - OPTIMIZED WITH COPY
 *
 * Loads all CSV files from GCS into zer4u schema tables
 * Uses PostgreSQL COPY command for maximum speed
 */

require('dotenv').config();
const { Pool } = require('pg');
const gcsService = require('../services/gcs.service');
const csv = require('csv-parser');
const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');
const fs = require('fs').promises;
const path = require('path');
const { from: copyFrom } = require('pg-copy-streams');

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

// ── Inline type conversion ────────────────────────────────────────────────────

/**
 * Convert a single CSV field value to the target PostgreSQL type.
 * Returns the converted string, or '' (empty = NULL in COPY) on bad input.
 */
function convertField(raw, type) {
  const v = raw.trim();
  if (v === '') return '';

  if (type === 'DATE') {
    // Accept DD/MM/YYYY or D/M/YYYY — convert to ISO YYYY-MM-DD
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  if (type === 'INTEGER') {
    // Accept plain integers only; "42.0" or "N/A" → NULL
    if (/^-?\d+$/.test(v)) return v;
    // Tolerate "42.0" style (common in Israeli ERP exports)
    const asNum = Number(v);
    if (!Number.isNaN(asNum) && Number.isFinite(asNum)) return String(Math.round(asNum));
    return '';
  }

  if (type === 'NUMERIC') {
    if (/^-?\d+(\.\d+)?$/.test(v)) return v;
    return '';
  }

  return raw;
}

/**
 * Split a string buffer into complete CSV lines, respecting quoted fields.
 * A \n inside a quoted field is part of the field value, not a row delimiter.
 * Returns { lines: string[], remainder: string } where remainder is any
 * incomplete (unterminated) line at the end of the buffer.
 */
function splitCSVLines(buffer) {
  const lines = [];
  let lineStart = 0;
  let inQuotes = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '"') {
      if (inQuotes && buffer[i + 1] === '"') {
        i++; // skip "" escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(buffer.slice(lineStart, i));
      lineStart = i + 1;
    }
  }

  return { lines, remainder: buffer.slice(lineStart) };
}

/**
 * Parse one CSV line into an array of field strings.
 * Handles double-quote escaping ("") and quoted fields containing commas.
 * Does NOT handle multi-line fields (zer4u data never has embedded newlines).
 */
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }
    if (line[i] === '"') {
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2; }
          else { i++; break; }
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

/**
 * Serialize an array of field strings back to a CSV line.
 * Only adds quotes when the value contains a comma, double-quote, or newline.
 */
function serializeCSVLine(fields) {
  return fields.map(f => {
    if (f === null || f === undefined) return '';
    const s = String(f);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }).join(',');
}

/**
 * Transform stream that converts typed columns inline before they reach COPY.
 *
 * - Reads the CSV header line to determine column positions (then passes it through).
 * - For each subsequent data line, converts fields at typed positions:
 *     DATE    → ISO YYYY-MM-DD  (from DD/MM/YYYY)
 *     INTEGER → clean integer   (strips ".0", non-numeric → empty = NULL)
 *     NUMERIC → clean decimal   (non-numeric → empty = NULL)
 * - TEXT columns are passed through byte-for-byte without touching them.
 * - Uses StringDecoder to handle multi-byte UTF-8 (Hebrew) correctly across
 *   chunk boundaries.
 *
 * If no columns need conversion, returns null (caller uses raw stream).
 */
function createTypeConvertTransform(schema) {
  const typedPositions = schema.columns
    .map((col, idx) => ({ idx, type: col.type, name: col.name }))
    .filter(c => c.type !== 'TEXT');

  if (typedPositions.length === 0) return null;

  // Quality stats: per column, track how many values couldn't be converted.
  // Keeps up to 5 sample bad values for diagnosis.
  const stats = {};
  for (const { name, type } of typedPositions) {
    stats[name] = { type, nullified: 0, samples: [] };
  }

  const decoder = new StringDecoder('utf8');
  let headerSkipped = false;
  let lineBuffer = '';

  const transform = new Transform({
    transform(chunk, _enc, callback) {
      lineBuffer += decoder.write(chunk);
      const { lines, remainder } = splitCSVLines(lineBuffer);
      lineBuffer = remainder;

      let out = '';
      for (const line of lines) {
        if (!headerSkipped) {
          headerSkipped = true;
          out += line + '\n'; // header — pass through unchanged, COPY will skip it
          continue;
        }
        if (line === '') { out += '\n'; continue; }
        out += convertLine(line) + '\n';
      }
      callback(null, Buffer.from(out, 'utf8'));
    },
    flush(callback) {
      const tail = decoder.end() + lineBuffer;
      if (!tail) { callback(); return; }
      const converted = headerSkipped && tail.trim() ? convertLine(tail) : tail;
      callback(null, Buffer.from(converted, 'utf8'));
    },
  });

  function convertLine(line) {
    const fields = parseCSVLine(line);
    for (const { idx, type, name } of typedPositions) {
      if (idx < fields.length) {
        const raw = fields[idx];
        const converted = convertField(raw, type);
        // Track nullification: non-empty value that became empty (= NULL in COPY)
        if (converted === '' && raw.trim() !== '') {
          stats[name].nullified++;
          if (stats[name].samples.length < 5) {
            stats[name].samples.push(raw.trim().slice(0, 60));
          }
        }
        fields[idx] = converted;
      }
    }
    return serializeCSVLine(fields);
  }

  // Returns only columns that actually had issues (nullified > 0).
  transform.getStats = () => {
    const issues = {};
    for (const [name, s] of Object.entries(stats)) {
      if (s.nullified > 0) issues[name] = { type: s.type, nullified: s.nullified, samples: s.samples };
    }
    return issues;
  };

  return transform;
}

/**
 * @param {string} schemaName - target PostgreSQL schema name
 * @param {Function|null} onProgress - progress callback
 * @param {Array|null} schemas - pre-scanned schema definitions; if null, read from local JSON file (CLI use only)
 */
async function loadAllCSVFiles(schemaName = 'zer4u', onProgress = null, schemas = null) {
  // Pool created inside function so multiple sequential calls are safe
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 8,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    connectionTimeoutMillis: 60000,
    idleTimeoutMillis: 600000,
  });
  const startTime = Date.now();

  try {
    // Load analysis
    if (!schemas) {
      // CLI fallback: read from local file
      const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
      schemas = JSON.parse(analysisData);
    }

    // Calculate total size
    const totalSize = schemas.reduce((sum, s) => sum + (parseInt(s.fileSize) || 0), 0);
    console.log(`\n📋 Found ${schemas.length} tables to load`);
    console.log(`📊 Total data size: ${formatBytes(totalSize)}\n`);

    let totalLoaded = 0;
    let totalRows = 0;
    const tableTimes = [];
    const qualityReport = {}; // tableName → { colName: { nullified, samples } }

    // Files <= 100 MB load in parallel (up to 2 at once).
    // Files > 100 MB load one at a time — they saturate DB/network I/O on their own.
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB
    const SMALL_CONCURRENCY = 2;

    const smallFiles = schemas.filter(s => (parseInt(s.fileSize) || 0) <= LARGE_FILE_THRESHOLD);
    const largeFiles = schemas.filter(s => (parseInt(s.fileSize) || 0) > LARGE_FILE_THRESHOLD);

    console.log(`📦 Small files (parallel x${SMALL_CONCURRENCY}): ${smallFiles.length}`);
    console.log(`🐘 Large files (sequential):  ${largeFiles.length}\n`);

    let fileIndex = 0;

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 10000;

    const isRetryable = (err) => {
      const msg = err.message || '';
      return msg.includes('Connection terminated') ||
             msg.includes('EPIPE') ||
             msg.includes('ECONNRESET') ||
             msg.includes('stalled') ||
             msg.includes('write EOF') ||
             err.code === 'EPIPE' ||
             err.code === 'ECONNRESET';
    };

    const loadOne = async (schema, i) => {
      if (schema.error) {
        throw new Error(`${schema.fileName}: analysis error — ${schema.error}`);
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const attemptLabel = attempt > 1 ? ` (attempt ${attempt}/${MAX_RETRIES})` : '';
          console.log(`\n[${i + 1}/${schemas.length}] 📥 Loading: ${schema.fileName} (${formatBytes(schema.fileSize)})${attemptLabel}`);
          if (onProgress) onProgress({ type: 'file_start', file: schema.fileName, index: i, totalFiles: schemas.length });

          const tableStart = Date.now();
          const { rowCount, qualityStats } = await loadCSVFile(schema, schemaName, pool, onProgress);
          const tableTime = Date.now() - tableStart;
          tableTimes.push({ name: schema.tableName, time: tableTime, rows: rowCount });
          const speed = rowCount > 0 ? Math.round(rowCount / (tableTime / 1000)) : 0;
          console.log(`  ✅ ${schema.fileName}: ${rowCount.toLocaleString()} rows in ${(tableTime / 1000).toFixed(1)}s (${speed.toLocaleString()} rows/s)`);
          if (Object.keys(qualityStats).length > 0) {
            qualityReport[schema.tableName] = qualityStats;
            const nullifiedTotal = Object.values(qualityStats).reduce((s, c) => s + c.nullified, 0);
            console.warn(`  ⚠️  ${schema.tableName}: ${nullifiedTotal} values nullified during type conversion`);
          }
          if (onProgress) onProgress({ type: 'file_complete', file: schema.fileName, rows: rowCount, durationMs: tableTime, qualityStats });
          totalLoaded++;
          totalRows += rowCount;
          return;
        } catch (err) {
          if (attempt < MAX_RETRIES && isRetryable(err)) {
            const delay = RETRY_DELAY_MS * attempt;
            console.warn(`  ⚠️  ${schema.fileName} failed (${err.message}) — retrying in ${delay / 1000}s...`);
            if (onProgress) onProgress({ type: 'file_error', file: schema.fileName, error: `${err.message} — retrying (attempt ${attempt}/${MAX_RETRIES})` });
            await new Promise(r => setTimeout(r, delay));
          } else {
            throw err;
          }
        }
      }
    };

    // Phase A: small files in parallel batches
    for (let i = 0; i < smallFiles.length; i += SMALL_CONCURRENCY) {
      const batch = smallFiles.slice(i, i + SMALL_CONCURRENCY).map(schema => loadOne(schema, fileIndex++));
      await Promise.all(batch);
    }

    // Phase B: large files one at a time
    for (const schema of largeFiles) {
      await loadOne(schema, fileIndex++);
    }

    const totalTime = Date.now() - startTime;
    const avgSpeed = totalRows > 0 ? Math.round(totalRows / (totalTime / 1000)) : 0;

    console.log('\n═'.repeat(60));
    console.log('📈 FINAL SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Total tables: ${schemas.length}`);
    console.log(`Successfully loaded: ${totalLoaded}`);
    console.log(`Total rows loaded: ${totalRows.toLocaleString()}`);
    console.log(`Total time: ${formatDuration(totalTime)}`);
    console.log(`Average speed: ${avgSpeed.toLocaleString()} rows/s`);
    console.log('═'.repeat(60));

    // Show slowest tables
    if (tableTimes.length > 0) {
      console.log('\n⏱️  Top 5 slowest tables:');
      tableTimes
        .sort((a, b) => b.time - a.time)
        .slice(0, 5)
        .forEach((t, idx) => {
          console.log(`  ${idx + 1}. ${t.name}: ${(t.time / 1000).toFixed(2)}s (${t.rows.toLocaleString()} rows)`);
        });
    }

    console.log('\n✅ Data loading complete!\n');

    return { qualityReport };

  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Load a single CSV file into its table using COPY
 */
async function loadCSVFile(schema, schemaName, pool, onProgress = null) {
  const client = await pool.connect();

  try {
    const tableName = `${schemaName}.${schema.tableName}`;
    const filePath = schema.filePath;

    // Get column names and sanitize them
    const columns = schema.columns.map(col =>
      sanitizeColumnName(col.name.replace(/^\uFEFF/, '').trim())
    );

    const columnNames = columns.map(c => `"${c}"`).join(', ');

    // Create COPY command
    const copyQuery = `COPY ${tableName} (${columnNames}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;

    console.log(`  🔄 Starting COPY stream...`);

    // Get GCS stream
    const gcsStream = gcsService.getFileStream(filePath);

    // Optional inline type-conversion transform (null if all columns are TEXT)
    const typeTransform = createTypeConvertTransform(schema);

    // Create COPY stream
    const copyStream = client.query(copyFrom(copyQuery));

    let totalRows = 0;
    let lastLogTime = Date.now();
    const startTime = Date.now();

    // Track progress
    let lastProgressRows = 0;
    let lastProgressTime = Date.now();

    const progressTransform = new Transform({
      transform(chunk, encoding, callback) {
        const newlines = chunk.toString().split('\n').length - 1;
        totalRows += newlines;

        if (totalRows > lastProgressRows) {
          lastProgressRows = totalRows;
          lastProgressTime = Date.now();
        }

        // Log progress every 2 seconds
        const now = Date.now();
        if (now - lastLogTime > 2000) {
          const elapsed = (now - startTime) / 1000;
          const speed = Math.round(totalRows / elapsed);
          process.stdout.write(`  ⏳ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(1)}s elapsed...\r`);
          if (onProgress) onProgress({ type: 'file_progress', file: schema.fileName, rowsLoaded: totalRows });
          lastLogTime = now;
        }

        callback(null, chunk);
      }
    });

    // Watchdog: if row count hasn't grown for 5 minutes, the stream is genuinely stuck
    const STALL_MS = 5 * 60 * 1000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressTime > STALL_MS) {
        clearInterval(watchdog);
        gcsStream.destroy(new Error(
          `COPY stalled: no row progress for 5 minutes (stuck at ${lastProgressRows.toLocaleString()} rows)`
        ));
      }
    }, 15_000); // check every 15 seconds

    await new Promise((resolve, reject) => {
      const abort = (err) => { clearInterval(watchdog); reject(err); };

      // Pipeline: GCS → [typeTransform →] progressTransform → COPY
      const upstream = typeTransform
        ? gcsStream.pipe(typeTransform)
        : gcsStream;

      upstream
        .pipe(progressTransform)
        .pipe(copyStream)
        .on('finish', () => {
          clearInterval(watchdog);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = Math.round(totalRows / elapsed);
          process.stdout.write(`  ✅ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(1)}s\n`);
          resolve();
        })
        .on('error', abort);

      gcsStream.on('error', abort);
      if (typeTransform) typeTransform.on('error', abort);
      progressTransform.on('error', abort);
    });

    const rowCount = Math.max(0, totalRows - 1); // Subtract header line
    const qualityStats = typeTransform ? typeTransform.getStats() : {};
    client.release();
    return { rowCount, qualityStats };

  } catch (err) {
    // Destroy the connection — a failed mid-stream COPY leaves the pg protocol
    // in an undefined state; returning it to the pool would corrupt subsequent files.
    client.release(err);
    throw err;
  }
}

/**
 * Sanitize column name (same as in create script)
 */
function sanitizeColumnName(name) {
  return name
    .replace(/\0/g, '')
    .replace(/"/g, '""')
    .trim();
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (size === 0 || isNaN(size)) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return Math.round(size / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Run if called directly
if (require.main === module) {
  loadAllCSVFiles()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { loadAllCSVFiles };
