/**
 * Ask GPT-5.6 Sol a design or product question, as a second opinion.
 *
 * WHY IT EXISTS. scripts/investor-deck-review.js does the same job but its
 * system prompt is welded to one artifact — six investor slides, no metrics,
 * no product tour. Asking it about a product UI produces a deck review of a
 * screen. This is the same idea with the framing left open: you supply the
 * brief, it supplies a direct answer.
 *
 * WHY A DIFFERENT MODEL AT ALL. Same reason the insights pipeline runs VERIFY
 * as its own call, and the same reason Otto splits brainstorm from build: the
 * model that made the thing cannot audit it. Sol has no stake in the current
 * design being good.
 *
 * WHAT MAKES THE ANSWERS USEFUL (learned the hard way — see
 * docs/marketing/PLAYBOOK.md §5):
 *   - Put the hard constraints in the brief. Without them it returns a generic
 *     SaaS answer that fits any product.
 *   - Tell it never to write a note without immediately writing the fix. That
 *     one instruction is what turns advice into something shippable.
 *   - Give it what already works and tell it to protect or beat it, or it will
 *     quietly discard good material.
 *   - Describe failures in the user's own words. "it looks sleazy" produces a
 *     better answer than "the aesthetic is off".
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/ask-sol.js --brief path/to/brief.md
 *   node scripts/ask-sol.js --brief brief.md --out docs/design/otto-review.md
 *   node scripts/ask-sol.js --brief brief.md --model gpt-5.6-terra
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODEL = arg('--model', 'gpt-5.6');
const BRIEF = arg('--brief', null);
const OUT = arg('--out', null);
// `high` is not free and not always better. Two 20-minute timeouts on layout
// briefs cost the whole answer and were billed for reasoning that produced
// nothing. Use `high` for judgement calls — palette, positioning, "is this a
// good idea" — and `medium` for specification work, where the thinking is
// already done and the model is writing values down.
const EFFORT = arg('--effort', 'high');

const SYSTEM = `
You are a senior product designer and design director. You have shipped interfaces for
operational software — the tools people actually use to run a business, not marketing
sites — and you are known for two things: you are direct to the point of being
uncomfortable, and you never leave a criticism without the fix beside it.

Rules for this answer:

1. NEVER write a note like "make it feel more premium" or "tighten the hierarchy" without
   immediately writing the specific, buildable version: the exact value, the exact words,
   the exact position. If you cannot make it concrete, do not raise it.
2. Take positions. If asked whether to do something and the answer is no, say no plainly
   and say what to do instead. Do not present balanced options and leave the choice open.
3. Specify things that can actually be built. Name typefaces that exist and are licensable
   or free; give colours as hex; give sizes and spacing as numbers. If you specify
   something that needs a license or an asset that does not exist yet, say so.
4. Check contrast before you specify a colour pair. A recommendation that turns out to be
   invisible costs more than no recommendation.
5. Respect stated constraints absolutely. If a constraint makes the design worse, say so in
   one sentence and then work within it anyway.
6. No filler. No summary of what you were asked. Start with the answer.
`.trim();

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — run this from aspect-agent-server so .env is picked up.');
    process.exit(1);
  }
  if (!BRIEF) {
    console.error('Usage: node scripts/ask-sol.js --brief <file> [--out <file>] [--model <id>]');
    process.exit(1);
  }
  if (!fs.existsSync(BRIEF)) {
    console.error(`Brief not found: ${BRIEF}`);
    process.exit(1);
  }

  const brief = fs.readFileSync(BRIEF, 'utf8');
  // 20 minutes, not the SDK's default 10. At `reasoning: high` a long brief
  // can spend twelve thousand reasoning tokens before it writes a word, and a
  // timeout costs the whole answer — there is no partial result to keep. The
  // fix that matters more is keeping briefs focused; this is the safety net.
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20 * 60 * 1000, maxRetries: 0 });

  console.log(`\n  Asking ${MODEL}… (long answers take 1-4 minutes)\n`);
  const started = Date.now();

  let response;
  try {
    response = await client.responses.create({
      model: MODEL,
      instructions: SYSTEM,
      input: brief,
      max_output_tokens: 32000,
      reasoning: { effort: EFFORT },
    });
  } catch (err) {
    console.error(`\n  Request failed: ${err.message}`);
    process.exit(1);
  }

  const text = (response.output_text || '').trim();
  if (!text) {
    console.error('\n  The model returned nothing. Status:', response.status);
    process.exit(1);
  }

  // Silent truncation is the failure mode that wastes a whole run: the answer
  // reads fine until you notice the last section never arrived.
  const truncated = response.status === 'incomplete'
    || response.incomplete_details != null
    || !/[.!?)\]`]\s*$/.test(text);
  if (truncated) {
    console.warn('');
    console.warn('  The answer was CUT OFF (it hit the output cap). Re-ask for the missing part.');
    console.warn('');
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(text);

  // Sol's calls do not go through services/llm.js, so nothing else logs them —
  // printing usage here is the only place the spend is visible. With
  // `reasoning: high` the reasoning tokens are billed at the OUTPUT rate, so
  // the length of the visible answer badly understates the bill.
  const u = response.usage || {};
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  // gpt-5.6 Sol, short context, checked 2026-09-08: $4 / $20 per million.
  const cost = (inTok / 1e6) * 4 + (outTok / 1e6) * 20;
  console.log(`\n  ── ${seconds}s · in ${inTok.toLocaleString()} · out ${outTok.toLocaleString()}`
    + (reasoning ? ` (${reasoning.toLocaleString()} reasoning)` : '')
    + ` · ~$${cost.toFixed(2)}`);

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `# ${path.basename(BRIEF)} — answer from ${MODEL}\n\n_${new Date().toISOString()} · ${seconds}s_\n\n---\n\n${text}\n`, 'utf8');
    console.log(`  ── saved to ${OUT}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
