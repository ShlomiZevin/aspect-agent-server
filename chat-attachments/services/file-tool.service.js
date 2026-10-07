/**
 * The `query_attached_file` crew tool (task #100): any agent, in a
 * conversation that has an attached spreadsheet, can list / filter / total /
 * calculate over that file's rows exactly — the file's own data, not the
 * client database.
 *
 * Attached per turn from the dispatcher, like module tools: present only while
 * the conversation has a spreadsheet, and removed again when it does not, so
 * a plain conversation never sees it.
 */
const fileQuery = require('./file-query.service');
const attachments = require('./chat-attachments.service');
const tableFormatService = require('../../services/table-format.service');

const TAG = Symbol('chatAttachmentTool');

const TOOL = {
  name: 'query_attached_file',
  description:
    'Run an exact query over a spreadsheet the USER ATTACHED in this conversation (its own data — not the business database). '
    + 'Use it for anything listed, filtered, counted, totalled, averaged or calculated from the file: it covers every row, '
    + 'so never compute such numbers by hand from the sample in the message. Columns are referenced by their labels as '
    + 'listed in the attached-file block. Returns a table the user can view in full and download (also in the file\'s own format).',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'The attached file id, e.g. "att_…" (from the attached-file block).' },
      sheet: { type: 'string', description: 'Sheet name; omit for the main sheet.' },
      filters: {
        type: 'array',
        description: 'Row filters, all must match.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'is_empty', 'not_empty'] },
            value: { type: 'string', description: 'Comparison value (numbers as text are fine). For "in": values separated by |.' },
          },
          required: ['column', 'op'],
        },
      },
      computed: {
        type: 'array',
        description: 'New columns calculated per row, e.g. {"as": "Recommendation", "expr": "[Monthly avg] * 4 - [Stock]"}. '
          + 'Operators + - * / and parentheses, numbers, functions abs(x), round(x, digits), min(a, b), max(a, b); '
          + 'columns in [square brackets].',
        items: { type: 'object', properties: { as: { type: 'string' }, expr: { type: 'string' } }, required: ['as', 'expr'] },
      },
      group_by: { type: 'array', items: { type: 'string' }, description: 'Group rows by these columns.' },
      aggregates: {
        type: 'array',
        description: 'With group_by (or alone, for grand totals).',
        items: {
          type: 'object',
          properties: {
            fn: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] },
            column: { type: 'string' },
            as: { type: 'string' },
          },
          required: ['fn'],
        },
      },
      select: { type: 'array', items: { type: 'string' }, description: 'Columns to return, in order (without group_by). Omit for all columns + computed ones.' },
      sort: {
        type: 'array',
        items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] },
      },
      limit: { type: 'number', description: 'Max rows to return (default: all, up to 5000).' },
      table_title: { type: 'string', description: 'A short title for the result table, in the user\'s language.' },
    },
    required: ['file_id'],
  },
  handler: async (params = {}) => {
    const { file_id: fileId, table_title: tableTitle, ...spec } = params;
    try {
      const out = await fileQuery.queryFile(fileId, spec);
      const result = tableFormatService.buildFetchResult({
        question: tableTitle || 'Query over the attached file',
        tableTitle,
        schema: null,
        result: { data: out.rows, columns: out.columns, rowCount: out.rows.length },
      });
      result.summary = `From the attached file (sheet "${out.sheet}", ${out.matchedRows} of ${out.totalRows} rows matched). `
        + result.summary;
      // What the chat's table viewer re-runs to show / export the full result
      // later (the rows themselves are never persisted on the thinking step).
      result.fileQuery = { attachmentId: fileId, spec };
      return result;
    } catch (err) {
      return { success: false, error: err.message, summary: `The file query failed: ${err.message}. Fix the parameters and try again.` };
    }
  },
};

/**
 * Add the tool to this turn's crew when the conversation has an attached
 * spreadsheet; take it away otherwise. Never throws — a chat turn must not
 * fail because this check did.
 */
async function attachTo(crew, conversationId) {
  if (!crew) return false;
  const base = (Array.isArray(crew.tools) ? crew.tools : []).filter(t => !t[TAG]);
  let has = false;
  try {
    has = await attachments.conversationHasSpreadsheet(conversationId);
  } catch (err) {
    console.warn(`[chat-attachments] tool check failed: ${err.message}`);
  }
  crew.tools = has ? [...base, { ...TOOL, [TAG]: true }] : base;
  return has;
}

module.exports = { attachTo, TOOL };
