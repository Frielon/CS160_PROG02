// Tests for js/office.js that need no API key and cost nothing.
//
//   node --test tools/test-office.mjs
//
// They check that the prompts carry only what the pack says, that every scene is tied to words in
// the pack, and that our no-AI checks catch the failures the handout warns about: a limit dropped,
// a power handed to the wrong office, a name or number the pack does not have ("that's the City Council").
// The live test against the API is tools/eval-office.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(ROOT, 'data/datapack.json'), 'utf8'));
const ctx = vm.createContext({});
for (const file of ['js/fk.js', 'js/office.js']) vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), ctx, { filename: file });
const O = vm.runInContext(`({ OFFICE_DESIGN, OFFICE_IMAGE_RULES, OFFICE_IMAGE_STYLES, SCENE_MENU_SIZE, officeFacts, officeSchema, buildOfficeMessages,
  checkOfficeExplanation, scenesToOffer, buildScenePickMessages, buildOfficeImagePrompt, explainOffice, pickScene, illustrateOffice })`, ctx);

const offices = pack.offices;
const office = (id) => offices.find((o) => o.id === id);
const check = (id, x) => O.checkOfficeExplanation(office(id), offices, x);
const bad = (result, kind) => result.flags.filter((f) => f.level === 'bad' && (!kind || f.check === kind));
const copy = (x) => JSON.parse(JSON.stringify(x));
// Arrays made inside the vm context have another realm's prototype, so compare lengths, not deepEqual([]).

// Hand-written explanations that follow every rule. Each failure below breaks one of them.
const GOOD = {
  'ac-transit-ward-1': {
    title: 'AC Transit Ward 1: Your East Bay Buses',
    summary: 'Imagine you ride the bus to class. This board decides where the buses go, what the fare is and how often they come.',
    decides: [
      { facts: ['F1'], text: 'It decides the bus routes across the East Bay, including the lines that run past campus.' },
      { facts: ['F1'], text: 'It sets the fares that bus riders pay.' },
      { facts: ['F1'], text: 'It decides service levels, such as how often buses come.' },
    ],
    doesNotDecide: [
      { facts: ['B1'], kind: 'limit', text: 'It sets AC Transit fares only. It has nothing to do with BART fares.' },
    ],
    aboutTheSeat: [
      { facts: ['F2'], text: 'This seat is a short term that ends in December 2028.' },
      { facts: ['F3'], text: 'The board is changing from five wards plus two at-large seats to seven wards.' },
    ],
    openQuestions: ['How many people sit on this board?'],
  },
  'berkeley-rent-board': {
    title: 'Berkeley Rent Board: Rules for Renters',
    summary: 'Imagine you rent an apartment in Berkeley. This board sets how high your rent can go and when you can be evicted.',
    decides: [
      { facts: ['F1'], text: 'It sets rent ceilings, the highest rent allowed for most rental units in Berkeley.' },
      { facts: ['F1'], text: 'It sets eviction protections for tenants.' },
      { facts: ['F1'], text: 'It sets the registration fees landlords pay.' },
    ],
    doesNotDecide: [
      { facts: ['F1'], kind: 'coverage', text: 'It covers most rental units in Berkeley, not all of them.' },
      { facts: ['F1'], kind: 'coverage', text: 'As a City of Berkeley board, it has no say over rents outside Berkeley.' },
    ],
    aboutTheSeat: [{ facts: ['F2'], text: 'Its members are directly elected.' }],
    openQuestions: ['How many members does the board have?', 'Which rental units are not covered?'],
  },
};

test('every office in the pack has a design, and every scene shows words from the pack', () => {
  for (const o of offices) {
    const design = O.OFFICE_DESIGN[o.id];
    assert.ok(design, `no design for ${o.id}`);
    assert.ok(design.scenes.length >= 6, `${o.id} offers only ${design.scenes.length} scenes`);
    assert.equal(new Set(design.scenes.map((s) => s.id)).size, design.scenes.length, `${o.id} repeats a scene id`);
    for (const s of design.scenes) assert.ok(o.description.includes(s.shows), `${o.id}/${s.id} shows “${s.shows}”, which the pack does not say`);
    for (const power of design.powers) assert.ok(o.description.toLowerCase().includes(power), `${o.id}: “${power}” is not in the pack’s words`);
    const limits = (o.additionalContext || []).filter((c) => c.kind === 'boundary');
    assert.equal(design.boundaries.length, limits.length, `${o.id}: one boundary check per limit in the pack`);
    for (const [i, b] of design.boundaries.entries()) assert.match(limits[i].fact, b.mention, `${o.id}: the check looks for a word the limit does not use`);
  }
});

test('the prompt carries this office’s facts and limits, and only the neighbors we chose', () => {
  const [system, user] = O.buildOfficeMessages(office('berkeley-rent-board'), offices);
  assert.equal(system.role, 'system');
  for (const sentence of office('berkeley-rent-board').description.split(/(?<=\.)\s+/)) assert.ok(user.content.includes(sentence));
  assert.match(user.content, /Limits the data pack states[^\n]*\nNone\./);
  assert.match(user.content, /voters mix up with this one[^\n]*\nNone\./, 'the Rent Board has no neighbors');
  for (const o of offices.filter((x) => x.id !== 'berkeley-rent-board')) assert.ok(!user.content.includes(o.description), `${o.id} should stay out`);

  const ac = O.buildOfficeMessages(office('ac-transit-ward-1'), offices)[1].content;
  assert.match(ac, /B1\. This board sets AC Transit fares and has nothing to do with BART's\./);
  assert.match(ac, /F2\. The seat on this ballot is a short term/);
  assert.match(ac, /O1\. BART Director .*regional rail system\./);
  assert.ok(!ac.includes(office('ebmud-director').description));

  const bart = O.buildOfficeMessages(office('bart-director'), offices)[1].content;
  assert.ok(bart.includes('nothing to do with BART'), 'a neighbor’s own limit comes along');
  assert.ok(!bart.includes('unexpired term'), 'a neighbor’s seat facts stay out');
});

test('citations in the schema are limited to the office’s real fact numbers', () => {
  const ids = (id) => [...O.officeSchema(office(id), offices).schema.properties.decides.items.properties.facts.items.enum];
  assert.deepEqual(ids('peralta-ccd-trustee'), ['F1', 'B1']);
  assert.deepEqual(ids('ac-transit-ward-1'), ['F1', 'F2', 'F3', 'B1', 'O1']);
});

test('a good explanation passes', () => {
  for (const [id, x] of Object.entries(GOOD)) {
    const r = check(id, x);
    assert.equal(bad(r).length, 0, `${id}: ${JSON.stringify(bad(r))}`);
    assert.ok(r.boundaries.every((b) => b.ok));
    assert.ok(r.keyFacts.every((k) => k.ok), `${id}: ${JSON.stringify(r.keyFacts)}`);
    assert.ok(r.grade < 11, `${id} grade ${r.grade}`);
  }
});

test('dropping a limit the pack states is caught', () => {
  const x = copy(GOOD['ac-transit-ward-1']);
  x.doesNotDecide = [{ facts: ['F1'], kind: 'coverage', text: 'It does not run trains.' }];
  assert.equal(bad(check('ac-transit-ward-1', x), 'boundary').length, 1);
});

test('giving the office a power the pack gives elsewhere is caught', () => {
  const ac = copy(GOOD['ac-transit-ward-1']);
  ac.decides.push({ facts: ['F1'], text: 'It sets bus and BART fares.' });
  assert.ok(bad(check('ac-transit-ward-1', ac), 'leak').length >= 1);

  const rent = copy(GOOD['berkeley-rent-board']);
  rent.decides.push({ facts: ['F1'], text: 'It also sets water rates for apartments.' });
  assert.ok(bad(check('berkeley-rent-board', rent), 'leak').some((f) => f.text.includes('EBMUD')));
});

test('a limit stated with "not" is not a leak', () => {
  const x = copy(GOOD['ac-transit-ward-1']);
  x.decides.push({ facts: ['F1'], text: 'It sets AC Transit bus fares, not BART fares.' });
  assert.equal(bad(check('ac-transit-ward-1', x)).length, 0);
});

test('Peralta: UC Berkeley must be a limit, never a power', () => {
  const x = {
    title: 'Peralta Trustee: Community College Budget', summary: 'This board runs Berkeley City College and its three sister colleges.',
    decides: [{ facts: ['F1'], text: 'It sets the budget and policy for Berkeley City College and its three sister colleges.' },
      { facts: ['F1'], text: 'It also sets tuition at UC Berkeley.' }],
    doesNotDecide: [{ facts: ['F1'], kind: 'coverage', text: 'It only covers four colleges.' }],
    aboutTheSeat: [], openQuestions: ['How long is a term?'],
  };
  const r = check('peralta-ccd-trustee', x);
  assert.equal(bad(r, 'boundary').length, 1);
  assert.equal(bad(r, 'leak').length, 1);
});

test('AC Transit: stretching “across the East Bay” into “not outside it” is caught (o6 did it in every run)', () => {
  const x = copy(GOOD['ac-transit-ward-1']);
  x.doesNotDecide.push({ facts: ['F1'], kind: 'coverage', text: 'Decisions about bus routes, fares, and service levels apply across the East Bay, not outside of it.' });
  assert.equal(bad(check('ac-transit-ward-1', x), 'misreading').length, 1);
  assert.equal(bad(check('ac-transit-ward-1', GOOD['ac-transit-ward-1']), 'misreading').length, 0);
});

test('names the pack does not have are caught (the handout example’s “that’s the Planning Commission”)', () => {
  const x = copy(GOOD['berkeley-rent-board']);
  x.doesNotDecide.push({ facts: ['F1'], kind: 'coverage', text: 'It does not control zoning or building permits; that is the Planning Commission.' });
  x.doesNotDecide.push({ facts: ['F1'], kind: 'coverage', text: 'It does not run parks or police; that is the city council.' });
  const names = bad(check('berkeley-rent-board', x), 'name').map((f) => f.text).join(' ');
  assert.match(names, /Planning Commission/);
  assert.match(names, /city council/);

  const peralta = { title: 'Peralta Trustee', summary: 'It runs Berkeley City College, Laney College and Merritt College.',
    decides: [{ facts: ['F1'], text: 'It sets the budget for the colleges.' }],
    doesNotDecide: [{ facts: ['B1'], kind: 'limit', text: 'It has no authority over UC Berkeley.' }], aboutTheSeat: [], openQuestions: [] };
  const found = bad(check('peralta-ccd-trustee', peralta), 'name').map((f) => f.text).join(' ');
  assert.match(found, /Laney/);
  assert.match(found, /Merritt/);
});

test('numbers the pack does not have are caught; numbers it has pass', () => {
  const x = {
    title: 'BART Director', summary: 'BART has nine directors who serve four-year terms and run 50 stations.',
    decides: [{ facts: ['F1'], text: 'It sets fares and service hours for the regional rail system.' }],
    doesNotDecide: [{ facts: ['O1'], kind: 'other-office', text: 'AC Transit’s board, not BART’s, sets AC Transit bus fares.' }],
    aboutTheSeat: [], openQuestions: [],
  };
  const numbers = bad(check('bart-director', x), 'number').map((f) => f.text).join(' ');
  for (const n of ['nine', 'four', '50']) assert.ok(numbers.includes(`“${n}”`), `missed ${n}: ${numbers}`);
  assert.equal(bad(check('ac-transit-ward-1', GOOD['ac-transit-ward-1']), 'number').length, 0); // 2028, five, two, seven, Ward 1
  const peralta = { title: 'Peralta Trustee: budget and policy for four colleges', summary: 'It runs Berkeley City College and its three sister colleges.',
    decides: [{ facts: ['F1'], text: 'It sets the budget for the colleges.' }],
    doesNotDecide: [{ facts: ['B1'], kind: 'limit', text: 'It has no authority over UC Berkeley.' }], aboutTheSeat: [], openQuestions: [] };
  assert.equal(bad(check('peralta-ccd-trustee', peralta), 'number').length, 0, 'four = Berkeley City College + three sister colleges');
  peralta.summary += ' It has seven trustees.';
  assert.equal(bad(check('peralta-ccd-trustee', peralta), 'number').length, 1);
});

test('citation problems are caught', () => {
  const x = copy(GOOD['berkeley-rent-board']);
  x.decides[0].facts = ['F9'];
  x.decides[1].facts = [];
  x.decides[2].facts = ['O1'];
  const texts = bad(check('berkeley-rent-board', x), 'citation').map((f) => f.text);
  assert.ok(texts.some((t) => t.includes('F9')));
  assert.ok(texts.some((t) => t.includes('Cites no fact')));
  assert.ok(texts.some((t) => t.includes('another office for something this office decides')));

  const ac = copy(GOOD['ac-transit-ward-1']);
  ac.doesNotDecide.push({ facts: ['O1'], kind: 'other-office', text: 'Train fares are set by a different board.' }); // O1 = BART, never named
  ac.doesNotDecide.push({ facts: ['F1'], kind: 'other-office', text: 'BART sets its own service hours.' });
  const acTexts = bad(check('ac-transit-ward-1', ac), 'citation').map((f) => f.text);
  assert.ok(acTexts.some((t) => t.includes('Cites BART Director but does not name it')));
  assert.ok(acTexts.some((t) => t.includes('cites none')));
});

test('an office the model was not shown counts as an outside name', () => {
  const x = copy(GOOD['berkeley-rent-board']);
  x.doesNotDecide.push({ facts: ['F1'], kind: 'coverage', text: 'It does not set fares for BART or water rates for EBMUD.' });
  const names = bad(check('berkeley-rent-board', x), 'name').map((f) => f.text).join(' ');
  assert.match(names, /BART/);
  assert.match(names, /EBMUD/);
});

test('generic office words are not names, but an outside body still is', () => {
  const x = { title: 'EBMUD Director', summary: 'The EBMUD Board decides how much you pay for water in most of the East Bay.',
    decides: [{ facts: ['F1'], text: 'It sets water rates, which decide what homes pay for water.' }],
    doesNotDecide: [{ facts: ['F1'], kind: 'coverage', text: 'Its rules cover most of the East Bay, not all of it.' }],
    aboutTheSeat: [], openQuestions: ['How many Directors sit on the EBMUD Board?'] };
  assert.equal(bad(check('ebmud-director', x), 'name').length, 0);
  x.summary += ' It is not the School Board.';
  assert.match(bad(check('ebmud-director', x), 'name').map((f) => f.text).join(' '), /School/);
});

test('a “does not decide” item with no limit in it, or the same neighbor twice, is flagged for a look', () => {
  const x = {
    title: 'BART Director', summary: 'This board runs the regional rail system.',
    decides: [{ facts: ['F1'], text: 'It sets fares, which decide what riders pay.' }],
    doesNotDecide: [
      { facts: ['O1'], kind: 'other-office', text: 'Bus routes are decided by AC Transit, not this office.' },
      { facts: ['O1'], kind: 'other-office', text: 'AC Transit fares are set by AC Transit, not BART.' },
      { facts: ['F1'], kind: 'coverage', text: 'This office decides fares across the regional rail system.' },
    ],
    aboutTheSeat: [], openQuestions: [],
  };
  const looks = check('bart-director', x).flags.filter((f) => f.check === 'shape').map((f) => f.text);
  assert.ok(looks.some((t) => t.startsWith('Lumps 4 decisions')));
  assert.ok(looks.some((t) => t.includes('out of bounds')));
  assert.ok(looks.some((t) => t.includes('more than once')));
});

test('words that judge, fact numbers in the text and dropped key facts are flagged for a look', () => {
  const x = copy(GOOD['berkeley-rent-board']);
  x.summary = 'This crucial board matters (see F1).';
  x.decides = x.decides.slice(0, 1);
  const r = check('berkeley-rent-board', x);
  assert.ok(r.flags.some((f) => f.check === 'judgment' && f.text.includes('crucial')));
  assert.ok(r.flags.some((f) => f.check === 'shape' && f.text.includes('fact number')));
  assert.ok(r.keyFacts.some((k) => !k.ok && k.fact.includes('eviction')));
});

test('scene menus are a random few, skip scenes already shown, and start over when all are shown', () => {
  const rent = office('berkeley-rent-board');
  const all = O.OFFICE_DESIGN[rent.id].scenes.map((s) => s.id);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const menu = O.scenesToOffer(rent, [], random).map((s) => s.id);
  assert.equal(menu.length, O.SCENE_MENU_SIZE);
  assert.ok(menu.every((id) => all.includes(id)) && new Set(menu).size === O.SCENE_MENU_SIZE);
  const seen = new Set();
  for (let i = 0; i < 50; i++) O.scenesToOffer(rent, [], random).forEach((s) => seen.add(s.id));
  assert.equal(seen.size, all.length, 'over many menus every scene gets offered');
  const rest = O.scenesToOffer(rent, all.filter((id) => !['lease', 'moving-in'].includes(id)), random).map((s) => s.id);
  assert.deepEqual([...rest].sort(), ['lease', 'moving-in'], 'only the scenes not shown yet');
  assert.equal(O.scenesToOffer(rent, all, random).length, O.SCENE_MENU_SIZE, 'all shown: start over');
});

test('every image prompt carries the rules, the place and the scene, and nothing about voting', () => {
  for (const o of offices) {
    for (const s of O.OFFICE_DESIGN[o.id].scenes) {
      const prompt = O.buildOfficeImagePrompt(o, s);
      assert.ok(prompt.includes(O.OFFICE_IMAGE_RULES) && prompt.includes(s.prompt) && prompt.includes(O.OFFICE_DESIGN[o.id].setting));
      assert.ok(prompt.startsWith(O.OFFICE_IMAGE_STYLES.illustration));
      const withoutRules = prompt.replace(O.OFFICE_IMAGE_RULES, '');
      assert.doesNotMatch(withoutRules, /\b(?:vot\w*|ballot|election|campaign|candidate|guide)\b/i, `${o.id}/${s.id}`);
    }
  }
});

// The pipeline with fake API calls: what each function does with a reply, without paying for one.
const reply = (content, cost = 0.0001) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost } });

test('explainOffice sends the schema and checks the reply; bad JSON is an error', async () => {
  let sent;
  const send = async (messages, opts) => { sent = opts; return reply(JSON.stringify(GOOD['ac-transit-ward-1'])); };
  const r = await O.explainOffice(office('ac-transit-ward-1'), offices, send);
  assert.equal(sent.responseFormat.type, 'json_schema');
  assert.equal(r.check.bad, 0);
  assert.equal(r.cost, 0.0001);
  const [, user] = O.buildOfficeMessages(office('ac-transit-ward-1'), offices);
  assert.match(user.content, /give each its own item in decides\): bus routes; fares; service levels\./);
  await assert.rejects(O.explainOffice(office('ac-transit-ward-1'), offices, async () => reply('Sure! Here it is')), /valid JSON/);
});

// Answers with a scene from the menu it was offered, as the real model must (the schema allows only those).
const offered = (messages) => [...messages[1].content.matchAll(/^- ([a-z-]+):/gm)].map((m) => m[1]);
const allBut = (officeId, keep) => O.OFFICE_DESIGN[officeId].scenes.map((s) => s.id).filter((id) => !keep.includes(id));

test('pickScene keeps the model’s choice when it is on the menu, and falls back when it is not', async () => {
  const bart = office('bart-director');
  const ok = await O.pickScene(bart, async () => reply('{"scene":"last-train"}'), { exclude: allBut('bart-director', ['last-train', 'platform']) });
  assert.equal(ok.scene.id, 'last-train');
  assert.equal(ok.fallback, false);
  const wrong = await O.pickScene(bart, async () => reply('{"scene":"a-ballot-box"}'));
  assert.equal(wrong.fallback, true);
  assert.equal(wrong.scene.id, wrong.offered[0]);
  const skipped = await O.pickScene(bart, async (messages) => {
    assert.ok(!offered(messages).includes('last-train'), 'a scene already shown should not be offered');
    return reply(JSON.stringify({ scene: offered(messages)[1] }));
  }, { exclude: ['last-train'] });
  assert.equal(skipped.fallback, false);
  assert.equal(skipped.offered.length, O.SCENE_MENU_SIZE);
});

test('illustrateOffice draws the picked scene and adds up both costs', async () => {
  const ebmud = office('ebmud-director');
  let imagePrompt;
  const r = await O.illustrateOffice(ebmud, async () => reply('{"scene":"reservoir"}', 0.00004),
    async (prompt, opts) => { imagePrompt = prompt; assert.equal(opts.model, 'google/gemini-2.5-flash-image'); return { data: [{ b64_json: 'AAAA', media_type: 'image/png' }], usage: { cost: 0.039 } }; },
    { exclude: allBut('ebmud-director', ['reservoir']) });
  assert.equal(r.scene.id, 'reservoir');
  assert.ok(imagePrompt.includes('A wide reservoir'));
  assert.equal(r.image.b64, 'AAAA');
  assert.equal(Math.round(r.cost * 1e5), Math.round(0.03904 * 1e5));
  await assert.rejects(O.illustrateOffice(ebmud, async () => reply('{"scene":"reservoir"}'), async () => ({ data: [] })), /no image/);
});
