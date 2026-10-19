// Functionality 2: compare the two sides of a ballot measure.
//
// The model reads the four documents the guide prints for a measure (each side's argument and
// rebuttal) and returns JSON. Two calls run at the same time:
//   1. The claims: every claim in each document, with the exact words it used and a dimension; for
//      each rebuttal claim, which claim in the other side's argument it answers and which claim in
//      its own argument it repeats; and each side's case in one sentence.
//   2. The backers: who each side says stands with it, each with the words that name it.
// It describes; it never says who is right.
//
// Why links and not "points": we first asked the model to group both sides' claims into questions.
// It split one question into several, reused a quote to give the silent side something to say, and
// left most points one-sided. A rebuttal is written to answer the other argument, so "which claim
// does this answer?" is a question the text itself answers, and the model gets it right far more often.
// Why a second call: asked in the same call which groups both sides claim, the model found teachers
// in one run, missed them in the next, and offered "California" in a third. Listing each side's
// backers is plain extraction; matching the two lists is our code's job.
//
// Our code (no AI) then does what we cannot trust a model to do. It looks for every quote in the
// printed documents and takes the side and round from where the quote really is, checks every link,
// and works out the debate's structure from that: answered in a rebuttal, never answered, or new in
// a rebuttal (where the other side never gets to reply). It finds the groups both sides claim by
// matching the two backer lists word by word. Signers come from the pack, never from the model.
// The model never sees measure.official (the answer key) or the legal text: this is not a fact check.
// Loaded by the guide and by tools/eval-compare.mjs, so both send exactly the same prompts.

const COMPARE_PROMPT_VERSION = 's12';
// Two models, one per call. The claims call has to judge which claim each rebuttal claim answers.
// Run side by side on the same prompt, Flash-Lite gave nearly every rebuttal claim a reply link and
// about 1 in 3 of them were weak (marking claims "answered" that nobody answered); Flash got about
// 1 in 10 wrong, and told a repeat of a side's own argument from a reply. Flash costs about 5 times
// as much ($0.011 against $0.002 for both calls) and takes about 14 seconds against 7.
// Listing backers is plain extraction, which Flash-Lite does as well, and our code checks every one.
// With a thinking budget Flash-Lite told repeats apart, but bent more quotes and missed more exchanges.
const COMPARE_MODEL = 'google/gemini-2.5-flash';
const BACKERS_MODEL = 'google/gemini-2.5-flash-lite';
// Extraction, not writing: 0 keeps runs as alike as the model allows.
const COMPARE_TEMPERATURE = 0;
const COMPARE_MAX_TOKENS = 12000;

// Every claim goes under one of these. They are fixed so the guide can line the sides up row by row,
// and say "neither side raises this" rather than quietly leaving a dimension out.
const DIMENSIONS = [
  { id: 'rules', label: 'What it would change',
    covers: 'what the measure itself requires, allows, forbids or leaves alone, and who and what it covers (claims about money go under money; claims about who decides, or about oversight, go under voice)' },
  { id: 'money', label: 'Money',
    covers: 'taxes, costs, prices, revenue and budgets: who pays, who gains, and any dollar figure' },
  { id: 'effects', label: 'Effects on people and services',
    covers: 'what will happen to people, jobs, health care, schools, housing, public safety or the environment' },
  { id: 'voice', label: 'Voice and accountability',
    covers: 'who gets to decide (voters, majorities, politicians, agencies, courts), including what it lets them change later, public input, and whether there is oversight or accountability' },
  { id: 'backers', label: 'Who is on each side',
    covers: 'who wrote or pays for the measure or the campaigns, which people and groups each side says support or oppose it, and what each side says about the other side’s motives' },
];

// How a side presents a claim. Not whether it is true.
const STATED_AS = { fact: 'Stated as fact', prediction: 'Prediction', opinion: 'Opinion' };

// The four documents in the order the prompt shows them: round 1, then round 2, YES first in each.
// `field` is where the model lists that document's claims; `prefix` starts their ids (YA1, YA2, ...).
// Careful: the guide's "Rebuttal to Argument in Favor" is written by the NO side.
const COMPARE_DOCS = [
  { key: 'argumentInFavor', field: 'yes_argument', prefix: 'YA', name: 'Argument in Favor' },
  { key: 'argumentAgainst', field: 'no_argument', prefix: 'NA', name: 'Argument Against' },
  { key: 'rebuttalToAgainst', field: 'yes_rebuttal', prefix: 'YR', name: 'Rebuttal to Argument Against' },
  { key: 'rebuttalToFavor', field: 'no_rebuttal', prefix: 'NR', name: 'Rebuttal to Argument in Favor' },
];

// The same opening for both calls.
const SHARED_RULES = `You will get the four documents the official voter guide prints for one California ballot measure: the argument for it, the argument against it, and each side's rebuttal. In round 1, each side writes an argument. In round 2, each side writes one rebuttal that answers the other side's argument. There is no round 3, so a claim first made in a rebuttal never gets an answer.

You report what each side says. You are not a fact-checker: you never say or hint that anything a side says is true, false, misleading or missing context, you never say which side is right, and you never tell anyone how to vote. Use only the four documents: add no facts, numbers, names or context from anywhere else, even when you know more about the topic or think a side is wrong.`;

const COMPARE_SYSTEM_PROMPT = `You help voters compare the two sides of a California ballot measure. ${SHARED_RULES}

Step 1: list the claims of each document, one document at a time, in the order they appear. A claim is one distinct thing the side asserts: what the measure would do, what it would cost, who it would affect, or who is for or against it. The documents are written under headings in capital letters, and each heading usually starts a new claim. Several sentences that make or back up the same assertion are one claim: quote the clearest of them, which is often the heading itself. List at most 10 claims for an argument; when it makes more, keep the ones a voter most needs, the ones the other side's rebuttal answers, and who the side says supports or opposes the measure. A rebuttal is short: list every claim it makes, including anything its own argument did not say. Skip slogans and calls to vote that assert nothing. For each claim give:
- id: the document's id and a number, such as YA1, YA2 and so on for the document with id "YA".
- quote: one continuous passage of at most 30 words, copied word for word from that document, with nothing changed, added or left out in the middle. A claim listed for an argument quotes that argument, never the rebuttal, and the other way around. From a bulleted list, quote the item itself, without the heading above it.
- restated: the claim in plain, neutral words, at most 25 words. Keep the side's numbers, its qualifiers (one-time, only, no limit, at least, up to, every) and how sure it sounds ("will" stays "will", "could" stays "could"). Leave out slogans, capital letters, insults and name-calling. Do not soften or strengthen the claim, and never add words such as "falsely", "wrongly", "correctly" or "without evidence".
- stated_as: "fact" for something the side presents as a fact about the measure or about the world now or in the past; "prediction" for what it says will or could happen; "opinion" for a judgment, a label, or a claim about someone's motives. This describes how the claim is presented, not whether it is true.
- dimension: the one that fits best:
${DIMENSIONS.map((d) => `  - ${d.id}: ${d.covers}.`).join('\n')}

Step 2: each rebuttal claim also says what it answers and what it repeats. A rebuttal is written to reply to the other side's argument, so most of its claims answer one of the other side's claims.
- For a YR claim: answers_NA is the id of the claim in the NO argument that it answers, and repeats_YA is the id of the claim in the YES argument that makes the same assertion.
- For an NR claim: answers_YA is the id of the claim in the YES argument that it answers, and repeats_NA is the id of the claim in the NO argument that makes the same assertion.
- A claim answers another when it disputes it, gives a different number or fact on the same question, or describes the same thing in a different light: "it protects the park" answers "it blocks new housing on the park land". Being on the same general topic is not enough.
- A claim often does both: it answers the other side by repeating its own argument. Then give both ids. Use "" only when there is no such claim.

Step 3: sum up each side's main case in one neutral sentence of at most 30 words, starting "The YES side argues" and "The NO side argues".`;

const BACKERS_SYSTEM_PROMPT = `You list who stands with each side of a California ballot measure. ${SHARED_RULES}

For each side, list every person, group, kind of person and organization that the side's own documents name as being on its side: for the YES side, those it says support the measure; for the NO side, those it says oppose it.
- Include every name in a list of endorsements.
- When one sentence names several kinds of people as being on its side (for example, "nurses, teachers and firefighters support it"), list each kind separately.
- Leave out people a side only says the measure would help or hurt; anyone a side says is behind the other side (its authors, funders or backers); and studies, experts or agencies a side only cites without saying they are on its side.
- List each backer once per side.
For each backer, give a short name, and a quote that names it: one continuous passage of at most 15 words, copied word for word from that side's documents. For a name in a list, the name alone, exactly as printed, is enough. Never join words from different places into one quote.`;

const claimProperties = (doc) => ({
  id: { type: 'string', description: `${doc.prefix}1, ${doc.prefix}2 and so on.` },
  quote: { type: 'string', description: 'One continuous passage copied word for word from this document, at most 30 words.' },
  restated: { type: 'string', description: 'The claim in plain, neutral words, at most 25 words, keeping its numbers, qualifiers and certainty.' },
  stated_as: { type: 'string', enum: Object.keys(STATED_AS) },
  dimension: { type: 'string', enum: DIMENSIONS.map((d) => d.id) },
});

// Rebuttal claims link to argument claims. The field names say which document each link points
// into (answers_YA, repeats_NA): with plain "replies_to" the model often put its own side's ids there.
const LINK_FIELDS = { YR: { answers: 'answers_NA', repeats: 'repeats_YA' }, NR: { answers: 'answers_YA', repeats: 'repeats_NA' } };

// No maxItems here: the cap lives in the prompt. Google rejects these lists with a length limit
// ("The specified schema produces a constraint that has too many states for serving").
const claimListSchema = (doc) => {
  const link = LINK_FIELDS[doc.prefix];
  const properties = link ? {
    ...claimProperties(doc),
    [link.answers]: { type: 'string', description: `The id of the ${link.answers.slice(-2)} claim this claim answers, or "" if it answers none.` },
    [link.repeats]: { type: 'string', description: `The id of the ${link.repeats.slice(-2)} claim that makes the same assertion, or "" if none does.` },
  } : claimProperties(doc);
  return {
    type: 'array',
    description: `Every claim in the document with id "${doc.prefix}", in order.`,
    items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
};

// The model writes properties in the order declared here: the arguments' claims come before the
// rebuttals', so every id a rebuttal claim points to is already written when it gets there.
const COMPARE_SCHEMA = {
  name: 'two_sides',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      ...Object.fromEntries(COMPARE_DOCS.map((d) => [d.field, claimListSchema(d)])),
      summary: {
        type: 'object',
        properties: {
          yes: { type: 'string', description: 'One neutral sentence starting "The YES side argues".' },
          no: { type: 'string', description: 'One neutral sentence starting "The NO side argues".' },
        },
        required: ['yes', 'no'],
        additionalProperties: false,
      },
    },
    required: [...COMPARE_DOCS.map((d) => d.field), 'summary'],
    additionalProperties: false,
  },
};

const backerList = (description) => ({
  type: 'array',
  maxItems: 25,
  description,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short name, such as "teachers" or "California Nurses Association".' },
      quote: { type: 'string', description: 'Words that name it, copied word for word from this side’s documents, at most 15 words.' },
    },
    required: ['name', 'quote'],
    additionalProperties: false,
  },
});

const BACKERS_SCHEMA = {
  name: 'backers',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      yes: backerList('Who the YES side says supports the measure.'),
      no: backerList('Who the NO side says opposes the measure.'),
    },
    required: ['yes', 'no'],
    additionalProperties: false,
  },
};

/** The four documents, as both calls get them. Only what the guide prints: no legal text, no official summary. */
function documentsMessage(measure, disclaimer, task) {
  const docs = COMPARE_DOCS.map(({ key, prefix, name }) => {
    const a = measure.arguments[key];
    const answers = a.respondsTo ? ` answers="the ${measure.arguments[a.respondsTo].side.toUpperCase()} side's argument"` : '';
    return `<document id="${prefix}" side="${a.side.toUpperCase()}" round="${a.round === 'argument' ? 1 : 2}" name="${name}"${answers}>
${a.text}
</document>`;
  });
  return `Here are the four documents that the Official Voter Information Guide prints for ${measure.label}, a measure on the California ballot for November 3, 2026.${disclaimer ? ` The guide prints this notice with them: "${disclaimer}"` : ''}

${docs.join('\n\n')}

Task: ${task}`;
}

function buildCompareMessages(measure, disclaimer) {
  return [
    { role: 'system', content: COMPARE_SYSTEM_PROMPT },
    { role: 'user', content: documentsMessage(measure, disclaimer, `compare the two sides of ${measure.label}. List each document's claims, link each rebuttal claim to what it answers and repeats, then sum up each side, following all the rules.`) },
  ];
}

function buildBackersMessages(measure, disclaimer) {
  return [
    { role: 'system', content: BACKERS_SYSTEM_PROMPT },
    { role: 'user', content: documentsMessage(measure, disclaimer, `list who stands with each side of ${measure.label}, following all the rules.`) },
  ];
}

// ---- Where is each quote, really? (no AI) ------------------------------------------------

/**
 * Lower-case words only: punctuation, dashes, curly quotes and capitals never decide a match, and
 * neither does "Proposition 43" against "Prop. 43" (the model shortens the shouted headlines).
 */
function quoteWords(text) {
  return (text || '').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}$%]+/gu, ' ')
    .replace(/\bproposition\b/g, 'prop').trim();
}

const docWords = new Map(); // "measure id|document key" → its words

function wordsOf(measure, key) {
  const id = `${measure.id}|${key}`;
  if (!docWords.has(id)) docWords.set(id, ` ${quoteWords(measure.arguments[key].text)} `);
  return docWords.get(id);
}

/**
 * Which documents a quote is in. 'exact' = every word, in order; 'partial' = a run of at least
 * 8 words (or 60% of a shorter quote) is; 'missing' = neither. Several keys when the words repeat.
 */
function locateQuote(measure, quote) {
  const q = quoteWords(quote);
  if (!q) return { found: 'none', keys: [] };
  const keys = COMPARE_DOCS.map((d) => d.key);
  const exact = keys.filter((k) => wordsOf(measure, k).includes(` ${q} `));
  if (exact.length) return { found: 'exact', keys: exact };
  const words = q.split(' ');
  const need = Math.min(8, Math.ceil(words.length * 0.6));
  let best = { run: 0, keys: [] };
  for (const k of keys) {
    const doc = wordsOf(measure, k);
    let run = 0;
    for (let i = 0; i < words.length && words.length - i > run; i++) {
      let j = i + run + 1;
      while (j <= words.length && doc.includes(` ${words.slice(i, j).join(' ')} `)) { run = j - i; j++; }
    }
    if (run > best.run) best = { run, keys: [k] };
    else if (run === best.run && run) best.keys.push(k);
  }
  return best.run >= need ? { found: 'partial', keys: best.keys } : { found: 'missing', keys: [] };
}

// ---- Words the model added or dropped (no AI, a flag for a person to look at) --------------

const JUDGMENT_WORDS = /\b(true|untrue|false|falsely|lies?|lying|misleading|misled|accurate|inaccurate|correct(?:ly)?|incorrect|wrong(?:ly)?|myths?|debunk\w*|actually|in fact|baseless|unfounded|without evidence|exaggerat\w*)\b/gi;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/**
 * Numbers in the text, ignoring the measure's own number ("Prop. 40") and list numbering ("1.").
 * "fourteen states" counts as 14; "one-time" and "two-thirds" are left as words.
 */
function numbersIn(text, measure) {
  const digits = (text || '').replace(/^\s*\d+\.\s/, '').replace(/,(?=\d{3})/g, '')
    .replace(/(?<![-\w])(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?![-\w])/gi,
      (w) => String(NUMBER_WORDS.indexOf(w.toLowerCase())));
  return [...new Set((digits.match(/\d+(?:\.\d+)?/g) || []).filter((n) => n !== String(measure.number)))];
}

function claimFlags(measure, claim) {
  const flags = [];
  const inQuote = numbersIn(claim.quote, measure);
  const inRestated = numbersIn(claim.restated, measure);
  const dropped = inQuote.filter((n) => !inRestated.includes(n));
  const added = inRestated.filter((n) => !inQuote.includes(n));
  if (dropped.length) flags.push({ kind: 'dropped-number', text: `The AI wording leaves out ${dropped.join(', ')} from the quote.` });
  if (added.length) flags.push({ kind: 'added-number', text: `The AI wording has ${added.join(', ')}, which is not in the quote.` });
  if (/one[- ]time/i.test(claim.quote) && !/one[- ]time/i.test(claim.restated)) {
    flags.push({ kind: 'dropped-qualifier', text: 'The quote says "one-time"; the AI wording does not.' });
  }
  const judged = (claim.restated.match(JUDGMENT_WORDS) || []).filter((w) => !new RegExp(`\\b${w}\\b`, 'i').test(claim.quote));
  if (judged.length) flags.push({ kind: 'added-judgment', text: `The AI wording adds "${judged.join('", "')}", which the side did not say.` });
  return flags;
}

// ---- Claims, links, and the debate's structure (no AI) --------------------------------------

// What each status means, for the guide. "The other side" is the guide's to fill in with YES or NO.
const CLAIM_STATUS = {
  answered: 'Answered in the other side’s rebuttal.',
  unanswered: 'Not answered: the other side’s rebuttal does not address this.',
  reply: 'A reply to the other side’s argument.',
  repeat: 'Repeats a point from this side’s own argument.',
  new: 'New in a rebuttal: raised for the first time here, so the other side never gets to respond.',
};

// Words that say nothing about which claim a rebuttal claim goes back to.
const FILLER_STEMS = new Set(['prop', 'that', 'this', 'with', 'from', 'will', 'would', 'they', 'their', 'them', 'your',
  'have', 'been', 'were', 'what', 'when', 'than', 'then', 'into', 'more', 'only', 'also', 'just', 'even', 'every',
  'there', 'these', 'those', 'which', 'about', 'becaus', 'califo', 'doesnt', 'dont', 'wont', 'isnt']);

function claimStems(text, measure) {
  return [...new Set(quoteWords(text).split(' ').filter((w) => w.length >= 4 && w !== String(measure.number))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w).slice(0, 6))
    .filter((st) => !FILLER_STEMS.has(st)))];
}

/** Share of a quote's telling words that also appear in one document. */
function wordOverlap(measure, quote, key) {
  const stems = claimStems(quote, measure);
  if (!stems.length) return 0;
  const doc = new Set(claimStems(measure.arguments[key].text, measure));
  return stems.filter((st) => doc.has(st)).length / stems.length;
}

// "New in a rebuttal" says the other side never got to answer, so the model's word is not enough:
// a rebuttal claim the model left unlinked that shares at least this share of its telling words
// with an argument is shown as going back to that argument (statusBy: 'words'). A safety net, not a
// judge: in testing the false "new" claims shared 75–92% of their words with their own argument,
// most claims that really were new shared under 60%, but one short claim made of the measure's most
// common words ("bans public funding of campaigns") reached 80%.
const NEW_OVERLAP_LIMIT = 0.7;

const otherSide = (side) => (side === 'yes' ? 'no' : 'yes');

/**
 * Every claim the model listed, placed where its quote really is. The list it was in says which
 * document the model meant; when the words are somewhere else, the words win and we note the move.
 */
function readClaims(measure, json) {
  const claims = [];
  const ids = new Set();
  for (const d of COMPARE_DOCS) {
    for (const c of json[d.field] || []) {
      const where = locateQuote(measure, c.quote);
      const key = where.keys.includes(d.key) ? d.key : where.keys[0] || d.key;
      const doc = measure.arguments[key];
      // Links point at ids, so a repeated id would be ambiguous: the first one keeps it.
      let id = c.id || `${d.prefix}?`;
      while (ids.has(id)) id += '′';
      ids.add(id);
      const link = LINK_FIELDS[d.prefix];
      claims.push({
        ...c, id, key, side: doc.side, round: doc.round, quoteFound: where.found,
        replies_to: link ? c[link.answers] : '', repeats: link ? c[link.repeats] : '',
        movedFrom: key !== d.key ? d.key : null, flags: claimFlags(measure, c),
      });
    }
  }
  return claims;
}

/**
 * Check each rebuttal claim's links, then give every claim its status. A link only counts when it
 * points the way the guide's rounds allow: a reply to the other side's argument, a repeat of its own.
 * Links are kept as ids (repliesTo, repeatsId, answeredBy), so a result can be saved as JSON.
 */
function linkClaims(measure, claims) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const argumentKey = (side) => Object.keys(measure.arguments).find((k) => measure.arguments[k].side === side && measure.arguments[k].round === 'argument');
  const badLinks = [];
  const target = (c, id, side) => {
    if (!id) return null;
    const t = byId.get(id);
    if (t && t.round === 'argument' && t.side === side) return t.id;
    badLinks.push({ from: c.id, to: id });
    return null;
  };
  for (const c of claims) {
    c.repliesTo = c.round === 'rebuttal' ? target(c, c.replies_to, otherSide(c.side)) : null;
    c.repeatsId = c.round === 'rebuttal' ? target(c, c.repeats, c.side) : null;
  }
  for (const c of claims) {
    c.answeredBy = claims.filter((r) => r.repliesTo === c.id).map((r) => r.id);
    c.status = c.round === 'argument' ? (c.answeredBy.length ? 'answered' : 'unanswered')
      : c.repliesTo ? 'reply' : c.repeatsId ? 'repeat' : 'new';
    c.statusBy = 'model';
    if (c.status === 'new') {
      const own = wordOverlap(measure, c.quote, argumentKey(c.side));
      const other = wordOverlap(measure, c.quote, argumentKey(otherSide(c.side)));
      if (Math.max(own, other) >= NEW_OVERLAP_LIMIT) Object.assign(c, { status: other > own ? 'reply' : 'repeat', statusBy: 'words' });
    }
    // A reply is shown with the claim it answers, so an exchange never splits across two dimensions.
    c.shownUnder = c.repliesTo ? byId.get(c.repliesTo).dimension : c.dimension;
  }
  return badLinks;
}

// ---- Backers, and the groups both sides claim (no AI) ----------------------------------------

// Words too common in group names to show that two sides claim the same group.
const GENERIC_STEMS = new Set(['califo', 'associ', 'counci', 'coalit', 'nation', 'americ', 'united', 'allian', 'federa',
  'organi', 'leader', 'member', 'group', 'people', 'state', 'local', 'commun', 'advoca', 'profes', 'former', 'actual',
  'univer', 'the', 'and', 'for', 'with', 'our', 'all']);

/** Telling words of a name, cut to stems: "Teachers" → teache, "unions" → union, "Coalition for Clean Air" → clean, air. */
function nameStems(name) {
  return [...new Set(quoteWords(name).split(' ').filter((w) => w.length >= 3)
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w).slice(0, 6))
    .filter((st) => !GENERIC_STEMS.has(st)))];
}

/**
 * Two backers are the same group when they share two telling words ("Planned Parenthood workers",
 * "Planned Parenthood Affiliates of California"), or one when either name is just that one word
 * ("teachers", "California Teachers Association"). One shared word between two longer names is not
 * enough: "American Clean Power" and "Clean Water Action" are not the same group.
 */
function sameGroup(a, b) {
  const shared = a.stems.filter((st) => b.stems.includes(st));
  return shared.length >= 2 || (shared.length === 1 && (a.stems.length === 1 || b.stems.length === 1));
}

/**
 * Who each side says stands with it, each checked: the quote must be word for word on that side and
 * must name the backer. In testing the model wrote "actual doctors, ..." where the guide says "actual
 * teachers, ...", so an unchecked quote could invent a backer.
 */
function readBackers(measure, json) {
  const lists = {};
  for (const side of ['yes', 'no']) {
    lists[side] = (json[side] || []).map((b) => {
      const where = locateQuote(measure, b.quote);
      const key = where.found === 'exact' ? where.keys.find((k) => measure.arguments[k].side === side) || null : null;
      const stems = nameStems(b.name);
      const names = nameStems(b.quote).some((st) => stems.includes(st));
      return { ...b, key, quoteFound: where.found, stems, verified: Boolean(key && names) };
    });
  }
  const shared = [];
  for (const y of lists.yes.filter((b) => b.verified)) {
    for (const n of lists.no.filter((b) => b.verified)) {
      if (!sameGroup(y, n)) continue;
      const group = shared.find((g) => g.yes.includes(y) || g.no.includes(n));
      if (!group) shared.push({ yes: [y], no: [n] });
      else {
        if (!group.yes.includes(y)) group.yes.push(y);
        if (!group.no.includes(n)) group.no.push(n);
      }
    }
  }
  return { yes: lists.yes, no: lists.no, shared };
}

// ---- Signers: straight from the pack, no AI -------------------------------------------------

/** "California Taxpayers Association (CalTax)" and "California Taxpayers Association" match. */
function signerOrgKey(name) {
  return name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Who signed each side, and any organization or person that signs for both. */
function signersBySide(measure) {
  const sides = { yes: [], no: [] };
  for (const { key, name } of COMPARE_DOCS) {
    const a = measure.arguments[key];
    for (const s of a.signers) sides[a.side].push({ ...s, key, document: name });
  }
  const orgs = (side) => new Map(sides[side].filter((s) => s.organization).map((s) => [signerOrgKey(s.organization), s.organization]));
  const yesOrgs = orgs('yes');
  const noOrgs = orgs('no');
  const noNames = new Set(sides.no.map((s) => s.name));
  return {
    ...sides,
    bothOrgs: [...yesOrgs.keys()].filter((k) => noOrgs.has(k)).map((k) => ({ yes: yesOrgs.get(k), no: noOrgs.get(k) })),
    bothPeople: [...new Set(sides.yes.map((s) => s.name))].filter((n) => noNames.has(n)),
  };
}

// ---- The whole pipeline -----------------------------------------------------------------

function readJsonReply(data, what) {
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error(data.choices?.[0]?.finish_reason === 'length'
      ? `The ${what} call hit its length cap and was cut off.`
      : `The ${what} call did not return valid JSON.`);
  }
}

/**
 * Two calls at once (claims, backers), then our code places every quote, checks every link and
 * works out who answered what. send(messages, { model, maxTokens, temperature, responseFormat })
 * must return OpenRouter's JSON reply: the guide passes chat() from js/openrouter.js, the test script
 * its own fetch. If only the backers call fails, the comparison still comes back, with backersError.
 */
async function compareSides(measure, send, { model = COMPARE_MODEL, backersModel = BACKERS_MODEL, disclaimer = '' } = {}) {
  const options = (schema, m) => ({
    model: m, temperature: COMPARE_TEMPERATURE, maxTokens: COMPARE_MAX_TOKENS,
    responseFormat: { type: 'json_schema', json_schema: schema },
  });
  const messages = buildCompareMessages(measure, disclaimer);
  const backerMessages = buildBackersMessages(measure, disclaimer);
  const started = Date.now();
  const [main, side] = await Promise.allSettled([
    send(messages, options(COMPARE_SCHEMA, model)),
    send(backerMessages, options(BACKERS_SCHEMA, backersModel)),
  ]);
  const ms = Date.now() - started;
  if (main.status === 'rejected') throw main.reason;
  const data = main.value;
  const json = readJsonReply(data, 'comparison');
  const claims = readClaims(measure, json);
  const badLinks = linkClaims(measure, claims);
  let backers = null;
  let backersError = null;
  try {
    if (side.status === 'rejected') throw side.reason;
    backers = readBackers(measure, readJsonReply(side.value, 'backers'));
  } catch (err) {
    backersError = err.message;
  }
  // Side by side, one row per dimension. An empty side or row stays in, so the guide can say so,
  // in words that match what it knows: raisedBy 'neither' means the model sorted no claim here, not
  // that neither side mentions it (one run filed "no accountability or oversight" under rules).
  const dimensions = DIMENSIONS.map((d) => {
    const yes = claims.filter((c) => c.shownUnder === d.id && c.side === 'yes');
    const no = claims.filter((c) => c.shownUnder === d.id && c.side === 'no');
    return { ...d, yes, no, raisedBy: yes.length && no.length ? 'both' : yes.length ? 'yes' : no.length ? 'no' : 'neither' };
  });
  const calls = [data, side.status === 'fulfilled' ? side.value : null].filter(Boolean);
  return {
    claims, dimensions, backers, backersError, badLinks,
    summary: json.summary || { yes: '', no: '' },
    signers: signersBySide(measure),
    counts: {
      claims: claims.length,
      perDocument: Object.fromEntries(COMPARE_DOCS.map((d) => [d.key, claims.filter((c) => c.key === d.key).length])),
      dimensionsBoth: dimensions.filter((d) => d.raisedBy === 'both').length,
      status: Object.fromEntries(Object.keys(CLAIM_STATUS).map((s) => [s, claims.filter((c) => c.status === s).length])),
      quotes: Object.fromEntries(['exact', 'partial', 'missing', 'none'].map((f) => [f, claims.filter((c) => c.quoteFound === f).length])),
      moved: claims.filter((c) => c.movedFrom).length,
      flagged: claims.filter((c) => c.flags.length).length,
      badLinks: badLinks.length,
      backers: backers ? { yes: backers.yes.length, no: backers.no.length } : { yes: 0, no: 0 },
      backersVerified: backers ? backers.yes.concat(backers.no).filter((b) => b.verified).length : 0,
      sharedGroups: backers ? backers.shared.length : 0,
    },
    messages: { claims: messages, backers: backerMessages },
    calls, ms, cost: calls.reduce((n, d) => n + (d.usage?.cost ?? 0), 0),
    finish: data.choices?.[0]?.finish_reason, models: { claims: model, backers: backersModel },
  };
}
