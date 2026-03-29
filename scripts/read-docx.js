/**
 * Read .docx files and output text + tables
 *
 * Usage:
 *   node scripts/read-docx.js <path-to-docx>
 *   node scripts/read-docx.js <path-to-docx> --tables-only
 *   node scripts/read-docx.js <path-to-docx> --json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const filePath = process.argv[2];
const tablesOnly = process.argv.includes('--tables-only');
const jsonOutput = process.argv.includes('--json');

if (!filePath) {
  console.error('Usage: node scripts/read-docx.js <path-to-docx> [--tables-only] [--json]');
  process.exit(1);
}

const absPath = path.resolve(filePath);

if (!fs.existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const pyScript = `
import sys, json
sys.stdout.reconfigure(encoding='utf-8')

try:
    from docx import Document
except ImportError:
    print("ERROR: python-docx not installed. Run: pip install python-docx", file=sys.stderr)
    sys.exit(1)

doc = Document(sys.argv[1])
tables_only = sys.argv[2] == '1'
json_output = sys.argv[3] == '1'

result = { 'paragraphs': [], 'tables': [] }

if not tables_only:
    for p in doc.paragraphs:
        text = p.text.strip()
        if text:
            result['paragraphs'].append(text)

for ti, table in enumerate(doc.tables):
    table_data = []
    for row in table.rows:
        cells = [cell.text.strip() for cell in row.cells]
        table_data.append(cells)
    result['tables'].append({ 'index': ti + 1, 'rows': table_data })

if json_output:
    print(json.dumps(result, ensure_ascii=False, indent=2))
else:
    if not tables_only:
        for p in result['paragraphs']:
            print(p)
        print()

    for table in result['tables']:
        print(f"=== Table {table['index']} ===")
        for row in table['rows']:
            print(' | '.join(row))
        print()
`;

// Write python script to temp file
const tmpFile = path.join(os.tmpdir(), 'read-docx.py');
fs.writeFileSync(tmpFile, pyScript, 'utf-8');

try {
  const output = execSync(
    `python "${tmpFile}" "${absPath}" ${tablesOnly ? '1' : '0'} ${jsonOutput ? '1' : '0'}`,
    {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60000,
    }
  );
  process.stdout.write(output);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(1);
} finally {
  try { fs.unlinkSync(tmpFile); } catch (_) {}
}
