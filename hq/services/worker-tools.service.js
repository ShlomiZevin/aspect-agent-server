/**
 * HQ — the tools a worker can use.
 *
 * Generic by design: a tool is a name, a schema and a handler. A worker row
 * lists the names it's allowed; adding an employee is an INSERT, and adding an
 * ability is one entry here.
 *
 * Two of these are what turn a chatbot into an employee:
 *   `start_job` — the model writes down a plan you can watch
 *   `update_step` — it ticks items off as it goes
 * Everything else is just capability.
 */

const db = require('../../services/db.pg');
const leonardo = require('./leonardo.service');
const render = require('./render.service');
const media = require('./media.service');
const ask = require('./ask.service');
const budget = require('./budget.service');
const brand = require('./brand.service');
const ingest = require('./ingest.service');
const reports = require('./reports.service');
const phrasing = require('./phrasing.service');

/** Above this, a job asks before spending. Cheap work shouldn't need a nod. */
const APPROVAL_THRESHOLD_USD = Number(process.env.HQ_JOB_APPROVAL_USD || 1.5);

/**
 * HARD CEILINGS. A worker that can see its own output will want to try again —
 * which is the point, and also the way an unattended loop spends real money.
 * These are not advisory: the tool refuses past them regardless of what the
 * model has decided, because a prompt is a request and a limit is a limit.
 *
 * Reaching one is not an error. The worker is told to stop and ask, which is
 * what a person would do on hitting a budget.
 */
const MAX_IMAGES_PER_JOB = Number(process.env.HQ_MAX_IMAGES_PER_JOB || 15);
const MAX_RETRIES_PER_JOB = Number(process.env.HQ_MAX_RETRIES_PER_JOB || 4);
const MAX_JOB_SPEND_USD = Number(process.env.HQ_MAX_JOB_SPEND_USD || 3);

/** One retry for writes that record work already done. */
async function withRetry(fn, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastError;
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

const startJob = {
  name: 'start_job',
  description:
    'Open a visible job with a plan. Use this for any request that needs several steps or ' +
    'produces files — the person can then watch progress, leave the page, and come back. ' +
    'Do NOT use it for a question you can simply answer. Write steps as short outcomes ' +
    '("Generate 3 background options"), not as internal thoughts.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name for the job' },
      steps: {
        type: 'array', items: { type: 'string' },
        description: 'The plan, in order. Aim for 3-10 real steps.',
      },
      estimated_images: {
        type: 'integer',
        description:
          'How many images this job will generate in total. 0 if none. Required — it is ' +
          'what tells the person what this will cost before you spend their money.',
      },
      image_model: {
        type: 'string',
        enum: ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2', 'lucid-origin', 'flux-pro-2.0'],
        description: 'Which model you plan to use, so the cost estimate is for the real thing.',
      },
      image_size: {
        type: 'string', enum: ['square', 'portrait', 'story', 'story_hd', 'poster'],
      },
    },
    required: ['title', 'steps', 'estimated_images'],
  },
  async handler({ title, steps, estimated_images = 0, image_model, image_size }, ctx) {
    // Priced from what we have actually paid for this model and size, not a
    // flat per-image guess. See leonardo.estimateCost.
    const quote = estimated_images > 0
      ? await leonardo.estimateCost({
          model: image_model || 'nano-banana-2',
          size: image_size || 'square',
          quantity: estimated_images,
        })
      : null;
    const estimate = quote ? quote.totalUsd : 0;
    const plan = steps.map((text, i) => ({ n: i + 1, title: text, status: 'pending' }));

    // Where this job's reasoning starts in the usage log. An id, not a time —
    // see migration 009 for why a timestamp cannot be used here.
    const { rows: [cursor] } = await db.query(
      `SELECT COALESCE(MAX(id), 0) AS id FROM llm_usage`);

    const { rows } = await db.query(
      `INSERT INTO hq_jobs (worker_id, conversation_id, title, brief, steps,
                            estimated_usd, current_step, llm_usage_from_id)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7) RETURNING *`,
      [ctx.workerId, ctx.conversationId, title, ctx.brief || null,
       JSON.stringify(plan), estimate, cursor.id]
    );
    const job = rows[0];
    ctx.jobId = job.id;
    ctx.onEvent?.({ type: 'job_started', job });

    return {
      job_id: job.id,
      steps: plan.length,
      estimated_usd: estimate,
      ...(quote ? { cost_detail: `${quote.quantity} x ${quote.modelLabel} at $${quote.unitUsd} each (${quote.basis})` } : {}),
      note: estimate > APPROVAL_THRESHOLD_USD
        ? `This will cost about $${estimate}. Say so and get a yes before generating.`
        : 'Proceed. Call update_step as you finish each step.',
    };
  },
};

const updateStep = {
  name: 'update_step',
  description:
    'Mark a step done (or failed) and move on. Call this as you actually finish each step, ' +
    'not all at the end — the point is that someone watching sees real progress.',
  input_schema: {
    type: 'object',
    properties: {
      step: { type: 'integer', description: 'Which step number' },
      status: { type: 'string', enum: ['running', 'done', 'failed'] },
      detail: { type: 'string', description: 'One short line about what happened' },
    },
    required: ['step', 'status'],
  },
  async handler({ step, status, detail }, ctx) {
    if (!ctx.jobId) return { error: 'No job is open. Call start_job first.' };

    const { rows } = await db.query(`SELECT steps FROM hq_jobs WHERE id = $1`, [ctx.jobId]);
    const steps = rows[0]?.steps || [];
    const target = steps.find(s => s.n === step);
    if (!target) return { error: `No step ${step}` };

    target.status = status;
    if (detail) target.detail = detail;
    if (status === 'running') target.startedAt = new Date().toISOString();
    else target.finishedAt = new Date().toISOString();

    const done = steps.filter(s => s.status === 'done').length;
    await db.query(
      `UPDATE hq_jobs SET steps = $2, current_step = $3, updated_at = NOW() WHERE id = $1`,
      [ctx.jobId, JSON.stringify(steps), Math.min(step + 1, steps.length)]
    );
    ctx.onEvent?.({ type: 'job_step', jobId: ctx.jobId, steps, done, total: steps.length });
    return { ok: true, done, total: steps.length };
  },
};

const finishJob = {
  name: 'finish_job',
  description: 'Close the job when the work is complete. Say briefly what was produced.',
  input_schema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  async handler({ summary }, ctx) {
    if (!ctx.jobId) return { error: 'No job is open.' };
    // The work is finished by this point, so a transient DB blip must not be
    // what leaves the job stuck at 'running'. One retry, then let the stale
    // sweep catch it.
    const { rows } = await withRetry(() => db.query(
      `UPDATE hq_jobs SET status='done', finished_at=NOW(), updated_at=NOW(),
              brief = COALESCE(brief, $2) WHERE id = $1
       RETURNING cost_usd, llm_usage_from_id,
                 (SELECT COUNT(*)::int FROM hq_media m WHERE m.job_id = hq_jobs.id) AS files`,
      [ctx.jobId, summary]
    ));

    const row = rows[0] || {};
    const images = Number(row.cost_usd || 0);

    // Thinking is read from llm_usage, NOT from the job row: the job's own
    // column is only written after the whole loop returns, so at this point it
    // is still zero and the worker would confidently report "$0 in thinking"
    // for a job that had just spent nine cents. llm_usage is written per turn,
    // so it is the only figure that is true when this runs.
    let thinking = 0;
    try {
      const budget = require('./budget.service');
      const { rows: turns } = await db.query(
        `SELECT model, SUM(input_tokens)::int inp, SUM(output_tokens)::int outp
           FROM llm_usage
          -- Both processes: the worker's own turns AND the phrasing model it
          -- called. Filtering to hq_worker made every write_copy call free,
          -- which is a different provider's real bill going unreported.
          WHERE agent_name = 'hq' AND process IN ('hq_worker', 'hq_phrasing')
            AND conversation_id = $1
            AND id > COALESCE($2, 0)
          GROUP BY model`,
        [ctx.conversationId, row.llm_usage_from_id]
      );
      thinking = turns.reduce((sum, t) => sum + budget.priceOf(t.model, t.inp, t.outp), 0);
    } catch (err) {
      console.warn('[hq] could not price the thinking:', err.message);
    }

    ctx.onEvent?.({ type: 'job_finished', jobId: ctx.jobId, summary });
    return {
      ok: true,
      cost: {
        images_usd: Number(images.toFixed(4)),
        thinking_usd: Number(thinking.toFixed(4)),
        total_usd: Number((images + thinking).toFixed(4)),
        files: row.files ?? 0,
      },
      note:
        'Tell the person what this cost: images and thinking separately, then the total. ' +
        'One short line, not a table. Say "about" — this excludes the message you are ' +
        'about to write, which is not billed until after it exists. The job panel shows ' +
        'the final figure.',
    };
  },
};

// ─── Making things ───────────────────────────────────────────────────────────

const generateImage = {
  name: 'generate_image',
  description:
    'Generate an image with Leonardo AI. These models render Hebrew, but LENGTH decides ' +
    'whether it stays correct: short strings (a 3-6 word headline, a short CTA) come out ' +
    'perfect, while a long headline degrades at the tail into gibberish. So put SHORT text ' +
    'in the prompt quoted exactly, and send long copy, paragraphs, exact URLs, prices or ' +
    'logos to render_html over a text-free background instead. nano-banana-pro holds longer ' +
    'Hebrew together better. If the person says which way they want it, do that.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full image description. Quote any text to render exactly.' },
      model: {
        type: 'string',
        // Only the three we have actually reviewed output from. The others in
        // leonardo.service are defined but deliberately not offered here —
        // nobody has judged their work, so a worker must not reach for one.
        enum: ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2'],
        description:
          'Pick deliberately — they are not interchangeable, and the price differs 5x.\n' +
          '- nano-banana-2 (~$0.04, ~10s): drafts, variations, anything you will iterate on. ' +
          'Photographic. Start here unless there is a reason not to.\n' +
          '- nano-banana-pro (~$0.21, ~30s): the final of a piece that matters, and the ' +
          'safest choice for the longest Hebrew. Use it once you know what you want, not while exploring.\n' +
          '- gpt-image-2 (~$0.10, ~40s): clean graphic and vector-feeling work — flat colour, ' +
          'strong shapes, poster and social layouts. Crisp Hebrew. Portrait is only 1024x1536.\n' +
          'If asked for several options, generate with more than one so they can be compared. ' +
          'Always say in your reply which model made which picture and why you chose it.',
      },
      size: {
        type: 'string', enum: ['square', 'portrait', 'story', 'story_hd', 'poster'],
        description: 'story/story_hd are 9:16 for Instagram.',
      },
      title: { type: 'string', description: 'Short name to file it under' },
      is_retry: {
        type: 'boolean',
        description:
          'True when this replaces an image you judged unsatisfactory. Retries are capped ' +
          'per job, so mark them honestly.',
      },
      brand_reference: {
        type: 'string', enum: ['logo', 'spiral'],
        description:
          'Optional. Feeds our real logo in as a colour reference, so output matches the ' +
          'brand rather than approximating it. Get the keys from brand_kit.',
      },
    },
    required: ['prompt'],
  },
  async handler({ prompt, model = 'nano-banana-2', size = 'square', title, brand_reference, is_retry }, ctx) {
    // A conversation can pin the model. When it does, that decision is the
    // person's and overrides whatever the worker asked for — otherwise "use
    // Pro for this chat" would be a suggestion she could quietly ignore.
    const forced = ctx.imageModel && ctx.imageModel !== 'auto' ? ctx.imageModel : null;
    if (forced && forced !== model) {
      ctx.onEvent?.({
        type: 'tool_progress', tool: 'generate_image',
        note: `this chat is set to ${leonardo.labelFor(forced)}, using that instead of ${model}`,
      });
      model = forced;
    }
    // ── Ceilings, checked before a penny is spent ──
    if (ctx.jobId) {
      const { rows } = await db.query(
        `SELECT image_count, retry_count, cost_usd FROM hq_jobs WHERE id = $1`, [ctx.jobId]);
      const job = rows[0] || {};

      if ((job.image_count || 0) >= MAX_IMAGES_PER_JOB) {
        return { error:
          `This job has already generated ${job.image_count} images, which is the limit. ` +
          'Stop and ask the person whether to continue — do not try another way around this.' };
      }
      if (is_retry && (job.retry_count || 0) >= MAX_RETRIES_PER_JOB) {
        return { error:
          `You have already re-generated ${job.retry_count} times in this job. Stop retrying. ` +
          'Show the person what you have, say what is wrong with it, and let them decide.' };
      }
      if (Number(job.cost_usd || 0) >= MAX_JOB_SPEND_USD) {
        return { error:
          `This job has spent $${Number(job.cost_usd).toFixed(2)}, which is the cap. ` +
          'Stop and ask before spending more.' };
      }
    }

    // The daily HQ budget applies to images too, not just thinking.
    try {
      await budget.assertWithinBudget('generating an image');
    } catch (err) {
      return { error: err.message };
    }

    let referenceImageId = null;
    if (brand_reference) {
      try { referenceImageId = await brand.referenceId(brand_reference); }
      catch (err) { ctx.onEvent?.({ type: 'tool_progress', tool: 'generate_image', note: `brand reference unavailable: ${err.message}` }); }
    }

    const result = await leonardo.generate({
      prompt, model, size, referenceImageId,
      onProgress: p => ctx.onEvent?.({ type: 'tool_progress', tool: 'generate_image', ...p }),
    });

    const saved = [];
    const blocks = [];
    for (const url of result.images) {
      const buffer = await leonardo.download(url);
      const item = await media.store(buffer, {
        workerId: ctx.workerId, conversationId: ctx.conversationId, jobId: ctx.jobId,
        title: title || prompt.slice(0, 60), kind: 'image',
        mimeType: 'image/jpeg', extension: 'jpg',
        width: result.width, height: result.height,
        prompt, model: result.modelLabel, costUsd: result.cost, source: 'leonardo',
        // Keep the id as well as the label: the label is for people, the id is
        // what you pass back to generate another like it.
        metadata: { modelId: model || 'nano-banana-2', size },
      });
      saved.push(item);
      ctx.onEvent?.({ type: 'media', item });

      // Hand the actual picture back so it can be judged rather than assumed.
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') },
      });
    }

    if (ctx.jobId) {
      await db.query(
        `UPDATE hq_jobs
            SET cost_usd = cost_usd + $2,
                image_count = image_count + $3,
                retry_count = retry_count + $4
          WHERE id = $1`,
        [ctx.jobId, result.cost, saved.length, is_retry ? 1 : 0]);
    }

    const remaining = MAX_IMAGES_PER_JOB - ((saved.length) + 0);
    blocks.push({
      type: 'text',
      text:
        `Saved as media ${saved.map(s => s.id).join(', ')}. Cost $${result.cost} (${result.modelLabel}).
` +
        'LOOK AT IT. Is the composition right, is any text spelled correctly, is it on brand, ' +
        'is it too dark or too busy? If it is good, move on. If something is wrong, say what — ' +
        'and only re-generate if the fix is clear and worth the money. Never re-generate more ' +
        'than once for the same problem without asking.',
    });

    return {
      __content: blocks,
      created: saved.length,
      media_ids: saved.map(s => s.id),
      cost_usd: result.cost,
      model: result.modelLabel,
    };
  },
};

const renderHtml = {
  name: 'render_html',
  description:
    'Render HTML/CSS to an exact-size PNG. Use for pixel-perfect type, a logo, a real URL, ' +
    'or the same template repeated. ' +
    'TO PUT TYPE OVER A GENERATED BACKGROUND: reference the image as {{media:ID}} in an ' +
    '<img src> or a CSS url(). It is inlined before rendering. Do NOT paste the image\'s ' +
    'https:// link — those are signed and time-limited, and the renderer will produce a ' +
    'blank space where the picture should be. ' +
    'Hebrew needs dir="rtl".',
  input_schema: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'Body HTML. Reference generated images as {{media:ID}}, never by URL.',
      },
      width: { type: 'integer' },
      height: { type: 'integer' },
      title: { type: 'string' },
    },
    required: ['html'],
  },
  async handler({ html, width = 1080, height = 1920, title }, ctx) {
    if (!render.isAvailable()) {
      return { error: 'No browser available to render HTML on this server. Generate the text in the image instead.' };
    }

    // Inline every referenced image as a data URI.
    //
    // A remote <img> is two ways to fail at once: our media URLs are signed and
    // expire, and headless Chrome screenshots whatever has loaded by the time
    // it fires — so a slow fetch silently yields a composition with a hole in
    // it, which is exactly what happened. Bytes in the page cannot race.
    const ids = [...new Set([...html.matchAll(/\{\{media:(\d+)\}\}/g)].map(m => Number(m[1])))];
    const missing = [];

    // Brand assets are files in the repo, not media rows, so {{media:ID}} never
    // covered them — which is exactly how a banner shipped with a broken-image
    // icon where the logo should have been.
    for (const key of [...new Set([...html.matchAll(/\{\{brand:(\w+)\}\}/g)].map(m => m[1]))]) {
      try {
        const buffer = brand.assetBuffer(key);
        html = html.replaceAll(`{{brand:${key}}}`, `data:image/png;base64,${buffer.toString('base64')}`);
      } catch {
        missing.push(`brand:${key}`);
      }
    }

    if (ids.length) {
      const { rows } = await db.query(
        `SELECT id, gcs_path, mime_type FROM hq_media WHERE id = ANY($1::int[])`, [ids]);
      const found = new Map(rows.map(r => [r.id, r]));

      for (const id of ids) {
        const row = found.get(id);
        if (!row) { missing.push(id); continue; }
        try {
          const buffer = await media.download(row.gcs_path);
          const uri = `data:${row.mime_type || 'image/jpeg'};base64,${buffer.toString('base64')}`;
          html = html.replaceAll(`{{media:${id}}}`, uri);
        } catch (err) {
          missing.push(id);
          console.warn(`[hq] could not inline media ${id}:`, err.message);
        }
      }
    }

    if (missing.length) {
      return { error:
        `Could not load ${missing.join(', ')} — the render would show a broken image there. ` +
        'Check the ids against what you actually generated, and use {{brand:logo}} or ' +
        '{{brand:spiral}} for our logo.' };
    }

    // Anything still pointing outward will not load in the renderer. Refusing
    // is better than producing a banner with a broken icon on it.
    const remote = html.match(/<img[^>]+src=["'](https?:|\/)[^"']*/i);
    if (remote) {
      return { error:
        'That HTML references an image by URL or path, which cannot load here — it would ' +
        'render as a broken icon. Use {{media:ID}} or {{brand:logo}} instead.' };
    }

    const buffer = await render.htmlToPng(html, { width, height });
    const item = await media.store(buffer, {
      workerId: ctx.workerId, conversationId: ctx.conversationId, jobId: ctx.jobId,
      title: title || 'Rendered design', kind: 'render',
      mimeType: 'image/png', extension: 'png',
      width, height, source: 'html_render',
    });
    ctx.onEvent?.({ type: 'media', item });

    // Hand the RESULT back to be looked at. Without this the composite was the
    // one thing nobody ever saw — she reviewed the background, rendered type
    // over it, and had no way to notice the picture had not come through.
    return {
      __content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
        },
        {
          type: 'text',
          text:
            `Rendered as media ${item.id}, ${width}x${height}.
` +
            'LOOK AT IT PROPERLY. Specifically: is there a BROKEN IMAGE ICON anywhere — a ' +
            'small grey box or torn-page symbol where a picture should be? Do not describe ' +
            'something as "the logo" without checking it actually rendered. Then: did the ' +
            'background come through, is the type positioned and spelled correctly, does it ' +
            'have enough contrast? Say plainly what is wrong if anything is.',
        },
      ],
      media_id: item.id, width, height,
    };
  },
};

const writeCopy = {
  name: 'write_copy',
  description:
    'Write finished copy — a headline, body text, a CTA, a caption, a subject line. ' +
    'ALWAYS use this for words that a customer will read, in either language. It goes to a ' +
    'model chosen for writing rather than for reasoning, and its Hebrew is markedly better ' +
    'than yours: yours reads translated. ' +
    'Give it a real brief — what the piece is, who it is for, any length limit, and the ' +
    'facts it must be accurate to. Do not use it for your own explanations to the person ' +
    'you are talking to; that is just you talking.',
  input_schema: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'What to write and for what. Include length limits ("headline, max 5 words") and ' +
          'anything it must avoid.',
      },
      context: {
        type: 'string',
        description:
          'Facts it must be accurate to — what the product does, what we agreed, a price. ' +
          'Pull these from search_hq rather than inventing them.',
      },
      language: { type: 'string', description: 'Hebrew or English' },
      tone: { type: 'string', description: 'Optional, e.g. "direct and clinical", "warm"' },
    },
    required: ['brief'],
  },
  async handler({ brief, context, language = 'Hebrew', tone }, ctx) {
    ctx.onEvent?.({ type: 'tool_progress', tool: 'write_copy' });
    const result = await phrasing.write({
      brief, context, language, tone,
      worker: ctx.worker,
      conversationId: ctx.conversationId,
    });
    return {
      copy: result.text,
      written_by: result.model,
      note: 'Use this text as written. If it is wrong, say what is wrong and ask again — ' +
            'do not quietly rewrite it yourself.',
    };
  },
};

// ─── Knowing things ──────────────────────────────────────────────────────────

const searchHq = {
  name: 'search_hq',
  description:
    "Search Lybi's own knowledge — meetings, proposals, decisions, brand material. Use this " +
    'before inventing anything about the company: colours, positioning, pricing, what was ' +
    'agreed. This is what makes you useful rather than generic.',
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
  },
  async handler({ question }, ctx) {
    ctx.onEvent?.({ type: 'tool_progress', tool: 'search_hq', question });
    const result = await ask.ask(question);
    return {
      answer: result.answer,
      sources: (result.citations || []).map(c => ({ title: c.title, date: c.date })),
    };
  },
};

const brandKit = {
  name: 'brand_kit',
  description:
    "Get Lybi's actual brand colours, fonts and logo assets. These are read live from the " +
    'codebase, so they are current by definition — use this rather than remembering hex ' +
    'codes. The returned asset keys can be passed to generate_image as brand_reference so ' +
    'the model takes real colour cues from our logo instead of being described it.',
  input_schema: { type: 'object', properties: {} },
  async handler(_input, ctx) {
    ctx.onEvent?.({ type: 'tool_progress', tool: 'brand_kit' });
    return brand.summary();
  },
};

const remember = {
  name: 'remember',
  description:
    'Save something into HQ so everyone — and every future conversation — can find it. Use ' +
    'this when you produce something worth keeping (a positioning line that was agreed, a ' +
    'campaign brief, a decision) or when someone tells you a fact about the company that ' +
    'HQ did not already know. Ask before saving something you invented; save freely what ' +
    'you were told.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'How someone would look for this later' },
      content: { type: 'string', description: 'The full text, in markdown' },
      kind: {
        type: 'string', enum: ['note', 'doc', 'decision'],
        description: 'decision for something settled, doc for reference material, note otherwise',
      },
    },
    required: ['title', 'content'],
  },
  async handler({ title, content, kind = 'note' }, ctx) {
    ctx.onEvent?.({ type: 'tool_progress', tool: 'remember', title });
    const { atom } = await ingest.ingestDocument({
      kind,
      title,
      body: content,
      // Provenance matters: a fact HQ learned from a worker should be
      // distinguishable later from one that came out of a real meeting.
      projects: ['hq-worker'],
    }, { runScribe: false });
    return {
      saved: true, atom_id: atom.id,
      note: 'Stored and searchable. Anyone asking HQ about this will now find it.',
    };
  },
};

const publishReport = {
  name: 'publish_report',
  description:
    'Publish a page presenting your work — options with reasoning, a comparison, a ' +
    'recommendation. Use this whenever you produce more than two or three things: ten ' +
    'creatives are unreviewable as chat messages but obvious on one page. Write the BODY ' +
    'only (h2/h3/p/ul/table/div) — the Lybi header, fonts and colours are added for you. ' +
    'Reference any image you made as {{media:ID}} in an <img src>; the link is refreshed ' +
    'every time the page is opened, so it never goes stale. Say what each option is FOR ' +
    'and which you would pick — a page of pictures is not a report.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string', description: 'One line under the title' },
      html: { type: 'string', description: 'Body HTML. Use {{media:ID}} for images you made.' },
    },
    required: ['title', 'html'],
  },
  async handler({ title, summary, html }, ctx) {
    const report = await reports.create({
      workerId: ctx.workerId, conversationId: ctx.conversationId, jobId: ctx.jobId,
      title, summary, html,
    });
    ctx.onEvent?.({ type: 'report', report });
    return {
      report_id: report.id,
      url: `/api/hq/reports/${report.id}/view`,
      note: 'Published. Tell the person it is ready and that they can open it from the conversation.',
    };
  },
};

const learn = {
  name: 'learn',
  description:
    'Record a craft lesson about HOW to do your job well here — a prompt pattern that ' +
    'worked, a mistake to avoid, a preference this company has expressed. It is added to ' +
    'your instructions from the next conversation onward, so you get better over time ' +
    'instead of relearning the same thing. ' +
    'This is NOT for facts about the company (use remember) and NOT for one-off details. ' +
    'Only record something you would want to be told before starting similar work again. ' +
    'Be specific: "backgrounds came out too dark — ask for mid-tone" beats "improve quality".',
  input_schema: {
    type: 'object',
    properties: {
      lesson: { type: 'string', description: 'One or two sentences, phrased as guidance to your future self' },
      learned_from: { type: 'string', description: 'What prompted it, briefly' },
    },
    required: ['lesson'],
  },
  async handler({ lesson, learned_from }, ctx) {
    const { rows } = await db.query(
      `INSERT INTO hq_worker_lessons (worker_id, lesson, learned_from)
       VALUES ($1,$2,$3) RETURNING id`,
      [ctx.workerId, lesson.trim(), learned_from || null]);
    ctx.onEvent?.({ type: 'tool_progress', tool: 'learn', note: lesson.slice(0, 80) });
    return {
      saved: true, lesson_id: rows[0].id,
      note: 'Recorded. It will be part of your instructions from now on, and a person can ' +
            'remove it if it turns out to be wrong.',
    };
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

const ALL = [
  startJob, updateStep, finishJob,
  generateImage, renderHtml, publishReport, writeCopy,
  searchHq, brandKit, remember, learn,
];
const BY_NAME = new Map(ALL.map(t => [t.name, t]));

/** Resolve the names on a worker row to real tools, ignoring unknown entries. */
function resolve(names = []) {
  return names.map(n => BY_NAME.get(n)).filter(Boolean);
}

module.exports = { ALL, BY_NAME, resolve, APPROVAL_THRESHOLD_USD };
