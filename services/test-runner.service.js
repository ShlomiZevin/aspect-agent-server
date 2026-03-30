const db = require('./db.pg');
const { testRuns, testConfigs } = require('../db/schema');
const { eq, desc, and } = require('drizzle-orm');
const llmService = require('./llm');

/**
 * Test Runner Service
 *
 * Manages automated agent testing: individual generation, conversation simulation, and review.
 * Config is loaded from DB (test_configs table) with file-based fallback.
 */
class TestRunnerService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  _slugify(agentName) {
    return agentName.toLowerCase().replace(/\s+/g, '-');
  }

  // =============================================
  // Config CRUD (DB-stored, file fallback)
  // =============================================

  /**
   * Get config for an agent. DB first, file fallback, seed DB if from file.
   */
  async getConfig(agentName) {
    if (!this.drizzle) this.initialize();

    // Try DB first
    const [dbConfig] = await this.drizzle
      .select()
      .from(testConfigs)
      .where(eq(testConfigs.agentName, agentName))
      .limit(1);

    if (dbConfig) return dbConfig;

    // Fallback: try to load from file and seed into DB
    const slug = this._slugify(agentName);
    try {
      const promptModule = require(`../test-prompts/${slug}/individual-generator.prompt`);
      const seeded = await this.createConfig({
        agentName,
        motivations: promptModule.MOTIVATIONS || [],
        generatorPrompt: promptModule.getSystemPrompt(),
        userMessageTemplate: 'MOTIVATION: {{motivation}}\nCOUNT: {{count}}\n\nReturn a JSON object with a key "individuals" containing an array of exactly {{count}} individual objects.',
      });
      return seeded;
    } catch {
      return null;
    }
  }

  async createConfig(data) {
    if (!this.drizzle) this.initialize();

    const [config] = await this.drizzle
      .insert(testConfigs)
      .values({
        agentName: data.agentName,
        motivations: data.motivations || [],
        generatorPrompt: data.generatorPrompt,
        userMessageTemplate: data.userMessageTemplate || '',
        personaSchema: data.personaSchema || null,
        defaultModel: data.defaultModel || 'gpt-4o',
        defaultCount: data.defaultCount || 10,
        metadata: data.metadata || {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return config;
  }

  async updateConfig(agentName, updates) {
    if (!this.drizzle) this.initialize();

    const updateData = { updatedAt: new Date() };
    if (updates.motivations !== undefined) updateData.motivations = updates.motivations;
    if (updates.generatorPrompt !== undefined) updateData.generatorPrompt = updates.generatorPrompt;
    if (updates.userMessageTemplate !== undefined) updateData.userMessageTemplate = updates.userMessageTemplate;
    if (updates.personaSchema !== undefined) updateData.personaSchema = updates.personaSchema;
    if (updates.defaultModel !== undefined) updateData.defaultModel = updates.defaultModel;
    if (updates.defaultCount !== undefined) updateData.defaultCount = updates.defaultCount;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

    const [config] = await this.drizzle
      .update(testConfigs)
      .set(updateData)
      .where(eq(testConfigs.agentName, agentName))
      .returning();

    return config || null;
  }

  // =============================================
  // Run CRUD
  // =============================================

  async createRun({ type, agentName, input }) {
    if (!this.drizzle) this.initialize();

    const [run] = await this.drizzle
      .insert(testRuns)
      .values({
        type,
        agentName,
        status: 'pending',
        input: input || {},
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return run;
  }

  async getRun(id) {
    if (!this.drizzle) this.initialize();

    const [run] = await this.drizzle
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, id))
      .limit(1);

    return run || null;
  }

  async listRuns(filters = {}) {
    if (!this.drizzle) this.initialize();

    const conditions = [];
    if (filters.type) conditions.push(eq(testRuns.type, filters.type));
    if (filters.agentName) conditions.push(eq(testRuns.agentName, filters.agentName));
    if (filters.status) conditions.push(eq(testRuns.status, filters.status));

    const query = this.drizzle
      .select()
      .from(testRuns)
      .orderBy(desc(testRuns.createdAt));

    if (conditions.length > 0) {
      return query.where(and(...conditions));
    }
    return query;
  }

  async deleteRun(id) {
    if (!this.drizzle) this.initialize();

    const result = await this.drizzle
      .delete(testRuns)
      .where(eq(testRuns.id, id))
      .returning({ id: testRuns.id });

    return result.length > 0;
  }

  /**
   * Update a run's input fields (e.g. rename a population).
   */
  async updateRunInput(id, inputUpdates) {
    if (!this.drizzle) this.initialize();

    const run = await this.getRun(id);
    if (!run) return null;

    const [updated] = await this.drizzle
      .update(testRuns)
      .set({
        input: { ...run.input, ...inputUpdates },
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, id))
      .returning();

    return updated;
  }

  /**
   * Save output directly (for populations — no LLM call needed).
   */
  async saveOutput(id, output) {
    if (!this.drizzle) this.initialize();

    const [updated] = await this.drizzle
      .update(testRuns)
      .set({
        status: 'completed',
        output,
        metadata: { count: Array.isArray(output) ? output.length : 0 },
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, id))
      .returning();

    return updated;
  }

  // =============================================
  // Step 1: Individual Generator
  // =============================================

  async generateIndividuals(runId) {
    if (!this.drizzle) this.initialize();

    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.type !== 'individuals') throw new Error(`Run ${runId} is type "${run.type}", expected "individuals"`);
    if (run.status !== 'pending') throw new Error(`Run ${runId} is "${run.status}", expected "pending"`);

    // Mark as running
    await this.drizzle
      .update(testRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(testRuns.id, runId));

    const startTime = Date.now();

    try {
      // Load config from DB (with file fallback)
      const config = await this.getConfig(run.agentName);
      if (!config) throw new Error(`No test config found for agent "${run.agentName}"`);

      const { motivation, count = config.defaultCount || 10, model = config.defaultModel || 'gpt-4o' } = run.input;
      if (!motivation) throw new Error('Missing "motivation" in run input');

      // Build motivations definitions block from config and inject into prompt
      const motivationsDefs = Array.isArray(config.motivations)
        ? config.motivations
            .map(m => typeof m === 'object' ? `${m.key} — ${m.description}` : m)
            .join('\n\n')
        : '';
      const systemPrompt = config.generatorPrompt
        .replace(/\{\{motivations_definitions\}\}/g, motivationsDefs);

      // Build user message from template
      const template = config.userMessageTemplate || 'MOTIVATION: {{motivation}}\nCOUNT: {{count}}';
      const userMessage = template
        .replace(/\{\{motivation\}\}/g, motivation)
        .replace(/\{\{count\}\}/g, String(count));

      console.log(`   🧪 [TestRunner] Generating ${count} individuals for "${run.agentName}" with motivation="${motivation}", model=${model}`);

      const responseText = await llmService.sendOneShot(
        systemPrompt,
        userMessage,
        { model, maxTokens: 16384, jsonOutput: true, context: 'test-runner' }
      );

      // Parse JSON — handle markdown code blocks
      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      let individuals = JSON.parse(cleaned);
      console.log(`   🧪 [TestRunner] Raw response type: ${typeof individuals}, isArray: ${Array.isArray(individuals)}, keys: ${typeof individuals === 'object' && individuals !== null ? Object.keys(individuals).join(', ') : 'N/A'}`);

      // OpenAI json_object mode wraps arrays in an object — unwrap it
      if (!Array.isArray(individuals) && typeof individuals === 'object' && individuals !== null) {
        const firstArrayKey = Object.keys(individuals).find(k => Array.isArray(individuals[k]));
        if (firstArrayKey) {
          console.log(`   🧪 [TestRunner] Unwrapping from key "${firstArrayKey}" (${individuals[firstArrayKey].length} items)`);
          individuals = individuals[firstArrayKey];
        } else if (individuals.id || individuals.name) {
          console.log(`   🧪 [TestRunner] Single individual returned, wrapping in array`);
          individuals = [individuals];
        }
      }

      // Assign globally unique IDs
      if (Array.isArray(individuals)) {
        individuals = individuals.map((ind, i) => ({
          ...ind,
          id: `${runId}-${String(i + 1).padStart(3, '0')}`,
        }));
      }
      const elapsed = Date.now() - startTime;

      const [updated] = await this.drizzle
        .update(testRuns)
        .set({
          status: 'completed',
          output: individuals,
          metadata: {
            model,
            elapsed_ms: elapsed,
            count: Array.isArray(individuals) ? individuals.length : 0,
          },
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, runId))
        .returning();

      console.log(`   🧪 [TestRunner] Generated ${Array.isArray(individuals) ? individuals.length : '?'} individuals in ${elapsed}ms`);
      return updated;

    } catch (err) {
      await this.drizzle
        .update(testRuns)
        .set({
          status: 'failed',
          error: err.message,
          metadata: { elapsed_ms: Date.now() - startTime },
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, runId));

      throw err;
    }
  }
}

module.exports = new TestRunnerService();
