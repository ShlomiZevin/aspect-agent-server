/**
 * Aspect Management's data: people, clients, projects, the daily report, quotes.
 *
 * Validation messages are in Hebrew because the UI shows them as they are, and
 * the product is Hebrew only. Every date crosses this file as 'YYYY-MM-DD' text
 * (`::text` in the SELECTs): `pg` turns a DATE into a JS Date at local midnight,
 * which reads as the day before anywhere west of the server's zone.
 */
const db = require('../../services/db.pg');
const signin = require('../../services/google-auth.service');
const rules = require('./rules');

// The project an Aspect employee's sign-in account belongs to.
const TENANT = 'aspect';
const QUOTE_OPEN = ['preparing', 'sent', 'pending'];
const QUOTE_STATUSES = [...QUOTE_OPEN, 'won', 'lost'];

function invalid(message) {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
}

function text(value, label, { required = true } = {}) {
  const clean = String(value ?? '').trim();
  if (required && !clean) throw invalid(`חסר ${label}`);
  return clean || null;
}

function number(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw invalid(`${label} לא תקין`);
  return n;
}

function date(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`${label} לא תקין`);
  return value;
}

function id(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw invalid(`חסר ${label}`);
  return n;
}

async function withTransaction(work) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- people -------------------------------------------------------------------

const PERSON_COLUMNS = `id, name, email, role, active`;

/**
 * Who this signed-in email is here. An admin of the Aspect project with no row
 * yet becomes an owner on first arrival, which is how the very first person gets
 * in — there is nobody yet to add them. The admin mark is read from the grant,
 * never taken from the request.
 */
async function whoAmI(emailRaw, name) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!email) return null;

  const { rows } = await db.query(`SELECT ${PERSON_COLUMNS} FROM am_people WHERE email = $1`, [email]);
  if (rows[0]) return rows[0].active ? rows[0] : null;

  const grant = await signin.grantFor(email, TENANT);
  if (grant?.role !== 'admin') return null;

  const { rows: created } = await db.query(
    `INSERT INTO am_people (name, email, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING ${PERSON_COLUMNS}`,
    [String(name || email.split('@')[0]).trim(), email],
  );
  return created[0];
}

async function listPeople() {
  const today = rules.todayInIsrael();
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.email, p.role, p.active,
            COALESCE(SUM(t.hours) FILTER (WHERE t.entry_date = $1::date), 0)::float8 AS "hoursPreviousWorkday",
            COALESCE(SUM(t.hours) FILTER (WHERE t.entry_date >= $2::date), 0)::float8 AS "hoursThisMonth",
            MAX(t.entry_date)::text AS "lastReportDate"
       FROM am_people p
       LEFT JOIN am_time_entries t ON t.person_id = p.id
      GROUP BY p.id
      ORDER BY p.active DESC, p.role DESC, p.name`,
    [rules.previousWorkday(today), rules.monthStart(today)],
  );
  return rows;
}

function personValues(body) {
  const email = text(body.email, 'אימייל').toLowerCase();
  if (!email.includes('@')) throw invalid('אימייל לא תקין');
  const role = body.role === 'owner' ? 'owner' : 'developer';
  return [text(body.name, 'שם'), email, role, body.active !== false];
}

async function createPerson(body) {
  try {
    const { rows } = await db.query(
      `INSERT INTO am_people (name, email, role, active) VALUES ($1, $2, $3, $4) RETURNING ${PERSON_COLUMNS}`,
      personValues(body),
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw invalid('האימייל הזה כבר קיים ברשימה');
    throw err;
  }
}

async function updatePerson(personId, body) {
  try {
    const { rows } = await db.query(
      `UPDATE am_people SET name = $2, email = $3, role = $4, active = $5 WHERE id = $1 RETURNING ${PERSON_COLUMNS}`,
      [id(personId, 'אדם'), ...personValues(body)],
    );
    if (!rows[0]) throw invalid('האדם לא נמצא');
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw invalid('האימייל הזה כבר קיים ברשימה');
    throw err;
  }
}

/** A person's last two weeks, for the owner opening them from the team screen. */
async function personReports(personId) {
  const pid = id(personId, 'אדם');
  const from = rules.addDays(rules.todayInIsrael(), -14);
  const [entries, blockers] = await Promise.all([
    db.query(
      `SELECT t.id, t.entry_date::text AS date, t.hours::float8 AS hours, t.description, t.billable,
              c.name AS "clientName", pr.name AS "projectName"
         FROM am_time_entries t
         LEFT JOIN am_clients c ON c.id = t.client_id
         LEFT JOIN am_projects pr ON pr.id = t.project_id
        WHERE t.person_id = $1 AND t.entry_date >= $2::date
        ORDER BY t.entry_date DESC, t.id`,
      [pid, from],
    ),
    db.query(
      `SELECT blocker_date::text AS date, body FROM am_blockers
        WHERE person_id = $1 AND blocker_date >= $2::date ORDER BY blocker_date DESC`,
      [pid, from],
    ),
  ]);
  return { entries: entries.rows, blockers: blockers.rows };
}

// --- projects -----------------------------------------------------------------

const PROJECT_SELECT = `
  SELECT p.id, p.client_id AS "clientId", c.name AS "clientName", p.name,
         p.hours_budget::float8 AS "hoursBudget", p.due_date::text AS "dueDate", p.status,
         p.amount::float8 AS amount, COALESCE(SUM(t.hours), 0)::float8 AS "hoursUsed"
    FROM am_projects p
    JOIN am_clients c ON c.id = p.client_id
    LEFT JOIN am_time_entries t ON t.project_id = p.id`;

function withState(projects) {
  const today = rules.todayInIsrael();
  return projects.map(p => ({ ...p, ...rules.projectState(p, today) }));
}

async function listActiveProjects() {
  const { rows } = await db.query(
    `${PROJECT_SELECT} WHERE p.status = 'active' GROUP BY p.id, c.name ORDER BY p.due_date NULLS LAST, p.id`,
  );
  return withState(rows);
}

function projectValues(body) {
  return [
    id(body.clientId, 'לקוח'),
    text(body.name, 'שם פרויקט'),
    number(body.hoursBudget, 'תקציב השעות'),
    date(body.dueDate, 'תאריך היעד'),
    body.status === 'done' ? 'done' : 'active',
    number(body.amount, 'הסכום'),
  ];
}

/**
 * A new project, or the one a won quote turns into. The quote is marked in the
 * same transaction, and a quote already converted refuses: the row lock stops a
 * double click from creating the project twice.
 */
async function createProject(body) {
  const values = projectValues(body);
  return withTransaction(async client => {
    if (body.quoteId) {
      const { rows } = await client.query('SELECT status, project_id FROM am_quotes WHERE id = $1 FOR UPDATE', [id(body.quoteId, 'הצעה')]);
      if (!rows[0] || rows[0].status !== 'won') throw invalid('אפשר להפוך לפרויקט רק הצעה שנסגרה');
      if (rows[0].project_id) throw invalid('ההצעה הזו כבר הפכה לפרויקט');
    }
    const { rows } = await client.query(
      `INSERT INTO am_projects (client_id, name, hours_budget, due_date, status, amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      values,
    );
    if (body.quoteId) await client.query('UPDATE am_quotes SET project_id = $2 WHERE id = $1', [body.quoteId, rows[0].id]);
    return rows[0];
  });
}

async function updateProject(projectId, body) {
  const { rows } = await db.query(
    `UPDATE am_projects SET client_id = $2, name = $3, hours_budget = $4, due_date = $5, status = $6, amount = $7
      WHERE id = $1 RETURNING id`,
    [id(projectId, 'פרויקט'), ...projectValues(body)],
  );
  if (!rows[0]) throw invalid('הפרויקט לא נמצא');
  return rows[0];
}

// --- clients ------------------------------------------------------------------

const CLIENT_COLUMNS = `c.id, c.name, c.logo_url AS "logoUrl", c.package_hours::float8 AS "packageHours",
  c.services, c.next_step AS "nextStep", c.next_step_date::text AS "nextStepDate"`;

// Only billable hours draw on the monthly package.
const HOURS_THIS_MONTH = `COALESCE((
  SELECT SUM(t.hours) FROM am_time_entries t
   WHERE t.client_id = c.id AND t.billable AND t.entry_date >= $1::date
), 0)::float8 AS "hoursThisMonth"`;

async function listClients() {
  const { rows } = await db.query(
    `SELECT ${CLIENT_COLUMNS}, ${HOURS_THIS_MONTH},
            (SELECT COUNT(*)::int FROM am_projects p WHERE p.client_id = c.id AND p.status = 'active') AS "activeProjects"
       FROM am_clients c ORDER BY c.name`,
    [rules.monthStart(rules.todayInIsrael())],
  );
  return rows;
}

/** The client card. Open items = active projects plus open quotes. */
async function getClient(clientId) {
  const cid = id(clientId, 'לקוח');
  const { rows } = await db.query(
    `SELECT ${CLIENT_COLUMNS}, ${HOURS_THIS_MONTH},
            (SELECT COUNT(*)::int FROM am_quotes q WHERE q.client_id = c.id AND q.status = ANY($3)) AS "openQuotes"
       FROM am_clients c WHERE c.id = $2`,
    [rules.monthStart(rules.todayInIsrael()), cid, QUOTE_OPEN],
  );
  if (!rows[0]) return null;

  const [projects, notes] = await Promise.all([
    db.query(`${PROJECT_SELECT} WHERE p.client_id = $1 GROUP BY p.id, c.name ORDER BY p.status, p.due_date NULLS LAST, p.id`, [cid]),
    db.query(
      `SELECT n.note_date::text AS date, n.body, pe.name AS "personName"
         FROM am_client_notes n LEFT JOIN am_people pe ON pe.id = n.person_id
        WHERE n.client_id = $1 ORDER BY n.note_date DESC, n.id DESC LIMIT 1`,
      [cid],
    ),
  ]);
  const clientProjects = withState(projects.rows);
  return {
    ...rows[0],
    projects: clientProjects,
    openItems: rows[0].openQuotes + clientProjects.filter(p => p.status === 'active').length,
    lastNote: notes.rows[0] || null,
  };
}

function clientValues(body) {
  const services = (Array.isArray(body.services) ? body.services : [])
    .map(s => ({ name: String(s?.name ?? '').trim(), status: String(s?.status ?? '').trim() }))
    .filter(s => s.name);
  return [
    text(body.name, 'שם לקוח'),
    text(body.logoUrl, 'לוגו', { required: false }),
    number(body.packageHours, 'שעות החבילה'),
    JSON.stringify(services),
    text(body.nextStep, 'הצעד הבא', { required: false }),
    date(body.nextStepDate, 'תאריך הצעד הבא'),
  ];
}

async function createClient(body) {
  const { rows } = await db.query(
    `INSERT INTO am_clients (name, logo_url, package_hours, services, next_step, next_step_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    clientValues(body),
  );
  return rows[0];
}

async function updateClient(clientId, body) {
  const { rows } = await db.query(
    `UPDATE am_clients SET name = $2, logo_url = $3, package_hours = $4, services = $5, next_step = $6, next_step_date = $7
      WHERE id = $1 RETURNING id`,
    [id(clientId, 'לקוח'), ...clientValues(body)],
  );
  if (!rows[0]) throw invalid('הלקוח לא נמצא');
  return rows[0];
}

async function addClientNote(clientId, body) {
  const { rows } = await db.query(
    `INSERT INTO am_client_notes (client_id, person_id, note_date, body) VALUES ($1, $2, $3, $4) RETURNING id`,
    [id(clientId, 'לקוח'), body.personId || null, rules.todayInIsrael(), text(body.body, 'טקסט')],
  );
  return rows[0];
}

// --- the daily report ---------------------------------------------------------

async function getReport(personIdRaw, dateRaw) {
  const personId = id(personIdRaw, 'אדם');
  const day = date(dateRaw, 'התאריך') || rules.todayInIsrael();
  const [entries, blocker, clients, projects] = await Promise.all([
    db.query(
      `SELECT id, client_id AS "clientId", project_id AS "projectId", hours::float8 AS hours, description, billable
         FROM am_time_entries WHERE person_id = $1 AND entry_date = $2::date ORDER BY id`,
      [personId, day],
    ),
    db.query('SELECT body FROM am_blockers WHERE person_id = $1 AND blocker_date = $2::date', [personId, day]),
    // This person's clients from the last month first, most recent on top.
    db.query(
      `SELECT c.id, c.name, MAX(t.entry_date) IS NOT NULL AS recent
         FROM am_clients c
         LEFT JOIN am_time_entries t
           ON t.client_id = c.id AND t.person_id = $1 AND t.entry_date >= ($2::date - 30)
        GROUP BY c.id
        ORDER BY MAX(t.entry_date) DESC NULLS LAST, c.name`,
      [personId, day],
    ),
    db.query(`SELECT id, client_id AS "clientId", name FROM am_projects WHERE status = 'active' ORDER BY name`),
  ]);
  return {
    date: day,
    entries: entries.rows,
    blocker: blocker.rows[0]?.body || '',
    clients: clients.rows,
    projects: projects.rows,
  };
}

/** Replaces the person's day with what the screen holds: one send, one state. */
async function saveReport(body) {
  const personId = id(body.personId, 'אדם');
  const day = date(body.date, 'התאריך');
  if (!day) throw invalid('חסר תאריך');
  if (day > rules.todayInIsrael()) throw invalid('אי אפשר לדווח על יום שעוד לא הגיע');

  const rows = (Array.isArray(body.entries) ? body.entries : []).map((row, i) => {
    const hours = Number(row.hours);
    if (!(hours > 0 && hours <= 24)) throw invalid(`שורה ${i + 1}: שעות צריכות להיות בין 0 ל-24`);
    const description = String(row.description ?? '').trim();
    if (!description) throw invalid(`שורה ${i + 1}: חסר מה עשית`);
    return {
      clientId: row.clientId ? id(row.clientId, 'לקוח') : null,
      projectId: row.projectId ? id(row.projectId, 'פרויקט') : null,
      hours,
      description,
      billable: Boolean(row.billable),
    };
  });
  const blocker = String(body.blocker ?? '').trim();

  await withTransaction(async client => {
    for (const row of rows) {
      if (!row.projectId) continue;
      const { rows: found } = await client.query('SELECT client_id FROM am_projects WHERE id = $1', [row.projectId]);
      if (found[0]?.client_id !== row.clientId) throw invalid('הפרויקט שנבחר לא שייך ללקוח');
    }
    await client.query('DELETE FROM am_time_entries WHERE person_id = $1 AND entry_date = $2::date', [personId, day]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO am_time_entries (person_id, entry_date, client_id, project_id, hours, description, billable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [personId, day, row.clientId, row.projectId, row.hours, row.description, row.billable],
      );
    }
    await client.query('DELETE FROM am_blockers WHERE person_id = $1 AND blocker_date = $2::date', [personId, day]);
    if (blocker) {
      await client.query('INSERT INTO am_blockers (person_id, blocker_date, body) VALUES ($1, $2, $3)', [personId, day, blocker]);
    }
  });
  return { saved: rows.length };
}

// --- quotes -------------------------------------------------------------------

const QUOTE_SELECT = `
  SELECT q.id, q.client_id AS "clientId", c.name AS "clientName", q.subject, q.amount::float8 AS amount, q.status,
         q.sent_date::text AS "sentDate", q.last_followup_date::text AS "lastFollowupDate",
         q.closed_date::text AS "closedDate", q.project_id AS "projectId",
         (q.created_at AT TIME ZONE 'Asia/Jerusalem')::date::text AS "createdDate"
    FROM am_quotes q JOIN am_clients c ON c.id = q.client_id`;

async function listAllQuotes() {
  const { rows } = await db.query(`${QUOTE_SELECT} ORDER BY q.id`);
  const today = rules.todayInIsrael();
  return rows.map(q => ({ ...q, ageDays: rules.quoteAgeDays(q, today) }));
}

/**
 * The money on the way, and what closed this month. A won quote stays listed past
 * its month until it becomes a project, or it could never be converted.
 */
async function listQuotes() {
  const quotes = await listAllQuotes();
  const open = quotes.filter(q => QUOTE_OPEN.includes(q.status)).sort((a, b) => b.ageDays - a.ageDays);
  const month = rules.monthStart(rules.todayInIsrael());
  return {
    open,
    openTotal: open.reduce((sum, q) => sum + q.amount, 0),
    closed: quotes.filter(q => q.status === 'won' && (q.closedDate >= month || !q.projectId)),
  };
}

function quoteValues(body, previous) {
  const status = QUOTE_STATUSES.includes(body.status) ? body.status : 'preparing';
  const today = rules.todayInIsrael();
  let sentDate = date(body.sentDate, 'תאריך השליחה');
  if (!sentDate && ['sent', 'pending'].includes(status)) sentDate = today;
  // Stamped once on closing, and cleared if the quote is reopened.
  const closedDate = ['won', 'lost'].includes(status) ? (previous?.closedDate || today) : null;
  const amount = number(body.amount, 'הסכום');
  if (amount === null) throw invalid('חסר סכום');
  return [
    id(body.clientId, 'לקוח'),
    text(body.subject, 'נושא'),
    amount,
    status,
    sentDate,
    date(body.lastFollowupDate, 'תאריך המעקב'),
    closedDate,
  ];
}

async function createQuote(body) {
  const { rows } = await db.query(
    `INSERT INTO am_quotes (client_id, subject, amount, status, sent_date, last_followup_date, closed_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    quoteValues(body),
  );
  return rows[0];
}

async function updateQuote(quoteId, body) {
  const qid = id(quoteId, 'הצעה');
  const { rows: found } = await db.query('SELECT closed_date::text AS "closedDate" FROM am_quotes WHERE id = $1', [qid]);
  if (!found[0]) throw invalid('ההצעה לא נמצאה');
  const { rows } = await db.query(
    `UPDATE am_quotes SET client_id = $2, subject = $3, amount = $4, status = $5, sent_date = $6,
            last_followup_date = $7, closed_date = $8
      WHERE id = $1 RETURNING id`,
    [qid, ...quoteValues(body, found[0])],
  );
  return rows[0];
}

// --- the morning screen -------------------------------------------------------

async function listAlertInputs() {
  const today = rules.todayInIsrael();
  const workday = rules.previousWorkday(today);
  const [projects, developers, quotes, blockers, clientCount] = await Promise.all([
    listActiveProjects(),
    db.query(
      `SELECT p.id, p.name, (p.created_at AT TIME ZONE 'Asia/Jerusalem')::date::text AS "createdDate",
              COALESCE(SUM(t.hours), 0)::float8 AS "hoursOnPreviousWorkday"
         FROM am_people p
         LEFT JOIN am_time_entries t ON t.person_id = p.id AND t.entry_date = $1::date
        WHERE p.role = 'developer' AND p.active
        GROUP BY p.id ORDER BY p.name`,
      [workday],
    ),
    listAllQuotes(),
    db.query(
      `SELECT b.person_id AS "personId", pe.name AS "personName", b.blocker_date::text AS date, b.body
         FROM am_blockers b JOIN am_people pe ON pe.id = b.person_id
        WHERE b.blocker_date >= $1::date ORDER BY b.blocker_date DESC`,
      [workday],
    ),
    db.query('SELECT COUNT(*)::int AS count FROM am_clients'),
  ]);
  return {
    today,
    projects,
    developers: developers.rows,
    quotes,
    blockers: blockers.rows,
    clientCount: clientCount.rows[0].count,
  };
}

async function morning() {
  const inputs = await listAlertInputs();
  return { today: inputs.today, alerts: rules.computeAlerts(inputs), clientCount: inputs.clientCount };
}

module.exports = {
  whoAmI,
  listPeople,
  createPerson,
  updatePerson,
  personReports,
  listActiveProjects,
  createProject,
  updateProject,
  listClients,
  getClient,
  createClient,
  updateClient,
  addClientNote,
  getReport,
  saveReport,
  listQuotes,
  listAllQuotes,
  createQuote,
  updateQuote,
  listAlertInputs,
  morning,
  invalid,
};
