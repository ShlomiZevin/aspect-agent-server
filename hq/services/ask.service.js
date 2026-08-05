/**
 * HQ — Ask.
 *
 * Retrieve over the `hq` namespace, answer from what came back, and cite.
 * An uncited brain is a liability, so every answer carries the atoms it leaned
 * on and the UI links each one back to its source.
 *
 * Tagged `agentName: 'hq'` / `crewMember: 'ask'` for free cost attribution.
 */

const pinecone = require('../../services/kb.pinecone.service');
const llmService = require('../../services/llm');
const atomsService = require('./atoms.service');
const { HQ_NAMESPACE } = require('./ingest.service');

const ASK_MODEL = process.env.HQ_ASK_MODEL || 'claude-sonnet-4-6';

// Cheap and fast — this one only rewrites the query, never sees the answer.
const EXPAND_MODEL = process.env.HQ_EXPAND_MODEL || 'gpt-4o-mini';

const TOP_K = 12;
const SCORE_THRESHOLD = 0.25;
const MAX_CONTEXT_TOKENS = 8000;

const HEBREW = /[֐-׿]/;

const INSTRUCTIONS = `You are HQ — the memory of Lybi, a 3-person AI company (Shlomi, Noa, Hila).

You answer questions about the company from the excerpts provided. Each excerpt is numbered and comes from a real document or meeting.

Rules:
- Answer ONLY from the excerpts. If they do not contain the answer, say so plainly and say what you'd need — never fill the gap from general knowledge.
- Cite with bracketed numbers matching the excerpts you used, e.g. [1] or [2][4]. Cite the specific claim, not the whole answer.
- Be direct and short. Lead with the answer, then the detail. No preamble.
- When the question is about a decision, say who decided and when if the excerpts show it.
- If excerpts disagree, say so explicitly and cite both — a contradiction is information, not something to smooth over.

LANGUAGE: answer in the same language the QUESTION was written in. The excerpts may be in a different language — translate from them as needed. An English question always gets an English answer, even when every excerpt is in Hebrew, and vice versa.`;

/**
 * We talk in a mix of Hebrew and English, so a Hebrew question routinely needs
 * to find English content and vice versa — and `text-embedding-3-small` is
 * weak at matching across scripts. So we retrieve with the question in BOTH
 * languages and merge. One cheap call; without it, "מה החלטנו לגבי זום?"
 * returns nothing from an English transcript that plainly answers it.
 */
async function buildQueryVariants(question) {
  const target = HEBREW.test(question) ? 'English' : 'Hebrew';

  try {
    const translated = await llmService.sendOneShot(
      `Translate the user's search query to ${target}. Keep product names, people's names and technical terms as they are. Return ONLY the translation, nothing else.`,
      question,
      { model: EXPAND_MODEL, maxTokens: 200, context: 'hq-ask-expand', agentName: 'hq', crewMember: 'ask' }
    );

    const variant = String(translated || '').trim();
    if (variant && variant.toLowerCase() !== question.toLowerCase()) return [question, variant];
  } catch (err) {
    // Retrieval in the original language still works — don't fail the question.
    console.warn('[hq] query expansion failed:', err.message);
  }
  return [question];
}

/**
 * @returns {Promise<{ answer, citations, hits, usedAtomIds }>}
 */
async function ask(question, { topK = TOP_K } = {}) {
  const trimmed = (question || '').trim();
  if (!trimmed) throw new Error('question is required');

  const variants = await buildQueryVariants(trimmed);

  // Merge across variants, keeping each chunk's best score.
  const byKey = new Map();
  for (const variant of variants) {
    const { results: hits } = await pinecone.query([HQ_NAMESPACE], variant, {
      topK,
      scoreThreshold: SCORE_THRESHOLD,
      maxTokens: MAX_CONTEXT_TOKENS,
    });
    for (const hit of hits) {
      const key = `${hit.fileId}#${hit.chunkIndex}`;
      const seen = byKey.get(key);
      if (!seen || hit.score > seen.score) byKey.set(key, hit);
    }
  }

  const results = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, topK);

  if (!results.length) {
    return {
      answer: "I don't have anything on that yet — nothing in HQ matches. Drop the relevant meeting or doc in and ask again.",
      citations: [],
      hits: [],
      usedAtomIds: [],
    };
  }

  // Chunks carry `fileId` of the form `atom-<id>`; map back so citations can
  // point at real atoms rather than at vector ids.
  const atomIds = [...new Set(
    results
      .map(r => {
        const match = /^atom-(\d+)$/.exec(String(r.fileId));
        return match ? parseInt(match[1], 10) : null;
      })
      .filter(Boolean)
  )];

  const atoms = await atomsService.getAtomsByIds(atomIds);
  const atomById = new Map(atoms.map(a => [a.id, a]));

  // Number the excerpts as presented — the model cites these indices.
  const excerpts = results.map((r, i) => {
    const match = /^atom-(\d+)$/.exec(String(r.fileId));
    const atom = match ? atomById.get(parseInt(match[1], 10)) : null;
    const when = atom?.occurred_at ? new Date(atom.occurred_at).toISOString().slice(0, 10) : null;

    return {
      n: i + 1,
      atomId: atom?.id ?? null,
      title: atom?.title || r.fileName,
      kind: atom?.kind || r.fileType,
      url: atom?.external_url || null,
      date: when,
      score: r.score,
      text: r.text,
    };
  });

  const context = excerpts
    .map(e => `[${e.n}] ${e.title}${e.date ? ` (${e.date})` : ''}\n${e.text}`)
    .join('\n\n---\n\n');

  const answer = await llmService.sendOneShot(
    INSTRUCTIONS,
    `Question: ${trimmed}\n\nExcerpts:\n\n${context}`,
    {
      model: ASK_MODEL,
      maxTokens: 1500,
      context: 'hq-ask',
      agentName: 'hq',
      crewMember: 'ask',
    }
  );

  // Only surface citations the answer actually referenced — a list of twelve
  // sources under a two-line answer is noise, not provenance.
  const cited = new Set();
  for (const m of String(answer).matchAll(/\[(\d+)\]/g)) cited.add(parseInt(m[1], 10));

  const citations = excerpts
    .filter(e => cited.has(e.n))
    .map(({ text, ...rest }) => ({ ...rest, snippet: text.slice(0, 320) }));

  return {
    answer,
    citations,
    hits: excerpts.map(({ text, ...rest }) => ({ ...rest, snippet: text.slice(0, 200) })),
    usedAtomIds: citations.map(c => c.atomId).filter(Boolean),
  };
}

module.exports = { ask, ASK_MODEL };
