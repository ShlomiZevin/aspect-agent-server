#!/usr/bin/env node
/**
 * Build the server settings file of a NEW Lybi environment — never prints a value.
 * Skill: .claude/skills/new-environment/SKILL.md
 *
 *   GEMINI_KEY=… OPENAI_KEY=… ANTHROPIC_KEY=… node scripts/make-env-file.js <env> \
 *     --project lybi-acme --region me-west1 --instance lybi-acme-db \
 *     --site https://lybi-acme.web.app --billing 017787-4464F3-55E08C
 *
 * Writes `.env.production.<env>` (git-ignored) from `.env.production.aspect`:
 *   kept    Gmail, Pinecone, Leonardo, Google sign-in client, model names, pool size
 *   new     database (Cloud SQL socket, user lybi_app, generated password),
 *           the three model keys (from the env vars above; missing → PENDING),
 *           billing account, the site's address
 *   dropped everything Aspect-only (WhatsApp, Notion, data reloads, admin keys, …)
 *
 * Run again any time: an existing file keeps its database password and any key
 * not passed in, so re-running never breaks a running environment's login.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const env = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const project = opt('project'), region = opt('region') || 'me-west1', instance = opt('instance');
const site = opt('site'), billing = opt('billing');
if (!env || !project || !instance || !site) {
  console.error('usage: make-env-file.js <env> --project <id> --instance <sql-instance> --site <https://…> [--region me-west1] [--billing <id>]');
  process.exit(1);
}

const read = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = read(path.join(ROOT, '.env.production.aspect'));
const outFile = path.join(ROOT, `.env.production.${env}`);
const prev = fs.existsSync(outFile) ? read(outFile) : {};

const KEEP = ['NODE_ENV', 'CLAUDE_MODEL', 'OPENAI_MODEL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PINECONE_API_KEY',
  'PINECONE_INDEX_NAME', 'LEONARDO_API_KEY', 'LYBI_LEONARDO_API_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'DB_POOL_MAX', 'DB_POOL_MIN'];
const pending = v => !v || v.startsWith('PENDING');
const key = (name, fromEnv) => process.env[fromEnv] || (!pending(prev[name]) ? prev[name] : 'PENDING-new-lybi-key');
const conn = `${project}:${region}:${instance}`;
const values = {
  ...Object.fromEntries(KEEP.filter(k => base[k] != null).map(k => [k, base[k]])),
  // A Google sign-in client made for this environment wins over Origin's.
  ...(prev.GOOGLE_OAUTH_CLIENT_ID ? { GOOGLE_OAUTH_CLIENT_ID: prev.GOOGLE_OAUTH_CLIENT_ID } : {}),
  GCP_PROJECT_ID: project,
  CLOUD_SQL_INSTANCE_NAME: instance,
  CLOUD_SQL_CONNECTION_NAME: conn,
  DB_HOST: `/cloudsql/${conn}`,
  DB_PORT: '5432',
  DB_NAME: 'agents_platform_db',
  DB_USER: 'lybi_app',
  DB_PASSWORD: prev.DB_PASSWORD || crypto.randomBytes(24).toString('base64url'),
  GEMINI_API_KEY: key('GEMINI_API_KEY', 'GEMINI_KEY'),
  OPENAI_API_KEY: key('OPENAI_API_KEY', 'OPENAI_KEY'),
  ANTHROPIC_API_KEY: key('ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'),
  ...(billing || prev.GCP_BILLING_ACCOUNT_ID ? { GCP_BILLING_ACCOUNT_ID: billing || prev.GCP_BILLING_ACCOUNT_ID } : {}),
  LYBI_APP_URL: site,
};

const lines = [
  `# Lybi environment "${env}" — project ${project}, ${region}. Built by scripts/make-env-file.js from .env.production.aspect.`,
  '# Shared with Origin on purpose: Gmail, Pinecone, Leonardo. Own: database, model keys, Google sign-in client.',
  ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
  '',
];
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`written .env.production.${env}: ${Object.keys(values).join(' ')}`);
console.log(`database password: ${prev.DB_PASSWORD ? 'kept' : 'generated'}`);
const missing = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => pending(values[k]));
console.log(missing.length ? `still PENDING: ${missing.join(', ')} — re-run with the key in its env var` : 'all three model keys set');
