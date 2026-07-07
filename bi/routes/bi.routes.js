/**
 * Aspect BI API — mounted at /api/bi (see server.js).
 *
 * A standalone, agent-independent BI layer over customer data schemas.
 * Endpoints:
 *   GET  /api/bi/datasets                       — list available datasets
 *   GET  /api/bi/datasets/:id                   — semantic model (fields) for the explorer
 *   POST /api/bi/query                          — { dataset, dimensions, measures, filters, sort, limit }
 *   GET  /api/bi/datasets/:id/values/:fieldId   — distinct values for filter pickers (?search=)
 *   CRUD /api/bi/dashboards                     — saved dashboards (widgets + specs as JSONB)
 */

const express = require('express');
const router = express.Router();

const { hypertoyDataset } = require('../datasets/hypertoy.dataset');
const { compileQuery, compileValuesQuery } = require('../services/query-compiler');
const dashboards = require('../services/dashboards.store');
const { getPool } = require('../../services/db.hypertoy');

const QUERY_TIMEOUT_MS = parseInt(process.env.BI_QUERY_TIMEOUT_MS || '15000', 10);

// Registry keyed by dataset id — add future customer schemas here.
const DATASETS = {
  [hypertoyDataset.id]: { dataset: hypertoyDataset, getPool },
};

function getDatasetEntry(id) {
  const entry = DATASETS[id];
  if (!entry) {
    const err = new Error(`Unknown dataset: ${id}`);
    err.status = 404;
    throw err;
  }
  return entry;
}

/** Public (client-facing) view of a dataset's semantic model. */
function describeDataset({ dataset }) {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    dimensions: dataset.dimensions.map(d => ({
      id: d.id, label: d.label, labelHe: d.labelHe || null, group: d.group, type: d.type,
    })),
    measures: dataset.measures.map(m => ({
      id: m.id, label: m.label, format: m.format,
    })),
  };
}

async function runQuery(pool, sql, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const start = Date.now();
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rows.length,
      columns: result.fields?.map(f => f.name) || [],
      duration: Date.now() - start,
    };
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

function handleError(res, err, context) {
  const status = err.status || 500;
  const isTimeout = err.code === '57014';
  if (status >= 500) console.error(`❌ BI ${context}:`, err.message);
  res.status(isTimeout ? 504 : status).json({
    error: isTimeout
      ? `Query exceeded ${QUERY_TIMEOUT_MS / 1000}s and was stopped. Narrow the date range or add filters.`
      : err.message,
  });
}

// ── Datasets ─────────────────────────────────────────────────────────

router.get('/datasets', (_req, res) => {
  res.json(Object.values(DATASETS).map(describeDataset));
});

router.get('/datasets/:id', (req, res) => {
  try {
    res.json(describeDataset(getDatasetEntry(req.params.id)));
  } catch (err) {
    handleError(res, err, 'datasets/:id');
  }
});

// ── Query ────────────────────────────────────────────────────────────

router.post('/query', async (req, res) => {
  try {
    const { dataset: datasetId, ...spec } = req.body || {};
    const entry = getDatasetEntry(datasetId);
    const { sql, params } = compileQuery(entry.dataset, spec);
    const result = await runQuery(entry.getPool(), sql, params);
    res.json({ ...result, sql });
  } catch (err) {
    handleError(res, err, 'query');
  }
});

router.get('/datasets/:id/values/:fieldId', async (req, res) => {
  try {
    const entry = getDatasetEntry(req.params.id);
    const { sql, params } = compileValuesQuery(entry.dataset, req.params.fieldId, req.query.search);
    const result = await runQuery(entry.getPool(), sql, params);
    res.json({ values: result.rows.map(r => r.value) });
  } catch (err) {
    handleError(res, err, 'values');
  }
});

// ── Dashboards ───────────────────────────────────────────────────────

router.get('/dashboards', async (req, res) => {
  try {
    res.json(await dashboards.listDashboards(req.query.dataset));
  } catch (err) {
    handleError(res, err, 'dashboards list');
  }
});

router.post('/dashboards', async (req, res) => {
  try {
    const { datasetId, name, definition } = req.body || {};
    if (!datasetId || !name) {
      return res.status(400).json({ error: 'datasetId and name are required' });
    }
    getDatasetEntry(datasetId);
    res.status(201).json(await dashboards.createDashboard({ datasetId, name, definition }));
  } catch (err) {
    handleError(res, err, 'dashboards create');
  }
});

router.get('/dashboards/:id', async (req, res) => {
  try {
    const dashboard = await dashboards.getDashboard(parseInt(req.params.id, 10));
    if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
    res.json(dashboard);
  } catch (err) {
    handleError(res, err, 'dashboards get');
  }
});

router.put('/dashboards/:id', async (req, res) => {
  try {
    const { name, definition } = req.body || {};
    const dashboard = await dashboards.updateDashboard(parseInt(req.params.id, 10), { name, definition });
    if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
    res.json(dashboard);
  } catch (err) {
    handleError(res, err, 'dashboards update');
  }
});

router.delete('/dashboards/:id', async (req, res) => {
  try {
    const deleted = await dashboards.deleteDashboard(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ error: 'Dashboard not found' });
    res.json({ deleted: true });
  } catch (err) {
    handleError(res, err, 'dashboards delete');
  }
});

module.exports = router;
