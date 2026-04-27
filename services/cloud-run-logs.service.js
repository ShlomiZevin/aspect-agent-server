const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'aspect-agents';
const SERVICE_NAME = 'aspect-agent-server';
const STDOUT_LOG    = `projects/${PROJECT_ID}/logs/run.googleapis.com%2Fstdout`;
const STDERR_LOG    = `projects/${PROJECT_ID}/logs/run.googleapis.com%2Fstderr`;
const REQUESTS_LOG  = `projects/${PROJECT_ID}/logs/run.googleapis.com%2Frequests`;

function getAuth() {
  const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, '..', 'storage-service-account-api-key.json');
  const options = { scopes: ['https://www.googleapis.com/auth/logging.read'] };
  if (fs.existsSync(keyFilePath)) options.keyFilename = keyFilePath;
  return new google.auth.GoogleAuth(options);
}

/**
 * Fetch Cloud Run logs: app logs (stdout/stderr) + HTTP request logs.
 * Always looks back 48 hours so older errors are not missed.
 */
async function fetchLogs({ severity = 'all', limit = 200, pageToken = null } = {}) {
  const auth = getAuth();
  const logging = google.logging({ version: 'v2', auth });

  // No timestamp filter — orderBy desc gives newest first and pageToken stays consistent
  let filter = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${SERVICE_NAME}"`,
    `(logName="${STDOUT_LOG}" OR logName="${STDERR_LOG}" OR logName="${REQUESTS_LOG}")`,
  ].join(' AND ');

  if (severity === 'error') {
    filter += ' AND severity>=ERROR';
  }

  const collected = [];
  let cursor = pageToken;
  let lastNextToken = null;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES && collected.length < limit; page++) {
    const response = await logging.entries.list({
      requestBody: {
        resourceNames: [`projects/${PROJECT_ID}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: 500,
        ...(cursor ? { pageToken: cursor } : {}),
      },
    });

    const raw = response.data.entries || [];
    for (const entry of raw) {
      let message = '';
      let extra = {};

      const httpReq = entry.httpRequest;
      if (httpReq) {
        const method = httpReq.requestMethod || '';
        const rawUrl = httpReq.requestUrl || '';
        const httpPath = rawUrl.replace(/^https?:\/\/[^/]+/, '') || rawUrl;
        const status = httpReq.status || '';
        const latencyRaw = httpReq.latency || '';
        const latencyMs = latencyRaw
          ? Math.round(parseFloat(latencyRaw) * 1000) + 'ms'
          : '';
        message = [method, httpPath, String(status), latencyMs].filter(Boolean).join(' ');
        extra = { type: 'http', httpMethod: method, httpPath, httpStatus: status, httpLatency: latencyMs };
      } else {
        message = entry.textPayload
          || (entry.jsonPayload
            ? (entry.jsonPayload.message || entry.jsonPayload.msg || JSON.stringify(entry.jsonPayload))
            : '')
          || '';
        extra = { type: 'app' };
      }

      if (!message) continue;

      collected.push({
        insertId: entry.insertId,
        timestamp: entry.timestamp,
        severity: entry.severity || 'DEFAULT',
        message,
        ...extra,
      });

      if (collected.length >= limit) break;
    }

    lastNextToken = response.data.nextPageToken || null;
    if (!lastNextToken || raw.length === 0) break;
    cursor = lastNextToken;
  }

  return {
    entries: collected,
    nextPageToken: collected.length >= limit ? lastNextToken : null,
  };
}

module.exports = { fetchLogs };
