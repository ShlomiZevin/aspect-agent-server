const db = require('./db.pg');
const { testRuns } = require('../db/schema');
const { eq, desc, and } = require('drizzle-orm');
const llmService = require('./llm');

/**
 * Test Runner Service
 *
 * Manages automated agent testing: individual generation, conversation simulation, and review.
 * The service is agent-agnostic — domain-specific prompts are loaded per agent from test-prompts/.
 */
class TestRunnerService {
  constructor() {
    this.drizzle = null;
  }

  initialize() {
    this.drizzle = db.getDrizzle();
  }

  // =============================================
  // CRUD
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

  // =============================================
  // Step 1: Individual Generator
  // =============================================

  /**
   * Normalize agent display name to folder slug.
   * "Banking Onboarder V2" → "banking-onboarder-v2"
   */
  _slugify(agentName) {
    return agentName.toLowerCase().replace(/\s+/g, '-');
  }

  /**
   * Load the generator prompt for an agent.
   * Prompts live in test-prompts/{slug}/individual-generator.prompt.js
   */
  _loadGeneratorPrompt(agentName) {
    const slug = this._slugify(agentName);
    try {
      const promptModule = require(`../test-prompts/${slug}/individual-generator.prompt`);
      return promptModule;
    } catch (err) {
      throw new Error(`No generator prompt found for agent "${agentName}" (slug: "${slug}"). Expected: test-prompts/${slug}/individual-generator.prompt.js`);
    }
  }

  /**
   * Execute an "individuals" run — generate synthetic personas via LLM.
   */
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
      const { motivation, count = 10, model = 'gpt-4o' } = run.input;
      if (!motivation) throw new Error('Missing "motivation" in run input');

      // Load domain-specific prompt
      const promptModule = this._loadGeneratorPrompt(run.agentName);
      const systemPrompt = promptModule.getSystemPrompt();

      // Build user message with session parameters
      const userMessage = promptModule.getUserMessage({ motivation, count });

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
          // LLM returned a single individual instead of an array
          console.log(`   🧪 [TestRunner] Single individual returned, wrapping in array`);
          individuals = [individuals];
        }
      }
      // Assign globally unique IDs: runId-序号
      if (Array.isArray(individuals)) {
        individuals = individuals.map((ind, i) => ({
          ...ind,
          id: `${runId}-${String(i + 1).padStart(3, '0')}`,
        }));
      }
      const elapsed = Date.now() - startTime;

      // Update run with results
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
      // Mark as failed
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
