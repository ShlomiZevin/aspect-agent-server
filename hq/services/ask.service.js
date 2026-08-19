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
const budget = require('./budget.service');
const db = require('../../services/db.pg');
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
    // NB: an earlier version said "keep names and technical terms as they are",
    // which made this flaky — the whole point is to produce the spelling the
    // corpus uses. "Meuhedet" left untranslated never matches "מאוחדת", so the
    // same question worked or failed depending on the rewrite. Names must be
    // rendered in the target script; only latin-script product names stay put.
    const translated = await llmService.sendOneShot(
      `Rewrite the user's search query in ${target}, as it would be written by a native speaker.\n` +
      `Render people's names, company names and place names in ${target} script — ` +
      `e.g. "Meuhedet" becomes "מאוחדת", "Discount" becomes "דיסקונט".\n` +
      `Leave latin-script product and technology names alone (Lybi, Notion, Zoom, API).\n` +
      `Return ONLY the rewritten query, nothing else.`,
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

// Question words and connectives carry no retrieval signal — dropping them
// stops "האם" / "what" from dominating a short query.
const STOPWORDS = new Set([
  'האם', 'האמ', 'על', 'של', 'את', 'אם', 'יש', 'אין', 'מה', 'מי', 'איך', 'למה', 'מתי',
  'כל', 'גם', 'לגבי', 'בנוגע', 'זה', 'זו', 'הוא', 'היא', 'אנחנו', 'אני', 'היה', 'היתה',
  'עם', 'אבל', 'או', 'כי', 'לא', 'כן', 'אצלנו', 'שלנו', 'איזכור', 'בפגישות', 'בפגישה',
  'the', 'and', 'are', 'was', 'were', 'did', 'does', 'do', 'we', 'our', 'what', 'when',
  'who', 'how', 'why', 'about', 'any', 'there', 'have', 'has', 'had', 'discuss', 'discussed',
  'talk', 'talked', 'meeting', 'meetings', 'mention', 'mentioned', 'anything',
]);

/**
 * Lexical fallback — the fix for a real miss.
 *
 * Dense embeddings match *topic and register*, not exact terms. Asked
 * "האם דנו בליבי לגבי יועץ חיצוני", the vector search returned 12 chunks at a
 * HIGHER similarity (0.47) than the phrasing that worked — and not one of them
 * contained the phrase. The actual mention is a terse line in a task list
 * ("יצירת קשר עם יועץ חיצוני"), which looks nothing like a question about
 * discussion, so it never surfaced and HQ truthfully said it knew nothing.
 *
 * So: also match the question's content words literally against atom bodies and
 * splice a window around each hit into the excerpts. Substring matching also
 * absorbs Hebrew prefix morphology for free — `%יועץ%` matches "ליועץ" too.
 *
 * TITLES MATTER MORE THAN BODIES. This searched bodies only, so naming a file
 * could never find it — "סכם לי את Macabi-lybi-Proposal 100826.pdf" missed a
 * document HQ held in full, because the filename lives in `title`, and HQ
 * answered that it had no access to a file it had already indexed. Naming
 * something is the strongest signal there is that you mean THAT thing, so a
 * title hit outranks any body hit and returns the head of the document — which
 * is where a proposal keeps its executive summary.
 */
async function keywordSearch(question, { maxAtoms = 4, windowChars = 1100 } = {}) {
  const terms = [...new Set(
    question
      .replace(/[?!.,;:"'()\[\]]/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
  )].slice(0, 6);

  if (!terms.length) return [];

  const { rows } = await db.query(
    `SELECT id, kind, title, body, external_url, occurred_at,
            (SELECT count(*) FROM unnest($1::text[]) term WHERE body ILIKE '%' || term || '%') AS hits,
            (SELECT count(*) FROM unnest($1::text[]) term WHERE title ILIKE '%' || term || '%') AS title_hits,
            (SELECT count(*) FROM unnest($1::text[]) term
              WHERE COALESCE(summary,'') ILIKE '%' || term || '%') AS summary_hits,
            summary
       FROM hq_atoms
      WHERE visibility = 'company'
        AND (body ILIKE ANY (SELECT '%' || term || '%' FROM unnest($1::text[]) term)
          OR title ILIKE ANY (SELECT '%' || term || '%' FROM unnest($1::text[]) term)
          OR COALESCE(summary,'') ILIKE ANY (SELECT '%' || term || '%' FROM unnest($1::text[]) term))
      ORDER BY title_hits DESC, summary_hits DESC, hits DESC, COALESCE(occurred_at, ingested_at) DESC
      LIMIT $2`,
    [terms, maxAtoms]
  );

  return rows.map(atom => {
    // Named outright: give the top of the document rather than a window round
    // a term. "What's in X" wants X's opening, not one paragraph from
    // somewhere in the middle.
    // The summary is the one place a document says what it IS, in its own
    // language. A proposal PDF written entirely in generic terms ("הקופה")
    // never contains the client's name, so the body can't be matched on it —
    // but the summary can, and it's what a person would have written down.
    if (Number(atom.title_hits) > 0 || Number(atom.summary_hits) > 0) {
      const head = atom.summary
        ? `${atom.summary}

---

${atom.body.slice(0, windowChars * 2)}`
        : atom.body.slice(0, windowChars * 3);
      return {
        atomId: atom.id,
        title: atom.title,
        kind: atom.kind,
        url: atom.external_url,
        occurredAt: atom.occurred_at,
        text: head,
        matched: Number(atom.title_hits) + Number(atom.summary_hits) + Number(atom.hits),
        namedDirectly: true,
      };
    }

    // Centre the window on the rarest term that actually appears, so the
    // excerpt contains the match rather than starting from the top of the doc.
    const found = terms
      .map(t => ({ t, at: atom.body.toLowerCase().indexOf(t.toLowerCase()) }))
      .filter(x => x.at >= 0)
      .sort((a, b) => b.t.length - a.t.length)[0];

    const centre = found ? found.at : 0;
    const start = Math.max(0, centre - Math.floor(windowChars / 3));

    return {
      atomId: atom.id,
      title: atom.title,
      kind: atom.kind,
      url: atom.external_url,
      occurredAt: atom.occurred_at,
      text: atom.body.slice(start, start + windowChars),
      matched: Number(atom.hits),
    };
  });
}

/**
 * @returns {Promise<{ answer, citations, hits, usedAtomIds }>}
 */
async function ask(question, { topK = TOP_K } = {}) {
  const trimmed = (question || '').trim();
  if (!trimmed) throw new Error('question is required');

  await budget.assertWithinBudget('this question');

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

  // Lexical pass, merged in front: an exact term match is stronger evidence
  // than any similarity score, so these lead the excerpt list.
  //
  // Run it over BOTH language variants. Asked "what did we decide with
  // Meuhedet?", the corpus spells the client "מאוחדת" and never "Meuhedet", so
  // an English-only lexical pass finds nothing — while the vector search
  // returned two chunks of the right meeting that happened not to name it, and
  // the model truthfully reported no mention. The translated variant matches
  // the Hebrew spelling and pulls a window that actually contains the name.
  const keywordSets = await Promise.all(
    variants.map(v => keywordSearch(v).catch(err => {
      console.warn('[hq] keyword search failed:', err.message);
      return [];
    }))
  );

  const byAtom = new Map();
  for (const hit of keywordSets.flat()) {
    const prev = byAtom.get(hit.atomId);
    if (!prev || hit.matched > prev.matched) byAtom.set(hit.atomId, hit);
  }
  const keyword = [...byAtom.values()].sort((a, b) => b.matched - a.matched).slice(0, 5);
  const vectorAtomIds = new Set(
    results.map(r => {
      const m = /^atom-(\d+)$/.exec(String(r.fileId));
      return m ? parseInt(m[1], 10) : null;
    }).filter(Boolean)
  );

  if (!results.length && !keyword.length) {
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

  const fromVector = results.map(r => {
    const match = /^atom-(\d+)$/.exec(String(r.fileId));
    const atom = match ? atomById.get(parseInt(match[1], 10)) : null;
    return {
      atomId: atom?.id ?? null,
      title: atom?.title || r.fileName,
      kind: atom?.kind || r.fileType,
      url: atom?.external_url || null,
      occurredAt: atom?.occurred_at || null,
      score: r.score,
      text: r.text,
      via: 'semantic',
    };
  });

  const fromKeyword = keyword.map(k => ({
    atomId: k.atomId,
    title: k.title,
    kind: k.kind,
    url: k.url,
    occurredAt: k.occurredAt,
    // Exact matches have no cosine score; report a floor so the UI can rank
    // them sensibly without pretending they were scored the same way. A
    // document the question NAMED sits above everything — asking about a file
    // by name is unambiguous in a way no similarity score can beat.
    score: k.namedDirectly ? 1 : vectorAtomIds.has(k.atomId) ? 0.99 : 0.9,
    text: k.text,
    via: k.namedDirectly ? 'named' : 'exact',
  }));

  // Number the excerpts as presented — the model cites these indices.
  const excerpts = [...fromKeyword, ...fromVector].slice(0, topK + 4).map((e, i) => {
    const when = e.occurredAt ? new Date(e.occurredAt).toISOString().slice(0, 10) : null;
    return { n: i + 1, ...e, date: when };
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
    .map(({ text, occurredAt, ...rest }) => ({ ...rest, snippet: text.slice(0, 320) }));

  return {
    answer,
    citations,
    hits: excerpts.map(({ text, occurredAt, ...rest }) => ({ ...rest, snippet: text.slice(0, 200) })),
    usedAtomIds: citations.map(c => c.atomId).filter(Boolean),
  };
}

module.exports = { ask, ASK_MODEL };
