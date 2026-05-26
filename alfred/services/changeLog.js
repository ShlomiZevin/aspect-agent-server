/**
 * agent_log read + write helpers.
 *
 * Append-only. Diffs live in (body_before, body_after); the UI computes
 * them at read time. Rows from one multi-target Apply share an
 * apply_group_id so they can be presented as a single entry.
 */

const { eq, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { agentLog } = require('../../db/schema');
const crypto = require('crypto');

function drizzle() {
  return db.getDrizzle();
}

/**
 * Insert one log row. Returns the inserted row.
 *
 * @param {object} entry
 * @param {string} entry.agentId
 * @param {string} entry.agentName
 * @param {'alfred' | 'manual'} entry.actor
 * @param {string} entry.reason
 * @param {string} [entry.whatChanged]
 * @param {object} entry.bodyBefore
 * @param {object} entry.bodyAfter
 * @param {'agent' | 'crew'} entry.entity
 * @param {string} entry.entityId
 * @param {string} entry.entityName
 * @param {number} [entry.sourceChatId]
 * @param {number} [entry.sourceMsgId]
 * @param {string} [entry.applyGroupId]
 * @param {string} entry.appliedBy
 */
async function insert(entry) {
  const [row] = await drizzle().insert(agentLog).values({
    agentId:       entry.agentId,
    agentName:     entry.agentName || '',
    actor:         entry.actor,
    reason:        entry.reason || '',
    whatChanged:   entry.whatChanged || '',
    bodyBefore:    entry.bodyBefore,
    bodyAfter:     entry.bodyAfter,
    entity:        entry.entity,
    entityId:      entry.entityId,
    entityName:    entry.entityName || '',
    sourceChatId:  entry.sourceChatId != null ? entry.sourceChatId : null,
    sourceMsgId:   entry.sourceMsgId  != null ? entry.sourceMsgId  : null,
    applyGroupId:  entry.applyGroupId || null,
    appliedBy:     entry.appliedBy,
  }).returning();
  return row;
}

/**
 * List rows for an agent, newest first. Same `applyGroupId` rows are
 * returned as-is — UI can group them by that field.
 */
async function listForAgent(agentId, limit = 100) {
  return drizzle()
    .select()
    .from(agentLog)
    .where(eq(agentLog.agentId, agentId))
    .orderBy(desc(agentLog.appliedAt))
    .limit(limit);
}

function newApplyGroupId() {
  return 'apply_' + crypto.randomBytes(8).toString('hex');
}

module.exports = { insert, listForAgent, newApplyGroupId };
