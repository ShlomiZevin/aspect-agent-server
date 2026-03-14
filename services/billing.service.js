/**
 * Billing Service
 *
 * Fetches current month usage and cost data from provider APIs.
 * - OpenAI: Usage API (/v1/organization/usage/*)
 * - Anthropic: Usage API (/v1/usage)
 * - Google: Not supported via API — manual check required
 */

const https = require('https');
const providerConfigService = require('./provider-config.service');

/**
 * Helper: perform an HTTPS GET request and return parsed JSON.
 */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on('error', reject);
  });
}

/**
 * Get current month date range as YYYY-MM-DD strings.
 */
function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end), startTs: Math.floor(start.getTime() / 1000), endTs: Math.floor(end.getTime() / 1000) };
}

class BillingService {

  // ─── OpenAI ──────────────────────────────────────────────────────────────────

  /**
   * Fetch OpenAI usage for the current month.
   * Uses the new /v1/organization/usage/* endpoints (available since 2024).
   * Docs: https://platform.openai.com/docs/api-reference/usage
   */
  async getOpenAIBilling(apiKey) {
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const { start, end } = getCurrentMonthRange();
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const { startTs, endTs } = getCurrentMonthRange();
    // Fetch completions usage (chat/completions, responses)
    const completionsUrl = `https://api.openai.com/v1/organization/usage/completions?start_time=${startTs}&end_time=${endTs}&bucket_width=1d&group_by[]=model`;
    // Fetch embeddings usage
    const embeddingsUrl = `https://api.openai.com/v1/organization/usage/embeddings?start_time=${startTs}&end_time=${endTs}&bucket_width=1d`;

    const [completions, embeddings] = await Promise.allSettled([
      httpsGet(completionsUrl, headers),
      httpsGet(embeddingsUrl, headers),
    ]);

    // Also try to get costs directly from the costs endpoint
    const costsUrl = `https://api.openai.com/v1/organization/costs?start_time=${startTs}&end_time=${endTs}&bucket_width=1d`;
    const costsResult = await httpsGet(costsUrl, headers).catch(() => null);

    // Aggregate completions usage
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const modelBreakdown = {};

    if (completions.status === 'fulfilled' && completions.value?.data) {
      for (const bucket of completions.value.data) {
        for (const result of (bucket.results || [])) {
          totalInputTokens += result.input_tokens || 0;
          totalOutputTokens += result.output_tokens || 0;
          const model = result.model_id;
          if (!model) continue;
          if (!modelBreakdown[model]) modelBreakdown[model] = { input_tokens: 0, output_tokens: 0 };
          modelBreakdown[model].input_tokens += result.input_tokens || 0;
          modelBreakdown[model].output_tokens += result.output_tokens || 0;
        }
      }
    }

    // Aggregate costs
    let totalCostUsd = null;
    if (costsResult?.data) {
      totalCostUsd = 0;
      for (const bucket of costsResult.data) {
        for (const result of (bucket.results || [])) {
          totalCostUsd += parseFloat(result.amount?.value || 0);
        }
      }
    }

    return {
      provider: 'openai',
      period: { start, end },
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUsd,
      modelBreakdown,
      error: completions.status === 'rejected' ? completions.reason?.message : null,
    };
  }

  // ─── Anthropic ───────────────────────────────────────────────────────────────

  /**
   * Fetch Anthropic usage for the current month.
   * Uses the Admin API (requires Admin API key, not the regular API key).
   * Docs: https://docs.anthropic.com/en/api/getting-started#usage
   */
  async getAnthropicBilling(adminApiKey) {
    if (!adminApiKey) throw new Error('Anthropic Admin API key not configured');

    const { start, end } = getCurrentMonthRange();
    const headers = {
      'x-api-key': adminApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };

    // Fetch usage via the usage report endpoint
    const usageUrl = `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${start}`;

    let usageData = null;
    let usageError = null;
    try {
      usageData = await httpsGet(usageUrl, headers);
    } catch (e) {
      usageError = e.message;
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = null;
    const modelBreakdown = {};

    if (usageData?.data) {
      totalCostUsd = 0;
      for (const entry of usageData.data) {
        const inputTokens = entry.input_tokens || 0;
        const outputTokens = entry.output_tokens || 0;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;

        if (entry.cost_usd != null) totalCostUsd += entry.cost_usd;

        // Skip entries without a model name (aggregate rows)
        const model = entry.model;
        if (!model) continue;

        if (!modelBreakdown[model]) modelBreakdown[model] = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        modelBreakdown[model].input_tokens += inputTokens;
        modelBreakdown[model].output_tokens += outputTokens;
        if (entry.cost_usd != null) modelBreakdown[model].cost_usd += entry.cost_usd;
      }
    }

    return {
      provider: 'anthropic',
      period: { start, end },
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUsd,
      modelBreakdown,
      error: usageError,
    };
  }

  // ─── Google ──────────────────────────────────────────────────────────────────

  /**
   * Fetch Google Cloud billing for the current month.
   * Queries BigQuery billing export data via the googleapis BigQuery client.
   *
   * Required config (via providerConfigService or env vars):
   *   gcp_billing_project_id  — GCP project that hosts the BigQuery dataset
   *   gcp_billing_dataset     — BigQuery dataset name (e.g. "billing_export")
   *   gcp_billing_account_id  — Billing account ID (e.g. "01FD2D-A3AC57-1B721E")
   *   gcp_billing_service_account_json — Service account JSON key
   *
   * One-time setup: enable "Standard usage cost" export in GCP Console →
   *   Billing → Billing export → BigQuery export.
   */
  async getGoogleBilling() {
    const projectId = providerConfigService.getCached('gcp_billing_project_id');
    const dataset = providerConfigService.getCached('gcp_billing_dataset');
    const billingAccountId = providerConfigService.getCached('gcp_billing_account_id');
    const serviceAccountJson = providerConfigService.getCached('gcp_billing_service_account_json');

    if (!projectId || !dataset || !serviceAccountJson) {
      return {
        provider: 'google',
        status: 'not_configured',
        message: 'Google Cloud billing requires BigQuery billing export. Configure: project ID, dataset name, billing account ID, and service account JSON.',
        setupUrl: 'https://console.cloud.google.com/billing',
        missingKeys: [
          ...(!projectId ? ['gcp_billing_project_id'] : []),
          ...(!dataset ? ['gcp_billing_dataset'] : []),
          ...(!serviceAccountJson ? ['gcp_billing_service_account_json'] : []),
        ],
      };
    }

    const { google } = require('googleapis');

    let credentials;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch (e) {
      return { provider: 'google', error: 'Invalid service account JSON: not valid JSON' };
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    });

    const bigquery = google.bigquery({ version: 'v2', auth });

    const { start, end } = getCurrentMonthRange();
    // End filter: first day of next month (exclusive upper bound)
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const endExclusive = nextMonth.toISOString().split('T')[0];

    // Table name: gcp_billing_export_v1_XXXXXX_YYYYYY_ZZZZZZ
    const tableSuffix = billingAccountId
      ? billingAccountId.replace(/-/g, '_')
      : '*';
    const fullTable = `\`${projectId}.${dataset}.gcp_billing_export_v1_${tableSuffix}\``;

    const query = `
      SELECT
        service.description AS service_name,
        SUM(cost) AS total_cost,
        SUM((SELECT SUM(c.amount) FROM UNNEST(credits) c)) AS total_credits,
        currency
      FROM ${fullTable}
      WHERE usage_start_time >= TIMESTAMP('${start}')
        AND usage_start_time < TIMESTAMP('${endExclusive}')
      GROUP BY service_name, currency
      ORDER BY total_cost DESC
    `;

    try {
      const response = await bigquery.jobs.query({
        projectId,
        requestBody: {
          query,
          useLegacySql: false,
          timeoutMs: 30000,
        },
      });

      const rows = response.data.rows || [];
      const fields = response.data.schema?.fields || [];

      // Parse BigQuery response rows
      let totalCost = 0;
      let totalCredits = 0;
      let currency = null;
      const serviceBreakdown = {};

      for (const row of rows) {
        const serviceName = row.f[0]?.v || 'Unknown';
        const cost = parseFloat(row.f[1]?.v || '0');
        const credits = parseFloat(row.f[2]?.v || '0');
        const cur = row.f[3]?.v || null;

        totalCost += cost;
        totalCredits += credits;
        if (cur) currency = cur;

        serviceBreakdown[serviceName] = {
          cost: Math.round(cost * 100) / 100,
          credits: Math.round(credits * 100) / 100,
          net: Math.round((cost + credits) * 100) / 100, // credits are negative
        };
      }

      const netCost = totalCost + totalCredits; // credits are negative amounts

      return {
        provider: 'google',
        period: { start, end },
        totalCostUsd: Math.round(totalCost * 100) / 100,
        totalCredits: Math.round(totalCredits * 100) / 100,
        netCostUsd: Math.round(netCost * 100) / 100,
        billingAccountId,
        currency,
        serviceBreakdown,
        rowCount: rows.length,
      };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      return { provider: 'google', error: msg };
    }
  }

  // ─── Combined ────────────────────────────────────────────────────────────────

  /**
   * Fetch billing data from all providers.
   */
  async getAllBilling() {
    const openaiApiKey = providerConfigService.getCached('openai_admin_api_key') || process.env.OPENAI_ADMIN_API_KEY || process.env.OPENAI_API_KEY;
    const anthropicAdminApiKey = providerConfigService.getCached('anthropic_admin_api_key') || process.env.ANTHROPIC_ADMIN_API_KEY;

    const [openai, anthropic, google] = await Promise.allSettled([
      openaiApiKey ? this.getOpenAIBilling(openaiApiKey) : Promise.resolve({ provider: 'openai', error: 'API key not configured' }),
      anthropicAdminApiKey ? this.getAnthropicBilling(anthropicAdminApiKey) : Promise.resolve({ provider: 'anthropic', error: 'Admin API key not configured' }),
      this.getGoogleBilling(),
    ]);

    return {
      openai: openai.status === 'fulfilled' ? openai.value : { provider: 'openai', error: openai.reason?.message },
      anthropic: anthropic.status === 'fulfilled' ? anthropic.value : { provider: 'anthropic', error: anthropic.reason?.message },
      google: google.status === 'fulfilled' ? google.value : { provider: 'google', error: google.reason?.message },
    };
  }
}

module.exports = new BillingService();
