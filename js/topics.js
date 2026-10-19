// Voter topics of concern, part 1: a rough first signal of which topics a measure touches.
// No AI: we count topic keywords in the measure's legal text. A high count is a hint to look
// closer, not proof of impact. Loaded by guide.html and by tools/topics-report.mjs.

// Each topic lists exact word forms (whole words, any case) and a few two-word phrases.
// A phrase is matched before its parts, so "health care" counts once, not as "health" + "care".
// Left out after reading the matches in context: "appropriate" (mostly the adjective, "culturally
// appropriate"), "contribution" (charitable contributions in Prop 40), "voting" ("voting control
// rights" of a business). Kept despite some noise: "election" (Prop 40 uses it for a taxpayer's choice).
const TOPICS = [
  {
    id: 'taxes', label: 'My Taxes', covers: 'Taxes and spending, such as how public money is spent',
    words: 'tax taxes taxed taxing taxation taxable taxpayer taxpayers excise levy levies revenue revenues '
      + 'fund funds funding funded budget budgets appropriated appropriation appropriations moneys',
    phrases: ['general fund', 'public funds', 'public money', 'public moneys', 'special fund'],
  },
  {
    id: 'home', label: 'My Home', covers: 'Rent and housing costs, renting and owning',
    words: 'housing home homes homeowner homeowners homeownership mortgage mortgages rent rents rental rentals renter renters '
      + 'tenant tenants landlord landlords residential apartment apartments dwelling dwellings eviction evictions homeless homelessness',
    phrases: ['real property', 'property tax', 'property taxes', 'affordable housing'],
  },
  {
    id: 'health', label: 'My Health and Schools', covers: 'Your health, and help for families and schools',
    words: 'health healthcare medical medi-cal medicare hospital hospitals clinic clinics patient patients physician physicians '
      + 'doctor doctors nurse nurses school schools education educational student students teacher teachers college colleges '
      + 'university universities child children families family food nutrition calfresh snap meal meals',
    phrases: ['health care', 'public health', 'child care', 'mental health'],
  },
  {
    id: 'neighborhood', label: 'My Neighborhood', covers: 'Local services and the environment, including water and roads',
    words: 'water wastewater sewer sewers road roads street streets highway highways bridge bridges transit transportation traffic '
      + 'park parks environment environmental pollution climate wildfire wildfires fire fires firefighter firefighters police '
      + 'library libraries infrastructure broadband electricity energy utility utilities',
    phrases: ['drinking water', 'public safety', 'open space', 'air quality', 'clean energy', 'local services'],
  },
  {
    id: 'vote', label: 'My Vote and My Say', covers: 'Elections and your vote',
    words: 'vote votes voter voters voted electorate election elections elective elected ballot ballots '
      + 'candidate candidates campaign campaigns initiative initiatives referendum',
    phrases: [],
  },
];

// Sections every initiative carries that talk about ballots and votes without being about your vote.
const PROCEDURAL_SECTION = /^(?:Conflicts?|Conflicting Measures|Liberal Construction|Legal Defense|Proponent Standing|Severability|Effective Date)\b/i;

/**
 * The text we count: the proposed law itself, with the [NEW: ...]/[DELETED: ...] marks removed
 * (keepMarks leaves them in, for checking where a quote comes from).
 * Deleted words stay in: what a measure takes away is part of what it changes.
 * Left out: the guide's standard opening paragraph and the procedural sections above.
 */
function countableText(measure, keepMarks = false) {
  const source = keepMarks ? measure.fullTextMarked : measure.fullTextMarked.replace(/\[(?:NEW|DELETED): /g, '').replace(/\]/g, '');
  const start = source.search(/^PROPOSED (?:LAW|AMENDMENT)/m);
  const body = start >= 0 ? source.slice(start) : source;
  // Split at section starts ("SEC. 8. Conflicts. ..."), drop the procedural ones.
  const parts = body.split(/(?=(?:^|\n\n)(?:SECTION|SEC\.) \d+(?:\.\d+)?\.\s)/);
  const skipped = [];
  const kept = parts.filter((part) => {
    const title = part.replace(/^\s*(?:SECTION|SEC\.) \d+(?:\.\d+)?\.\s+/, '');
    if (/^\s*(?:SECTION|SEC\.)/.test(part) && PROCEDURAL_SECTION.test(title)) {
      skipped.push(part.trim().match(/^(?:SECTION|SEC\.) \d+(?:\.\d+)?\.\s+[^.]+/)[0]);
      return false;
    }
    return true;
  });
  const text = kept.join('');
  return { text, words: (text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length, skipped };
}

function topicRegex(topic) {
  const terms = [...topic.phrases, ...topic.words.split(/\s+/)]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return new RegExp(`\\b(?:${terms.join('|')})\\b`, 'gi');
}

/** Rough strength from mentions per 1,000 words of the counted text. */
function topicStrength(per1000) {
  if (per1000 === 0) return { id: 'none', label: 'Not mentioned' };
  if (per1000 < 2) return { id: 'low', label: 'Mentioned' };
  if (per1000 < 8) return { id: 'some', label: 'Some focus' };
  return { id: 'high', label: 'Strong focus' };
}

/**
 * Count each topic in one measure.
 * @returns {{words:number, skipped:string[], topics: Array<{id, label, covers, count, per1000, strength, top: Array<[string, number]>}>}}
 */
function countTopics(measure) {
  const { text, words, skipped } = countableText(measure);
  const topics = TOPICS.map((topic) => {
    const hits = new Map();
    for (const m of text.matchAll(topicRegex(topic))) {
      const term = m[0].toLowerCase().replace(/\s+/g, ' ');
      hits.set(term, (hits.get(term) || 0) + 1);
    }
    const count = [...hits.values()].reduce((a, b) => a + b, 0);
    const per1000 = Math.round((1000 * count / words) * 10) / 10;
    return {
      id: topic.id, label: topic.label, covers: topic.covers, count, per1000, strength: topicStrength(per1000),
      top: [...hits.entries()].sort((a, b) => b[1] - a[1]),
    };
  });
  return { words, skipped, topics };
}

// ---- Part 2: what the measure means for one topic (one model call) --------------------
//
// The voter picks a topic; the model reads the legal text and returns what the text says about
// that topic (each point with a quote from the legal text) and, separately, its own opinion.
// Our code then looks for every quote in the legal text (verifyQuote in js/checker.js), and the
// page labels the opinion as an AI opinion every time. The official summary is never sent.

const TOPIC_MODEL = 'google/gemini-2.5-flash-lite';
const TOPIC_PROMPT_VERSION = 't3';

const TOPIC_SYSTEM_PROMPT = `You explain what one California ballot measure means for one topic a voter cares about, using only the measure's legal text. You are neutral about politics.

Reply in JSON with three parts:
1. "facts": at most 3 things the legal text says about this topic itself, most important first. Each has a "quote" (one continuous passage copied from the legal text, word for word, at most 40 words: no section headings, no joining of separate passages, nothing added before or after) and a "summary" (one or two sentences, at the reading level you are given). Keep the qualifiers that change the meaning: one-time, only, unless, except, amounts and dates. The measure's findings and purpose sections are its authors' claims, so write "the measure says" for them. Do not stretch: if you would have to explain why a fact matters for this topic, it is not about this topic. A word appearing once in a list is not an effect. If the legal text says nothing about this topic, give no facts.
2. "opinion": your own view, in at most 80 words, of whether this measure looks good, bad or mixed for a voter who cares about this topic, and why. Base it only on the facts above, name the trade-off where there is one, and never tell the voter how to vote. If the text says nothing about the topic, say the measure does not seem to affect it.
3. "relevance":
   - "direct": the measure's own rules change something a voter would notice in this topic (who pays a tax, rent or housing rules, money for health care or schools, local services, how elections or voting work).
   - "indirect": the topic appears only in the findings or purpose, in a list, or the measure changes money or rules that could later affect it.
   - "none": the text says nothing about it.
   Decide this last, from your own facts: if none of your facts is one of the measure's rules that changes this topic, it is not "direct", and if you have no facts, it is "none".
   Never use the standard opening paragraph ("This initiative measure is submitted to the people…"), the line "The people of California do enact as follows", or a section about conflicting measures on the same ballot as facts about elections: every initiative has them. Findings and purpose alone never make a topic "direct".

Text inside [DELETED: ...] is current law that the measure removes; text inside [NEW: ...] is added by the measure.`;

// Gemini writes properties in alphabetical order: facts (quote, then summary), then opinion,
// then relevance. So the evidence is written before the opinion, and the quote before the summary.
const TOPIC_SCHEMA = {
  name: 'topic_explanation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      facts: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            quote: { type: 'string', description: 'Exact words from the legal text, at most 40 words.' },
            summary: { type: 'string', description: 'What it means for the topic, at the reading level asked.' },
          },
          required: ['quote', 'summary'],
          additionalProperties: false,
        },
      },
      opinion: { type: 'string', description: 'Your own view, at most 80 words.' },
      relevance: { type: 'string', enum: ['direct', 'indirect', 'none'] },
    },
    required: ['facts', 'opinion', 'relevance'],
    additionalProperties: false,
  },
};

function buildTopicMessages(measure, topicId, levelLabel) {
  const topic = TOPICS.find((t) => t.id === topicId);
  const counted = countTopics(measure).topics.find((t) => t.id === topicId);
  const words = counted.count
    ? `Our keyword count found ${counted.count} topic word${counted.count === 1 ? '' : 's'} in the text (${counted.top.slice(0, 8).map(([w, n]) => `${w} ×${n}`).join(', ')}). That is only a rough signal; read the text itself.`
    : 'Our keyword count found no topic words in the text. That is only a rough signal; read the text itself.';
  return [
    { role: 'system', content: TOPIC_SYSTEM_PROMPT },
    { role: 'user', content: `Here is the full legal text of ${measure.label}, a measure on the California ballot for November 3, 2026.

<legal_text>
${measure.fullTextMarked}
</legal_text>

Topic: "${topic.label}" (${topic.covers}).
${words}

Explain what ${measure.label} means for this topic. Write the summaries at the ${levelLabel} reading level.` },
  ];
}

/**
 * Where a fact's quote comes from. 'rules' = the measure itself; 'standard' = only the opening
 * paragraph or a procedural section every initiative has (the parts the keyword count leaves out);
 * 'unverified' = the quote is not in the legal text word for word.
 */
function quoteSource(measure, fact) {
  if (fact.quoteFound !== 'exact' && fact.quoteFound !== 'partial') return 'unverified';
  const counted = countableText(measure, true).text;
  const q = normalizeForQuote(fact.quote).replace(/^the measure says:?\s*/, '').replace(/^["']|["']$/g, '').trim();
  const inRules = [counted, counted.replace(/\[DELETED: [^\]]*\]/g, ' ')]
    .some((t) => findPieces(q, normalizeForQuote(t)) !== 'missing');
  return inRules ? 'rules' : 'standard';
}

/**
 * The relevance we show. In testing the model called a tax measure "direct" for elections on the
 * strength of the opening paragraph and the conflicting-measures section, even when told not to.
 * So a "direct" or "indirect" reading needs at least one fact quoted, word for word, from the measure's
 * own rules; otherwise we show "none" and say why.
 */
function settleRelevance(measure, result) {
  for (const f of result.facts) f.source = quoteSource(measure, f);
  const supported = result.facts.some((f) => f.source === 'rules');
  if (result.relevance !== 'none' && !supported) {
    return { relevance: 'none', note: `The AI said "${result.relevance}", but none of its points quotes the measure's own rules word for word, so we show "none".` };
  }
  return { relevance: result.relevance, note: null };
}

/**
 * One topic explanation. send(messages, options) must return OpenRouter's JSON reply.
 * @returns {{relevance, facts: Array<{summary, quote, quoteFound}>, opinion, opinionWords, cost, ms, messages}}
 */
async function explainTopic(measure, topicId, levelLabel, send, { model = TOPIC_MODEL } = {}) {
  const started = Date.now();
  const messages = buildTopicMessages(measure, topicId, levelLabel);
  const data = await send(messages, {
    model, temperature: 0.3, maxTokens: 1500, responseFormat: { type: 'json_schema', json_schema: TOPIC_SCHEMA },
  });
  let parsed;
  try {
    parsed = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('The model did not return valid JSON for this topic.');
  }
  const facts = (parsed.facts || []).slice(0, 3).map((f) => ({ ...f, quoteFound: verifyQuote(measure, f.quote) }));
  const settled = settleRelevance(measure, { relevance: parsed.relevance, facts });
  return {
    aiRelevance: parsed.relevance, relevance: settled.relevance, relevanceNote: settled.note, facts, opinion: (parsed.opinion || '').trim(),
    opinionWords: (parsed.opinion || '').trim().split(/\s+/).filter(Boolean).length,
    cost: data.usage?.cost ?? 0, ms: Date.now() - started, messages, data,
  };
}
