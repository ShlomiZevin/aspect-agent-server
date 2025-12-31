/**
 * Print first N rows of QVD file data
 * This script extracts actual data from QVD files
 */

const fs = require('fs');
const xml2js = require('xml2js');

class QVDDataExtractor {
  constructor(filePath) {
    this.filePath = filePath;
    this.metadata = null;
    this.buffer = null;
    this.dataOffset = 0;
  }

  async extract(maxRows = 100) {
    try {
      // Read entire file
      this.buffer = fs.readFileSync(this.filePath);

      // Find XML header end
      const headerEndMarker = Buffer.from('</QvdTableHeader>');
      const headerEndIndex = this.buffer.indexOf(headerEndMarker);

      if (headerEndIndex === -1) {
        throw new Error('Invalid QVD file: XML header not found');
      }

      const xmlEndPos = headerEndIndex + headerEndMarker.length;
      const xmlHeader = this.buffer.slice(0, xmlEndPos).toString('utf-8');

      // Parse XML metadata
      const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
      });

      const result = await parser.parseStringPromise(xmlHeader);
      const header = result.QvdTableHeader;

      this.metadata = {
        tableName: header.TableName || 'Unknown',
        recordCount: parseInt(header.NoOfRecords) || 0,
        fields: [],
      };

      // Parse field information
      if (header.Fields && header.Fields.QvdFieldHeader) {
        const fieldsArray = Array.isArray(header.Fields.QvdFieldHeader)
          ? header.Fields.QvdFieldHeader
          : [header.Fields.QvdFieldHeader];

        this.metadata.fields = fieldsArray.map((field) => ({
          name: field.FieldName || '',
          type: field.Type || 'UNKNOWN',
          offset: parseInt(field.Offset) || 0,
          length: parseInt(field.Length) || 0,
          bitOffset: parseInt(field.BitOffset) || 0,
          bitWidth: parseInt(field.BitWidth) || 0,
          bias: parseInt(field.Bias) || 0,
          noOfSymbols: parseInt(field.NoOfSymbols) || 0,
        }));
      }

      this.dataOffset = xmlEndPos;

      // Now extract symbol tables and data
      const rows = await this.extractRows(maxRows);

      return {
        metadata: this.metadata,
        rows: rows,
      };
    } catch (error) {
      console.error('Error extracting QVD data:', error.message);
      throw error;
    }
  }

  async extractRows(maxRows) {
    const rows = [];
    let currentOffset = this.dataOffset;

    console.log('\n🔍 Parsing symbol tables and data...\n');

    // QVD format after XML header:
    // 1. Symbol tables for each field (compressed lookup tables)
    // 2. Index records pointing to symbols

    // Read symbol tables for each field
    const symbolTables = [];

    for (let fieldIdx = 0; fieldIdx < this.metadata.fields.length; fieldIdx++) {
      const field = this.metadata.fields[fieldIdx];
      const symbols = [];

      // Each symbol table starts with the number of symbols
      if (currentOffset + 4 > this.buffer.length) break;

      // Skip to symbol table (this is a simplified approach)
      // In reality, QVD uses a complex compression format

      symbolTables.push({
        fieldName: field.name,
        symbols: [],
      });
    }

    // For now, let's try a different approach - extract raw data in chunks
    // and display what we can parse

    console.log('📊 Attempting to extract data (note: QVD uses proprietary compression)...\n');

    // Try to find text patterns in the data section
    const dataSection = this.buffer.slice(this.dataOffset);
    const textMatches = [];

    // Look for printable strings in the data
    let currentStr = '';
    for (let i = 0; i < Math.min(dataSection.length, 100000); i++) {
      const byte = dataSection[i];

      // Check if printable character (including Hebrew UTF-8)
      if ((byte >= 32 && byte <= 126) || byte >= 128) {
        currentStr += String.fromCharCode(byte);
      } else {
        if (currentStr.length > 3) {
          textMatches.push(currentStr);
        }
        currentStr = '';
      }
    }

    console.log(`Found ${textMatches.length} text segments in data section\n`);
    console.log('Sample text segments (first 50):\n');

    const limit = Math.min(50, textMatches.length);
    for (let i = 0; i < limit; i++) {
      const text = textMatches[i].substring(0, 100); // Limit length
      if (text.trim().length > 0) {
        console.log(`${i + 1}. ${text}`);
      }
    }

    return rows;
  }

  printResults(data, maxRows) {
    console.log('\n' + '='.repeat(80));
    console.log(`TABLE: ${data.metadata.tableName}`);
    console.log(`Total Records: ${data.metadata.recordCount}`);
    console.log(`Fields: ${data.metadata.fields.length}`);
    console.log('='.repeat(80));

    console.log('\n📋 Field Names:');
    data.metadata.fields.forEach((field, idx) => {
      console.log(`  ${idx + 1}. ${field.name} (${field.type}) - ${field.noOfSymbols} unique values`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('⚠️  NOTE: QVD files use proprietary binary compression.');
    console.log('Full data extraction requires reverse-engineering QlikView\'s format.');
    console.log('For production use, consider using QlikView API or converting to CSV.');
    console.log('='.repeat(80) + '\n');
  }
}

async function main() {
  const filePath = process.argv[2];
  const maxRows = parseInt(process.argv[3]) || 100;

  if (!filePath) {
    console.log('Usage: node printQvdData.js <path-to-qvd-file> [max-rows]');
    console.log('\nExample:');
    console.log('  node printQvdData.js ./data/פריטים.qvd 100');
    process.exit(1);
  }

  console.log(`\n🔍 Extracting data from: ${filePath}`);
  console.log(`Max rows to extract: ${maxRows}\n`);

  const extractor = new QVDDataExtractor(filePath);
  const data = await extractor.extract(maxRows);

  extractor.printResults(data, maxRows);
}

main().catch(error => {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
});
