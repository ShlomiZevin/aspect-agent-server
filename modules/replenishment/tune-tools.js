/**
 * Smart Tune — the scoped chat's tools.
 *
 * The tune scope gets TWO tools: the module's existing read tool
 * (fetch_replenishment, with its full scope surface) and this proposal tool.
 * The model's job here is pure scope-mapping: "move all umbrellas to Out of
 * season" becomes {filter: {nameContains: 'מטריה', currentGroup: 'order_now'},
 * targetGroup: 'out_of_season'}. Resolution, preview, snapshot, execution and
 * undo are all deterministic code (services/proposals.service.js).
 *
 * The tool result tells the talker to PRESENT THE PREVIEW and never claim the
 * change happened — Process is a button, not a chat turn (decision D8: the
 * action affordance appears only when the user asked for an action, which is
 * exactly when this tool gets called).
 */

const proposals = require('./services/proposals.service');
const { GROUPS } = require('./groups');

function buildProposeTool(datasetId, { settings = {}, conversationId, scopeContext = {} } = {}) {
  return {
    name: 'propose_group_change',
    description:
      'Propose moving a set of items to another group (order_now / suspicious / '
      + 'out_of_season / fading / new). Call this ONLY when the user asks to move, '
      + 'reject, park or reclassify items — never for read questions. You choose the '
      + 'FILTER (name text, category, current group, supplier, or an explicit SKU '
      + 'list); the system resolves it, shows the user a preview with a Process '
      + 'button, and nothing changes until they press it. Present the preview and its '
      + 'interpretation; NEVER say the items were moved.',
    parameters: {
      type: 'object',
      properties: {
        nameContains: { type: 'string', description: 'Filter: item-name/code text match, as the data spells it.' },
        category: { type: 'string', description: 'Filter: exact catalogue category label as delivered.' },
        subcategory: { type: 'string', description: 'Filter: exact subcategory label as delivered.' },
        supplier: { type: 'string', description: 'Filter: one supplier, exactly as the data names it.' },
        currentGroup: {
          type: 'string', enum: Object.values(GROUPS),
          description: 'Filter: only items currently in this group. Defaults to the group this panel was opened on.',
        },
        skus: { type: 'array', items: { type: 'string' }, description: 'Filter: explicit item codes (resolve exotic vocabulary to these first).' },
        targetGroup: {
          type: 'string', enum: Object.values(GROUPS),
          description: 'Where the matched items should move.',
        },
        reason: { type: 'string', description: 'One short sentence, stored on the items as the note.' },
      },
      required: ['targetGroup'],
    },
    handler: async (params) => {
      const filter = {
        nameContains: params.nameContains || undefined,
        category: params.category || undefined,
        subcategory: params.subcategory || undefined,
        supplier: params.supplier || undefined,
        currentGroup: params.currentGroup || scopeContext.group || undefined,
        skus: Array.isArray(params.skus) && params.skus.length ? params.skus : undefined,
      };
      const out = await proposals.create(datasetId, {
        filter,
        targetGroup: params.targetGroup,
        reason: params.reason,
        conversationId,
        createdBy: scopeContext.userId || 'client',
        settings,
      });

      if (out.error) return { error: out.error, summary: out.error };
      if (out.empty) {
        return {
          summary: `No items matched. ${out.interpreted} The scope was searched, not refused — `
            + 'the term may be spelled differently in the catalogue; try a broader match.',
          proposal: null,
        };
      }
      if (out.overCap) {
        return {
          summary: `${out.matchedCount} items matched — above the ${out.maxItems}-item limit for one change. `
            + 'Narrow the filter (by supplier, category, or a tighter name match) and propose again.',
          proposal: null,
        };
      }
      return {
        summary:
          `PREVIEW ONLY — nothing has moved. Found ${out.count} item(s): ${out.interpreted} `
          + `Proposed move → ${params.targetGroup}. Present this preview; the user must press Process to apply it.`,
        proposal: {
          proposalId: out.proposalId,
          targetGroup: out.targetGroup,
          count: out.count,
          interpreted: out.interpreted,
          expiresAt: out.expiresAt,
          sample: out.sample,
        },
      };
    },
  };
}

module.exports = { buildProposeTool };
