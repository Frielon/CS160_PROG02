// Functionality 3: explain a down-ballot office, and illustrate something it decides.
//
// The model only ever sees what data/datapack.json says about the offices: this office's facts,
// numbered so every line it writes cites one, and any office on the ballot a voter could mix it up
// with, so it can say what belongs to that office ("BART's board, not AC Transit's, sets BART fares").
// What an office does NOT decide is the half a model invents if we let it ("that's the City
// Council"), so the prompt allows only three kinds of limit, and our code (no AI) checks the reply:
// every limit the pack states is there, every citation is real, and no name or number appears that
// the model was not given.
//
// In testing (o1), shown all four other offices, the model listed every one of them as something
// this office does not decide ("the Rent Board does not set water rates"): true, and useless. Now it
// only sees the neighbors we chose, and an office with none has to find its limits in its own words.
//
// The illustration: we wrote a menu of scenes for each office, each tied to words in the pack. Our code
// offers two at random, Flash-Lite picks the one that fits, and our code builds the image prompt from
// it, so the page can say which scene it drew and which fact it shows. The image model never chooses.
// Loaded by tools/eval-office.mjs and tools/test-office.mjs, and by the guide (guide.html, Offices tab).
// Needs js/fk.js.

const OFFICE_PROMPT_VERSION = 'o7';
const OFFICE_MODEL = 'google/gemini-2.5-flash-lite';
const OFFICE_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const OFFICE_TEMPERATURE = 0.3; // same as the measure renderings
const OFFICE_MAX_TOKENS = 1500;
// Picking a scene is a choice, not writing, so a high temperature. Even so, offered the whole
// shuffled menu, Flash-Lite picked the most literal scene almost every time (o7: EBMUD "reservoir"
// 10 of 10, Peralta "classroom" 10 of 10). So our code offers two scenes at random and the model
// picks the one that fits best: the sampling gives the variety, the model still makes the choice.
// In 20 fresh picks per office, two at a time showed 5 or 6 different scenes; three at a time, 4 or 5.
const SCENE_PICK_TEMPERATURE = 1;
const SCENE_MENU_SIZE = 2;
const OFFICE_IMAGE_ASPECT = '3:2';

// ---- What we, the designers, decided about each office ---------------------------------
// alias:      how the text names this office (to check that an "other-office" limit names it)
// terms:      words only this office's subject uses; one in another office's "decides" is a leak
// powers:     the decisions the pack's description lists, in its own words; each gets its own item
//             (o4 lumped "bus routes, fares and service levels" into one line and explained none of them)
// neighbors:  offices on the ballot a voter could mix this one up with; the only others the model sees
// boundaries: limits the pack states (kind "boundary"), and the word that shows each was kept
// keyFacts:   things the pack says that an explanation should not drop (a word match, like KEY_FACTS)
// misreadings: mistakes the model made in testing, written from the pack (like KNOWN_MISREADINGS)
// impliedNumbers: numbers the pack implies without writing them, so the number check lets them through
// setting:    where the pictures take place
// avoid:      what must never be in this office's pictures
// scenes:     the menu Flash-Lite picks from; `shows` is the words in the pack that the scene shows

const OFFICE_DESIGN = {
  'berkeley-rent-board': {
    alias: /Rent (?:Stabilization )?Board/i,
    terms: /\b(?:rents?|rental|renters?|evict\w*|tenants?|landlords?)\b/i,
    powers: ['rent ceilings', 'eviction protections', 'registration fees'],
    neighbors: [],
    boundaries: [],
    keyFacts: [
      { fact: 'it sets rent ceilings', pattern: /ceiling|highest rent|maximum|rent limit|limits? (?:on|for) (?:how much )?rent|\bcap\b/i },
      { fact: 'it sets eviction protections', pattern: /evict/i },
      { fact: 'it sets registration fees', pattern: /registration|fee/i },
      { fact: 'it covers most rental units, not all', pattern: /\bmost\b|not all|not every|some (?:rental )?(?:units|homes|apartments)/i },
    ],
    setting: 'Berkeley, California: a residential street of older brown-shingle houses and small two- and three-story apartment buildings, street trees, bicycles, the East Bay hills in the distance.',
    avoid: '',
    scenes: [
      { id: 'lease', label: 'Renters reading a lease', shows: 'Rent ceilings',
        prompt: 'Two roommates sit at a small kitchen table in a sunny Berkeley apartment, reading over a lease together before they sign it.' },
      { id: 'apartment-tour', label: 'Touring an apartment for rent', shows: 'rental units',
        prompt: 'A young couple tours an empty, sunlit apartment in an older Berkeley building, looking out a bay window while the landlord waits by the door.' },
      { id: 'moving-in', label: 'Moving into a rental', shows: 'rental units',
        prompt: 'A family carries boxes and a couch up the front steps of a brown-shingle house that has been divided into apartments.' },
      { id: 'landlord-talk', label: 'A tenant and landlord talking', shows: 'eviction protections',
        prompt: 'A tenant and a landlord talk on the front steps of a small apartment building, the tenant holding a folded letter.' },
      { id: 'rent-day', label: 'Paying the rent', shows: 'Rent ceilings',
        prompt: 'A renter drops an envelope into the landlord\'s mailbox in the front hall of a small apartment building.' },
      { id: 'landlord-paperwork', label: 'A landlord paying the fees', shows: 'registration fees',
        prompt: 'A small landlord sits at a dining table with a laptop and a folder of papers, doing the paperwork and paying the fees for the apartments they rent out.' },
      { id: 'rental-street', label: 'A street of rentals', shows: 'most rental units in Berkeley',
        prompt: 'A tree-lined Berkeley street of older apartment buildings and houses split into flats, bikes locked out front, neighbors coming and going in the late afternoon.' },
    ],
  },
  'ac-transit-ward-1': {
    alias: /AC Transit/i,
    terms: /\b(?:bus|buses|AC Transit)\b/i,
    powers: ['bus routes', 'fares', 'service levels'],
    neighbors: ['bart-director'],
    boundaries: [{ fact: 'it has nothing to do with BART’s fares', mention: /\bBART\b/ }],
    // o6, all three runs: "apply across the East Bay, not outside of it". The pack only says "across".
    misreadings: [
      { wrong: 'that its decisions stop at the edge of the East Bay',
        right: 'that it decides bus routes, fares and service levels “across the East Bay”; the pack does not say it does nothing outside it',
        pattern: /\b(?:not|never|no|nothing)\b[^.]{0,40}\b(?:outside|beyond|elsewhere)\b|\bonly\b[^.]{0,40}\bEast Bay\b|\bnowhere else\b/i },
    ],
    keyFacts: [
      { fact: 'it decides bus routes', pattern: /route/i },
      { fact: 'it decides fares', pattern: /fare/i },
      { fact: 'it decides service levels', pattern: /service|how often|schedule/i },
      { fact: 'this seat is a short term ending in December 2028', pattern: /2028/ },
    ],
    setting: 'Berkeley and the East Bay, California: a busy street of small shops with awnings, street trees and a bus shelter.',
    avoid: 'Only buses: no trains, rail tracks or train stations.',
    scenes: [
      { id: 'bus-stop', label: 'Riders at a bus stop', shows: 'Bus routes',
        prompt: 'Riders of all ages wait at a bus shelter on a busy Berkeley street as a city bus pulls up to the curb.' },
      { id: 'fare-tap', label: 'Paying the fare', shows: 'fares',
        prompt: 'A rider taps a transit card on the fare reader as they climb aboard a city bus.' },
      { id: 'night-bus', label: 'Waiting for a late bus', shows: 'service levels',
        prompt: 'A late-evening bus stop under a streetlight, a few riders waiting as the lights of an approaching bus appear down the street.' },
      { id: 'on-board', label: 'The morning commute', shows: 'service levels',
        prompt: 'Inside a city bus during the morning commute: students with backpacks, workers and an older rider, seated and standing, the street sliding past the windows.' },
      { id: 'bike-rack', label: 'A bike on the bus', shows: 'Bus routes',
        prompt: 'A cyclist loads a bicycle onto the front rack of a city bus at a stop on a busy Berkeley street.' },
      { id: 'past-campus', label: 'A bus past campus', shows: 'the lines running past campus',
        prompt: 'A city bus rolls along a busy street of small shops at the edge of a college campus, students waiting at the stop.' },
    ],
  },
  'bart-director': {
    alias: /\bBART\b/,
    terms: /\b(?:BART|rail|trains?)\b/i,
    powers: ['capital spending', 'fares', 'service hours', 'policing policy'],
    neighbors: ['ac-transit-ward-1'],
    boundaries: [],
    keyFacts: [
      { fact: 'it decides capital spending', pattern: /capital|construct|build|repair|upgrade|long-term/i },
      { fact: 'it decides fares', pattern: /fare/i },
      { fact: 'it decides service hours', pattern: /hours|how late|when (?:the )?trains run/i },
      { fact: 'it decides policing policy', pattern: /polic/i },
    ],
    setting: 'The San Francisco Bay Area: an elevated regional rail station in the East Bay with the hills in the distance.',
    avoid: 'Only trains: no buses.',
    scenes: [
      { id: 'platform', label: 'Commuters on the platform', shows: 'service hours',
        prompt: 'Commuters wait on an elevated train platform in the morning light as a regional train glides into the station, the East Bay hills behind.' },
      { id: 'fare-gates', label: 'Through the fare gates', shows: 'fares',
        prompt: 'Riders pass through a row of fare gates in a station concourse, one tapping a transit card.' },
      { id: 'track-work', label: 'Track work at night', shows: 'Capital spending',
        prompt: 'At night, a crew in hard hats and safety vests replaces a section of track under work lights on an elevated rail line.' },
      { id: 'escalator-repair', label: 'Fixing a station escalator', shows: 'Capital spending',
        prompt: 'Workers repair a station escalator behind a low barrier while riders take the stairs beside it.' },
      { id: 'last-train', label: 'The last train', shows: 'service hours',
        prompt: 'A nearly empty platform late at night, a few riders boarding the last train of the evening.' },
      { id: 'station-officer', label: 'An officer helping a rider', shows: 'policing policy',
        prompt: 'A uniformed transit officer gives directions to a rider with a suitcase on a busy station platform.' },
      { id: 'in-the-car', label: 'Riding the train', shows: 'the regional rail system',
        prompt: 'Inside a regional train car, riders read, talk and look out the window as the train crosses the East Bay.' },
    ],
  },
  'ebmud-director': {
    alias: /\bEBMUD\b|East Bay Municipal/i,
    terms: /\b(?:water|drought|EBMUD)\b/i,
    powers: ['water rates', 'supply planning', 'drought restrictions'],
    neighbors: [],
    boundaries: [],
    keyFacts: [
      { fact: 'it sets water rates', pattern: /rate|price|how much (?:you|people|customers) pay/i },
      { fact: 'it plans the water supply', pattern: /supply|plan/i },
      { fact: 'it sets drought restrictions', pattern: /drought/i },
      { fact: 'it covers most of the East Bay, not all', pattern: /\bmost\b|not all|not every/i },
    ],
    setting: 'The East Bay hills, California: wood-sided hillside homes among live oaks, dry golden grass in summer, a reservoir in the distance.',
    avoid: '',
    scenes: [
      { id: 'kitchen-tap', label: 'Water at the kitchen tap', shows: 'Water rates',
        prompt: 'A parent fills a pot at the kitchen tap while a child sets the table in a sunny East Bay kitchen.' },
      { id: 'water-meter', label: 'Reading the water meter', shows: 'Water rates',
        prompt: 'A utility worker in a safety vest checks a water meter in a small box in the sidewalk in front of a row of houses.' },
      { id: 'reservoir', label: 'A reservoir in a dry summer', shows: 'supply planning',
        prompt: 'A wide reservoir among golden, dry summer hills, the waterline low on its banks, a hiker on a trail above.' },
      { id: 'native-garden', label: 'Replacing a lawn', shows: 'drought restrictions',
        prompt: 'A homeowner plants drought-tolerant native plants in a front yard where a lawn used to be, a coiled hose unused nearby.' },
      { id: 'watering-can', label: 'Watering by hand', shows: 'drought restrictions',
        prompt: 'Early in the morning, a neighbor waters a vegetable garden with a watering can along a quiet Berkeley street.' },
      { id: 'bucket-wash', label: 'Washing a car with a bucket', shows: 'drought restrictions',
        prompt: 'A neighbor washes a car with a bucket and sponge, no hose running, on a sunny driveway.' },
    ],
  },
  'peralta-ccd-trustee': {
    alias: /Peralta|Berkeley City College/i,
    terms: /\b(?:Peralta|community colleges?|City College|sister colleges?)\b/i,
    powers: ['budget', 'policy'],
    neighbors: [],
    boundaries: [{ fact: 'it has no authority over UC Berkeley', mention: /\bUC Berkeley\b|University of California/i }],
    impliedNumbers: ['4'], // Berkeley City College and its three sister colleges (o7: "four colleges")
    keyFacts: [
      { fact: 'it sets the budget', pattern: /budget|money|spend/i },
      { fact: 'it sets policy', pattern: /polic|rules/i },
      { fact: 'it covers Berkeley City College', pattern: /Berkeley City College/i },
      { fact: 'it covers three sister colleges too', pattern: /three|sister|other colleges|four colleges/i },
    ],
    setting: 'Downtown Berkeley, California: a modern, multi-story community college building on a busy city street.',
    avoid: 'This is a community college in a city building, not a university: no clock tower, no historic stone campus, no university crests.',
    scenes: [
      { id: 'classroom', label: 'A community college class', shows: 'Berkeley City College',
        prompt: 'Adult students of many ages and backgrounds take notes in a bright community college classroom while an instructor talks with them.' },
      { id: 'library', label: 'Studying in the library', shows: 'Berkeley City College',
        prompt: 'Students study together at long tables in a modern community college library with tall windows onto a downtown street.' },
      { id: 'counselor', label: 'Planning classes with a counselor', shows: 'policy',
        prompt: 'A student meets with a college counselor at a small desk to plan next semester\'s classes.' },
      { id: 'science-lab', label: 'A hands-on science lab', shows: 'Budget',
        prompt: 'Students in safety goggles work through a hands-on science lab with new equipment at a community college.' },
      { id: 'arriving', label: 'Arriving for class', shows: 'Berkeley City College',
        prompt: 'Students with backpacks and coffee walk into a modern, multi-story city college building on a downtown street in the morning.' },
      { id: 'evening-class', label: 'An evening class', shows: 'three sister colleges',
        prompt: 'Working adults arrive for an evening class at a community college, its windows glowing at dusk.' },
    ],
  },
};

// ---- 1. The explanation -----------------------------------------------------------------

const OFFICE_SYSTEM_PROMPT = `You explain local elected offices to voters in Berkeley, California, for a nonpartisan class voter guide. You explain; you never advise.

You get numbered facts about one office from the guide's data pack. They are your only source.

Your job is to make those facts easy to picture. Explain, do not copy: say what each thing the office decides means in everyday life, and explain any term a voter might not know (for example, a library board that sets "branch hours" decides when each branch is open). Explaining what a word means is not adding a fact.

Rules:
1. Use only these facts. Do not add powers, duties, numbers, dates, names, places, history, reasons or examples that they do not state, even if you believe they are true. When a voter would want to know something the facts do not say (how many members the board has, how long a term is, what a fee costs), do not guess: put it in openQuestions.
2. Never name a person, candidate, party, agency, board, council, school, city or group that the facts do not name.
3. Stay neutral: no opinions, no advice on how to vote, and no words that judge, such as "important", "crucial", "powerful", "fair" or "best". Describe what the office decides, not whether that is good.
4. decides: one item for each thing the office decides, from its F facts; never lump a list into one item. Each item says what it decides and what that means for people, in everyday words (for example: "It sets branch hours, which decide when each library branch is open."). What it means must follow from the words themselves (a ceiling is a maximum), not from how you think the office works. Keep the facts' limiting words, such as "most".
5. doesNotDecide is the harder half, and voters need it most. Each item must be one of these kinds:
   - "limit": a B fact, a limit the data pack states. Every B fact must be here.
   - "other-office": something the facts give to one of the offices voters mix up with this one (the O facts). Name that office, and say the decision is its, not this office's (for example: "Park hours are set by the parks board, not by this office."). One item per office, not one per decision.
   - "coverage": only when the office's own facts use a limiting word such as "most" or "only": say what that word leaves out ("most" means not all). A place the facts mention is not a limit: "across the East Bay" does not mean "nowhere else", so never write that the office does nothing outside a place.
   Never claim the office lacks some other power the facts do not mention (such as "it does not handle parking" or "that is up to the city council"): the facts cannot back that up. Write only as many items as the facts support, even if that is one, and never pad.
6. Cite: every item lists the facts it comes from, such as ["F1"], ["B1"] or ["F1", "O1"]. Fact numbers go only in that list, never in the text.
7. Write for an everyday adult reader, at grade 9 or below: full sentences in common words, no fragments.`;

/**
 * The office's facts, numbered the way the prompt shows them: F for what the pack says about the
 * office, B for limits the pack states, O for each office a voter could mix it up with (its neighbors).
 */
function officeFacts(office, offices) {
  const context = office.additionalContext || [];
  const own = [
    ...office.description.split(/(?<=\.)\s+/).filter(Boolean),
    ...context.filter((c) => c.kind !== 'boundary').map((c) => c.fact),
  ].map((text, i) => ({ id: `F${i + 1}`, text }));
  const limits = context.filter((c) => c.kind === 'boundary').map((c, i) => ({ id: `B${i + 1}`, text: c.fact }));
  // A neighbor's own limits come along: BART's explainer can then say AC Transit's fares are not BART's call.
  const neighbors = OFFICE_DESIGN[office.id]?.neighbors || [];
  const others = offices.filter((o) => neighbors.includes(o.id)).map((o, i) => ({
    id: `O${i + 1}`, officeId: o.id, name: o.name, jurisdiction: o.jurisdiction,
    text: [o.description, ...(o.additionalContext || []).filter((c) => c.kind === 'boundary').map((c) => c.fact)].join(' '),
  }));
  return { own, limits, others, all: [...own, ...limits, ...others] };
}

/** The JSON shape we ask for. Citations are limited to this office's real fact numbers. */
function officeSchema(office, offices) {
  const cites = { type: 'array', items: { type: 'string', enum: officeFacts(office, offices).all.map((f) => f.id) },
    description: 'The numbers of the facts this comes from.' };
  const item = (extra = {}) => ({
    type: 'object',
    properties: { facts: cites, ...extra, text: { type: 'string', description: 'One or two full, plain sentences.' } },
    required: ['facts', ...Object.keys(extra), 'text'],
    additionalProperties: false,
  });
  // Gemini writes properties in alphabetical order, so each item's citation comes before its text.
  return {
    name: 'office_explainer',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        aboutTheSeat: { type: 'array', items: item(), description: 'What the facts say about this seat or how its members are chosen (such as how they are elected or when the term ends). Empty if the facts say nothing about that.' },
        decides: { type: 'array', items: item(), description: 'One item for each thing this office decides, never a list lumped into one: what it decides, then what that means for people.' },
        doesNotDecide: { type: 'array', items: item({ kind: { type: 'string', enum: ['limit', 'other-office', 'coverage'] } }),
          description: 'What this office does not decide: as many items as the facts support, at least one. Every B fact must be here.' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: 'Two or three questions a voter might ask that the facts do not answer. Never ask what the facts already answer. Questions only, no answers.' },
        summary: { type: 'string', description: 'Two or three sentences that help a voter picture whose life this office touches, and how: a short everyday scene built only from the facts. May open with "Imagine".' },
        title: { type: 'string', description: "The office's short name and what it decides, in at most 8 words." },
      },
      required: ['aboutTheSeat', 'decides', 'doesNotDecide', 'openQuestions', 'summary', 'title'],
      additionalProperties: false,
    },
  };
}

function buildOfficeMessages(office, offices) {
  const { own, limits, others } = officeFacts(office, offices);
  const powers = OFFICE_DESIGN[office.id]?.powers || [];
  const list = (facts) => facts.map((f) => `${f.id}. ${f.text}`).join('\n');
  const user = `Office: ${office.name}
Area: ${office.jurisdiction}

What the data pack says about this office:
${list(own)}
${powers.length ? `\nThe decisions these facts name (give each its own item in decides): ${powers.join('; ')}.\n` : ''}
Limits the data pack states (each one must appear in doesNotDecide):
${limits.length ? list(limits) : 'None.'}

Offices on this ballot that voters mix up with this one (use them only to say what this office does not decide):
${others.length ? others.map((o) => `${o.id}. ${o.name} (${o.jurisdiction}): ${o.text}`).join('\n') : 'None.'}

Explain this office to a voter.`;
  return [
    { role: 'system', content: OFFICE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---- Checks on what came back. No AI: word matches that flag, so a person can look. -------

// Outside names a model reaches for when it explains these offices. Real, but not in the pack.
const OFFICE_OUTSIDE_NAMES = /\b(?:city council|planning commission|mayor|board of supervisors|county|regents|state legislature|legislature|governor|Caltrans|Caltrain|Muni|Amtrak|Capitol Corridor|Oakland|Emeryville|Albany|Richmond|El Cerrito|Piedmont|Hayward|Fremont|San Leandro|Laney|Merritt|College of Alameda|Mokelumne|Pardee|Hetch Hetchy)\b/gi;
// Words that judge instead of describe.
const OFFICE_JUDGMENT_WORDS = /\b(?:important|crucial|vital|critical|essential|significant|powerful|fair|unfair|best|worst|great|should vote|vote (?:for|against|yes|no)|you should|we recommend)\b/gi;
const OFFICE_NEGATION = /\b(?:not|no|never|nothing|none)\b|n['’]t\b/i;
const OFFICE_NAME_ALLOW = /^(?:I|U\.?S\.?|America|American)$/;
// Common nouns that are capitalized inside an office's name ("the EBMUD Board"): not a new name on their own.
const OFFICE_GENERIC_WORDS = new Set(['board', 'director', 'trustee', 'member', 'seat', 'office', 'district', 'ward', 'term']);
// A "does not decide" item has to say what is out of bounds.
const OFFICE_LIMIT_WORDS = /\b(?:not|no|never|nothing|none|only|outside|except)\b|n['’]t\b/i;
const OFFICE_NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, dozen: 12, twenty: 20, hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

/** Numbers in a text, as digit strings: "nine" → "9", "$1,200" → "1200", "5%" → "5" and "%". */
function officeNumbers(text) {
  const out = [];
  const re = new RegExp(`\\d[\\d,.]*\\d|\\d|%|\\bpercent\\b|\\b(?:${Object.keys(OFFICE_NUMBER_WORDS).join('|')})\\b`, 'gi');
  for (const [m] of text.matchAll(re)) {
    const word = m.toLowerCase();
    if (word === '%' || word === 'percent') out.push({ raw: m, value: '%' });
    else if (OFFICE_NUMBER_WORDS[word]) out.push({ raw: m, value: String(OFFICE_NUMBER_WORDS[word]) });
    else out.push({ raw: m, value: m.replace(/,/g, '') });
  }
  return out;
}

/** Capitalized words that do not start a sentence and are not in `vocabulary` (the words the model was given). */
function officeUnknownNames(text, vocabulary) {
  const found = new Set();
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const tokens = sentence.match(/[A-Za-z][A-Za-z'’&.-]*[A-Za-z]|[A-Z]/g) || [];
    for (const t of tokens.slice(1)) {
      if (!/^[A-Z]/.test(t) || OFFICE_NAME_ALLOW.test(t)) continue;
      const parts = t.replace(/['’]s$/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const known = (p) => vocabulary.has(p) || vocabulary.has(p.replace(/s$/, '')) || OFFICE_GENERIC_WORDS.has(p.replace(/s$/, ''));
      if (!parts.every(known)) found.add(t);
    }
  }
  return [...found];
}

/** Every piece of text a voter will read, with where it sits. */
function officeTextParts(x) {
  const items = (list, where) => (x[list] || []).map((it, i) => ({ where: `${where} ${i + 1}`, list, item: it, text: it.text || '' }));
  return [
    { where: 'title', text: x.title || '' },
    { where: 'summary', text: x.summary || '' },
    ...items('decides', 'decides'),
    ...items('doesNotDecide', 'does not decide'),
    ...items('aboutTheSeat', 'about the seat'),
    ...(x.openQuestions || []).map((q, i) => ({ where: `open question ${i + 1}`, text: q })),
  ];
}

/**
 * Check an explanation against the pack. Each flag is { level: 'bad' | 'warn', check, where, text }:
 * 'bad' breaks a rule (a lost limit, an invented name or number, a power given to the wrong office),
 * 'warn' is worth a look. Also returns the pack's limits and key facts, each found or not, and the reading grade.
 */
function checkOfficeExplanation(office, offices, x) {
  const design = OFFICE_DESIGN[office.id] || { boundaries: [], keyFacts: [] };
  const facts = officeFacts(office, offices);
  const ids = new Map(facts.all.map((f) => [f.id, f]));
  const parts = officeTextParts(x);
  const flags = [];
  const flag = (level, check, where, text) => flags.push({ level, check, where, text });

  // The shape: the harder half must be there.
  if (!x.decides?.length) flag('bad', 'shape', 'decides', 'Says nothing about what the office decides.');
  if (!x.doesNotDecide?.length) flag('bad', 'shape', 'does not decide', 'Says nothing about what the office does not decide.');
  if (!x.openQuestions?.length) flag('warn', 'shape', 'open questions', 'Lists nothing the pack leaves unanswered.');
  if ((x.title || '').split(/\s+/).length > 10) flag('warn', 'shape', 'title', 'The title is longer than 10 words.');
  const powers = design.powers || [];
  if (x.decides?.length && x.decides.length < powers.length) {
    flag('warn', 'shape', 'decides', `Lumps ${powers.length} decisions (${powers.join(', ')}) into ${x.decides.length} item${x.decides.length === 1 ? '' : 's'}.`);
  }

  for (const [i, it] of (x.doesNotDecide || []).entries()) {
    if (!OFFICE_LIMIT_WORDS.test(it.text || '')) flag('warn', 'shape', `does not decide ${i + 1}`, 'Does not say what is out of bounds (no "not", "only" or "outside").');
  }
  const neighborsCited = (x.doesNotDecide || []).filter((it) => it.kind === 'other-office').flatMap((it) => (it.facts || []).filter((id) => id.startsWith('O')));
  for (const id of new Set(neighborsCited)) {
    if (neighborsCited.filter((x2) => x2 === id).length > 1) flag('warn', 'shape', 'does not decide', `Says more than once what ${ids.get(id)?.name || id} decides.`);
  }

  // Citations: real, from the right place, and matching the kind of limit.
  for (const p of parts.filter((q) => q.item)) {
    const cited = p.item.facts || [];
    if (!cited.length) flag('bad', 'citation', p.where, 'Cites no fact.');
    for (const id of cited) if (!ids.has(id)) flag('bad', 'citation', p.where, `Cites ${id}, which is not one of the facts.`);
    if (p.list === 'decides' && cited.some((id) => id.startsWith('O'))) {
      flag('bad', 'citation', p.where, 'Cites another office for something this office decides.');
    }
    if (p.list === 'doesNotDecide') {
      const kind = p.item.kind;
      if (kind === 'limit' && !cited.some((id) => id.startsWith('B'))) flag('warn', 'citation', p.where, 'A "limit" that cites no limit from the pack.');
      if (kind === 'coverage' && !cited.some((id) => id.startsWith('F'))) flag('warn', 'citation', p.where, 'A "coverage" limit that cites none of the office’s own facts.');
      if (kind === 'other-office') {
        const named = cited.filter((id) => id.startsWith('O')).map((id) => ids.get(id)).filter(Boolean);
        if (!named.length) flag('bad', 'citation', p.where, 'Says another office decides this, but cites none.');
        for (const o of named) {
          const alias = OFFICE_DESIGN[o.officeId]?.alias;
          if (alias && !alias.test(p.text)) flag('bad', 'citation', p.where, `Cites ${o.name} but does not name it.`);
        }
      }
    }
  }

  // Every limit the pack states is kept, and never turned around into something the office decides.
  const boundaries = design.boundaries.map((b) => ({
    fact: b.fact,
    ok: (x.doesNotDecide || []).some((it) => b.mention.test(it.text)),
  }));
  for (const b of boundaries) if (!b.ok) flag('bad', 'boundary', 'does not decide', `Drops the pack’s limit: ${b.fact}.`);
  for (const it of x.decides || []) {
    if (OFFICE_NEGATION.test(it.text)) continue;
    for (const b of design.boundaries) if (b.mention.test(it.text)) flag('bad', 'leak', 'decides', `Says it decides something the pack says it does not: “${it.text}”`);
    for (const o of offices.filter((q) => q.id !== office.id)) {
      if (OFFICE_DESIGN[o.id]?.terms.test(it.text)) flag('bad', 'leak', 'decides', `Gives it something the pack gives to ${o.name}: “${it.text}”`);
    }
  }

  // Names and numbers the model was not given (its facts, its neighbors, and "Berkeley, California"); words that judge.
  const given = [office.name, office.jurisdiction, ...facts.all.map((f) => [f.name, f.jurisdiction, f.text].join(' ')), 'Berkeley, California'].join(' ');
  const vocabulary = new Set(given.toLowerCase().match(/[a-z0-9]+/g));
  const givenNumbers = new Set([...officeNumbers(given).map((n) => n.value), ...(design.impliedNumbers || [])]);
  for (const p of parts) {
    // Titles are usually Title Case, so only the list of known outside names applies to them.
    const unknown = p.where === 'title' ? [] : officeUnknownNames(p.text, vocabulary);
    const names = new Set([...unknown, ...[...p.text.matchAll(OFFICE_OUTSIDE_NAMES)].map((m) => m[0])]);
    for (const name of names) flag('bad', 'name', p.where, `Names “${name}”, which is not in the facts it was given.`);
    for (const n of officeNumbers(p.text)) if (!givenNumbers.has(n.value)) flag('bad', 'number', p.where, `Uses the number “${n.raw}”, which is not in the facts it was given.`);
    for (const m of p.text.matchAll(OFFICE_JUDGMENT_WORDS)) flag('warn', 'judgment', p.where, `Judges instead of describing: “${m[0]}”.`);
    if (/\b[FBO]\d+\b/.test(p.text)) flag('warn', 'shape', p.where, 'Shows a fact number to the voter.');
  }

  // Mistakes the model has made before.
  for (const m of design.misreadings || []) {
    for (const p of parts.filter((q) => m.pattern.test(q.text))) flag('bad', 'misreading', p.where, `Says ${m.wrong}; the pack says ${m.right}.`);
  }

  // What the pack says that this explanation should not drop.
  const allText = parts.map((p) => p.text).join('\n');
  const keyFacts = design.keyFacts.map((k) => ({ fact: k.fact, ok: k.pattern.test(allText) }));
  for (const k of keyFacts) if (!k.ok) flag('warn', 'dropped', 'explanation', `Does not seem to mention that ${k.fact}.`);

  // Reading level of everything a voter reads (a title or question counts as a sentence).
  const fk = fleschKincaid(parts.map((p) => p.text.trim()).filter(Boolean).map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(' '));
  if (fk.grade != null && fk.grade >= 10) flag('warn', 'grade', 'explanation', `Reads at grade ${fk.grade}; the target is grade 9 or below.`);

  return {
    flags, boundaries, keyFacts, words: fk.words, grade: fk.grade,
    bad: flags.filter((f) => f.level === 'bad').length, warn: flags.filter((f) => f.level === 'warn').length,
  };
}

/** Parse the JSON reply; a code fence around it is tolerated. */
function officeJson(data) {
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('The model did not return valid JSON.');
  }
}

/**
 * One explanation: one call, then our checks.
 * send(messages, { model, maxTokens, temperature, responseFormat }) must return OpenRouter's JSON reply;
 * the guide can pass chat() from js/openrouter.js and the test script passes its own fetch.
 */
async function explainOffice(office, offices, send) {
  const messages = buildOfficeMessages(office, offices);
  const started = Date.now();
  const data = await send(messages, {
    model: OFFICE_MODEL, maxTokens: OFFICE_MAX_TOKENS, temperature: OFFICE_TEMPERATURE,
    responseFormat: { type: 'json_schema', json_schema: officeSchema(office, offices) },
  });
  const explanation = officeJson(data);
  return {
    explanation, check: checkOfficeExplanation(office, offices, explanation), messages, data,
    ms: Date.now() - started, cost: data.usage?.cost ?? 0, finish: data.choices?.[0]?.finish_reason,
  };
}

// ---- 2. The illustration ------------------------------------------------------------------

const SCENE_PICK_PROMPT = `You choose the illustration for a voter guide page about one local elected office. Our designers wrote these scenes, and each one shows something this office decides, so any of them is acceptable. Pick the one that would best help a voter picture what the office decides. If the page's explanation is given, pick the one that fits it best.`;

/** A random few of the scenes not shown yet (all of them again once every one has been shown). */
function scenesToOffer(office, exclude = [], random = Math.random, size = SCENE_MENU_SIZE) {
  const all = OFFICE_DESIGN[office.id]?.scenes || [];
  const fresh = all.filter((s) => !exclude.includes(s.id));
  const menu = [...(fresh.length ? fresh : all)];
  for (let i = menu.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [menu[i], menu[j]] = [menu[j], menu[i]];
  }
  return menu.slice(0, size);
}

function buildScenePickMessages(office, menu, explanation = '') {
  const user = `Office: ${office.name} (${office.jurisdiction})
What the data pack says it decides: ${office.description}
${explanation ? `\nThe explanation on the page says: "${explanation}"\n` : ''}
Scenes:
${menu.map((s) => `- ${s.id}: ${s.label}. ${s.prompt}`).join('\n')}

Answer with the id of one scene.`;
  return [
    { role: 'system', content: SCENE_PICK_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Flash-Lite picks a scene from the menu (minus the ones in `exclude`). The answer is limited to the
 * menu's ids; if it still comes back wrong, we use the first scene offered and say so (fallback: true).
 */
async function pickScene(office, send, { exclude = [], explanation = '', random = Math.random, size } = {}) {
  const menu = scenesToOffer(office, exclude, random, size);
  if (!menu.length) throw new Error(`No scenes are written for ${office.name}.`);
  const messages = buildScenePickMessages(office, menu, explanation);
  const data = await send(messages, {
    model: OFFICE_MODEL, maxTokens: 50, temperature: SCENE_PICK_TEMPERATURE,
    responseFormat: { type: 'json_schema', json_schema: { name: 'scene_pick', strict: true, schema: {
      type: 'object', properties: { scene: { type: 'string', enum: menu.map((s) => s.id) } }, required: ['scene'], additionalProperties: false,
    } } },
  });
  let id;
  try { id = officeJson(data).scene; } catch { id = null; }
  const scene = menu.find((s) => s.id === id);
  return { scene: scene || menu[0], fallback: !scene, offered: menu.map((s) => s.id), messages, data, cost: data.usage?.cost ?? 0 };
}

// One look for every office, so the five pictures read as one guide.
const OFFICE_IMAGE_STYLES = {
  illustration: 'A warm editorial illustration with flat shapes and a soft paper-grain texture, soft natural light, and a muted palette of sage green, slate blue, warm ochre and cream. Calm, everyday and unposed. Full-bleed, edge to edge, with no border or frame.',
  photo: 'A documentary photograph shot on a 35mm lens at eye level in natural light, with warm California tones and soft contrast. A candid, unposed everyday moment. Full-bleed, with no border or frame.',
};
const OFFICE_IMAGE_STYLE = 'illustration';

// The handout's rules, in every image prompt: no real people, nothing that could pass for election
// material. Image models also write garbled words onto signs and papers, so nothing carries text.
// Scenes describe shops by how they look, not by name: "a street of cafes" came back with a "CAFE" sign.
const OFFICE_IMAGE_RULES = `The people are invented, ordinary members of the community, of varied ages and backgrounds, seen from a middle distance and busy with what they are doing. No one is a real or recognizable person, and there are no close-up portraits.
Every sign, shop awning, screen, paper, poster, uniform and vehicle is plain: no words, letters, numbers, logos or symbols anywhere in the image. Papers and screens show only soft gray lines where text would be.
Nothing about elections or politics: no ballots, voting booths, campaign signs, buttons, flags, podiums, seals or government buildings.`;

function buildOfficeImagePrompt(office, scene, style = OFFICE_IMAGE_STYLE) {
  const design = OFFICE_DESIGN[office.id];
  return `${OFFICE_IMAGE_STYLES[style]}

Scene: ${scene.prompt}
Place: ${design.setting}

${OFFICE_IMAGE_RULES}${design.avoid ? `\n${design.avoid}` : ''}`;
}

/**
 * One illustration: Flash-Lite picks a scene, our code writes the prompt, the image model draws it.
 * sendImage(prompt, { model, aspectRatio }) must return the JSON reply of OpenRouter's /api/v1/images.
 * Pass the scenes already shown as `exclude` so "draw another" shows a different one.
 */
async function illustrateOffice(office, send, sendImage, { exclude = [], explanation = '', style = OFFICE_IMAGE_STYLE, random } = {}) {
  const started = Date.now();
  const pick = await pickScene(office, send, { exclude, explanation, random });
  const prompt = buildOfficeImagePrompt(office, pick.scene, style);
  const data = await sendImage(prompt, { model: OFFICE_IMAGE_MODEL, aspectRatio: OFFICE_IMAGE_ASPECT });
  const image = data.data?.[0];
  if (!image?.b64_json) throw new Error('The image model sent back no image.');
  return {
    scene: pick.scene, pick, prompt, style, data,
    image: { b64: image.b64_json, mediaType: image.media_type || 'image/png' },
    ms: Date.now() - started, cost: pick.cost + (data.usage?.cost ?? 0),
  };
}
