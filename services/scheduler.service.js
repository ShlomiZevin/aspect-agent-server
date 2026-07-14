/**
 * Cloud Scheduler admin service.
 *
 * Lets the admin UI list and retime the data-loader cron jobs (drive-sync,
 * ensure-loaded, ensure-indexed) instead of going through the GCP Console.
 * Uses the Cloud Run service's own runtime service account (roles/editor -
 * already has Cloud Scheduler admin permissions), so no extra credentials
 * are needed on Cloud Run. Locally it falls back to gcloud's Application
 * Default Credentials.
 */

const { CloudSchedulerClient } = require('@google-cloud/scheduler');

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'aspect-agents';
const LOCATION = process.env.GCP_REGION || 'europe-west1';

// Only expose jobs that hit our own data-loader endpoints - this admin
// surface is for reload scheduling, not a general Cloud Scheduler browser.
const RELEVANT_URI_MARKER = '/api/admin/data-loader/';

let client = null;
function getClient() {
  if (!client) client = new CloudSchedulerClient();
  return client;
}

function parent() {
  return `projects/${PROJECT_ID}/locations/${LOCATION}`;
}

function jobName(name) {
  return `${parent()}/jobs/${name}`;
}

// Cloud Scheduler returns protobuf Timestamps ({ seconds, nanos }), not ISO strings.
function toIso(timestamp) {
  if (!timestamp?.seconds) return null;
  return new Date(Number(timestamp.seconds) * 1000 + Math.round((timestamp.nanos || 0) / 1e6)).toISOString();
}

function toApiShape(job) {
  const shortName = job.name.split('/').pop();
  return {
    name: shortName,
    schedule: job.schedule,
    timeZone: job.timeZone,
    state: job.state, // 'ENABLED' | 'PAUSED'
    uri: job.httpTarget?.uri || null,
    lastAttemptTime: toIso(job.lastAttemptTime),
    scheduleTime: toIso(job.scheduleTime), // next scheduled run
  };
}

async function listJobs() {
  const [jobs] = await getClient().listJobs({ parent: parent() });
  return jobs
    .filter(j => j.httpTarget?.uri?.includes(RELEVANT_URI_MARKER))
    .map(toApiShape)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function updateSchedule(name, schedule) {
  const [updated] = await getClient().updateJob({
    job: { name: jobName(name), schedule },
    updateMask: { paths: ['schedule'] },
  });
  return toApiShape(updated);
}

async function setPaused(name, paused) {
  const fn = paused ? 'pauseJob' : 'resumeJob';
  const [updated] = await getClient()[fn]({ name: jobName(name) });
  return toApiShape(updated);
}

/**
 * Creates a new HTTP job hitting one of our own data-loader endpoints.
 * Used to turn on a capability (e.g. Drive sync) for a schema that didn't
 * have a Cloud Scheduler job for it yet. Created paused by default so
 * setting it up never silently starts firing before someone confirms it.
 */
async function createJob(name, schedule, uri, { paused = true } = {}) {
  const [created] = await getClient().createJob({
    parent: parent(),
    job: {
      name: jobName(name),
      schedule,
      timeZone: 'Asia/Jerusalem',
      httpTarget: {
        uri,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{}'),
      },
      attemptDeadline: { seconds: 60 },
    },
  });
  if (paused) {
    const [pausedJob] = await getClient().pauseJob({ name: created.name });
    return toApiShape(pausedJob);
  }
  return toApiShape(created);
}

module.exports = { listJobs, updateSchedule, setPaused, createJob };
