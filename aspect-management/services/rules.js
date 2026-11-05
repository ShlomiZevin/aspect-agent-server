/**
 * The V0 alert rules and the date logic under them. Pure: no DB, no clock unless
 * passed in, so `scripts/test-aspect-management-unit.js` can pin every rule.
 *
 * Dates are 'YYYY-MM-DD' strings throughout. Aspect works Sunday to Thursday in
 * Israel, so "today" and "the previous workday" are Israeli dates, not the
 * server's UTC ones — at 01:00 in Tel Aviv the UTC date is still yesterday.
 * Holidays are not known here; a developer can read as unreported on one.
 */
const NEAR_BUDGET_PCT = 90;
const OVER_BUDGET_PCT = 100;
const FOLLOWUP_DAYS = 7;
const AWAITING_ANSWER = ['sent', 'pending'];
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function todayInIsrael(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

const toUtc = date => new Date(`${date}T00:00:00Z`);

function addDays(date, days) {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86400000);

function previousWorkday(today) {
  let day = addDays(today, -1);
  // Friday (5) and Saturday (6) are the Israeli weekend.
  while ([5, 6].includes(toUtc(day).getUTCDay())) day = addDays(day, -1);
  return day;
}

const monthStart = today => `${today.slice(0, 7)}-01`;

function daysText(n) {
  if (n === 1) return 'יום אחד';
  if (n === 2) return 'יומיים';
  return `${n} ימים`;
}

/** Hours used against budget and due date. A project with no budget has no %. */
function projectState(project, today) {
  const budget = project.hoursBudget;
  const pct = budget > 0 ? Math.round((project.hoursUsed / budget) * 100) : null;
  const active = project.status === 'active';
  const late = active && Boolean(project.dueDate) && project.dueDate < today;
  return {
    pct,
    late,
    lateDays: late ? daysBetween(project.dueDate, today) : 0,
    over: active && pct !== null && pct >= OVER_BUDGET_PCT,
    near: active && pct !== null && pct >= NEAR_BUDGET_PCT && pct < OVER_BUDGET_PCT,
  };
}

/** Days since anyone last touched the quote: follow-up, else sent, else created. */
function quoteAgeDays(quote, today) {
  return daysBetween(quote.lastFollowupDate || quote.sentDate || quote.createdDate, today);
}

/**
 * One row per alert, what needs action first.
 *
 * @param {object} input
 * @param {string} input.today
 * @param {Array} input.projects   { id, name, clientName, hoursBudget, hoursUsed, dueDate, status }
 * @param {Array} input.developers active developers: { id, name, createdDate, hoursOnPreviousWorkday }
 * @param {Array} input.quotes     { id, clientName, subject, status, sentDate, lastFollowupDate, createdDate }
 * @param {Array} input.blockers   { personId, personName, date, body }
 */
function computeAlerts({ today, projects, developers, quotes, blockers }) {
  const alerts = [];
  const workday = previousWorkday(today);

  for (const project of projects) {
    const state = projectState(project, today);
    const base = { name: project.clientName, detail: project.name, target: { type: 'project', id: project.id } };
    if (state.late) {
      alerts.push({ ...base, kind: 'late', severity: 'action', action: 'לטיפול', line: `פרויקט באיחור של ${daysText(state.lateDays)}` });
    }
    if (state.over) {
      alerts.push({ ...base, kind: 'over', severity: 'action', action: 'לטיפול', line: `חריגה משעות התקציב: ${state.pct}%` });
    } else if (state.near) {
      alerts.push({ ...base, kind: 'near', severity: 'attention', action: 'לעקוב', line: `קרוב לסוף התקציב: ${state.pct}%` });
    }
  }

  for (const blocker of blockers) {
    if (blocker.date < workday) continue;
    alerts.push({
      kind: 'blocker',
      severity: 'action',
      action: 'לטיפול',
      name: blocker.personName,
      line: `משהו תקוע: ${blocker.body}`,
      target: { type: 'person', id: blocker.personId },
    });
  }

  for (const dev of developers) {
    // Someone added after that workday could not have reported on it.
    if (dev.hoursOnPreviousWorkday > 0 || dev.createdDate > workday) continue;
    const when = workday === addDays(today, -1) ? 'אתמול' : `ביום ${WEEKDAYS[toUtc(workday).getUTCDay()]}`;
    alerts.push({
      kind: 'no_report',
      severity: 'attention',
      action: 'לתזכורת',
      name: dev.name,
      line: `לא דיווח ${when}`,
      target: { type: 'person', id: dev.id },
    });
  }

  for (const quote of quotes) {
    if (!AWAITING_ANSWER.includes(quote.status)) continue;
    const age = quoteAgeDays(quote, today);
    if (age < FOLLOWUP_DAYS) continue;
    alerts.push({
      kind: 'no_followup',
      severity: 'attention',
      action: 'לעקוב',
      name: quote.clientName,
      detail: quote.subject,
      line: `הצעת מחיר ללא מעקב כבר ${daysText(age)}`,
      target: { type: 'quote', id: quote.id },
    });
  }

  return alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'action' ? -1 : 1));
}

module.exports = {
  todayInIsrael,
  addDays,
  daysBetween,
  previousWorkday,
  monthStart,
  projectState,
  quoteAgeDays,
  computeAlerts,
};
