#!/usr/bin/env node
/**
 * Aspect Management (#115): a demo set for Itzik to explore, and its removal.
 *
 *   node scripts/aspect-management-demo.js seed   # adds the demo (refuses if one exists)
 *   node scripts/aspect-management-demo.js wipe   # removes every is_demo row, nothing else
 *
 * Runs against the platform DB through the Cloud SQL proxy, like the migration
 * runners (DB_HOST_PROXY / DB_PORT_PROXY). Needs migration 067 (is_demo).
 *
 * Every date is relative to today in Israel, so a seed shows every kind of
 * morning alert whenever it runs: a late project, one over budget, one close
 * to it, a developer who did not report on the previous workday, a blocker,
 * and a quote with no follow-up for 9 days. The clients are the made-up ones
 * from the concept images, so nobody mistakes them for real ones.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const rules = require('../aspect-management/services/rules');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || process.env.DB_HOST,
  port: process.env.DB_PORT_PROXY || process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const TODAY = rules.todayInIsrael();
const day = n => rules.addDays(TODAY, n);
const isWorkday = date => ![5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

// The developers. Yossi's address is also a sign-in account, so Itzik can see
// the developer's own screen (the account itself is made on the Access page).
const PEOPLE = [
  { key: 'yossi', name: 'יוסי לוי', email: 'dev@aspect.com' },
  { key: 'dana', name: 'דנה שמש', email: 'dana.demo@aspect.com' },
  { key: 'ron', name: 'רון אברהם', email: 'ron.demo@aspect.com' },
];

const CLIENTS = [
  { key: 'alon', name: 'קבוצת אלון', packageHours: 40, services: [{ name: 'סוכן AI', status: 'פעיל' }, { name: 'דשבורד מכירות', status: 'פעיל' }, { name: 'Intelligence Center', status: 'בהטמעה' }], nextStep: 'האישור על סוכן ה-AI עד יום ראשון', nextStepIn: 3, note: { daysAgo: 3, by: 'owner', body: 'פגישה עם רון, המנכ"ל. רוצים להרחיב את הסוכן לסניפים בצפון. לשלוח הצעה עד סוף החודש.' } },
  { key: 'gal', name: 'מעדני גל', packageHours: 20, services: [{ name: 'דשבורד מכירות', status: 'פעיל' }], nextStep: 'הצגת גרסה ראשונה של הדשבורד', nextStepIn: 2, note: { daysAgo: 6, by: 'owner', body: 'ביקשו להוסיף השוואה לשנה שעברה. אמרתי שנבדוק אחרי הגרסה הראשונה.' } },
  { key: 'prachi', name: 'רשת פרחי', packageHours: null, services: [{ name: 'Insights', status: 'בהטמעה' }], nextStep: 'שיחת מעקב על הצעת המחיר', nextStepIn: 1, note: { daysAgo: 9, by: 'owner', body: 'נשלחה הצעת מחיר להרחבת Insights לכל הסניפים.' } },
  { key: 'talor', name: 'טל-אור', packageHours: 30, services: [{ name: 'Intelligence Center', status: 'בהטמעה' }], nextStep: 'הדרכה לצוות הקנייה', nextStepIn: 8, note: { daysAgo: 4, by: 'owner', body: 'הצוות שלהם התחיל לעבוד עם Intelligence. מבקשים הדרכה קצרה לקניינים.' } },
  { key: 'cafe', name: 'בית הקפה', packageHours: 15, services: [{ name: 'דשבורד סניפים', status: 'פעיל' }], nextStep: null, nextStepIn: null, note: null },
];

// target = hours the time entries add up to (that is what the % is made of).
const PROJECTS = [
  { key: 'alonAgent', client: 'alon', name: 'פריסת סוכן AI', budget: 120, target: 126, dueIn: -11, amount: 48000, devs: ['yossi', 'ron'], work: ['חיבור הסוכן ל-CRM', 'בדיקות עם נציגי השירות', 'תיקון זרימת ההעברה לנציג', 'כתיבת תסריטי שיחה'] },
  { key: 'galDash', client: 'gal', name: 'דשבורד מכירות', budget: 80, target: 41, dueIn: -5, amount: 22000, devs: ['dana'], work: ['בניית דשבורד מכירות', 'חיבור לנתוני הקופות', 'גרפים לפי סניף'] },
  { key: 'prachiInsights', client: 'prachi', name: 'הטמעת Insights', budget: 60, target: 55, dueIn: 30, amount: 18000, devs: ['dana', 'ron'], work: ['הגדרת שאלות Insights', 'טעינת נתוני מלאי', 'בדיקת דוחות מול הלקוח'] },
  { key: 'talorIc', client: 'talor', name: 'הטמעת Intelligence Center', budget: 100, target: 32, dueIn: 60, amount: 36000, devs: ['yossi'], work: ['חיבור מקורות נתונים', 'הגדרת דוחות ראשונים', 'פגישה עם צוות הקנייה'] },
  { key: 'cafeDash', client: 'cafe', name: 'דשבורד סניפים', budget: 50, target: 10, dueIn: 45, amount: 12000, devs: ['ron'], work: ['אפיון מסכי הסניפים', 'חיבור נתוני קופה'] },
];

const QUOTES = [
  { client: 'prachi', subject: 'הרחבת Insights לכל הסניפים', amount: 48000, status: 'sent', sentAgo: 9, followupAgo: null },
  { client: 'alon', subject: 'סוכן AI לסניפי הצפון', amount: 72000, status: 'pending', sentAgo: 6, followupAgo: 3 },
  { client: 'cafe', subject: 'דוח חודשי אוטומטי לבעלים', amount: 26000, status: 'preparing', sentAgo: null, followupAgo: null, createdAgo: 1 },
  { client: 'talor', subject: 'עבודה נוספת מעבר להסכם', amount: 40000, status: 'pending', sentAgo: 8, followupAgo: 4 },
  { client: 'gal', subject: 'תמיכה שנתית', amount: 120000, status: 'won', sentAgo: 20, followupAgo: 12, closedAgo: 5 },
];

async function seed(db) {
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM am_people WHERE is_demo');
  if (n > 0) throw new Error('A demo set is already there. Run "wipe" first.');

  // Created a month ago: someone added after the previous workday is never
  // flagged as "did not report", and the quotes need a creation date to age from.
  const created = `${day(-30)} 09:00:00+02`;
  const people = {};
  for (const p of PEOPLE) {
    const { rows: [row] } = await db.query(
      `INSERT INTO am_people (name, email, role, active, created_at, is_demo)
       VALUES ($1, $2, 'developer', true, $3, true) RETURNING id`, [p.name, p.email, created]);
    people[p.key] = row.id;
  }
  const { rows: [owner] } = await db.query(`SELECT id FROM am_people WHERE role = 'owner' AND NOT is_demo ORDER BY id DESC LIMIT 1`);

  const clients = {};
  for (const c of CLIENTS) {
    const { rows: [row] } = await db.query(
      `INSERT INTO am_clients (name, package_hours, services, next_step, next_step_date, created_at, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
      [c.name, c.packageHours, JSON.stringify(c.services), c.nextStep, c.nextStepIn === null ? null : day(c.nextStepIn), created]);
    clients[c.key] = row.id;
    if (c.note) {
      await db.query(
        `INSERT INTO am_client_notes (client_id, person_id, note_date, body, is_demo) VALUES ($1, $2, $3, $4, true)`,
        [row.id, owner ? owner.id : null, day(-c.note.daysAgo), c.note.body]);
    }
  }

  const projects = {};
  for (const p of PROJECTS) {
    const { rows: [row] } = await db.query(
      `INSERT INTO am_projects (client_id, name, hours_budget, due_date, status, amount, created_at, is_demo)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, true) RETURNING id`,
      [clients[p.client], p.name, p.budget, day(p.dueIn), p.amount, created]);
    projects[p.key] = { ...p, id: row.id, left: p.target };
  }

  // Three weeks of reports, newest first, so the recent days carry project work.
  // Each developer fills about 7-8 hours a day from their projects until each
  // project reaches its target; the rest of the day is internal work. Dana
  // skips the previous workday.
  const workdays = [];
  for (let d = 0; d >= -21; d--) if (isWorkday(day(d))) workdays.push(day(d));
  const skip = { dana: rules.previousWorkday(TODAY) };
  let entries = 0;
  for (const [i, date] of workdays.entries()) {
    for (const person of PEOPLE) {
      if (skip[person.key] === date) continue;
      if (date === TODAY && person.key !== 'yossi') continue; // only Yossi has reported today
      let capacity = date === TODAY ? 3 : 7 + ((i + person.key.length) % 3) * 0.5;
      const mine = Object.values(projects).filter(p => p.devs.includes(person.key) && p.left > 0);
      for (const project of mine) {
        if (capacity <= 0) break;
        const hours = Math.min(project.left, capacity, 4 + ((i * 3 + project.id) % 3));
        if (hours <= 0) continue;
        await db.query(
          `INSERT INTO am_time_entries (person_id, entry_date, client_id, project_id, hours, description, billable, is_demo)
           VALUES ($1, $2, $3, $4, $5, $6, true, true)`,
          [people[person.key], date, clients[project.client], project.id, hours, project.work[(i + entries) % project.work.length]]);
        project.left -= hours;
        capacity -= hours;
        entries++;
      }
      if (capacity >= 1 && date !== TODAY) {
        await db.query(
          `INSERT INTO am_time_entries (person_id, entry_date, client_id, project_id, hours, description, billable, is_demo)
           VALUES ($1, $2, NULL, NULL, $3, $4, false, true)`,
          [people[person.key], date, capacity, ['ישיבת צוות ותכנון', 'למידה ותשתיות', 'עזרה לצוות ותחזוקה'][i % 3]]);
        entries++;
      }
    }
  }

  await db.query(
    `INSERT INTO am_blockers (person_id, blocker_date, body, is_demo) VALUES ($1, $2, $3, true)`,
    [people.ron, rules.previousWorkday(TODAY), 'אין לי גישה לשרת של הלקוח בטל-אור']);

  for (const q of QUOTES) {
    await db.query(
      `INSERT INTO am_quotes (client_id, subject, amount, status, sent_date, last_followup_date, closed_date, created_at, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [clients[q.client], q.subject, q.amount, q.status,
        q.sentAgo === null ? null : day(-q.sentAgo),
        q.followupAgo === null ? null : day(-q.followupAgo),
        q.closedAgo ? day(-q.closedAgo) : null,
        q.createdAgo ? `${day(-q.createdAgo)} 09:00:00+02` : created]);
  }

  const short = Object.values(projects).filter(p => p.left > 0).map(p => `${p.name} (${p.left}h short)`);
  console.log(`Seeded: ${PEOPLE.length} developers, ${CLIENTS.length} clients, ${PROJECTS.length} projects, ${entries} time entries, 1 blocker, ${QUOTES.length} quotes.`);
  if (short.length) console.log(`Projects below their target: ${short.join(', ')}`);
}

async function wipe(db) {
  const order = ['am_time_entries', 'am_blockers', 'am_client_notes', 'am_quotes', 'am_projects', 'am_clients', 'am_people'];
  for (const table of order) {
    const { rowCount } = await db.query(`DELETE FROM ${table} WHERE is_demo`);
    console.log(`${table}: ${rowCount} demo rows removed`);
  }
}

async function main() {
  const action = process.argv[2];
  if (!['seed', 'wipe'].includes(action)) {
    console.log('Usage: node scripts/aspect-management-demo.js seed|wipe');
    process.exit(1);
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await (action === 'seed' ? seed(db) : wipe(db));
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(`Nothing changed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

main();
