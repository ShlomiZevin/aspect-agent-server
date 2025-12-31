const fs = require('fs');
const xml2js = require('xml2js');

/**
 * QVD File Parser
 * Parses QlikView Data (.qvd) files which consist of:
 * 1. XML Header with metadata
 * 2. Symbol tables (lookup tables for values)
 * 3. Binary data records
 */
class QVDParser {
  constructor(filePath) {
    this.filePath = filePath;
    this.metadata = null;
    this.symbolTables = [];
    this.records = [];
  }

  /**
   * Parse the QVD file
   * @returns {Object} Parsed data including metadata and records
   */
  async parse() {
    const buffer = fs.readFileSync(this.filePath);

    // Step 1: Extract and parse XML header
    const headerEndMarker = Buffer.from('</QvdTableHeader>');
    const headerEndIndex = buffer.indexOf(headerEndMarker);

    if (headerEndIndex === -1) {
      throw new Error('Invalid QVD file: XML header not found');
    }

    const xmlEndPos = headerEndIndex + headerEndMarker.length;
    const xmlHeader = buffer.slice(0, xmlEndPos).toString('utf-8');

    // Parse XML header
    this.metadata = await this.parseXMLHeader(xmlHeader);

    // Step 2: Parse symbol tables and data
    // The data after XML header contains symbol tables followed by binary records
    const dataBuffer = buffer.slice(xmlEndPos);

    // For now, we'll extract the metadata and basic structure
    // Full binary parsing would require understanding QlikView's compression format

    return {
      metadata: this.metadata,
      filePath: this.filePath,
      dataOffset: xmlEndPos,
      dataSize: dataBuffer.length,
    };
  }

  /**
   * Parse XML header to extract metadata
   * @param {string} xmlHeader - XML header content
   * @returns {Object} Parsed metadata
   */
  async parseXMLHeader(xmlHeader) {
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
    });

    const result = await parser.parseStringPromise(xmlHeader);
    const header = result.QvdTableHeader;

    const metadata = {
      tableName: header.TableName || 'Unknown',
      recordCount: parseInt(header.NoOfRecords) || 0,
      fields: [],
      creatorDoc: header.CreatorDoc || '',
      createUtcTime: header.CreateUtcTime || '',
      sourceCreateUtcTime: header.SourceCreateUtcTime || '',
      lineage: header.Lineage || [],
    };

    // Parse field information
    if (header.Fields && header.Fields.QvdFieldHeader) {
      const fieldsArray = Array.isArray(header.Fields.QvdFieldHeader)
        ? header.Fields.QvdFieldHeader
        : [header.Fields.QvdFieldHeader];

      metadata.fields = fieldsArray.map((field) => ({
        name: field.FieldName || '',
        type: field.Type || 'UNKNOWN',
        offset: parseInt(field.Offset) || 0,
        length: parseInt(field.Length) || 0,
        bitOffset: parseInt(field.BitOffset) || 0,
        bitWidth: parseInt(field.BitWidth) || 0,
        bias: parseInt(field.Bias) || 0,
        numberFormat: field.NumberFormat || {},
        noOfSymbols: parseInt(field.NoOfSymbols) || 0,
        tags: field.Tags || [],
        comment: field.Comment || '',
      }));
    }

    return metadata;
  }

  /**
   * Get a summary of the QVD file
   * @returns {string} Summary string
   */
  getSummary() {
    if (!this.metadata) {
      return 'QVD file not parsed yet';
    }

    let summary = `QVD File: ${this.filePath}\n`;
    summary += `Table Name: ${this.metadata.tableName}\n`;
    summary += `Records: ${this.metadata.recordCount}\n`;
    summary += `Fields (${this.metadata.fields.length}):\n`;

    this.metadata.fields.forEach((field, idx) => {
      summary += `  ${idx + 1}. ${field.name} (${field.type})`;
      if (field.noOfSymbols > 0) {
        summary += ` - ${field.noOfSymbols} unique values`;
      }
      summary += '\n';
    });

    return summary;
  }

  /**
   * Convert metadata to JSON
   * @returns {Object} Metadata as JSON
   */
  toJSON() {
    return {
      metadata: this.metadata,
      filePath: this.filePath,
    };
  }

  /**
   * Get field names
   * @returns {Array<string>} Array of field names
   */
  getFieldNames() {
    return this.metadata?.fields.map((f) => f.name) || [];
  }

  /**
   * Get field information by name
   * @param {string} fieldName - Field name
   * @returns {Object|null} Field information
   */
  getField(fieldName) {
    return this.metadata?.fields.find((f) => f.name === fieldName) || null;
  }
}

module.exports = QVDParser;
