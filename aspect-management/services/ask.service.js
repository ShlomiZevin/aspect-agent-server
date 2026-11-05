/**
 * "שואלים את המערכת": a question about the company, a short Hebrew answer.
 *
 * The task's preferred route was pointing the NL->SQL data-chat engine at these
 * tables. It is not used, on purpose: the engine would run generated SQL on the
 * platform DB, where nothing stops a question reaching `users` or conversations,
 * and its prompts are tuned for retail schemas. Here the model is handed the V0
 * data as facts that code already computed, so it can only see this tool's rows
 * and the numbers on this screen match the numbers on the others.
 */
const db = require('../../services/db.pg');
const llmService = require('../../services/llm');
const management = require('./management.service');
const rules = require('./rules');

const MODEL = 'claude-sonnet-5-5';
const HISTORY_DAYS = 45;
const MAX_QUESTION_CHARS = 500;

const INSTRUCTIONS = `You answer the owner of Aspect, an Israeli software company, about his company's operations.

Answer in Hebrew only, whatever language the question or the data is in. Plain, short sentences: three or four at most, the answer first. No headings, no tables, no markdown, no bullet symbols.

Use only the JSON facts you are given. Every number must come from them or be a direct sum of them; never estimate. If the facts cannot answer the question, say so in one sentence and name what is missing. The time entries cover only the last ${HISTORY_DAYS} days.

Vocabulary in the facts:
- "today" and "previousWorkday" are Israeli dates. Aspect works Sunday to Thursday, so "yesterday" in a question means previousWorkday.
- alerts: what needs the owner's attention or decision today, already computed.
- A time entry with clientName null is internal work.
- project pct is the share of the hours budget used, so 105 means 5% over the budget, not 105% over it. over = 100 or more, near = 90 or more, late = past its due date.
- quote status: preparing, sent, pending = open. won = closed. lost = lost. ageDays = days since the last follow-up.`;

async function loadTimeEntries(from) {
  const { rows } = await db.query(
    `SELECT t.entry_date::text AS date, pe.name AS person, c.name AS "clientName", pr.name AS project,
            t.hours::float8 AS hours, t.billable, t.description
       FROM am_time_entries t
       JOIN am_people pe ON pe.id = t.person_id
       LEFT JOIN am_clients c ON c.id = t.client_id
       LEFT JOIN am_projects pr ON pr.id = t.project_id
      WHERE t.entry_date >= $1::date
      ORDER BY t.entry_date DESC, pe.name`,
    [from],
  );
  return rows;
}

async function buildFacts() {
  const inputs = await management.listAlertInputs();
  const from = rules.addDays(inputs.today, -HISTORY_DAYS);
  const [clients, timeEntries] = await Promise.all([management.listClients(), loadTimeEntries(from)]);
  return {
    today: inputs.today,
    previousWorkday: rules.previousWorkday(inputs.today),
    alerts: rules.computeAlerts(inputs).map(({ name, line, detail }) => ({ name, line, detail })),
    developers: inputs.developers.map(({ name, hoursOnPreviousWorkday }) => ({ name, hoursOnPreviousWorkday })),
    clients: clients.map(({ name, packageHours, hoursThisMonth, services, nextStep, nextStepDate }) => ({
      name, packageHours, hoursThisMonth, services, nextStep, nextStepDate,
    })),
    activeProjects: inputs.projects.map(({ clientName, name, hoursBudget, hoursUsed, dueDate, pct, late, lateDays, over, near }) => ({
      clientName, name, hoursBudget, hoursUsed, dueDate, pct, late, lateDays, over, near,
    })),
    quotes: inputs.quotes.map(({ clientName, subject, amount, status, ageDays, closedDate }) => ({
      clientName, subject, amount, status, ageDays, closedDate,
    })),
    recentBlockers: inputs.blockers.map(({ personName, date, body }) => ({ personName, date, body })),
    timeEntries,
  };
}

async function ask(questionRaw) {
  const question = String(questionRaw ?? '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw management.invalid('מה רצית לשאול?');

  const facts = await buildFacts();
  const answer = await llmService.sendOneShot(
    INSTRUCTIONS,
    `Facts:\n${JSON.stringify(facts)}\n\nQuestion:\n${question}`,
    { model: MODEL, maxTokens: 800, temperature: 0, context: 'aspect_management_ask' },
  );
  return { answer: String(answer ?? '').trim() };
}

module.exports = { ask };
