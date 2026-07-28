/**
 * Aspect Intelligence admin API — mounted at /api/admin/intelligence (see
 * server.js). Same no-real-auth convention as every other /api/admin/* route
 * in this codebase (not linked from public nav) — nothing new introduced here.
 *
 * Endpoints:
 *   GET  /api/admin/intelligence/datasets                          — every registered dataset (enabled or not) + config + insight counts
 *   PUT  /api/admin/intelligence/datasets/:id                      — update a dataset's config (enabled, dataModelDescription, brandLabel, bootstrapPrompts, examplePrompts) — auto-snapshots the pre-write content into version history
 *   GET  /api/admin/intelligence/datasets/:id/versions/:section     — version history for one section ('config' | 'prompts'), newest first — see intelligence-config.service.js
 *   POST /api/admin/intelligence/datasets/:id/versions/:section/:savedAt/restore — restores a past version of that section (itself snapshotted first, so undoable)
 *   DELETE /api/admin/intelligence/datasets/:id/versions/:section/:savedAt — removes one version entry (doesn't touch the live config)
 *   POST /api/admin/intelligence/datasets/:id/generate-description — introspects the real DB schema and drafts a plain-language dataModelDescription (not saved — caller reviews then PUTs it)
 *   POST /api/admin/intelligence/datasets/:id/generate-example-prompt — proposes one new example/hero-chip prompt, distinct from the ones already listed (not saved — caller reviews then adds it)
 *   GET  /api/admin/intelligence/datasets/:id/insights             — full generated-insight list for monitoring/cleanup
 *
 * Bootstrap/investigate/delete reuse the existing public /api/insights/*
 * routes directly — no admin-only duplicates needed for those.
 */

const express = require('express');
const router = express.Router();
const registry = require('../datasets/registry');
const intelligenceConfigService = require('../services/intelligence-config.service');
const investigationService = require('../services/investigation.service');
const schemaDescriptorService = require('../../services/schema-descriptor.service');
const llmService = require('../../services/llm');

function handleError(res, err, context) {
  const status = err.status || 500;
  if (status >= 500) console.error(`❌ Insights admin ${context}:`, err.message);
  res.status(status).json({ error: err.message });
}

router.get('/datasets', async (_req, res) => {
  try {
    const configs = await intelligenceConfigService.getAllConfigs();
    const datasets = configs.map(config => {
      const entry = registry.get(config.id);
      const generated = investigationService.listGenerated(config.id);
      return {
        id: entry.id,
        name: entry.defaultMeta.name,
        description: entry.defaultMeta.description,
        logoText: entry.defaultMeta.logoText,
        gradientFrom: entry.defaultMeta.gradientFrom,
        gradientTo: entry.defaultMeta.gradientTo,
        config,
        insightCount: generated.length,
        trackedCount: generated.filter(i => i.tracked).length,
      };
    });
    res.json({ datasets });
  } catch (err) {
    handleError(res, err, 'datasets list');
  }
});

router.put('/datasets/:id', async (req, res) => {
  try {
    const updated = await intelligenceConfigService.setConfig(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: `Unknown dataset: ${req.params.id}` });
    res.json({ id: req.params.id, config: updated });
  } catch (err) {
    handleError(res, err, 'update config');
  }
});

router.get('/datasets/:id/versions/:section', async (req, res) => {
  const versions = await intelligenceConfigService.getHistory(req.params.id, req.params.section);
  if (versions === null) return res.status(404).json({ error: `Unknown dataset or section: ${req.params.id}/${req.params.section}` });
  res.json({ versions });
});

router.post('/datasets/:id/versions/:section/:savedAt/restore', async (req, res) => {
  try {
    const savedAt = Number(req.params.savedAt);
    const updated = await intelligenceConfigService.restoreVersion(req.params.id, req.params.section, savedAt);
    if (!updated) return res.status(404).json({ error: 'Unknown dataset, section, or version' });
    res.json({ id: req.params.id, config: updated });
  } catch (err) {
    handleError(res, err, 'restore version');
  }
});

router.delete('/datasets/:id/versions/:section/:savedAt', async (req, res) => {
  try {
    const savedAt = Number(req.params.savedAt);
    const removed = await intelligenceConfigService.deleteVersion(req.params.id, req.params.section, savedAt);
    if (removed === null) return res.status(404).json({ error: `Unknown dataset or section: ${req.params.id}/${req.params.section}` });
    if (!removed) return res.status(404).json({ error: 'Unknown version' });
    res.json({ deleted: true });
  } catch (err) {
    handleError(res, err, 'delete version');
  }
});

// Lets a non-technical client fill in "Data model description" without
// knowing anything about the database — introspects the dataset's real
// schema (same schemaDescriptorService used for SQL generation) and asks
// the model to condense it into the short, plain-language paragraph shape
// investigation.service.js's prompts expect. Returns a DRAFT only — the
// admin still reviews and clicks Save, nothing is persisted here.
router.post('/datasets/:id/generate-description', async (req, res) => {
  try {
    const entry = registry.get(req.params.id);
    if (!entry) return res.status(404).json({ error: `Unknown dataset: ${req.params.id}` });

    const technicalDescription = await schemaDescriptorService.generateSchemaDescription(entry.schemaName, entry.getPool());

    const systemPrompt = `You are helping a non-technical business owner configure an AI data-analysis tool. You are given a detailed, technical description of their database schema (table names, column names, types). Rewrite it as ONE short paragraph (3-5 sentences) in plain business language for an AI planning agent to read — no table names, no column names, no SQL or technical jargon.

Follow this exact shape: start with what the core data represents, then "Common measures: ..." (the business metrics available — e.g. revenue, profit, quantity sold, inventory levels), then "Common dimensions: ..." (the ways the data can be broken down or grouped — e.g. store, product, date, customer).

Example of the target style: "a facts table with sales, inventory, and target rows (record types), joined to products, stores/warehouses, and customers. Common measures: revenue (ex VAT), profit, margin %, units sold, target attainment %, inventory value/units, loyalty signups. Common dimensions: store, region, branch, product, product family, date (day/week/month/quarter), cashier, campaign, customer city."

Respond with ONLY the paragraph text — no preamble, no markdown, no quotes around it.`;

    const draft = await llmService.sendOneShot(systemPrompt, `Technical schema description:\n\n${technicalDescription}`, {
      model: 'claude-sonnet-4-6', maxTokens: 500, context: 'intelligence_generate_description',
    });

    res.json({ dataModelDescription: String(draft).trim() });
  } catch (err) {
    handleError(res, err, 'generate description');
  }
});

// Proposes one new example prompt (hero chip) distinct from whatever's
// already listed — reuses the same "propose something genuinely new" idea
// as investigation.service.js's proposeInvestigationPrompt, just for the
// short, clickable end-user chip shape instead of a full investigation.
// `existingPrompts` in the body lets the caller include prompts it has
// added locally but not saved yet, so the suggestion never duplicates one
// already on screen. Returns a DRAFT only — not saved here.
router.post('/datasets/:id/generate-example-prompt', async (req, res) => {
  try {
    const entry = registry.get(req.params.id);
    if (!entry) return res.status(404).json({ error: `Unknown dataset: ${req.params.id}` });

    const config = await intelligenceConfigService.getConfig(req.params.id);
    const existing = Array.isArray(req.body?.existingPrompts) ? req.body.existingPrompts : config.examplePrompts;

    const systemPrompt = `You are picking one new example question to show as a clickable quick-question suggestion in a business intelligence tool. Given the business and what its data covers, and the questions already listed, propose ONE new short question (under 10 words) in the same natural, non-technical style — a real business question a user could click without typing.

It must be meaningfully different from every question already listed below — a different measure, angle, or topic, not a rephrasing of one.

Business: ${config.brandLabel}
What the data covers: ${config.dataModelDescription}

Already listed:
${existing.length ? existing.map(p => `- ${p}`).join('\n') : '(none yet)'}

Respond with ONLY the new question text — no quotes, no markdown, no preamble.`;

    const draft = await llmService.sendOneShot(systemPrompt, 'Propose the next example prompt.', {
      model: 'claude-sonnet-4-6', maxTokens: 64, context: 'intelligence_generate_example_prompt',
    });

    res.json({ prompt: String(draft).trim().replace(/^["']|["']$/g, '') });
  } catch (err) {
    handleError(res, err, 'generate example prompt');
  }
});

router.get('/datasets/:id/insights', async (req, res) => {
  if (!registry.get(req.params.id)) {
    return res.status(404).json({ error: `Unknown dataset: ${req.params.id}` });
  }
  const insights = investigationService.listGenerated(req.params.id);
  res.json({ insights });
});

module.exports = router;
