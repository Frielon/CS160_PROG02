// Functionality 1: render a ballot measure at a reading level and a length.
//
// The prompts live here so the guide (guide.html) and the test script (tools/eval-render.mjs)
// send exactly the same thing. The model only ever sees the measure's legal text (fullTextMarked):
// never measure.official, which is the answer key. Needs js/fk.js for the checks.
//
// We send fullTextMarked rather than fullText because only the marked version shows which words
// are new. Prop 4's remaining ban ("...if the funds are earmarked for education, transportation,
// or public safety") is new text; without the [NEW: ...] marks the model dropped it every time.

const PROMPT_VERSION = 'v8';

// Lower temperature = fewer surprises between runs. Shared by the guide and the tests.
const RENDER_TEMPERATURE = 0.3;

const READING_LEVELS = [
  {
    id: 'as-written', label: 'As written', target: 'certified text',
    reads: 'The certified legal text, untouched. No model involved.',
  },
  {
    id: 'plain', label: 'Plain English', grade: [11, 13], target: 'grade 11–13', sentenceWords: 18,
    reads: 'Newspaper editorial. Technical terms kept, but defined on first use.',
    style: `Write like a newspaper editorial for adult readers. Sentences average about 18 words.
Keep the legal and technical terms that matter (for example "special tax" or "environmental impact report"),
and define each one in plain words the first time you use it.`,
  },
  {
    id: 'everyday', label: 'Everyday', grade: [7, 9], target: 'grade 7–9', sentenceWords: 11,
    reads: 'Short sentences, common words, nothing left undefined.',
    style: `Write for a middle-school reader (grade 7 to 9). Sentences average about 11 words, and none is longer than 18 words.
Use common, everyday words. Explain every legal or technical idea in everyday words. Leave nothing undefined.`,
  },
  {
    id: 'simplest', label: 'Simplest', grade: [3, 4], target: 'grade 3–4', sentenceWords: 7,
    reads: 'Elementary school, told as a relatable story.',
    style: `Write for a third- or fourth-grade reader (about 9 years old). One idea per sentence. Most sentences have 4 to 8 words; none has more than 10.
Use short, common words a 9-year-old knows. Swap long words for short ones: "people running for office" for "candidates",
"the state" or "the city" for "government", "money" for "funds" or "revenue", "rule" for "regulation", "vote" for "election".
Keep the key facts: who it affects, what changes, the numbers, and words like "one time" or "only".
This is the sentence style to copy (the topic is different on purpose): "The library has a new rule. Kids can take home ten books. Before, it was five. The rule starts in June."`,
    // Only when there is room for it: a 25-word headline cannot also be a story.
    story: `Tell it as a short story with a made-up, everyday example (a family, a neighborhood, a town) that shows what the measure would change.
Start the story with "Imagine". The example may only show what the legal text says; it must not invent how things work today.
Build the example only from people, places and things the legal text itself names. If the measure covers only certain kinds of projects,
people or places, the example must be one of those kinds. Do not make up numbers, amounts or dates for it.
Say what the measure does, not what its authors hope it will do.`,
  },
];

const LENGTHS = [
  { id: 'headline', label: 'Headline', words: [1, 25], target: '25 words or fewer', maxTokens: 300 },
  { id: 'short', label: 'Short', words: [75, 100], target: '75–100 words', maxTokens: 600 },
  { id: 'standard', label: 'Standard', words: [250, 300], target: '250–300 words', maxTokens: 1500 },
  { id: 'complete', label: 'Complete', words: null, target: 'no cap', maxTokens: 16000 },
  // For debugging the reading level on its own: no length instruction at all.
  { id: 'none', label: 'No length rule', words: null, target: 'debug: no length rule', maxTokens: 16000, debug: true },
];

const SYSTEM_PROMPT = `You rewrite California ballot measures so that voters can understand them. You translate; you do not comment.

Rules:
1. Use only the legal text you are given. Do not add facts, numbers, dates, history or context that are not in it. If the text does not say something (for example, what the measure will cost), do not guess.
2. Do not describe what the law is today, or how things work now, unless the legal text itself shows it (for example in [DELETED: ...] text).
3. Stay neutral. No opinions, no advice on how to vote, and no words that judge the measure (such as "fair", "harmful" or "important"). Do not predict effects (for example "this could lower costs") and do not state goals as results; you may write "the measure says its goal is ...".
4. Keep the qualifiers that change the meaning: one-time, temporary, only, at least, up to, except, unless, start dates, dollar amounts, percentages, vote thresholds, and who is covered. Say both what the measure allows or requires and the limits or exclusions it sets. Never drop a condition: "not allowed unless X" must not become "not allowed", and "allowed only if X" must not become "allowed".
5. When a rate, limit or rule applies to an amount, say exactly what it applies to (for example the whole amount, or only the part above a line), as the text says.
6. When the text makes an exception by pointing to another law (for example "except as provided in Section 4"), say that some exceptions apply. Do not guess what they are.
7. The legal text marks changes. Words inside [NEW: ...] are added by this measure. Words inside [DELETED: ...] are current law that this measure would remove: describe them as something the measure takes away or ends, never as something it does. Unmarked words are either current law that stays the same or the measure's own titles, findings and instructions. The [NEW: ...] and [DELETED: ...] parts are usually what a voter most needs to know, and limits or exceptions inside [NEW: ...] text are part of what the measure does: include them even in a short version.
8. "Findings and declarations" and purpose sections are the authors' claims, not rules. Do not repeat them as facts. If you mention them, say "the measure says".
9. If the legal text is too short to fill the requested length without repeating yourself or adding outside facts, write less.
10. Write plain text only: no headings, no bullet points, no numbered lists, no bold, no markdown. Separate paragraphs with a blank line. End every sentence with a period, question mark or exclamation mark.`;

function levelById(id) { return READING_LEVELS.find((l) => l.id === id); }
function lengthById(id) { return LENGTHS.find((l) => l.id === id); }

/**
 * The length instruction, plus the reminder that closes the prompt.
 * It depends on the level: the same 90 words is 4 sentences in Plain English and 11 in Simplest.
 */
function lengthRule(level, length) {
  const sentences = (words) => Math.max(1, Math.round(words / level.sentenceWords));
  switch (length.id) {
    case 'headline': {
      const shape = { plain: 'one sentence', everyday: 'one or two sentences', simplest: 'two or three very short sentences' }[level.id];
      return {
        rule: `Headline. Your whole reply is a single headline-style summary of 25 words or fewer (${shape}). Nothing before it and nothing after it.`,
        reminder: 'Your whole reply must be 25 words or fewer.',
      };
    }
    case 'short':
      return {
        rule: `Short. About 90 words in total (between 75 and 100), in one paragraph (about ${sentences(90)} sentences).`,
        reminder: 'Your whole reply must be between 75 and 100 words.',
      };
    case 'standard':
      return {
        rule: `Standard. About 280 words in total (between 250 and 300): 4 paragraphs of about 70 words each (about ${sentences(280)} sentences in all). `
          + 'Cover what the measure does, who it affects, any money involved as the text states it, and when it takes effect.',
        reminder: 'Your whole reply must be between 250 and 300 words, unless the legal text is too short to fill that honestly.',
      };
    case 'complete':
      return {
        rule: 'Complete. No word limit. Cover every provision of the measure, in the order the text presents them. '
          + 'Leave nothing out, including technical and procedural sections, but say each thing only once.',
        reminder: 'Cover every provision; there is no word limit.',
      };
    default:
      return { rule: '', reminder: '' };
  }
}

/** The messages for one rendering. The long legal text comes first so repeated calls on one measure share a prefix. */
function buildRenderMessages(measure, levelId, lengthId) {
  const level = levelById(levelId);
  const length = lengthById(lengthId);
  const { rule, reminder } = lengthRule(level, length);
  const style = level.story && length.id !== 'headline' ? `${level.style}\n${level.story}` : level.style;
  const steps = [
    rule && `Length: ${rule}`,
    `Reading level: ${level.label} (${level.target}). ${style}`,
    'Start directly with the rewrite: no title, and no introduction such as "Here is".',
  ].filter(Boolean);
  const user = `Here is the full legal text of ${measure.label}, a measure on the California ballot for November 3, 2026. It is ${measure.wordCount} words long.

<legal_text>
${measure.fullTextMarked}
</legal_text>

Task: rewrite ${measure.label} for a voter.

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}
${reminder ? `\n${reminder}` : ''}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---- Checks on what came back. No AI: just counting. ------------------------------

/**
 * Grade ranges are read the way school grades are: "grade 7–9" accepts FK 7.0 up to 9.9.
 * @returns {{words:number, grade:number|null, sentences:number, syllables:number, lengthOk:boolean|null, gradeOk:boolean|null}}
 */
function checkRendering(text, levelId, lengthId) {
  const level = levelById(levelId);
  const length = lengthById(lengthId);
  const fk = fleschKincaid(text);
  const lengthOk = length.words ? fk.words >= length.words[0] && fk.words <= length.words[1] : null;
  const gradeOk = level.grade && fk.grade != null ? fk.grade >= level.grade[0] && fk.grade < level.grade[1] + 1 : null;
  return { words: fk.words, grade: fk.grade, sentences: fk.sentences, syllables: fk.syllables, lengthOk, gradeOk };
}

// ---- One automatic revision. ---------------------------------------------------------
// The model cannot count its own words or syllables, but our code can. When a draft misses its
// targets we tell the model the measured numbers in the same conversation (so it still has the
// legal text) and ask once more. One retry only: it costs a second call.
// Complete renderings are not revised automatically: a second pass over 5,000 words doubles a
// 30–45 second wait, and in testing it dropped provisions while chasing the grade.
const AUTO_REVISE_LENGTHS = ['headline', 'short', 'standard'];

/** What is off about a draft, as instructions for the model. Empty when it is on target. */
function revisionAsks(measure, levelId, lengthId, check, missing = [], misread = [], flagged = []) {
  const level = levelById(levelId);
  const length = lengthById(lengthId);
  const asks = [
    ...misread.map((m) => `It says ${m.wrong}, but the legal text says ${m.right}. Fix that.`),
    ...flagged.slice(0, 6).map((f) => `A check against the legal text found that this claim ${f.verdict === 'contradicted' ? 'contradicts the legal text' : 'is not in the legal text'}: "${f.claim}" ${f.reason}`
      + `${f.quote && f.quoteFound !== 'missing' ? ` The legal text says: "${f.quote}"` : ''} Fix it or leave it out.`),
    ...missing.map((fact) => `It leaves out something the legal text says that a version this long should keep: ${fact}. Add it, in words that fit the reading level.`),
  ];
  const middle = length.words && Math.round((length.words[0] + length.words[1]) / 2);
  if (length.words && check.words > length.words[1]) {
    asks.push(length.id === 'headline'
      ? `It is ${check.words - 25} words too long. Cut it to 25 words or fewer.`
      : `It is ${check.words - length.words[1]} words too long. Cut it to about ${middle} words (between ${length.words[0]} and ${length.words[1]}): drop minor details first, and keep qualifiers such as "one-time", "only" and "except".`);
  } else if (length.words && check.words < length.words[0] && !sourceTooShort(measure, lengthId)) {
    asks.push(`It is ${length.words[0] - check.words} words too short. Bring it to about ${middle} words (between ${length.words[0]} and ${length.words[1]}) with more detail from the legal text.`);
  }
  // Grade is only worth a retry when it is clearly off: asked to nudge 6.9 up to 7, the model jumps to 13.
  const GRADE_SLACK = 0.5;
  if (level.grade && check.grade != null && (check.grade >= level.grade[1] + 1 + GRADE_SLACK || check.grade < level.grade[0] - GRADE_SLACK)) {
    // Solve the Flesch–Kincaid formula for words per sentence, keeping this draft's syllables per word.
    const goal = (level.grade[0] + level.grade[1] + 1) / 2; // 7–9 → 8.5
    const syllablesPerWord = check.syllables / check.words;
    const perSentence = check.words / check.sentences;
    const needed = (goal + 15.59 - 11.8 * syllablesPerWord) / 0.39;
    const floor = Math.max(4, Math.round(level.sentenceWords * 0.6));
    if (check.grade >= level.grade[1] + 1) {
      asks.push(needed >= floor
        ? `It reads above the target grade. Your sentences average ${perSentence.toFixed(1)} words; make them average about ${Math.round(needed)} words by splitting long ones. Keep the words themselves about as simple as they are.`
        : `It reads above the target grade. Your sentences average ${perSentence.toFixed(1)} words; make them average about ${floor} words, and use shorter, more common words (fewer words of three or more syllables).`);
    } else {
      asks.push(`It reads below the target grade. Your sentences average ${perSentence.toFixed(1)} words; make them a little longer, about ${Math.round(Math.min(needed, perSentence * 1.4))} words, by joining some short ones.`);
    }
  }
  return asks;
}

function buildRevisionMessages(measure, levelId, lengthId, draft, check, missing = [], misread = [], flagged = []) {
  const level = levelById(levelId);
  const length = lengthById(lengthId);
  const perSentence = (check.words / Math.max(1, check.sentences)).toFixed(1);
  const feedback = `Our checker measured your rewrite: ${check.words} words, ${check.sentences} sentences (about ${perSentence} words per sentence), Flesch-Kincaid grade ${check.grade}.
The target is ${length.words ? length.target : 'no length limit'} at ${level.label} (${level.target}).

${revisionAsks(measure, levelId, lengthId, check, missing, misread, flagged).join('\n')}

Rewrite it. Keep every fact and qualifier it has now, add nothing that is not in the legal text, and follow all the earlier instructions.${length.words ? ` The whole rewrite must stay ${length.id === 'headline' ? 'at 25 words or fewer' : `between ${length.words[0]} and ${length.words[1]} words`}.` : ''} Reply with the new rewrite only.`;
  return [
    ...buildRenderMessages(measure, levelId, lengthId),
    { role: 'assistant', content: draft },
    { role: 'user', content: feedback },
  ];
}

/**
 * How far a rendering is from its targets: 0 is on target. A dropped key fact costs more than a
 * missed number, so a revision that hits the word count but loses "one-time" does not win.
 */
function missScore(measure, levelId, lengthId, check, missing, misread = [], flagged = []) {
  const level = levelById(levelId);
  const length = lengthById(lengthId);
  let score = 3 * missing.length + 5 * misread.length;
  for (const f of flagged) score += f.verdict === 'contradicted' ? 5 : 2;
  if (length.words) {
    const [lo, hi] = length.words;
    if (check.words > hi) score += (10 * (check.words - hi)) / hi;
    else if (check.words < lo && !sourceTooShort(measure, lengthId)) score += (10 * (lo - check.words)) / lo;
  }
  if (level.grade && check.grade != null) {
    if (check.grade >= level.grade[1] + 1) score += check.grade - (level.grade[1] + 1) + 0.1;
    else if (check.grade < level.grade[0]) score += level.grade[0] - check.grade;
  }
  return score;
}

/** True when the legal text is too short to honestly fill the length (Prop 43 is 214 words; Standard asks 250–300). */
function sourceTooShort(measure, lengthId) {
  const length = lengthById(lengthId);
  return Boolean(length.words) && measure.wordCount < length.words[0] * 2;
}

// Facts from each measure's legal text that a rendering of at least `from` length should keep.
// A word match, not understanding: it flags likely drops for a person to look at.
const LENGTH_ORDER = ['headline', 'short', 'standard', 'complete', 'none'];

const KEY_FACTS = {
  'prop-4': [
    { fact: 'it is about public money for election campaigns', from: 'headline',
      pattern: /public (?:money|moneys|funds?|funding|financing)|(?:government|taxpayer|tax|state|city|town) (?:money|funds?|dollars)|(?:state|cities|city|towns?|governments?) (?:could |can |would |to )?(?:give|pay|fund)/i },
    { fact: 'money set aside for education, transportation or public safety cannot be used', from: 'short',
      pattern: /educat|school|transport|public safety/i },
  ],
  'prop-43': [
    { fact: 'new local special taxes need a two-thirds vote', from: 'headline', pattern: /two[- ]thirds|2\/3|two (?:out )?of (?:every )?three/i },
    { fact: 'it includes taxes that voters propose themselves (initiatives)', from: 'short',
      pattern: /initiative|petition|citizens?\b|voters (?:themselves|who|can|propose|start|put)|people (?:try to )?(?:start|propose)/i },
    { fact: 'it starts January 1, 2027', from: 'standard', pattern: /2027/ },
  ],
  'prop-40': [
    { fact: 'the tax is one-time', from: 'headline', pattern: /one[- ]time|only once|just once|a single time/i },
    { fact: 'it only applies to people worth more than $1 billion', from: 'headline', pattern: /billion/i },
    { fact: 'the tax is 5% of net worth', from: 'short', pattern: /\b5 ?%|\b5 percent|five percent|5 (?:cents|dollars) (?:of|for|out of) every/i },
    { fact: 'most of the money (90%) goes to health care', from: 'short', pattern: /health/i },
    { fact: 'it can be paid in five yearly installments', from: 'standard',
      pattern: /install|five (?:equal |yearly |annual )*(?:payments|parts|years)|5 (?:payments|years)|over five years/i },
  ],
  'prop-45': [
    { fact: 'it changes environmental review', from: 'headline', pattern: /environment/i },
    { fact: 'it covers "essential" projects such as housing, water, energy and transportation', from: 'short',
      pattern: /housing|homes|water|energy|transport|transit|roads/i },
    { fact: 'it sets deadlines for that review', from: 'short', pattern: /deadline|time limit|\d+ days|one year|timeline|within a (?:year|set time)/i },
    { fact: 'it changes how court challenges (lawsuits) work', from: 'standard', pattern: /lawsuit|court|\bsue\b|legal challenge|judicial/i },
  ],
};

/** Each key fact a rendering of this length should keep, and whether the text mentions it. */
function factChecks(measureId, lengthId, text) {
  const reach = LENGTH_ORDER.indexOf(lengthId);
  return (KEY_FACTS[measureId] || [])
    .filter((f) => LENGTH_ORDER.indexOf(f.from) <= reach)
    .map((f) => ({ fact: f.fact, ok: f.pattern.test(text) }));
}

/** Key facts this length should keep but the text never mentions. */
function missingFacts(measureId, lengthId, text) {
  return factChecks(measureId, lengthId, text).filter((f) => !f.ok).map((f) => f.fact);
}

// Mistakes this model made in testing that change what a measure does. Each `right` is written
// from the legal text (not the official summary). A word match again: it flags, a person decides.
const KNOWN_MISREADINGS = {
  'prop-40': [
    { wrong: 'that the 5% applies only to wealth above $1 billion',
      right: 'that the tax is 5% of a person’s whole net worth, not just the part above $1 billion (with a lower rate for people worth between $1 billion and $1.1 billion)',
      pattern: /(?:5 ?%|five percent|5 percent)[^.]{0,40}(?:wealth|net worth|assets|money)[^.]{0,10}(?:above|over|beyond|in excess of|past) (?:the first )?(?:\$?1|one) billion/i },
  ],
  'prop-45': [
    { wrong: 'that it covers parks',
      right: 'that it covers only essential housing, clean energy, water, public health, public safety, broadband, education facility and transportation projects',
      pattern: /\bparks?\b/i },
  ],
};

/** Known misreadings that appear in the text. */
function misreadings(measureId, text) {
  return (KNOWN_MISREADINGS[measureId] || []).filter((m) => m.pattern.test(text));
}

/** A note about level × length combinations that cannot be done honestly, shown before the call. */
function comboWarning(levelId, lengthId) {
  if (levelId === 'as-written') return null;
  if (lengthId === 'headline' && levelId === 'simplest') {
    return '25 words at a 3rd-grade level will almost certainly drop qualifiers. Read it against the full text.';
  }
  if (lengthId === 'headline') return 'A 25-word headline leaves most of the measure out.';
  return null;
}

// ---- The whole pipeline ---------------------------------------------------------------

/** Everything our code measures about one rendering's text (no AI). */
function measureRendering(measure, levelId, lengthId, text) {
  return {
    text, ...checkRendering(text, levelId, lengthId),
    facts: factChecks(measure.id, lengthId, text), missing: missingFacts(measure.id, lengthId, text),
    misread: misreadings(measure.id, text),
  };
}

/**
 * Draft → checks → (for short lengths, if needed) one revision → keep whichever is closer to target
 * → fix whatever the fact check still flags.
 * Checks are our code (words, grade, key facts, known misreadings) and, when factCheck is given,
 * a second model call that tests every claim against the legal text (js/checker.js).
 * The final fix (finalFix) edits only the flagged sentences; the code applies the edits, so the
 * rest of the text stays word for word, and each replacement is checked again before it is used.
 *
 * send(messages, { maxTokens, temperature }) must return OpenRouter's JSON reply; the guide passes
 * chat() from js/openrouter.js and the test script passes its own fetch, so both run this same code.
 * factCheck(text) returns checkClaims()'s result; finalFix(text, factCheck) returns fixRendering()'s.
 * onStep(step, rendering, extra) reports progress: 'draft', 'check', 'revise', 'recheck', 'fix'.
 * revise: false stops after the draft (and its fix).
 */
async function renderMeasure(measure, levelId, lengthId, send, onStep = () => {}, { revise = true, factCheck = null, finalFix = null } = {}) {
  const length = lengthById(lengthId);
  const autoChecked = AUTO_REVISE_LENGTHS.includes(lengthId);
  const measureText = (text) => measureRendering(measure, levelId, lengthId, text);
  const ask = async (messages) => {
    const started = Date.now();
    const data = await send(messages, { maxTokens: length.maxTokens, temperature: RENDER_TEMPERATURE });
    const text = (data.choices?.[0]?.message?.content || '').trim();
    return {
      ...measureText(text), messages, data, ms: Date.now() - started, cost: data.usage?.cost ?? 0,
      finish: data.choices?.[0]?.finish_reason, factCheck: null,
    };
  };
  const runFactCheck = async (r, step) => {
    if (!factCheck || !autoChecked) return;
    onStep(step, r);
    r.factCheck = await factCheck(r.text);
  };
  const flagsOf = (r) => r.factCheck?.flagged || [];
  const score = (r) => missScore(measure, levelId, lengthId, r, r.missing, r.misread, flagsOf(r));

  // The fixed text replaces r only if it scores no worse (a deletion that drops a key fact
  // to silence a minor flag does not win).
  const fixFlags = async (r) => {
    if (!finalFix || !autoChecked || !flagsOf(r).length) return r;
    onStep('fix', r, flagsOf(r));
    const fix = await finalFix(r.text, r.factCheck);
    if (!fix.edits.some((e) => e.accepted)) return { ...r, fix };
    const fixed = { ...r, ...measureText(fix.text), cost: 0, ms: 0, factCheck: fix.factCheck, fix, fixedFrom: r };
    return score(fixed) <= score(r) ? fixed : { ...r, fix, fixRejected: true };
  };

  onStep('draft');
  const draft = await ask(buildRenderMessages(measure, levelId, lengthId));
  await runFactCheck(draft, 'check');
  const asks = revise && autoChecked
    ? revisionAsks(measure, levelId, lengthId, draft, draft.missing, draft.misread, flagsOf(draft)) : [];
  if (!asks.length) return { kept: await fixFlags(draft), draft, revision: null, asks };

  onStep('revise', draft, asks);
  const revision = await ask(buildRevisionMessages(measure, levelId, lengthId, draft.text, draft, draft.missing, draft.misread, flagsOf(draft)));
  await runFactCheck(revision, 'recheck');
  const better = score(revision) < score(draft) ? revision : draft;
  return { kept: await fixFlags(better), draft, revision, asks, keptRevision: better === revision };
}
