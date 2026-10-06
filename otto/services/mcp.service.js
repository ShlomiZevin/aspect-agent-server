/**
 * The engine side of the "build with your own AI" door (task #96).
 *
 * The outside AI does what Otto's build call does — write a screen spec — and
 * everything after that is Otto's own pipeline, unchanged: validateSpec →
 * executeSpec (compiled SQL, statement timeout, row caps) → verifyBuild
 * probes → screens.storeSpec. Nothing here compiles SQL or renders anything,
 * and nothing here calls an LLM: the client's tool pays for the thinking.
 *
 * A saved screen also gets a PLAN derived from its spec, so the same draft
 * can be reopened in Otto and revised by talking — Otto's revision loop needs
 * a stored plan to change.
 */

const { validateSpec, validatePlan, isBilingual, ICONS } = require('./spec.contract');
const dataService = require('./data.service');
const probesService = require('./probes.service');
const screens = require('./screens.store');
const docStore = require('./doc-store.service');
const briefService = require('./brief.service');

const SAMPLE_ROWS = 5;

function httpError(status, message, detail) {
  return Object.assign(new Error(message), { status, detail });
}

/** The bilingual label of a column a result set exposes. */
function labelOf(rs, colId, brief) {
  const own = [...(rs.computed || []), ...(rs.aggregate?.measures || [])].find(c => c.id === colId);
  if (own?.label) return own.label;
  const field = (brief.fields || []).find(f => f.id === colId && f.sourceId === rs.source);
  return field?.label || { en: colId, he: colId };
}

/**
 * A plan that describes the spec, in the shape Otto's plan card and revision
 * loop expect. Built deterministically — no model reads or writes it.
 */
function derivePlan(spec, brief, { title, summary, icon }) {
  const rsById = Object.fromEntries(spec.resultSets.map(r => [r.id, r]));
  const sourceIds = [...new Set(spec.resultSets.map(r => r.source))];
  const isField = (rs, id) => (brief.fields || []).some(f => f.id === id && f.sourceId === rs.source);
  const ref = (rs, id) => ({ ...(isField(rs, id) ? { field: id } : {}), label: labelOf(rs, id, brief) });

  const columns = [];
  const filters = [];
  const kpis = [];
  const charts = [];
  const actions = [];
  for (const b of spec.blocks) {
    const rs = rsById[b.from];
    if (b.kind === 'dataTable') columns.push(...b.columns.map(c => ref(rs, c)));
    if (b.kind === 'filterBar') filters.push(...b.filters.map(c => ref(rs, c)));
    if (b.kind === 'kpiCards') kpis.push(...b.cards.map(c => ({ label: c.label, ...(c.sub ? { detail: c.sub } : {}) })));
    // The variant goes INTO the label: that is where Otto's coerceChartVariants
    // reads an approved chart type, so a later Otto revision keeps the pie a pie.
    if (b.kind === 'chart') charts.push({ label: { en: `${b.title.en} (${b.variant})`, he: `${b.title.he} (${b.variant})` } });
    if (b.kind === 'actionsBar') actions.push(...b.actions.map(a => ({ label: a.label })));
  }
  // A screen of only charts/KPIs still has columns it shows — the plan
  // contract requires at least one.
  if (columns.length === 0) {
    const rs = spec.resultSets[0];
    const ids = rs.aggregate ? [...rs.aggregate.groupBy, ...rs.aggregate.measures.map(m => m.id)] : rs.select;
    columns.push(...ids.map(id => ref(rs, id)));
  }

  const caveatIds = new Set(spec.blocks.filter(b => b.kind === 'noteLine').flatMap(b => b.caveatIds));
  const notes = (brief.caveats || [])
    .filter(c => caveatIds.has(c.id) && isBilingual(c.text))
    .map(c => c.text);

  return {
    title,
    summary,
    icon,
    sources: sourceIds.map(id => {
      const s = (brief.sources || []).find(x => x.id === id);
      return { id, label: s?.label || { en: id, he: id } };
    }),
    columns,
    filters,
    kpis,
    charts,
    actions,
    notes,
    isChange: false,
    changes: [],
  };
}

/**
 * Validate, execute and verify a spec without storing anything — the dry run
 * the outside AI iterates on. Never throws for a bad spec: the errors ARE the
 * answer, worded so the next attempt can fix exactly them.
 */
/**
 * Chart rules the door enforces on top of Otto's contract.
 *
 * Otto's build prompt TELLS its model these (a pie takes one series and at
 * most 10 slices) and Otto's plan step keeps them in line; the contract itself
 * does not check them. An outside AI has no plan step, and in the first door
 * tests a 40-slice pie and a chart whose "series" was a text column both
 * passed and would have rendered as an unreadable pie and an empty chart.
 * Checked here, not in spec.contract.js, so Otto's engine is untouched.
 */
function doorChecks(spec, brief) {
  const errors = [];
  const rsById = Object.fromEntries((spec.resultSets || []).map(r => [r.id, r]));
  (spec.blocks || []).forEach((b, i) => {
    if (b?.kind !== 'chart') return;
    const rs = rsById[b.from];
    if (!rs) return;
    const numeric = new Set([
      ...(rs.computed || []).map(c => c.id),
      ...(rs.aggregate?.measures || []).map(m => m.id),
      ...(brief.fields || []).filter(f => f.sourceId === rs.source && f.type === 'number').map(f => f.id),
    ]);
    for (const s of b.series || []) {
      if (!numeric.has(s)) errors.push(`blocks[${i}]: series '${s}' is not a numeric column — a chart plots numbers; use a measure, a computed column or a number field`);
    }
    if (b.variant === 'pie') {
      if ((b.series || []).length !== 1) errors.push(`blocks[${i}]: a pie takes exactly ONE series`);
      if (!rs.orderBy || !Number.isInteger(rs.limit) || rs.limit > 10) {
        errors.push(`blocks[${i}]: a pie shows at most 10 slices — give result set '${rs.id}' an orderBy (usually the measure, desc) and a limit of 10 or less, or use a bar chart`);
      }
    }
  });
  return errors;
}

async function check(spec, brief, ctx) {
  const errors = validateSpec(spec, brief);
  if (errors.length) return { ok: false, stage: 'validation', errors };
  const doorErrors = doorChecks(spec, brief);
  if (doorErrors.length) return { ok: false, stage: 'validation', errors: doorErrors };

  let payload;
  try {
    payload = await dataService.executeSpec(spec, brief, ctx);
  } catch (err) {
    return {
      ok: false,
      stage: 'query',
      errors: [`the spec is valid but its data could not be read: ${err.message}. `
        + 'Usually a result set is too broad for a heavy source — aggregate it, filter it, or lower its limit.'],
    };
  }

  const verification = probesService.verifyBuild(spec, payload);
  const sample = {};
  for (const [id, set] of Object.entries(payload.resultSets)) {
    sample[id] = { rowCount: set.total, truncated: set.truncated, firstRows: set.rows.slice(0, SAMPLE_ROWS) };
  }
  return {
    ok: verification.passed,
    stage: verification.passed ? 'passed' : 'verification',
    errors: verification.probes.filter(p => !p.passed).map(p => `${p.probe}: ${p.detail}`),
    warnings: scopeWarnings(spec, payload),
    probes: verification.probes,
    kpis: payload.kpis,
    sample,
  };
}

/**
 * What the screen will show that differs from what it seems to show.
 *
 * Otto's KPI cards are computed over every row the result set's `where`
 * keeps — its `limit` only trims the table (compiler.service.js, by design:
 * "totals over everything"). So a card on a result set that hit its limit
 * does NOT cover the rows on screen. In the second door test an outside AI
 * built "the last 30 days" as orderBy date desc + limit 30 and got a
 * "total revenue" card for all 639 days, with /check green — the probe that
 * would compare skips truncated sets. Not an error (a top-10 table with a
 * grand-total card is legitimate), so it is a warning the AI must relay.
 */
function scopeWarnings(spec, payload) {
  const warnings = [];
  for (const b of spec.blocks || []) {
    const set = payload.resultSets[b.from];
    if (!set) continue;
    if (b.kind === 'kpiCards' && set.truncated) {
      warnings.push(`kpiCards on '${b.from}': the cards cover ALL rows of '${b.from}' that its "where" keeps — NOT only the ${set.rows.length} rows its limit returns. `
        + 'If the limit picks a window ("last 30 days", "top 10"), these cards do not follow it: drop them, or label them as all-time totals and tell the person.');
    }
    if (b.kind === 'chart' && b.variant !== 'pie' && set.rows.length > 30) {
      warnings.push(`chart on '${b.from}': ${set.rows.length} rows but a chart draws only the first 30 — order and limit the result set to the 30 that matter.`);
    }
  }
  return warnings;
}

function readMeta(body, { required }) {
  const meta = {};
  if (body.title !== undefined || required) {
    if (!isBilingual(body.title)) throw httpError(400, 'title must be {"en": "...", "he": "..."} — both languages, the screen renders in either');
    meta.title = { en: String(body.title.en).slice(0, 60), he: String(body.title.he).slice(0, 60) };
  }
  if (body.summary !== undefined || required) {
    if (body.summary !== undefined && !isBilingual(body.summary)) {
      throw httpError(400, 'summary, when given, must be {"en": "...", "he": "..."}');
    }
    meta.summary = body.summary
      ? { en: String(body.summary.en).slice(0, 300), he: String(body.summary.he).slice(0, 300) }
      : meta.title;
  }
  if (body.icon !== undefined) {
    if (!ICONS.includes(body.icon)) throw httpError(400, `icon must be one of: ${ICONS.join(', ')}`);
    meta.icon = body.icon;
  }
  return meta;
}

/** Run the full check, and refuse to store anything that did not pass it. */
async function checkOrThrow(spec, brief, ctx) {
  const result = await check(spec, brief, ctx);
  if (!result.ok) {
    throw httpError(422, `the spec did not pass ${result.stage} — nothing was saved. Fix these and send it again`, result.errors);
  }
  return result;
}

const FROM_OUTSIDE = 'This app was built outside the Intelligence Center, with your own AI tool. '
  + 'You can keep changing it here by talking to Otto, or go on in your own tool.';

// ── versions — every door write is undoable ────────────────────────────────
//
// LYBI's door versions every save; an outside AI that makes a screen worse
// must not cost the person the one that worked. Stored in Otto's generic doc
// store (dataset-scoped, no migration): module 'ai-builder', one collection
// per app, one doc per version. Versions record what the DOOR saved; an edit
// made in Otto's own builder afterwards shows up as `currentMatchesLatest:
// false` rather than as a version.

const VERSIONS_MODULE = 'ai-builder';
const versionsOf = screenId => `versions.${screenId}`;
const versionDocId = n => `v${String(n).padStart(4, '0')}`;

function snapshotOf(row) {
  return { title: row.title, summary: row.summary || null, icon: row.icon || 'grid', spec: row.screenSpec || null };
}

async function readVersions(datasetId, screenId) {
  const docs = await docStore.listDocs(datasetId, VERSIONS_MODULE, versionsOf(screenId));
  return docs.map(d => d.data).filter(v => Number.isInteger(v?.n)).sort((a, b) => a.n - b.n);
}

async function recordVersion(datasetId, row, { by, note }) {
  const existing = await readVersions(datasetId, row.id);
  const n = (existing.at(-1)?.n || 0) + 1;
  const doc = { n, at: new Date().toISOString(), by, note: note ? String(note).slice(0, 200) : null, ...snapshotOf(row) };
  try {
    await docStore.putDoc(datasetId, VERSIONS_MODULE, versionsOf(row.id), versionDocId(n), doc);
  } catch (err) {
    // A version that cannot be written (oversized spec) must not fail the
    // save the person asked for — it costs the undo for this one step only.
    console.warn(`[ai-builder] version ${n} of ${row.id} not stored: ${err.message}`);
  }
  return n;
}

/** Before the first door change to an app the door did not make (Otto built
 *  it, or it predates versions), keep what it was — so "undo" has a target. */
async function ensureBaseline(datasetId, screen) {
  const existing = await readVersions(datasetId, screen.id);
  if (existing.length === 0 && screen.screenSpec) {
    await recordVersion(datasetId, screen, { by: 'before-ai', note: 'The app as it was before the first change from an AI tool' });
  }
}

async function listVersions(ctx, viewerId, screenId) {
  const screen = await screens.get(ctx.datasetId, screenId);
  if (!screen || !screens.canView(screen, viewerId)) {
    throw httpError(404, `there is no app '${screenId}' you can see — list them with list_apps (or GET apps)`);
  }
  const versions = await readVersions(ctx.datasetId, screen.id);
  const latest = versions.at(-1);
  return {
    id: screen.id,
    versions: versions.map(v => ({ version: v.n, at: v.at, by: v.by, note: v.note, title: v.title })),
    currentMatchesLatest: latest ? JSON.stringify(latest.spec) === JSON.stringify(screen.screenSpec) : null,
  };
}

/** Undo = re-save an old version as the newest one (history is never rewritten). */
async function restoreVersion(ctx, viewerId, screenId, version) {
  const screen = await loadOwn(ctx, viewerId, screenId);
  const versions = await readVersions(ctx.datasetId, screen.id);
  const v = versions.find(x => x.n === Number(version));
  if (!v) {
    throw httpError(404, `app '${screenId}' has no version ${version} — its versions are: ${versions.map(x => x.n).join(', ') || 'none yet'}`);
  }
  if (!v.spec) throw httpError(409, `version ${v.n} has no screen to restore`);
  return update(ctx, viewerId, screen.id, {
    spec: v.spec, title: v.title, summary: v.summary || undefined, icon: v.icon,
    note: `Restored version ${v.n}`,
  });
}

// ── the full database structure — reference only ───────────────────────────

const FULL_SCHEMA_TTL_MS = 10 * 60 * 1000;
const fullSchemaCache = new Map();

/**
 * Every table and column in the client's schema, with Otto's brief mapped on
 * top: which relations and columns are OPEN for screens (and under which
 * source/field id). The brief stays the only thing a spec may use — this is
 * so the AI can tell the person what exists and what is not open yet, instead
 * of "there is no such data". Read through Otto's own audit (pg_attribute, so
 * materialized views are included) and cached briefly: it scans the catalog.
 */
async function fullSchema(ctx) {
  const hit = fullSchemaCache.get(ctx.datasetId);
  if (hit && Date.now() - hit.at < FULL_SCHEMA_TTL_MS) return hit.value;

  const audit = await briefService.audit({ pool: ctx.pool, schemaName: ctx.schemaName, datasetId: ctx.datasetId });
  const sourceByRelation = new Map((ctx.brief.sources || []).map(s => [s.relation, s]));
  const fieldByColumn = new Map((ctx.brief.fields || []).map(f => {
    const src = (ctx.brief.sources || []).find(s => s.id === f.sourceId);
    return [`${src?.relation}.${f.column}`, f];
  }));

  const value = {
    note: 'Reference only. Screens can use ONLY the sources and fields in get_schema; relations marked open=false exist in the database but are not available for screens yet — tell the person, and suggest asking their Aspect contact to open them.',
    about: audit.manifestProse || null,
    relations: audit.relations.map(r => {
      const src = sourceByRelation.get(r.name);
      return {
        name: r.name,
        kind: r.kind,
        approxRows: r.rows,
        open: Boolean(src),
        ...(src ? { source: src.id } : {}),
        columns: r.columns.map(c => {
          const f = fieldByColumn.get(`${r.name}.${c.name}`);
          return { name: c.name, type: c.type, ...(f ? { field: f.id } : {}) };
        }),
        ...(r.columnsTruncated ? { columnsTruncated: true } : {}),
      };
    }),
    ...(audit.relationsTruncated ? { relationsTruncated: true } : {}),
  };
  fullSchemaCache.set(ctx.datasetId, { at: Date.now(), value });
  return value;
}

async function create(ctx, viewerId, body) {
  const meta = readMeta(body, { required: true });
  const verified = await checkOrThrow(body.spec, ctx.brief, ctx);
  meta.icon = meta.icon || 'grid';

  const plan = derivePlan(body.spec, ctx.brief, meta);
  // Belt and braces: a derived plan Otto would reject later is a draft Otto
  // cannot revise. Store the screen anyway (it works), but say so.
  const planErrors = validatePlan(plan, ctx.brief);

  const row = await screens.create(ctx.datasetId, {
    title: meta.title,
    plan: planErrors.length ? {} : plan,
    conversation: [{ role: 'assistant', content: FROM_OUTSIDE }],
    createdBy: viewerId,
  });
  await screens.update(ctx.datasetId, row.id, { summary: meta.summary, icon: meta.icon });
  const stored = await screens.storeSpec(ctx.datasetId, row.id, body.spec);
  dataService.invalidate(ctx.datasetId, row.id);
  const version = await recordVersion(ctx.datasetId, stored, { by: 'ai', note: body.note || 'Created' });
  return { screen: stored, check: verified, planStored: planErrors.length === 0, version };
}

/**
 * Load a screen for a write — Otto's routes' rules (loadScreen forEdit):
 * a screen you cannot see does not exist (404, never revealing it), and only
 * its creator may change, publish or delete it.
 */
async function loadOwn(ctx, viewerId, screenId) {
  const screen = await screens.get(ctx.datasetId, screenId);
  if (!screen || !screens.canView(screen, viewerId)) {
    throw httpError(404, `there is no app '${screenId}' you can see — list them with list_apps (or GET apps)`);
  }
  if (!screens.canEdit(screen, viewerId)) throw httpError(403, 'only the person who created this app can change, publish or delete it');
  return screen;
}

async function update(ctx, viewerId, screenId, body) {
  const screen = await loadOwn(ctx, viewerId, screenId);
  if (screen.status === 'active') {
    throw httpError(409, 'this app is published, and published apps are frozen. Unpublish it first (unpublish_app, or POST apps/<id>/unpublish) and tell the person it leaves their colleagues\' shelf until published again — then send the change');
  }

  const meta = readMeta(body, { required: false });
  const spec = body.spec !== undefined ? body.spec : screen.screenSpec;
  if (!spec) throw httpError(400, 'this app has no spec yet — send one in "spec"');
  const verified = body.spec !== undefined ? await checkOrThrow(spec, ctx.brief, ctx) : null;

  await ensureBaseline(ctx.datasetId, screen);

  const merged = {
    title: meta.title || screen.title,
    summary: meta.summary || screen.summary || meta.title || screen.title,
    icon: meta.icon || screen.icon || 'grid',
  };
  const plan = derivePlan(spec, ctx.brief, merged);
  const planOk = validatePlan(plan, ctx.brief).length === 0;
  await screens.update(ctx.datasetId, screen.id, { ...merged, ...(planOk ? { plan } : {}) });

  let row = await screens.get(ctx.datasetId, screen.id);
  if (body.spec !== undefined) {
    row = await screens.storeSpec(ctx.datasetId, screen.id, spec);
    dataService.invalidate(ctx.datasetId, screen.id);
  }
  const version = await recordVersion(ctx.datasetId, row, { by: 'ai', note: body.note || null });
  return { screen: row, check: verified, version };
}

/** "Save to Apps" — same store call as the builder's button. */
async function publish(ctx, viewerId, screenId) {
  const screen = await loadOwn(ctx, viewerId, screenId);
  if (screen.status === 'active') return screen;
  const row = await screens.publish(ctx.datasetId, screen.id);
  if (!row) throw httpError(409, 'only a saved app with a built screen can be published — save a spec to it first');
  return row;
}

/** "Edit" on a published app — back to an editable draft, snapshot kept. */
async function unpublish(ctx, viewerId, screenId) {
  const screen = await loadOwn(ctx, viewerId, screenId);
  if (screen.status !== 'active') return screen;
  const row = await screens.unpublish(ctx.datasetId, screen.id);
  if (!row) throw httpError(409, 'this app could not be taken back to a draft — it is no longer published');
  return row;
}

/** Delete — never-published drafts only, exactly the builder's rule. */
async function remove(ctx, viewerId, screenId) {
  const screen = await loadOwn(ctx, viewerId, screenId);
  if (screen.status === 'active' || screen.publishedState) {
    throw httpError(403, 'an app that has ever been published cannot be deleted from here — the person can ask their Aspect contact to remove it');
  }
  const ok = await screens.removeDraft(ctx.datasetId, screen.id);
  if (!ok) throw httpError(409, 'the draft could not be deleted — it may have been published or deleted meanwhile; list the apps again');
  // The app is gone; its history would only be orphaned rows.
  await docStore.deleteCollection(ctx.datasetId, VERSIONS_MODULE, versionsOf(screen.id)).catch(err =>
    console.warn(`[ai-builder] versions of ${screen.id} not removed: ${err.message}`));
  return { deleted: true, id: screen.id, title: screen.title };
}

module.exports = {
  check, create, update, publish, unpublish, remove,
  listVersions, restoreVersion, fullSchema,
  derivePlan, labelOf,
};
