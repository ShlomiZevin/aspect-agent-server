/**
 * Leonardo AI — image generation for HQ workers.
 *
 * ON TYPOGRAPHY, because the guide that shipped with the previous project says
 * "Leonardo cannot do typography" and that is simply wrong. Measured
 * 2026-08-23: the same prompt across nano-banana-2, nano-banana-pro and
 * gpt-image-2 rendered both a Hebrew headline and a Hebrew sub-line correctly
 * in all three.
 *
 * (A caution about reviewing them: small Hebrew is genuinely hard to read in a
 * downscaled preview. During that test the sub-line looked misspelled in every
 * image — and looked equally "misspelled" in an HTML render that provably
 * contained the right string. Judge the text at full size, not from a thumbnail,
 * before concluding a model got it wrong.)
 *
 * So text-in-image is a first-class option, not a fallback:
 *   - headlines and body copy: the models handle it
 *   - must be EXACT and repeatable (a logo, a URL, a price, legal wording, or
 *     the same template thirty times): render it in HTML over a text-free
 *     background instead
 *   - which route to take is the user's call, changeable mid-conversation
 *
 * The API returns the real USD cost upfront, so nothing here guesses at price.
 */

const API = 'https://cloud.leonardo.ai/api/rest';

/**
 * Only the models actually enabled on this account. Ideogram/Recraft/Phoenix
 * are NOT available here — don't add them back without checking.
 *
 * `sizes` lists dimension pairs the API accepts; arbitrary sizes are rejected
 * with an unhelpful VALIDATION_ERROR.
 */
const MODELS = {
  'nano-banana-2': {
    id: 'nano-banana-2', label: 'Nano Banana 2',
    about: 'Fast and cheap. Good photos, good headlines. The workhorse.',
    approxCost: 0.04, typical: 8,
  },
  'nano-banana-pro': {
    id: 'gemini-image-2', label: 'Nano Banana Pro',
    about: 'Best quality and the most reliable Hebrew. Slower and dearer.',
    approxCost: 0.21, typical: 25,
  },
  'gpt-image-2': {
    id: 'gpt-image-2', label: 'GPT Image 2',
    about: 'Very clean and graphic. Crisp Hebrew. Portrait is only 1024x1536.',
    approxCost: 0.10, typical: 40,
  },
  'lucid-origin': {
    id: 'lucid-origin', label: 'Lucid Origin',
    about: 'Cheapest. Good at flat vector and simple marks.',
    approxCost: 0.03, typical: 8,
  },
  'flux-pro-2.0': {
    id: 'flux-pro-2.0', label: 'Flux Pro 2.0',
    about: 'Strong geometry and composition.',
    approxCost: 0.05, typical: 12,
  },
};

/** Dimension pairs the API accepts. Anything else is rejected. */
const SIZES = {
  square:          { width: 1024, height: 1024 },
  portrait:        { width: 1024, height: 1536 },   // the only one gpt-image-2 takes
  story:           { width: 768,  height: 1376 },   // 9:16, 1K
  story_hd:        { width: 1536, height: 2752 },   // 9:16, 2K
  poster:          { width: 1696, height: 2528 },   // 2:3, high res
};

const DEFAULT_MODEL = 'nano-banana-2';

function isConfigured() {
  return !!process.env.LEONARDO_API_KEY;
}

function headers() {
  const key = process.env.LEONARDO_API_KEY;
  if (!key) throw new Error('LEONARDO_API_KEY is not set');
  return { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Queue a generation and wait for it.
 *
 * `onProgress` gets called while polling so a job can show "still rendering"
 * rather than looking hung — Pro routinely takes 20-40s and has gone past 90.
 */
async function generate({
  prompt,
  model = DEFAULT_MODEL,
  size = 'square',
  width,
  height,
  quantity = 1,
  referenceImageId = null,
  referenceStrength = 'LOW',
  onProgress = null,
} = {}) {
  if (!prompt || !prompt.trim()) throw new Error('An image needs a prompt');

  const chosen = MODELS[model] || MODELS[DEFAULT_MODEL];
  const dims = (width && height) ? { width, height } : (SIZES[size] || SIZES.square);

  const body = {
    // Omitting `public` returns a bare VALIDATION_ERROR on several models.
    public: false,
    model: chosen.id,
    parameters: {
      prompt: prompt.trim(),
      quantity,
      ...dims,
      prompt_enhance: 'OFF',
    },
  };

  if (referenceImageId) {
    // The documented flat `image_id` fails validation; the working shape is
    // nested. LOW keeps it as a colour/brand hint — MID and above make the
    // model try to redraw the reference.
    body.parameters.guidances = {
      image_reference: [{ image: { id: referenceImageId, type: 'UPLOADED' }, strength: referenceStrength }],
    };
  }

  const res = await fetch(`${API}/v2/generations`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const queued = await res.json();
  if (!queued.generate) {
    throw new Error(`Leonardo refused the request: ${JSON.stringify(queued).slice(0, 200)}`);
  }

  const generationId = queued.generate.generationId;
  const cost = Number(queued.generate.cost?.amount || 0);

  // Poll the v1 endpoint — v2 only queues. 70 x 2.5s ≈ 3 minutes; Pro needs it.
  for (let attempt = 0; attempt < 70; attempt++) {
    await sleep(2500);
    const poll = await fetch(`${API}/v1/generations/${generationId}`, { headers: headers() });
    const data = await poll.json();
    const gen = data.generations_by_pk;

    if (gen?.status === 'COMPLETE') {
      return {
        images: (gen.generated_images || []).map(i => i.url),
        cost, generationId,
        model, modelLabel: chosen.label,
        ...dims,
      };
    }
    if (gen?.status === 'FAILED') {
      // Two things were invisible when this happened in production: WHY it
      // failed, and that Leonardo had already quoted a price at queue time
      // which we then threw away. A retry that silently costs money is the
      // worst version of this, so both are surfaced.
      //
      // stderr rather than a return value: by the time the worker decides to
      // retry, nothing is left to inspect, and Cloud Run keeps stderr.
      const why = gen.status_reason || gen.statusReason || gen.error || null;
      console.error('[leonardo] generation FAILED', JSON.stringify({
        generationId, model: chosen.id, quotedCost: cost, reason: why,
        dims: `${dims.width}x${dims.height}`,
      }));
      const err = new Error(
        `Leonardo failed to generate the image${why ? `: ${why}` : ''}` +
        `${cost ? ` (it had quoted $${cost.toFixed(4)}; that may still be charged)` : ''}`
      );
      err.generationId = generationId;
      err.quotedCost = cost;
      throw err;
    }
    onProgress?.({ waitedMs: (attempt + 1) * 2500, generationId });
  }

  // It has almost certainly finished server-side; the caller can recover it.
  console.error('[leonardo] generation TIMED OUT', JSON.stringify({
    generationId, model: chosen.id, quotedCost: cost, waitedMs: 70 * 2500,
  }));
  throw new Error(`Leonardo timed out (generation ${generationId} may still have completed)`);
}

/**
 * Fetch the bytes of a generated image.
 *
 * Two traps, both of which return a plausible-looking failure rather than an
 * error: the CDN 403s the default Node user-agent, and Leonardo builds
 * filenames from the prompt, so an em-dash in the path produces an 87-byte
 * error page. Hence the browser UA, the encoded path, and the size check.
 */
async function download(url) {
  const parsed = new URL(url);
  parsed.pathname = encodeURI(decodeURI(parsed.pathname));

  const res = await fetch(parsed.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 5000) throw new Error('Image download returned an error page, not an image');
  return buffer;
}

/** Upload a reference image (e.g. our logo) so generations can take cues from it. */
async function uploadReference(buffer, extension = 'png') {
  const init = await fetch(`${API}/v1/init-image`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ extension }),
  });
  const { uploadInitImage } = await init.json();
  if (!uploadInitImage) throw new Error('Leonardo would not accept the reference upload');

  const fields = JSON.parse(uploadInitImage.fields);
  const form = new FormData();
  // The presigned POST requires every field BEFORE the file.
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([buffer]), `reference.${extension}`);

  const put = await fetch(uploadInitImage.url, { method: 'POST', body: form });
  if (!put.ok) throw new Error(`Reference upload failed (${put.status})`);
  return uploadInitImage.id;
}

/** Remaining credits, for the UI and for refusing work we can't pay for. */
async function balance() {
  const res = await fetch(`${API}/v1/me`, { headers: headers() });
  const data = await res.json();
  const me = data.user_details?.[0] || {};
  return { paidTokens: me.apiPaidTokens ?? null, subscriptionTokens: me.apiSubscriptionTokens ?? null };
}

/**
 * What a generation will actually cost.
 *
 * Leonardo has no pre-flight price for these models — v1/pricing-calculator
 * returns null for all of them (it prices the older diffusion models, which
 * take inferenceSteps and alchemy flags). The real figure comes back on the
 * POST, but by then you have already spent it.
 *
 * So instead of a hardcoded guess, this reads what WE have actually paid for
 * the same model and size. Every generated image records its true cost, so the
 * estimate is real money from real runs and gets sharper with use. The measured
 * fallbacks below are the figures observed on 2026-08-23 the first time each
 * model was run, used only until there is history.
 */
const MEASURED = {
  'nano-banana-2': 0.0389,
  'nano-banana-pro': 0.2093,
  'gpt-image-2': 0.0972,
  'lucid-origin': 0.03,
  'flux-pro-2.0': 0.042,
};

/**
 * The models a worker may actually use, in the order they are offered.
 *
 * MODELS holds more than this. The extras are defined and callable, but nobody
 * has judged their output, so they are deliberately not offered to a worker or
 * shown in the UI — an unreviewed model must not turn up in a campaign because
 * it happened to be in a list.
 */
const OFFERED = ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2'];

/** Human name for a model id — for anywhere we report what made a picture. */
function labelFor(id) {
  return (MODELS[id] || {}).label || id || 'unknown';
}

async function estimateCost({ model = DEFAULT_MODEL, size = 'square', quantity = 1 } = {}) {
  const label = (MODELS[model] || MODELS[DEFAULT_MODEL]).label;
  const dims = SIZES[size] || SIZES.square;

  let unit = null;
  let basis = 'first-run measurement';
  try {
    const db = require('../../services/db.pg');
    const { rows } = await db.query(
      `SELECT AVG(cost_usd)::numeric(10,4) AS unit, COUNT(*)::int AS n
         FROM hq_media
        WHERE model = $1 AND width = $2 AND height = $3 AND cost_usd > 0`,
      [label, dims.width, dims.height]
    );
    if (rows[0]?.n > 0) {
      unit = Number(rows[0].unit);
      basis = `average of ${rows[0].n} we actually paid`;
    }
  } catch {
    // No history available is not a reason to refuse an estimate.
  }

  if (unit === null) unit = MEASURED[model] ?? 0.06;

  return {
    unitUsd: Number(unit.toFixed(4)),
    totalUsd: Number((unit * quantity).toFixed(2)),
    quantity, model, modelLabel: label, basis,
    ...dims,
  };
}

module.exports = {
  MODELS, SIZES, DEFAULT_MODEL, MEASURED, labelFor, OFFERED,
  isConfigured, generate, download, uploadReference, balance, estimateCost,
};
