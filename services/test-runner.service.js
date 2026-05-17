const db = require('./db.pg');
const { testRuns, testConfigs, conversations: conversationsTable } = require('../db/schema');
const { eq, desc, and } = require('drizzle-orm');
const llmService = require('./llm');
const syntheticUserService = require('./synthetic-user.service');
const conversationService = require('./conversation.service');
const { runChatTurn } = require('./chat-turn.service');

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
   * Also lazily seeds metadata.conversationPrompt from a conversation-agent.prompt.js
   * file if present and not already in DB.
   */
  async getConfig(agentName) {
    if (!this.drizzle) this.initialize();

    // Try DB first
    const [dbConfig] = await this.drizzle
      .select()
      .from(testConfigs)
      .where(eq(testConfigs.agentName, agentName))
      .limit(1);

    if (dbConfig) {
      // Lazy-seed the conversation prompt into metadata if missing
      if (!dbConfig.metadata?.conversationPrompt) {
        const convPrompt = this._loadConversationPromptFromFile(agentName);
        if (convPrompt) {
          const newMetadata = { ...(dbConfig.metadata || {}), conversationPrompt: convPrompt };
          const [updated] = await this.drizzle
            .update(testConfigs)
            .set({ metadata: newMetadata, updatedAt: new Date() })
            .where(eq(testConfigs.agentName, agentName))
            .returning();
          return updated;
        }
      }
      return dbConfig;
    }

    // Fallback: try to load from file and seed into DB
    const slug = this._slugify(agentName);
    try {
      const promptModule = require(`../test-prompts/${slug}/individual-generator.prompt`);
      const convPrompt = this._loadConversationPromptFromFile(agentName);
      const seeded = await this.createConfig({
        agentName,
        motivations: promptModule.MOTIVATIONS || [],
        generatorPrompt: promptModule.getSystemPrompt(),
        userMessageTemplate: 'MOTIVATION: {{motivation}}\nCOUNT: {{count}}\n\nReturn a JSON object with a key "individuals" containing an array of exactly {{count}} individual objects.',
        metadata: convPrompt ? { conversationPrompt: convPrompt } : {},
      });
      return seeded;
    } catch {
      return null;
    }
  }

  _loadConversationPromptFromFile(agentName) {
    const slug = this._slugify(agentName);
    try {
      const mod = require(`../test-prompts/${slug}/conversation-agent.prompt`);
      const defaults = mod.getDefaults ? mod.getDefaults() : {};
      return {
        systemPrompt: mod.getSystemPrompt(),
        userMessageTemplate: mod.getUserMessageTemplate(),
        defaultMaxTurns: defaults.defaultMaxTurns || 30,
        defaultModel: defaults.defaultModel || 'gpt-4o',
      };
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

  // =============================================
  // Step 3: Conversation Simulator
  // =============================================

  /**
   * Start a synthetic conversation for one persona.
   * Creates the synthetic user, the conversation row, and the test_runs row.
   * Returns identifiers + a URL for opening the conversation in the chat UI.
   */
  async startConversation({ agentName, persona, populationRunId = null, maxTurns, model }) {
    if (!this.drizzle) this.initialize();
    if (!agentName) throw new Error('startConversation requires agentName');
    if (!persona || !persona.id) throw new Error('startConversation requires persona with id');

    const config = await this.getConfig(agentName);
    const convCfg = config?.metadata?.conversationPrompt || {};
    const effectiveMaxTurns = maxTurns || convCfg.defaultMaxTurns || 30;
    const effectiveModel = model || convCfg.defaultModel || 'gpt-4o';

    // 1. Upsert synthetic user
    const { user } = await syntheticUserService.upsert({ persona, populationRunId });

    // 2. Create the test_runs row first (so we have its id for the conversation metadata).
    // Snapshot the full persona into input so the cockpit can show its summary
    // without an extra user-fetch, and so the run is self-contained even if the
    // synthetic user's metadata is later re-generated.
    const [run] = await this.drizzle
      .insert(testRuns)
      .values({
        type: 'conversation',
        agentName,
        status: 'running',
        input: {
          agentName,
          personaId: persona.id,
          persona,
          userId: user.id,
          populationRunId,
          maxTurns: effectiveMaxTurns,
          model: effectiveModel,
        },
        output: { transcript: [], turnCount: 0, terminationReason: null },
        parentRunId: populationRunId || null,
        metadata: { startedAt: new Date().toISOString() },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // 3. Create the conversation row tagged synthetic + linked to the test run
    const agent = await conversationService.getAgentByName(agentName);
    const externalId = `test-${run.id}-${String(persona.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;

    const [conversation] = await this.drizzle
      .insert(conversationsTable)
      .values({
        externalId,
        agentId: agent.id,
        userId: user.id,
        status: 'active',
        metadata: {
          synthetic: true,
          testRunId: run.id,
          populationRunId,
          individualId: String(persona.id),
        },
      })
      .returning();

    // 4. Patch the run with conversation linkage
    const [updatedRun] = await this.drizzle
      .update(testRuns)
      .set({
        input: { ...run.input, conversationId: conversation.id, conversationExternalId: externalId },
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, run.id))
      .returning();

    // 5. Build a conversation URL using the agent's url_slug if available
    const slug = (agent.urlSlug || this._slugify(agentName)).replace(/^\/+|\/+$/g, '');
    const conversationUrl = `/${slug}/conversations/${externalId}`;

    console.log(`🤖 [TestRunner] Started synthetic conversation run=${run.id} user=${user.id} conv=${externalId}`);

    return {
      testRunId: run.id,
      conversationId: conversation.id,
      conversationExternalId: externalId,
      conversationUrl,
      userId: user.id,
      userExternalId: user.externalId,
      maxTurns: effectiveMaxTurns,
      model: effectiveModel,
      run: updatedRun,
    };
  }

  /**
   * Roleplay one synthetic user reply. Pure LLM call, no DB writes.
   * Used internally by advanceConversationTurn, but exposed as its own endpoint
   * for debugging the persona prompt without firing a real conversation.
   */
  async generateNextMessage({ persona, transcript, agentName }) {
    if (!agentName) throw new Error('generateNextMessage requires agentName');
    if (!persona) throw new Error('generateNextMessage requires persona');

    const config = await this.getConfig(agentName);
    const convCfg = config?.metadata?.conversationPrompt;
    if (!convCfg || !convCfg.systemPrompt) {
      throw new Error(`No conversationPrompt configured for agent "${agentName}". Seed test-prompts/${this._slugify(agentName)}/conversation-agent.prompt.js or set via Settings.`);
    }

    const motivationDescription = this._motivationDescription(config, persona.motivation_primary) || persona.motivation_primary || '';
    const transcriptText = Array.isArray(transcript) && transcript.length > 0
      ? transcript.map(t => `${t.role}: ${t.content}`).join('\n')
      : '(empty — this is the opening turn)';

    const systemPrompt = (convCfg.systemPrompt || '')
      .replace(/\{\{persona_json\}\}/g, JSON.stringify(persona, null, 2))
      .replace(/\{\{motivation_description\}\}/g, motivationDescription)
      .replace(/\{\{name\}\}/g, persona.name || '');

    const userMessage = (convCfg.userMessageTemplate || 'Transcript:\n{{transcript}}\n\nRespond as {{name}}.')
      .replace(/\{\{persona_json\}\}/g, JSON.stringify(persona))
      .replace(/\{\{motivation_description\}\}/g, motivationDescription)
      .replace(/\{\{name\}\}/g, persona.name || '')
      .replace(/\{\{transcript\}\}/g, transcriptText);

    const model = convCfg.defaultModel || 'gpt-4o';
    const responseText = await llmService.sendOneShot(systemPrompt, userMessage, {
      model,
      maxTokens: 1024,
      jsonOutput: true,
      context: 'test-runner-synthetic-user',
    });

    let cleaned = (responseText || '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Fallback: wrap raw text as message, don't end
      console.warn(`   🤖 [TestRunner] Synthetic user JSON parse failed; falling back to raw text. err=${e.message}`);
      return { message: cleaned, end: false, reason: 'fallback-non-json' };
    }

    return {
      message: typeof parsed.message === 'string' ? parsed.message : '',
      end: !!parsed.end,
      reason: parsed.reason || undefined,
    };
  }

  _motivationDescription(config, key) {
    if (!config || !Array.isArray(config.motivations) || !key) return null;
    const found = config.motivations.find(m => (typeof m === 'object' ? m.key : m) === key);
    if (!found) return null;
    return typeof found === 'object' ? (found.description || '') : '';
  }

  /**
   * Advance ONE turn of a synthetic conversation.
   * Atomic, stateless: re-reads the run each time. Safe to call repeatedly.
   *
   * Returns { run, terminated, lastUserMessage?, lastAssistantReply? }
   */
  async advanceConversationTurn(runId) {
    if (!this.drizzle) this.initialize();

    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.type !== 'conversation') throw new Error(`Run ${runId} is type "${run.type}", expected "conversation"`);

    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return { run, terminated: true };
    }

    const input = run.input || {};
    const output = run.output || { transcript: [], turnCount: 0, terminationReason: null };
    const transcript = Array.isArray(output.transcript) ? output.transcript : [];
    const turnCount = typeof output.turnCount === 'number' ? output.turnCount : transcript.filter(t => t.role === 'user').length;
    const maxTurns = input.maxTurns || 30;

    // Max-turns guard
    if (turnCount >= maxTurns) {
      const [updated] = await this.drizzle
        .update(testRuns)
        .set({
          status: 'completed',
          output: { ...output, transcript, turnCount, terminationReason: 'max_turns' },
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, runId))
        .returning();
      return { run: updated, terminated: true };
    }

    // Load persona — prefer the synthetic user's metadata (source of truth), fall back to input
    const persona = await this._loadPersonaForRun(input);
    if (!persona) {
      const [updated] = await this.drizzle
        .update(testRuns)
        .set({ status: 'failed', error: 'Could not resolve persona for synthetic user', updatedAt: new Date() })
        .where(eq(testRuns.id, runId))
        .returning();
      return { run: updated, terminated: true };
    }

    try {
      // 1. Generate the synthetic user's next message
      const next = await this.generateNextMessage({
        persona,
        transcript,
        agentName: input.agentName,
      });

      // End signal
      if (next.end) {
        const [updated] = await this.drizzle
          .update(testRuns)
          .set({
            status: 'completed',
            output: {
              ...output,
              transcript,
              turnCount,
              terminationReason: 'end_signal',
              endReason: next.reason || null,
              lastSyntheticUserMessage: next.message || null,
            },
            updatedAt: new Date(),
          })
          .where(eq(testRuns.id, runId))
          .returning();
        return { run: updated, terminated: true };
      }

      if (!next.message || !next.message.trim()) {
        throw new Error('Synthetic user returned empty message');
      }

      // 2. Drive the chat turn through the real dispatcher
      const turnResult = await runChatTurn({
        message: next.message,
        conversationId: input.conversationExternalId,
        agentName: input.agentName,
        userId: null, // synthetic users are linked via the existing conversation, no externalId needed here
        restrictedMode: true, // skip profiler / extra thinking — fast lane
      });

      // 3. Append both turns to transcript
      const newTranscript = [
        ...transcript,
        { role: 'user', content: next.message },
        {
          role: 'assistant',
          content: turnResult.reply || '',
          crewMember: turnResult.crewMember || null,
          ...(turnResult.crewTransitions && turnResult.crewTransitions.length > 0
            ? { crewTransitions: turnResult.crewTransitions }
            : {}),
        },
      ];

      const [updated] = await this.drizzle
        .update(testRuns)
        .set({
          output: {
            ...output,
            transcript: newTranscript,
            turnCount: turnCount + 1,
            terminationReason: null,
          },
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, runId))
        .returning();

      return {
        run: updated,
        terminated: false,
        lastUserMessage: next.message,
        lastAssistantReply: turnResult.reply,
        crewMember: turnResult.crewMember,
        crewTransitions: turnResult.crewTransitions,
      };
    } catch (err) {
      console.error(`❌ [TestRunner] advanceConversationTurn run=${runId} failed:`, err.message);
      const [updated] = await this.drizzle
        .update(testRuns)
        .set({
          status: 'failed',
          error: err.message,
          output: { ...output, transcript, turnCount, terminationReason: 'failed' },
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, runId))
        .returning();
      return { run: updated, terminated: true, error: err.message };
    }
  }

  /**
   * Drive a conversation run to completion by repeatedly calling
   * advanceConversationTurn. Checks the run row between turns for a
   * `cancelled` flag and stops cleanly if cancelled.
   *
   * Returns the final run row.
   */
  async runConversationToCompletion(runId) {
    if (!this.drizzle) this.initialize();
    let safety = 1000; // hard ceiling against any logic bug — maxTurns is the real limit

    while (safety-- > 0) {
      // Cancellation check between turns
      const current = await this.getRun(runId);
      if (!current) return null;
      if (['completed', 'failed', 'cancelled'].includes(current.status)) {
        return current;
      }
      if (current.output?.cancelled === true) {
        const [cancelled] = await this.drizzle
          .update(testRuns)
          .set({
            status: 'cancelled',
            output: { ...(current.output || {}), terminationReason: 'cancelled' },
            updatedAt: new Date(),
          })
          .where(eq(testRuns.id, runId))
          .returning();
        return cancelled;
      }

      const { run, terminated } = await this.advanceConversationTurn(runId);
      if (terminated) return run;
    }
    return this.getRun(runId);
  }

  /**
   * Request cancellation of a running conversation. The server-side loop
   * (and the batch driver) check this flag between turns and exit cleanly.
   * If the run is already terminal, this is a no-op.
   */
  async cancelConversationRun(runId) {
    if (!this.drizzle) this.initialize();

    const run = await this.getRun(runId);
    if (!run) return null;
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;

    const [updated] = await this.drizzle
      .update(testRuns)
      .set({
        output: { ...(run.output || {}), cancelled: true },
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, runId))
      .returning();
    return updated;
  }

  /**
   * Resolve persona for a conversation run. Prefer synthetic user metadata,
   * fall back to the persona field stored on the run input.
   */
  async _loadPersonaForRun(input) {
    if (input?.persona && input.persona.id) return input.persona;
    if (!input?.userId) return null;
    if (!this.drizzle) this.initialize();
    const { users } = require('../db/schema');
    const [user] = await this.drizzle
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    return user?.metadata?.persona || null;
  }
}

module.exports = new TestRunnerService();
