// A second model call that checks an AI rendering against the measure's legal text.
//
// The checker lists every claim in the rendering with a verdict and an exact quote from the
// legal text. Our code then looks for each quote in the legal text, so a claim only counts as
// backed up when its quote is really there: the checker cannot invent support either.
// It is still a model judging a model, so the guide shows its findings as flags, not verdicts.
// Loaded by guide.html and by tools/eval-checker.mjs.

// Tested on 22 labeled cases (tools/eval-checker.mjs): with Gemini 2.5 Flash for both calls it caught
// 16/16 real misreadings over two runs with no false alarm on correct texts; Flash-Lite caught about half.
const CHECK_MODEL = 'google/gemini-2.5-flash';   // call A: spell out meanings (no legal text)
const VERIFY_MODEL = 'google/gemini-2.5-flash';  // call B: check them against the legal text
const CHECK_PROMPT_VERSION = 'c7';

// Two calls. In testing, one call that both read the claim and checked it worked out the right
// meaning ("5% of only the part above $1 billion") and then still matched surface words ("5% …
// 5 percent → supported"). So call A spells out what each claim means without seeing the legal
// text, and call B checks only those spelled-out meanings against the legal text.

const MEANING_SYSTEM_PROMPT = `You restate claims precisely. You will get a plain-language rewrite of a California ballot measure.

Split it into its claims (usually one per sentence; split a sentence that makes two separate claims). Skip sentences that only set up a made-up example and say nothing about the measure (such as "Imagine a family that needs help."), but keep what the example says the measure does.

For each claim, write its meaning as one or more facts. Each fact is one short sentence stating a single thing the claim's words say to an ordinary voter, spelled out precisely (who is covered, what exactly a number or rate applies to, when, under what conditions). A claim that says three separate things becomes three facts. But never split a list: "It applies only to A, B and C" stays one fact, because "It applies only to A" alone would be false. Every fact keeps the claim's time frame and conditions: if the claim is about today's law ("today", "currently", "right now") or has an "except" or "unless", each of its facts says so too.

When a fact involves a rate or percentage, say exactly what it is charged on, in the form "The X% is charged on ...". Follow the claim's own words: "X% of [an amount] over [a line]" becomes "The X% is charged on only the part of [the amount] above [the line]", while "X% of the [amount] of people with over [a line]" becomes "The X% is charged on the whole [amount] of people above [the line]". Do not add any condition or exception the claim leaves out: a claim that something "cannot" happen, with no "unless", means it can never happen. In everyday English, "X% of [an amount] above (or over) [a line]" means X% of only the part above the line. If a sentence could be read two ways, give the reading most voters would take.`;

const VERIFY_SYSTEM_PROMPT = `You check numbered statements about a California ballot measure against the measure's full legal text. You are strict about meaning and neutral about politics.

For each statement decide:
- "supported": the legal text says this. A simpler paraphrase is fine if the meaning is the same.
- "contradicted": the legal text says something different. Look hard at numbers and percentages, what a rate or limit applies to (for example the whole amount, or only the part above a line), who is covered, start dates, one-time versus ongoing, and conditions such as "unless", "only" and "except".
- "unsupported": the legal text does not say this: outside facts, invented numbers, claims about how the law works today that the text does not show, or predicted effects stated as fact. A number, threshold or rule the legal text does not state (for example a vote requirement) is "unsupported" even when the text refers to other laws.

Notes:
- Text inside [DELETED: ...] is current law that the measure removes. Text inside [NEW: ...] is added by the measure.
- Judge each statement exactly as written. Do not excuse it by reading in conditions or details it does not state.
- A statement credited to the measure's own findings or purpose ("the measure says...") is supported if those sections say it. The same statement as plain fact is "unsupported".

For every statement, copy a quote of at most 40 words, word for word, from the legal text: the passage that supports or contradicts it (for "unsupported", the closest relevant passage, or "" if there is none). Give a one-sentence reason.`;

// Gemini writes properties in alphabetical order, so each verdict comes after its quote and reason.
const MEANING_SCHEMA = {
  name: 'claim_meanings',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'The claim, copied from the rewrite (a sentence or part of one).' },
            facts: { type: 'array', items: { type: 'string' }, description: "Single facts the claim's words state, each spelled out precisely." },
          },
          required: ['claim', 'facts'],
          additionalProperties: false,
        },
      },
    },
    required: ['claims'],
    additionalProperties: false,
  },
};

const VERIFY_SCHEMA = {
  name: 'statement_checks',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The statement number.' },
            quote: { type: 'string', description: 'Word-for-word quote from the legal text, at most 40 words.' },
            reason: { type: 'string', description: 'One sentence.' },
            verdict: { type: 'string', enum: ['supported', 'contradicted', 'unsupported'] },
          },
          required: ['id', 'quote', 'reason', 'verdict'],
          additionalProperties: false,
        },
      },
    },
    required: ['checks'],
    additionalProperties: false,
  },
};

function buildMeaningMessages(rendering) {
  return [
    { role: 'system', content: MEANING_SYSTEM_PROMPT },
    { role: 'user', content: `<rewrite>\n${rendering}\n</rewrite>\n\nList the claims in this rewrite and the facts each one states.` },
  ];
}

function buildVerifyMessages(measure, facts) {
  return [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    { role: 'user', content: `Here is the full legal text of ${measure.label}.

<legal_text>
${measure.fullTextMarked}
</legal_text>

Check each of these statements about ${measure.label} against the legal text.

${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}` },
  ];
}

// ---- Is the quote really in the legal text? (no AI) ------------------------------------

/** Lower-case, drop the [NEW: ...]/[DELETED: ...] marks, and even out quotes, dashes and spaces. */
function normalizeForQuote(text) {
  return text
    .replace(/\[(?:NEW|DELETED): /g, '').replace(/\]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Two versions of each legal text: with the struck-out words, and as it would read if passed.
// Quotes of amended law (Prop 4) often skip the deleted words: "public [DELETED: moneys] funds".
const quoteIndex = new Map(); // measure id → [normalized full text, normalized text without deleted words]

/**
 * 'exact' = the quote is in the legal text (an elided quote, "A … B", counts when every piece of
 * three or more words is there, in order); 'partial' = at least half the pieces are; 'missing'; 'none' = no quote.
 */
function verifyQuote(measure, quote) {
  const q = normalizeForQuote(quote || '').replace(/^the measure says:?\s*/, '').replace(/^["']|["']$/g, '').trim();
  if (!q) return 'none';
  if (!quoteIndex.has(measure.id)) {
    quoteIndex.set(measure.id, [
      normalizeForQuote(measure.fullTextMarked),
      normalizeForQuote(measure.fullTextMarked.replace(/\[DELETED: [^\]]*\]/g, ' ')),
    ]);
  }
  const [full, clean] = quoteIndex.get(measure.id);
  const found = (legal) => findPieces(q, legal);
  const a = found(full);
  if (a === 'exact') return a;
  const b = found(clean);
  return b === 'exact' || a === 'missing' ? b : a;
}

function findPieces(q, legal) {
  const pieces = q.split(/\.\.\.|…/).map((x) => x.trim().replace(/^[,;:.]\s*|[,;:]$/g, '')).filter((x) => x.split(' ').length >= 3);
  if (!pieces.length) return legal.includes(q) ? 'exact' : 'missing';
  let from = 0;
  let found = 0;
  let inOrder = true;
  for (const piece of pieces) {
    const at = legal.indexOf(piece, from);
    if (at >= 0) { found++; from = at + piece.length; } else if (legal.includes(piece)) { found++; inOrder = false; }
  }
  if (found === pieces.length && inOrder) return 'exact';
  return found * 2 >= pieces.length ? 'partial' : 'missing';
}

function parseJson(data, what) {
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error(`The ${what} did not return valid JSON.`);
  }
}

/**
 * Run the checker on one rendering: call A (facts, no legal text), then call B (verify each fact).
 * A claim is flagged when any of its facts is. send(messages, options) must return OpenRouter's JSON reply.
 * @returns {{claims: Array<{claim, facts: Array<{fact, verdict, quote, reason, quoteFound}>, verdict}>, flagged: Array, calls: Array, ms, cost}}
 */
async function checkClaims(measure, rendering, send, { model = CHECK_MODEL, verifyModel = VERIFY_MODEL } = {}) {
  const started = Date.now();
  const json = (m, schema) => ({ model: m, temperature: 0, maxTokens: 12000, responseFormat: { type: 'json_schema', json_schema: schema } });

  const a = await send(buildMeaningMessages(rendering), json(model, MEANING_SCHEMA));
  const claims = (parseJson(a, 'checker').claims || []).filter((c) => c.facts?.length);
  const facts = claims.flatMap((c) => c.facts);
  const b = await send(buildVerifyMessages(measure, facts), json(verifyModel, VERIFY_SCHEMA));
  const checks = parseJson(b, 'checker').checks || [];

  // Worst verdict first: one contradicted fact makes the whole claim contradicted.
  const rank = { contradicted: 3, unsupported: 2, unchecked: 1, supported: 0 };
  let n = 0;
  const merged = claims.map((c) => {
    const checked = c.facts.map((fact) => {
      const id = ++n;
      const check = checks.find((x) => x.id === id);
      return check
        ? { fact, verdict: check.verdict, quote: check.quote, reason: check.reason, quoteFound: verifyQuote(measure, check.quote) }
        : { fact, verdict: 'unchecked', quote: '', reason: 'The checker skipped this fact.', quoteFound: 'none' };
    });
    const worst = checked.reduce((w, f) => (rank[f.verdict] > rank[w.verdict] ? f : w), checked[0]);
    return { claim: c.claim, facts: checked, verdict: worst.verdict, quote: worst.quote, reason: worst.reason, quoteFound: worst.quoteFound, meaning: worst.fact };
  });
  return {
    claims: merged,
    flagged: merged.filter((c) => c.verdict !== 'supported'),
    calls: [a, b], ms: Date.now() - started,
    cost: (a.usage?.cost ?? 0) + (b.usage?.cost ?? 0),
  };
}

// ---- Fixing what the fact check flagged ------------------------------------------------
//
// The last step of the pipeline. The model does not rewrite the text: it returns one edit per
// flagged sentence ({ original, replacement }), and our code applies them. So every sentence
// that was not flagged stays word for word. Each replacement is then fact-checked on its own,
// and an edit is kept only if its replacement passes; otherwise the original sentence stays
// (and stays flagged).

const FIX_MODEL = 'google/gemini-2.5-flash-lite';
const FIX_PROMPT_VERSION = 'f3';

const FIX_SYSTEM_PROMPT = `You correct sentences in a plain-language rewrite of a California ballot measure so that they match the measure's legal text. A fact check has flagged some claims in the rewrite. For each flagged claim, return one edit:
- "original": the whole sentence from the rewrite that contains the flagged claim, copied character for character so that it can be found and replaced.
- "replacement": a corrected sentence that says what the legal text actually says. Use the fact check's reason and quote, and the legal text itself. Keep the same reading level and about the same length; it may be a few words longer only when a needed qualifier requires it ("only", "unless", "one-time", what a rate applies to). Add nothing the legal text does not say.

If the flagged claim has no basis in the legal text at all (an outside fact or an invented detail), drop that part: return the sentence without it, or an empty replacement if nothing true would be left.
If several flagged claims are in the same sentence, return one edit for that sentence that fixes all of them.
The fact check can be wrong. If a flagged sentence is already a fair plain-language reading of the legal text (for example it correctly names a term the legal text uses), return it unchanged as the replacement.
Do not change sentences that have no flagged claim, with one exception: if a fix would leave the sentence that sets it up wrong (for example the opening of a made-up example, "Imagine your town needs a new park"), edit that sentence too, as a separate edit.
Respect the length limit you are given: prefer the shortest correct wording (for example "5% of their whole net worth") over adding detail. When space is tight, drop a less important detail from the sentence (such as what the money is for) before you drop a qualifier. Add no describing words the legal text does not use (such as "small" or "large"). Text inside [DELETED: ...] in the legal text is current law the measure removes; text inside [NEW: ...] is added by the measure.`;

const FIX_SCHEMA = {
  name: 'sentence_edits',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: 'The number of the flagged claim (the first one if the sentence has several).' },
            original: { type: 'string', description: 'The whole sentence from the rewrite, copied exactly.' },
            replacement: { type: 'string', description: 'The corrected sentence, or "" to delete it.' },
          },
          required: ['id', 'original', 'replacement'],
          additionalProperties: false,
        },
      },
    },
    required: ['edits'],
    additionalProperties: false,
  },
};

function buildFixMessages(measure, levelLabel, rendering, flagged, wordRange) {
  const list = flagged.map((f, i) => `${i + 1}. "${f.claim}": ${f.verdict === 'contradicted' ? 'contradicts the legal text' : 'is not in the legal text'}. `
    + `Why: ${f.reason}${f.quote && f.quoteFound !== 'missing' ? ` The legal text says: "${f.quote}"` : ''}`).join('\n');
  return [
    { role: 'system', content: FIX_SYSTEM_PROMPT },
    { role: 'user', content: `Here is the full legal text of ${measure.label}.

<legal_text>
${measure.fullTextMarked}
</legal_text>

Here is a plain-language rewrite of it${levelLabel ? `, written at the ${levelLabel} reading level` : ''}.

<rewrite>
${rendering}
</rewrite>

It is ${rendering.split(/\s+/).filter(Boolean).length} words long.${wordRange ? ` After your edits the whole rewrite must still be ${wordRange[0] <= 1 ? `${wordRange[1]} words or fewer` : `between ${wordRange[0]} and ${wordRange[1]} words`}.` : ''}

The fact check flagged these claims:
${list}

Return the edits.` },
  ];
}

/** Find a sentence in the text even if spaces or curly quotes differ. Returns [start, end] or null. */
function locate(text, sentence) {
  const exact = text.indexOf(sentence);
  if (exact >= 0) return [exact, exact + sentence.length];
  const pattern = sentence.trim().split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]").replace(/["“”]/g, '["“”]'))
    .join('\\s+');
  const m = pattern && new RegExp(pattern).exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

const sentencesOf = (text) => text.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) || [];

/** How many sentences of the original an edit changes; we refuse edits that rewrite more than two. */
function sentencesChanged(edit) {
  const kept = new Set(sentencesOf(edit.replacement));
  return sentencesOf(edit.original).filter((x) => !kept.has(x)).length;
}

/** Apply edits by position; an empty replacement deletes the sentence and the space after it. */
function applyEdits(text, edits) {
  let out = text;
  for (const e of edits) {
    if (!e.accepted) continue;
    const at = locate(out, e.original);
    if (!at) { e.accepted = false; e.note = 'could not find the sentence'; continue; }
    const end = e.replacement ? at[1] : at[1] + (/^[ \t]+/.exec(out.slice(at[1]))?.[0].length || 0);
    out = out.slice(0, at[0]) + e.replacement + out.slice(end);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Fix the flagged sentences of one rendering.
 * send(messages, options) must return OpenRouter's JSON reply. levelLabel is e.g. "Everyday (grade 7–9)".
 * @returns {{text, edits: Array<{original, replacement, flags, accepted, recheck, note}>, cost, ms, calls}}
 */
async function fixFlagged(measure, levelLabel, rendering, flagged, send, { model = FIX_MODEL, wordRange = null } = {}) {
  const started = Date.now();
  const data = await send(buildFixMessages(measure, levelLabel, rendering, flagged, wordRange), {
    model, temperature: 0, maxTokens: 6000, responseFormat: { type: 'json_schema', json_schema: FIX_SCHEMA },
  });
  const proposed = (parseJson(data, 'fixer').edits || []).filter((e) => e.original)
    .map((e) => ({ ...e, flags: flagged.filter((f) => locate(e.original, f.claim) || e.id === flagged.indexOf(f) + 1) }));
  // An unchanged replacement means the fixer thinks the flag is wrong: record it, change nothing.
  const disputed = proposed.filter((e) => e.replacement.trim() === e.original.trim());
  const edits = proposed.filter((e) => !disputed.includes(e))
    .map((e) => ({ ...e, accepted: Boolean(locate(rendering, e.original)) && sentencesChanged(e) <= 2 }));
  for (const e of edits) {
    if (!locate(rendering, e.original)) e.note = 'could not find the sentence';
    else if (!e.accepted) e.note = 'the edit rewrote more than the flagged sentence, so it was not used';
  }

  // Check every replacement in one call, then credit each claim to the replacement it came from.
  const toCheck = edits.filter((e) => e.accepted && e.replacement);
  let recheck = null;
  if (toCheck.length) {
    recheck = await checkClaims(measure, toCheck.map((e) => e.replacement).join('\n\n'), send);
    for (const e of toCheck) {
      e.recheck = recheck.claims.filter((c) => locate(e.replacement, c.claim) || e.replacement.includes(c.claim.slice(0, 30)));
      const worse = e.recheck.filter((c) => c.verdict !== 'supported');
      const wasContradicted = e.flags.some((f) => f.verdict === 'contradicted');
      // Keep the edit if its replacement passes, or if it turns a contradiction into a milder "not found".
      e.accepted = worse.length === 0 || (wasContradicted && worse.every((c) => c.verdict === 'unsupported'));
      if (!e.accepted) e.note = 'the replacement was flagged too, so the original sentence stays';
      else if (!e.recheck.length) e.note = 'the replacement could not be matched to the re-check';
    }
  }
  for (const e of edits) if (e.accepted && !e.replacement) e.note = 'deleted: nothing in the legal text supports it';
  return {
    text: applyEdits(rendering, edits),
    edits,
    disputed: disputed.map((e) => ({ sentence: e.original, flags: e.flags })),
    calls: [data, ...(recheck ? recheck.calls : [])],
    cost: (data.usage?.cost ?? 0) + (recheck?.cost ?? 0),
    ms: Date.now() - started,
  };
}

/**
 * Fix a checked rendering and update its fact check to match: claims in sentences that were
 * replaced or deleted give way to the re-check of the replacements.
 * @returns fixFlagged()'s result plus factCheck (the merged fact check for the new text).
 */
async function fixRendering(measure, levelLabel, rendering, factCheck, send, options = {}) {
  const fix = await fixFlagged(measure, levelLabel, rendering, factCheck.flagged, send, options);
  const accepted = fix.edits.filter((e) => e.accepted);
  const touched = (c) => accepted.some((e) => locate(e.original, c.claim));
  const claims = [
    ...factCheck.claims.filter((c) => !touched(c)),
    ...accepted.flatMap((e) => (e.recheck || []).map((c) => ({ ...c, fromFix: true }))),
  ];
  return { ...fix, factCheck: { ...factCheck, claims, flagged: claims.filter((c) => c.verdict !== 'supported') } };
}
