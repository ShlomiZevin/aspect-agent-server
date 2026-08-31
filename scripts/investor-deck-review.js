/**
 * Investor-deck review by GPT-5.6 Sol, acting as a positioning advisor.
 *
 * WHAT THIS IS FOR. The "We are your AI" deck (client route /we-are-your-ai,
 * source aspect-react-client/src/pages/WeAreYourAIPage.tsx) is a six-slide
 * narrative for investor conversations. This script hands a second model the
 * full brief — who we are, the idea, the lines that already work, and the
 * current copy verbatim — and asks for a hostile review plus rewritten copy,
 * writing rules and a visual direction.
 *
 * WHY A DIFFERENT MODEL. Same reason insights/services/investigation.service.js
 * runs VERIFY as its own call: the model that wrote the thing cannot also
 * audit it. This one has no stake in the current copy sounding good.
 *
 * KEEP THE BRIEF IN SYNC. DECK below is a hand-maintained copy of what the
 * page actually says. It is duplicated rather than parsed out of the JSX
 * because a regex over markup breaks quietly and a stale brief produces a
 * confident review of a deck that no longer exists. If you edit the page,
 * edit DECK.
 *
 * Usage:
 *   cd aspect-agent-server
 *   node scripts/investor-deck-review.js
 *   node scripts/investor-deck-review.js --model gpt-5.6-terra
 *   node scripts/investor-deck-review.js --ask "make it work for a 3-minute demo day slot"
 *
 * Writes docs/marketing/investor-deck-review.md and prints the same to stdout.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ── Args ─────────────────────────────────────────────────────────────────

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MODEL = arg('--model', 'gpt-5.6');          // GPT-5.6 Sol — see services/models.service.js
const EXTRA = arg('--ask', '');
// Ask for a subset, e.g. --sections 6,7,8. A full pass at effort:high can spend
// most of its budget on reasoning and get cut off mid-answer; asking for the
// tail on its own is faster than raising the cap and re-running everything.
const SECTIONS = arg('--sections', '').split(',').map(x => x.trim()).filter(Boolean);
const SLUG = SECTIONS.length ? `-sections-${SECTIONS.join('-')}` : '';
const OUT = path.join(__dirname, '..', 'docs', 'marketing', `investor-deck-review${SLUG}.md`);

// ── The brief ────────────────────────────────────────────────────────────

/** Who we are and what the idea is. Written as the founder would say it. */
const WHO_WE_ARE = `
The product IS the customer's own AI. Not a tool they have to learn — an employee they talk
to. They tell it what the business needs and it builds it: a report, a screen, an
automation, an entire internal system. There is no product catalogue and no roadmap they
wait in line behind. They point it at whatever they need next.

WE ARE NOT THE ONES DOING THE WORK. Our job is to make that AI capable of the work: we
connect it to the business and teach it the data. After that it runs. Any framing where the
company builds things by hand is a services company, and that is not what this is.

The closest existing analogy anyone will recognise: Claude Code gave developers an
open-ended builder that works against their codebase. Nothing equivalent ever existed for
running a business. This is that — for the business, against its data.

What makes the promise real rather than a services pitch: the AI is already
connected to the customer's data and has already learned it. Their tables, their
language, the quirks nobody documented, the way their business actually counts revenue.
That work happens once, up front, before the first question is ever asked. It is the
foundation, not the project — which is why everything the customer asks for afterwards
arrives fast.

The economics only work now. Saying yes to every request used to mean headcount, months,
and dead margin, so every vendor in history learned to say no and called it focus. The AI
does the building, so the answer can be yes. And each thing we build makes the next thing
faster.

Under the surface it is a real platform, not a pile of bespoke work: one pipeline serves
several unrelated retail chains with completely different database schemas; new
capabilities install themselves by reading the customer's schema; every number the system
produces carries the query that produced it and is independently fact-checked before it
ships. But NONE of that goes on these slides — see the constraints.
`.trim();

/** Lines the founder already believes in. The review must protect these or beat them outright. */
const LINES_THAT_WORK = [
  'We are your AI.',
  'Not a tool you learn. An AI that works for you.',
  'Ask it for something it has never built.',
  'Every other vendor sells you what they already built. Yours builds what you ask for.',
  'No catalog. No roadmap. Just: what do you need?',
  'Everything you need is a project. So you stopped asking.',
  'Saying yes to everything used to be a services business.',
  'The AI does the building now.',
  'We make it capable. It does the work.',
  'Claude Code, for the business.',
];

/** The deck as it currently stands. Six slides, in order. KEEP IN SYNC with the page. */
const DECK = [
  {
    n: 1,
    label: 'Hero',
    headline: 'We are your AI.',
    body: 'Not a tool you learn. An AI that works for you. You talk to it. It builds what your business needs — on your data.',
  },
  {
    n: 2,
    label: 'The old rule',
    headline: 'Everything you need is a project.',
    body: 'A scope. A quote. A quarter. Your software only answers the questions it was built to answer. Everything else waits. So you stopped asking.',
  },
  {
    n: 3,
    label: 'What we do',
    headline: 'Before you ask, it already knows your data.',
    body: 'That is our job. We connect your AI to the business and teach it — your tables, your language, your exceptions, the way you actually count. Once, up front. We make it capable. It does the work.',
  },
  {
    n: 4,
    label: 'The idea',
    headline: 'So ask.',
    body: 'Claude Code, for the business. Developers got an open-ended builder for their code. Your business gets one for its data. A report? It builds it. A screen? It builds it. An automation? It builds it. A whole system? It builds it. No catalog. No roadmap. Just: what do you need?',
  },
  {
    n: 5,
    label: 'Why now',
    headline: 'Now, saying yes scales.',
    body: 'More requests used to mean more people, more months, less margin. So every vendor learned to say no and called it focus. The AI does the building now. And every build makes the next one faster.',
  },
  {
    n: 6,
    label: 'The test',
    headline: 'Ask it for something it has never built.',
    body: 'Every other vendor sells you what they already built. Yours builds what you ask for. Bring one real question to the next meeting — it will answer on your data, in the room.',
  },
];

// ── Prompts ──────────────────────────────────────────────────────────────

const SYSTEM = `
You are one of the sharpest positioning and narrative advisors working today. You have spent
your career on seed and Series A investor narratives: the six-to-ten slide story a founder
tells before anyone opens a spreadsheet. You are known for two things — you are direct to the
point of being uncomfortable, and your rewrites are always shorter and hit harder than what
you were given.

You do not produce corporate copy. You do not produce lists of adjectives. You write lines a
founder can say out loud in a room and have land.

HARD CONSTRAINTS on what this deck is. Violating these makes your review useless:

1. This deck presents WHO WE ARE and WHAT THE IDEA IS. It is not a product tour. There are no
   screenshots, no feature lists, no user personas, no "how it works" diagram, no customer
   journey, no pricing, no team slide, no competitive matrix.
2. There are deliberately NO metrics, NO logos, NO customer names and NO proof numbers on
   these slides. That is a decision, not an oversight. Do not tell the founder to add traction
   numbers — tell them how to make the IDEA carry the room without them.
3. Six slides. If you believe a slide must be added, cut or merged, say so explicitly and
   defend it — but the ceiling is seven and the floor is five.
4. The audience is investors. The founder presents in English; they are not a native speaker,
   so every line must be sayable out loud without tripping.
5. THE AI IS THE ACTOR, NEVER THE COMPANY. The product IS the customer's AI — an employee
   they talk to, that does whatever the business needs. The company's role is to make that AI
   capable of it (connect it, teach it the data), not to do the work by hand. Any rewrite that
   makes "we" the builder re-opens the services objection and is wrong. Passive voice ("it gets
   built") breaks the same rule.
6. It must feel electric. Confident, fast, a little dangerous. Not warm, not corporate, not
   "we empower organisations to unlock".
`.trim();

const deckText = DECK.map(s =>
  `SLIDE ${s.n} — ${s.label}\nHEADLINE: ${s.headline}\nBODY: ${s.body}`,
).join('\n\n');

const SECTION_TITLES = {
  '1': 'The verdict', '2': 'Slide by slide', '3': 'The rewrite', '4': 'The one line',
  '5': 'Writing rules', '6': 'Visual direction', '7': 'The kill list', '8': 'What comes after slide six',
};

const REQUEST_INTRO = SECTIONS.length
  ? `Answer ONLY these sections, with these exact headings, in this order: ${SECTIONS.map(n => `"## ${n}. ${SECTION_TITLES[n] || n}"`).join(', ')}. Skip every other section entirely. Be specific. Never write a note like "make it punchier" without immediately writing the punchier version yourself.`
  : 'Answer in this exact order, with these exact headings. Be specific. Never write a note like "make it punchier" without immediately writing the punchier version yourself.';

const USER = `
# Who we are, and the idea

${WHO_WE_ARE}

# Lines the founder already believes in

These have been tested in conversation and they work. Protect them, or beat them outright and
say why yours is better. Do not quietly discard one.

${LINES_THAT_WORK.map(l => `- "${l}"`).join('\n')}

# The deck as it stands today

${deckText}

# What I need from you

${REQUEST_INTRO}

## 1. The verdict
Does this land in the first thirty seconds? What is the single weakest link in the chain, and
what happens in an investor's head at that moment? Three sentences maximum. Be blunt.

## 2. Slide by slide
For each of the six slides: what is working, what is dead weight, and what an investor is
actually thinking while it is on screen. One tight paragraph each — no bullet soup.

## 3. The rewrite
The whole deck, rewritten, ready to paste. For every slide give: the eyebrow label, the
headline, and the body. Give TWO headline options per slide and mark which one you would ship
and why, in one clause. Headlines under nine words wherever you can manage it.

## 4. The one line
The single sentence this entire deck should be remembered by, when the investor is in the car
afterwards and repeats it to a partner. Give three candidates, ranked, then commit to one.

## 5. Writing rules
The house style for every word in this deck, as rules the founder can apply themselves later.
Sentence rhythm, sentence length, what verbs to reach for, banned words and phrases, how to
end a slide, when to use a full stop as a weapon. Give at least eight rules, each with a
one-line before/after example drawn from THIS deck.

## 6. Visual direction
Concrete art direction, not mood words. Cover: the typographic idea and how type carries the
argument; how much text per slide and where it sits; colour — how many, doing what job;
what motion or transition should exist and what must not; one structural device that repeats
across all six slides and encodes something true about the content; and slide by slide, what
each one should actually look like. If a slide should be nearly empty, say which and how
empty.

## 7. The kill list
What to cut outright, and what to never say. Include any word or phrase currently in the deck
that you would ban.

## 8. What comes after slide six
The three questions an investor asks the moment the deck ends, and the sharpest one-paragraph
answer to each — written in the founder's voice, out loud, not as a slide.
${EXTRA ? `\n# Additional instruction from the founder\n\n${EXTRA}\n` : ''}
`.trim();

// ── Run ──────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — run this from aspect-agent-server so .env is picked up.');
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\n  Asking ${MODEL} for a review of the six-slide investor deck...`);
  if (EXTRA) console.log(`  Extra instruction: ${EXTRA}`);
  console.log('  This is a long answer — expect 1-3 minutes.\n');

  const started = Date.now();
  let response;
  try {
    response = await client.responses.create({
      model: MODEL,
      instructions: SYSTEM,
      input: USER,
      max_output_tokens: 32000,
      reasoning: { effort: 'high' },
    });
  } catch (err) {
    console.error(`\n  Request failed: ${err.message}`);
    if (err.status === 400) {
      console.error('  If the model rejected "reasoning", try --model gpt-5.5 or drop that field.');
    }
    process.exit(1);
  }

  const text = (response.output_text || '').trim();
  if (!text) {
    console.error('\n  The model returned nothing. Raw status:', response.status);
    process.exit(1);
  }

  // Silent truncation is the failure mode that wastes a whole run: the answer
  // reads fine until you notice section 7 never arrived. Same lesson as
  // looksTruncated() in the insights pipeline — make it loud.
  const truncated = response.status === 'incomplete'
    || response.incomplete_details != null
    || !/[.!?)\]`]\s*$/.test(text);
  if (truncated) {
    console.warn('');
    console.warn('  The answer was CUT OFF (it hit the output cap). Re-run the missing part, e.g.:');
    console.warn('    node scripts/investor-deck-review.js --sections 6,7,8');
    console.warn('');
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const header = [
    '# Investor deck review — "We are your AI"',
    '',
    `**Reviewer:** ${MODEL} · **Generated:** ${new Date().toISOString()} · **Took:** ${seconds}s`,
    EXTRA ? `**Extra instruction:** ${EXTRA}` : null,
    '',
    `Deck under review: \`aspect-react-client/src/pages/WeAreYourAIPage.tsx\` (route \`/we-are-your-ai\`).`,
    'Regenerate with `node scripts/investor-deck-review.js`.',
    '',
    '---',
    '',
  ].filter(l => l !== null).join('\n');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + text + '\n', 'utf8');

  console.log(text);
  console.log(`\n  ── Saved to ${path.relative(path.join(__dirname, '..'), OUT)} (${seconds}s)\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
