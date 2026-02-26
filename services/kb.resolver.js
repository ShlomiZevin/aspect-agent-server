/**
 * KB Resolver Service
 *
 * Resolves knowledge base names to provider-specific IDs at runtime,
 * based on the model provider being used.
 *
 * Precedence: openai → vectorStoreId, google → googleCorpusId, anthropic → skip
 */
const { eq, inArray } = require('drizzle-orm');
const { knowledgeBases } = require('../db/schema');
const dbService = require('./db.pg');

class KBResolverService {
  /**
   * Detect model provider from model name.
   * @param {string} modelName - e.g. 'gpt-4o', 'gemini-2.0-flash', 'claude-sonnet-4-6'
   * @returns {'openai'|'google'|'anthropic'}
   */
  getModelProvider(modelName) {
    if (!modelName) return 'openai';
    const m = modelName.toLowerCase();
    if (m.startsWith('claude-')) return 'anthropic';
    if (m.startsWith('gemini-')) return 'google';
    return 'openai';
  }

  /**
   * Resolve KB source names to provider-specific IDs.
   *
   * @param {string[]} sourceNames - KB names from crew config (e.g. ['Freeda Medical KB'])
   * @param {string} modelProvider - 'openai' | 'google' | 'anthropic'
   * @param {number} agentId - Agent ID to scope KB lookup
   * @returns {Promise<Object>} Resolved KB config for the LLM service
   *
   * Returns for OpenAI:
   * {
   *   enabled: true,
   *   provider: 'openai',
   *   storeIds: ['vs_xxx'],
   *   resolvedSources: [{ name, resolved, id, reason }]
   * }
   *
   * Returns for Google:
   * {
   *   enabled: true,
   *   provider: 'google',
   *   corpusIds: ['projects/.../corpora/xxx'],
   *   resolvedSources: [{ name, resolved, id, reason }]
   * }
   */
  async resolve(sourceNames, modelProvider, agentId) {
    if (!sourceNames || sourceNames.length === 0) {
      return { enabled: false, resolvedSources: [] };
    }

    try {
      // Query all KBs for this agent matching the requested names
      const rows = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.agentId, agentId));

      // Build name → KB map
      const kbByName = new Map();
      for (const row of rows) {
        kbByName.set(row.name, row);
      }

      const resolvedSources = [];
      const storeIds = [];
      const corpusIds = [];

      for (const name of sourceNames) {
        const kb = kbByName.get(name);

        if (!kb) {
          console.warn(`⚠️ [KB Resolver] KB not found in DB: "${name}"`);
          resolvedSources.push({ name, resolved: false, reason: 'not found in DB' });
          continue;
        }

        if (modelProvider === 'openai') {
          if (kb.vectorStoreId) {
            storeIds.push(kb.vectorStoreId);
            resolvedSources.push({ name, resolved: true, id: kb.vectorStoreId });
          } else {
            console.warn(`⚠️ [KB Resolver] KB "${name}" has no vectorStoreId for OpenAI`);
            resolvedSources.push({ name, resolved: false, reason: 'no vectorStoreId' });
          }
        } else if (modelProvider === 'google') {
          if (kb.googleCorpusId) {
            corpusIds.push(kb.googleCorpusId);
            resolvedSources.push({ name, resolved: true, id: kb.googleCorpusId });
          } else {
            console.warn(`⚠️ [KB Resolver] KB "${name}" has no googleCorpusId for Google`);
            resolvedSources.push({ name, resolved: false, reason: 'no googleCorpusId' });
          }
        }
      }

      if (modelProvider === 'openai') {
        return {
          enabled: storeIds.length > 0,
          provider: 'openai',
          storeIds,
          resolvedSources
        };
      } else if (modelProvider === 'google') {
        return {
          enabled: corpusIds.length > 0,
          provider: 'google',
          corpusIds,
          resolvedSources
        };
      }

      return { enabled: false, resolvedSources };
    } catch (error) {
      console.error('❌ [KB Resolver] Error resolving KB sources:', error.message);
      return { enabled: false, resolvedSources: sourceNames.map(name => ({ name, resolved: false, reason: error.message })) };
    }
  }

  /**
   * Get all available KBs for an agent (for debug panel dropdown).
   * @param {number} agentId
   * @returns {Promise<Array>} List of { id, name, provider, fileCount, totalSize, hasOpenAI, hasGoogle }
   */
  async getAvailableKBs(agentId) {
    try {
      const rows = await dbService.db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.agentId, agentId));

      return rows.map(kb => ({
        id: kb.id,
        name: kb.name,
        provider: kb.provider,
        fileCount: kb.fileCount || 0,
        totalSize: kb.totalSize || 0,
        hasOpenAI: !!kb.vectorStoreId,
        hasGoogle: !!kb.googleCorpusId,
      }));
    } catch (error) {
      console.error('❌ [KB Resolver] Error fetching available KBs:', error.message);
      return [];
    }
  }
}

module.exports = new KBResolverService();
