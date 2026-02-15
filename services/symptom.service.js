const db = require('./db.pg');
const { userSymptoms, users, conversations } = require('../db/schema');
const { eq, and, desc } = require('drizzle-orm');

/**
 * Symptom Service
 *
 * Handles DB operations for symptom tracking during assessments
 */
class SymptomService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  /**
   * Record a symptom reported by the user
   * @param {Object} params - Symptom data
   * @param {number} params.userId - User ID
   * @param {number} params.conversationId - Conversation ID
   * @param {string} params.userProvidedName - User's exact words describing the symptom
   * @param {string} params.symptomGroup - emotional, cognitive, or physical
   * @param {string} params.crewMember - Which crew collected this
   * @param {string} [params.impact] - low, medium, high (optional)
   * @param {string} [params.timing] - recent, ongoing, fluctuating (optional)
   * @returns {Promise<Object>} - The created symptom record
   */
  async recordSymptom({
    userId,
    conversationId,
    userProvidedName,
    symptomGroup,
    crewMember,
    impact = null,
    timing = null
  }) {
    if (!this.drizzle) this.initialize();

    const [symptom] = await this.drizzle
      .insert(userSymptoms)
      .values({
        userId,
        conversationId,
        userProvidedName,
        symptomGroup,
        crewMember,
        impact,
        timing
      })
      .returning();

    console.log(`📋 Symptom recorded: "${userProvidedName}" (${symptomGroup}) for user ${userId}`);

    return symptom;
  }

  /**
   * Get all symptoms for a user
   * @param {number} userId - User ID
   * @param {string} [symptomGroup] - Filter by group (optional)
   * @returns {Promise<Array>} - List of symptoms
   */
  async getSymptomsForUser(userId, symptomGroup = null) {
    if (!this.drizzle) this.initialize();

    let query = this.drizzle
      .select()
      .from(userSymptoms)
      .where(eq(userSymptoms.userId, userId));

    if (symptomGroup) {
      query = this.drizzle
        .select()
        .from(userSymptoms)
        .where(and(
          eq(userSymptoms.userId, userId),
          eq(userSymptoms.symptomGroup, symptomGroup)
        ));
    }

    const symptoms = await query.orderBy(desc(userSymptoms.reportedAt));

    return symptoms;
  }

  /**
   * Get symptoms for a specific conversation
   * @param {number} conversationId - Conversation ID
   * @returns {Promise<Array>} - List of symptoms
   */
  async getSymptomsForConversation(conversationId) {
    if (!this.drizzle) this.initialize();

    const symptoms = await this.drizzle
      .select()
      .from(userSymptoms)
      .where(eq(userSymptoms.conversationId, conversationId))
      .orderBy(desc(userSymptoms.reportedAt));

    return symptoms;
  }

  /**
   * Get symptom counts grouped by symptom group for a user
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Counts per group { emotional: 2, cognitive: 1, physical: 0 }
   */
  async getSymptomCountsByGroup(userId) {
    if (!this.drizzle) this.initialize();

    const symptoms = await this.drizzle
      .select({
        symptomGroup: userSymptoms.symptomGroup
      })
      .from(userSymptoms)
      .where(eq(userSymptoms.userId, userId));

    const counts = {
      emotional: 0,
      cognitive: 0,
      physical: 0
    };

    for (const s of symptoms) {
      if (s.symptomGroup && counts.hasOwnProperty(s.symptomGroup)) {
        counts[s.symptomGroup]++;
      }
    }

    return counts;
  }

  /**
   * Update system symptom name (for later categorization)
   * @param {number} symptomId - Symptom ID
   * @param {string} systemSymptomName - Standardized symptom name
   * @returns {Promise<Object>} - Updated symptom
   */
  async updateSystemSymptomName(symptomId, systemSymptomName) {
    if (!this.drizzle) this.initialize();

    const [updated] = await this.drizzle
      .update(userSymptoms)
      .set({ systemSymptomName })
      .where(eq(userSymptoms.id, symptomId))
      .returning();

    return updated;
  }
}

module.exports = new SymptomService();
