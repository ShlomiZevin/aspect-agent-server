const db = require('./db.pg');
const { users } = require('../db/schema');
const { eq } = require('drizzle-orm');

/**
 * Synthetic User Service
 *
 * Synthetic users are real rows in the `users` table, tagged via
 * `users.metadata.synthetic = true` and carrying the full persona JSON
 * in `users.metadata.persona`. They're reused across multiple test
 * conversations so each persona has its own conversation history.
 */
class SyntheticUserService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  _externalIdFor(persona, populationRunId) {
    const personaId = String(persona.id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-');
    if (populationRunId) return `synthetic-pop${populationRunId}-${personaId}`;
    return `synthetic-direct-${personaId}`;
  }

  /**
   * Get or create a synthetic user for a given persona.
   * Idempotent — repeated calls return the same user row.
   */
  async upsert({ persona, populationRunId = null }) {
    if (!this.drizzle) this.initialize();
    if (!persona || !persona.id) {
      throw new Error('upsert requires persona with an id');
    }

    const externalId = this._externalIdFor(persona, populationRunId);

    const existing = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);

    if (existing.length > 0) {
      // Refresh persona JSON in case the persona was regenerated/edited.
      const merged = {
        ...(existing[0].metadata || {}),
        synthetic: true,
        persona,
        populationRunId,
      };
      const [updated] = await this.drizzle
        .update(users)
        .set({ metadata: merged, name: persona.name || existing[0].name, updatedAt: new Date() })
        .where(eq(users.id, existing[0].id))
        .returning();
      return { user: updated, created: false };
    }

    const [created] = await this.drizzle
      .insert(users)
      .values({
        externalId,
        name: persona.name || `Synthetic ${persona.id}`,
        role: 'user',
        source: 'web',
        subscription: 'demo',
        tenant: null,
        metadata: {
          synthetic: true,
          persona,
          populationRunId,
        },
      })
      .returning();

    console.log(`🤖 [SyntheticUser] Created ${created.id} (${externalId}) for persona "${persona.name || persona.id}"`);
    return { user: created, created: true };
  }
}

module.exports = new SyntheticUserService();
