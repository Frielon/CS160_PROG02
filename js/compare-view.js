// Represent! Functionality 2: compare the two sides of a ballot measure.
//
// The page shows who wrote and signed the four printed documents (no AI), then, on request, what each
// side claims, side by side under five headings, and how the two sides answered each other. The
// claims come from compareSides() in js/compare.js: the model lists and links them, our code checks
// every quote against the printed text and works out what was answered. Every AI-written line is
// labeled, and every claim carries the side's own words, one click from the printed document.
//
// This is the guide's "Compare the two sides" tab (guide.html#compare). It is a module: js/app.js
// loads the pack, shows the tab, shares the picked measure with the Read tab, and keeps the session cost.
//
// A comparison is kept in sessionStorage for its measure, so coming back to it costs nothing.
// To look without spending: guide.html?replay=<tag>#compare runs a saved tools/eval-compare.mjs result
// (tools/.cache/eval/<tag>.json) through the same code, with no API call.

const MODEL_NAMES = {
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
};
// Estimates only, shown before a call. The real cost comes back in usage.cost and is what we count.
const PRICES = {
  'google/gemini-2.5-flash': { input: 0.30 / 1e6, output: 2.50 / 1e6 },
  'google/gemini-2.5-flash-lite': { input: 0.10 / 1e6, output: 0.40 / 1e6 },
};
const OUTPUT_TOKENS = { claims: 4200, backers: 900 }; // about what the final test runs wrote

// For voters. The prompt's own definitions (DIMENSIONS[].covers) are written for the model.
const DIMENSION_BLURBS = {
  rules: 'What the measure requires, allows or forbids, and who it covers.',
  money: 'Taxes, costs, prices and budgets: who pays and who gains.',
  effects: 'What each side says will happen to people and public services.',
  voice: 'Who gets to decide, public input, oversight and accountability.',
  backers: 'Who is behind the measure and the campaigns, and who each side says is with it.',
};
const RAISED = { both: 'Both sides', yes: 'Only the YES side', no: 'Only the NO side', neither: 'No claims sorted here' };
const STATUS_LABELS = { answered: 'Answered', unanswered: 'Not answered', reply: 'Reply', repeat: 'Repeat', new: 'New in a rebuttal' };

const results = new Map(); // measure id → finished comparison (also kept in sessionStorage)
const running = new Map(); // measure id → { started } while the two calls are out
const failures = new Map(); // measure id → why the last try failed
let replayNote = null;

const $ = (id) => document.getElementById(id);
const measure = () => app.pack.measures.find((m) => m.id === app.measureId);
const modelName = (id) => MODEL_NAMES[id] || id || 'the model';
const sideName = (side) => side.toUpperCase();
const docName = (key) => COMPARE_DOCS.find((d) => d.key === key)?.name || key;
const argumentWords = (m) => Object.values(m.arguments).reduce((n, a) => n + a.wordCount, 0);
const scrollBehavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// ---- 1. Start: js/app.js calls init() once the pack is in, and draw() to show the tab ---------

registerView('compare', { init, draw });

function init() {
  for (const m of app.pack.measures) {
    const saved = loadResult(m.id);
    if (saved) results.set(m.id, saved);
  }
  const tag = new URLSearchParams(location.search).get('replay');
  if (tag) replay(tag).then(draw);
}

/** The measure is the guide's, shared with the Read tab; js/app.js puts it in the address. */
function choose(id) {
  go({ measureId: id });
}

const storeKey = (id) => `represent.compare.${id}.${COMPARE_PROMPT_VERSION}`;

function loadResult(id) {
  try {
    return JSON.parse(sessionStorage.getItem(storeKey(id)));
  } catch {
    return null;
  }
}

function keepResult(id, result) {
  results.set(id, result);
  try { sessionStorage.setItem(storeKey(id), JSON.stringify(result)); } catch { /* full or blocked: kept until reload */ }
}

// ---- 2. Session cost: js/app.js keeps it for all three tabs (addCost, money) -----------------

// ---- 3. Picker and page --------------------------------------------------------------

function draw() {
  drawPicker();
  const m = measure();
  $('compare-main').replaceChildren(h('div', { class: 'stack' },
    measureHead(m),
    replayNote && h('p', { class: `notice ${replayNote.kind}` }, replayNote.text),
    h('p', { class: 'disclaimer' }, h('b', {}, 'From the guide: '), `“${app.pack.meta.argumentDisclaimer}” `,
      'This page does not check them either: it shows what each side says and how the two sides answered each other.'),
    whoWrote(m),
    comparisonView(m),
    documentsView(m),
    devTools()));
}

function drawPicker() {
  $('compare-picker').replaceChildren(...app.pack.measures.map((m) => h('button', {
    type: 'button', class: 'pick', 'aria-pressed': String(m.id === app.measureId), onclick: () => choose(m.id),
  },
  h('span', { class: 'pick-label' }, m.label),
  h('span', { class: 'pick-title' }, titleCase(m.official.title)),
  h('span', { class: 'pick-len' }, h('span', { class: 'len-num' }, `4 documents · ${fmt(argumentWords(m))} words`)),
  running.has(m.id) ? h('span', { class: 'pick-done' }, 'Comparing…') : results.has(m.id) && h('span', { class: 'pick-done' }, 'Compared'))));
}

/** "REPEALS PROHIBITION ... LEGISLATIVE STATUTE." → "Repeals prohibition ..." (drop the measure-type tail). */
function titleCase(title) {
  const main = title.split('.')[0].toLowerCase();
  return main.charAt(0).toUpperCase() + main.slice(1);
}

function measureHead(m) {
  return h('header', { class: 'measure-head' },
    h('p', { class: 'eyebrow' }, 'Compare the two sides'),
    h('h2', {}, `${m.label}: ${titleCase(m.official.title)}`),
    h('p', { class: 'official-line' }, 'Title as the state wrote it. ',
      h('a', { href: `#read/${m.id}` }, `Read ${m.label} itself`), ' · ',
      link(m.sources.argumentsPage, 'Arguments as published'), ' · ', link(m.sources.officialPage, 'Official guide page')));
}

// ---- 4. Who wrote what (no AI) -----------------------------------------------------------

function whoWrote(m) {
  const signers = signersBySide(m);
  const both = [...signers.bothOrgs.map((o) => `${o.yes} (YES) and ${o.no} (NO)`), ...signers.bothPeople];
  const cell = ({ key, name }) => {
    const a = m.arguments[key];
    return h('div', { class: 'doc-cell' },
      h('div', { class: 'doc-cell-head' },
        h('span', { class: `chip ${a.side}` }, `${sideName(a.side)} · round ${a.round === 'argument' ? 1 : 2}`),
        h('b', {}, name), h('span', { class: 'small muted' }, `${fmt(a.wordCount)} words`)),
      a.respondsTo && h('p', { class: 'relation' }, `Answers the ${sideName(m.arguments[a.respondsTo].side)} side’s argument.`),
      h('ul', { class: 'signers' }, a.signers.map((s) => h('li', {}, s.name,
        (s.title || s.organization) && h('span', { class: 'org' }, `, ${[s.title, s.organization].filter(Boolean).join(', ')}`)))));
  };
  return h('section', { class: 'glance' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Who wrote what'), h('span', { class: 'badge cert' }, 'As printed · no AI')),
    h('p', { class: 'small muted', style: 'margin:0' },
      'Each side writes one argument, then one rebuttal that answers the other side’s argument. There is no third round. Names and organizations are as printed in the guide.'),
    h('div', { class: 'docs-grid' },
      h('div', { class: 'col-head yes' }, 'YES side', h('small', {}, 'urges a yes vote')),
      h('div', { class: 'col-head no' }, 'NO side', h('small', {}, 'urges a no vote')),
      COMPARE_DOCS.map(cell)),
    both.length
      ? h('p', { class: 'callout finding' }, h('b', {}, 'Signs for both sides: '), both.join('; '))
      : h('p', { class: 'callout' }, `No organization or person signs for both sides of ${m.label} (names as printed, matched ignoring case).`));
}

// ---- 5. The comparison ---------------------------------------------------------------------

function comparisonView(m) {
  if (running.has(m.id)) return progressView(m, running.get(m.id));
  if (failures.has(m.id)) return failedView(m, failures.get(m.id));
  if (results.has(m.id)) return resultView(m, results.get(m.id));
  return readyView(m);
}

function estimate(m) {
  const tokens = (messages) => Math.round(messages.reduce((n, x) => n + x.content.length, 0) / 4);
  const price = (model, input, output) => (PRICES[model] ? input * PRICES[model].input + output * PRICES[model].output : 0);
  const claimsIn = tokens(buildCompareMessages(m, app.pack.meta.argumentDisclaimer));
  const backersIn = tokens(buildBackersMessages(m, app.pack.meta.argumentDisclaimer));
  return {
    inputTokens: claimsIn + backersIn,
    cost: price(COMPARE_MODEL, claimsIn, OUTPUT_TOKENS.claims) + price(BACKERS_MODEL, backersIn, OUTPUT_TOKENS.backers),
  };
}

function readyView(m) {
  const est = estimate(m);
  return h('section', { class: 'ready' },
    h('p', { class: 'eyebrow' }, `${m.label} · the two sides`),
    h('h2', {}, 'Not compared yet'),
    h('p', {}, `Two calls run at once. ${modelName(COMPARE_MODEL)} lists every claim in the four documents and says which claim each rebuttal claim answers; `
      + `${modelName(BACKERS_MODEL)} lists who each side says stands with it. Our code then finds every quote in the printed text and works out what was answered, `
      + 'what was not, and what was raised too late to answer.'),
    h('div', { class: 'generate' },
      h('button', { type: 'button', class: 'primary', onclick: () => generate(m) }, 'Compare the two sides with AI'),
      h('p', { class: 'small muted' }, `Sends about ${fmt(est.inputTokens)} tokens · about ${money(est.cost)} · usually 12 to 16 seconds.`)));
}

async function generate(m) {
  if (running.has(m.id)) return;
  failures.delete(m.id);
  const job = { started: Date.now() };
  running.set(m.id, job);
  draw();
  const tick = setInterval(() => {
    const el = $('compare-elapsed');
    if (el && app.measureId === m.id) el.textContent = `${((Date.now() - job.started) / 1000).toFixed(1)} s`;
  }, 200);
  const send = async (messages, options) => {
    const data = await chat(messages, options);
    const part = options.responseFormat?.json_schema?.name === 'backers' ? 'who stands with each side' : 'claims';
    addCost(`${m.label} · two sides · ${part}`, data.usage?.cost ?? 0, 'compare');
    return data;
  };
  try {
    const result = await compareSides(m, send, { disclaimer: app.pack.meta.argumentDisclaimer });
    keepResult(m.id, { ...result, at: Date.now() });
  } catch (err) {
    failures.set(m.id, err.message);
  } finally {
    clearInterval(tick);
    running.delete(m.id);
    if (app.measureId === m.id) draw(); else drawPicker();
  }
}

function progressView(m, job) {
  return h('article', { class: 'card ai' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, 'Comparing the two sides'),
      h('span', { class: 'elapsed', id: 'compare-elapsed' }, `${((Date.now() - job.started) / 1000).toFixed(1)} s`)),
    h('div', { class: 'progress' }, h('span')),
    h('p', { style: 'margin:0' }, `Reading the four documents for ${m.label} (${fmt(argumentWords(m))} words). `
      + `${modelName(COMPARE_MODEL)} is listing and linking the claims while ${modelName(BACKERS_MODEL)} lists who stands with each side.`),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Usually 12 to 16 seconds. You can switch measures meanwhile; this keeps running.'));
}

function failedView(m, message) {
  return h('div', { class: 'notice bad' }, h('b', {}, 'The comparison failed: '), message,
    h('p', { style: 'margin:8px 0 0' }, h('button', { type: 'button', class: 'primary', onclick: () => generate(m) }, 'Try again')));
}

function resultView(m, r) {
  const byId = new Map(r.claims.map((c) => [c.id, c]));
  return h('article', { class: 'card ai compare-result' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, `${m.label}: what each side claims`),
      h('p', { class: 'provenance' },
        `${modelName(r.models?.claims)} listed the claims in the four printed documents and linked each rebuttal claim to the claim it answers; `
        + `${modelName(r.models?.backers)} listed who each side says stands with it. Our code found every quote below in the printed text and worked out `
        + 'from the links what was answered. The AI can misread, and nothing here checks whether a claim is true.')),
    h('div', { class: 'result-actions' },
      h('p', { class: 'result-meta' }, resultMeta(r)),
      !r.replay && h('button', { type: 'button', class: 'secondary', onclick: () => generate(m) },
        `Run again (new calls, about ${money(estimate(m).cost)})`)),
    h('div', { class: 'tally' }, tallyChips(r)),
    r.backersError && h('p', { class: 'notice warn' },
      `The second call (who stands with each side) failed: ${r.backersError} The claims below are not affected.`),
    h('div', { class: 'case-row' }, ['yes', 'no'].map((side) => h('p', { class: `case ${side}` },
      r.summary[side] || '', ' ', h('span', { class: 'ai-tag' }, 'AI summary')))),
    sharedView(r),
    legend(),
    r.dimensions.map((d) => dimensionView(d, byId)),
    backersView(r),
    h('details', { class: 'more' }, h('summary', {}, 'What we sent the model (two calls)'),
      h('p', { class: 'small muted' }, `The claims call, to ${modelName(r.models?.claims)}:`), promptView(r.messages.claims),
      h('p', { class: 'small muted' }, `The backers call, to ${modelName(r.models?.backers)}:`), promptView(r.messages.backers)),
    h('details', { class: 'more' }, h('summary', {}, 'What the model sent back (JSON)'),
      h('div', { class: 'prompt' }, r.calls.map((d) => h('pre', {}, prettyContent(d))))));
}

function resultMeta(r) {
  if (r.replay) {
    return `Replayed from the saved test run “${r.replay.tag}” (prompt ${r.replay.promptVersion}): no API call, $0. `
      + `It cost ${money(r.replay.cost || 0)} when it was made.`;
  }
  const when = new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Generated at ${when} · ${money(r.cost)} for two calls · ${(r.ms / 1000).toFixed(1)} s · ${r.counts.claims} claims`;
}

function tallyChips(r) {
  const s = r.counts.status;
  const loose = r.counts.claims - r.counts.quotes.exact;
  return [
    h('span', { class: 'chip' }, `${r.counts.claims} claims`),
    h('span', { class: 'chip st-answered' }, `${s.answered} answered`),
    h('span', { class: 'chip st-unanswered' }, `${s.unanswered} not answered`),
    h('span', { class: 'chip st-new' }, `${s.new} new in a rebuttal`),
    loose > 0 && h('span', { class: 'chip' }, `${loose} quote${loose === 1 ? '' : 's'} not word for word`),
  ];
}

function sharedView(r) {
  if (!r.backers) return null;
  const groups = r.backers.shared;
  return h('section', { class: 'shared' },
    h('h3', {}, groups.length ? 'Both sides say these are with them' : 'No group named by both sides'),
    h('p', { class: 'small muted', style: 'margin:0' }, groups.length
      ? 'Found by our code: each name appears in both sides’ lists of who stands with them, and every quote was found word for word on its own side. The lists themselves are AI-extracted.'
      : 'Our code found no group in both sides’ lists of who stands with them. The lists are AI-extracted, so the documents below are the final word.'),
    groups.map((g) => h('div', { class: 'shared-item' },
      h('div', { class: 'shared-name' }, groupName(g)),
      h('p', { class: 'shared-quote' }, h('span', { class: 'chip yes' }, 'YES'), g.yes.map((b) => `“${b.quote}”`).join(' · ')),
      h('p', { class: 'shared-quote' }, h('span', { class: 'chip no' }, 'NO'), g.no.map((b) => `“${b.quote}”`).join(' · ')))));
}

/** The words both names share: "Planned Parenthood" from "Planned Parenthood workers" and "... Affiliates of California". */
function groupName(g) {
  const shared = g.yes[0].stems.filter((st) => g.no.some((b) => b.stems.includes(st)));
  const words = g.yes[0].name.split(/\s+/).filter((w) => nameStems(w).some((st) => shared.includes(st)));
  const label = words.join(' ').replace(/[,.;:]+$/, '');
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : g.yes[0].name;
}

function legend() {
  const item = (status, text) => h('li', {}, h('span', { class: `chip st-${status}` }, STATUS_LABELS[status]), h('span', {}, text));
  return h('section', { class: 'legend-box' },
    h('h3', {}, 'How each claim sits in the debate'),
    h('ul', { class: 'legend-list' },
      item('answered', 'the other side’s rebuttal takes it on'),
      item('unanswered', 'the other side’s rebuttal leaves it alone'),
      item('reply', 'a rebuttal claim answering the other side'),
      item('repeat', 'a rebuttal claim restating its own argument'),
      item('new', 'first raised in round 2, so the other side never gets to answer')),
    h('p', { class: 'small muted', style: 'margin:0' },
      'These describe the debate, not the truth. The AI makes the links; our code only lets a rebuttal answer the other side’s argument. Hover a claim to see what it is linked to.'));
}

function dimensionView(d, byId) {
  return h('section', { class: 'dimension', id: `dim-${d.id}` },
    h('div', { class: 'dim-head' },
      h('h3', {}, d.label),
      h('span', { class: `raised ${d.raisedBy}` }, RAISED[d.raisedBy]),
      h('p', { class: 'dim-covers' }, DIMENSION_BLURBS[d.id] || d.covers)),
    h('div', { class: 'sides' }, ['yes', 'no'].map((side) => h('div', { class: 'side-col' },
      h('div', { class: `side-label ${side}` }, `${sideName(side)} side`),
      d[side].length
        ? d[side].map((c) => claimCard(c, byId))
        : h('p', { class: 'empty-side' }, `No ${sideName(side)} claim is sorted here. The AI files each claim under one heading, so the documents below are the final word on what the ${sideName(side)} side mentions.`)))));
}

function claimCard(c, byId) {
  const linked = [c.repliesTo, c.repeatsId, ...(c.answeredBy || [])].filter(Boolean);
  const mark = (on) => linked.forEach((id) => $(`claim-${id}`)?.classList.toggle('linked', on));
  return h('article', { class: `claim ${c.side}`, id: `claim-${c.id}`, onmouseenter: () => mark(true), onmouseleave: () => mark(false) },
    h('div', { class: 'claim-top' },
      h('span', { class: 'chip' }, c.round === 'argument' ? 'Argument' : 'Rebuttal'),
      h('span', { class: 'chip' }, STATED_AS[c.stated_as] || c.stated_as),
      c.status && h('span', { class: `chip st-${c.status}` }, STATUS_LABELS[c.status]),
      h('span', { class: 'cid' }, c.id)),
    h('p', { class: 'restated' }, c.restated, ' ', h('span', { class: 'ai-tag' }, 'AI wording')),
    h('blockquote', { class: 'quote' }, `“${c.quote}”`),
    h('p', { class: 'quote-src' }, `Their words, from the ${docName(c.key)}`,
      c.quoteFound === 'exact' && [' · ', h('button', { type: 'button', class: 'linkish', onclick: () => showInDocument(c.id) }, 'show in the document')]),
    relationLine(c, byId),
    warnings(c));
}

const shorten = (text = '', n = 90) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

function relationLine(c, byId) {
  const other = sideName(otherSide(c.side));
  const own = sideName(c.side);
  const jump = (id) => h('button', { type: 'button', class: 'jump', title: byId.get(id)?.restated || '', onclick: () => jumpTo(id) }, id);
  const line = (...parts) => h('p', { class: 'relation-line' }, ...parts);
  const byWords = h('span', { class: 'by-words' }, '(Found by our word check; the AI did not link it.)');
  switch (c.status) {
    case 'answered':
      return line(`The ${other} rebuttal answers this: `, c.answeredBy.map(jump), '.');
    case 'unanswered':
      return line(`The ${other} rebuttal does not take this on.`);
    case 'reply':
      return c.repliesTo
        ? line(`Answers the ${other} argument: `, jump(c.repliesTo), h('span', { class: 'target' }, ` “${shorten(byId.get(c.repliesTo)?.restated)}”`),
          c.repeatsId && [' Also repeats ', jump(c.repeatsId), '.'])
        : line(`Goes back to the ${other} argument. `, byWords);
    case 'repeat':
      return c.repeatsId ? line(`Repeats the ${own} argument: `, jump(c.repeatsId), '.') : line(`Repeats the ${own} argument. `, byWords);
    case 'new':
      return line(`Raised for the first time in a rebuttal, so the ${other} side never gets to respond.`);
    default:
      return null;
  }
}

function warnings(c) {
  const list = [];
  if (c.quoteFound === 'partial') list.push('These words are not exactly as printed: the AI changed some of them. Read the document before relying on the quote.');
  if (c.quoteFound === 'missing' || c.quoteFound === 'none') list.push('We could not find these words in the printed text.');
  if (c.movedFrom) list.push(`The AI listed this under the ${docName(c.movedFrom)}, but the words are in the ${docName(c.key)}, so it is shown there.`);
  for (const f of c.flags || []) list.push(f.text);
  return list.map((text) => h('p', { class: 'claim-warn' }, '⚑ ', text));
}

function backersView(r) {
  if (!r.backers) return null;
  const column = (side) => {
    const shown = r.backers[side].filter((b) => b.verified);
    const hidden = r.backers[side].length - shown.length;
    return h('div', {},
      h('div', { class: `side-label ${side}` }, side === 'yes' ? 'The YES side says these support it' : 'The NO side says these oppose it'),
      shown.length
        ? h('ul', { class: 'backer-list' }, shown.map((b) => h('li', { title: `“${b.quote}”` }, b.name)))
        : h('p', { class: 'empty-side' }, 'None named.'),
      hidden > 0 && h('p', { class: 'small muted', style: 'margin:6px 0 0' },
        `${hidden} more the AI listed ${hidden === 1 ? 'is' : 'are'} not shown: the quote did not match the printed text, or did not name them.`));
  };
  return h('section', { class: 'backers' },
    h('h3', {}, 'Who each side says stands with it'),
    h('p', { class: 'small muted', style: 'margin:0' },
      `Listed by ${modelName(r.models?.backers)}; a name is shown only when our code found its quote, word for word, on that side. Hover a name to see the quote.`),
    h('div', { class: 'backer-cols' }, column('yes'), column('no')));
}

function jumpTo(id) {
  const el = $(`claim-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  flash(el);
}

function showInDocument(id) {
  const el = document.querySelector(`mark.q[data-claims~="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  flash(el);
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

/** The exact messages, with each document's text folded so the instructions are readable. */
function promptView(messages) {
  return h('div', { class: 'prompt' }, messages.map((msg) => h('div', { class: 'prompt-msg' },
    h('div', { class: 'prompt-role' }, msg.role === 'system' ? 'System' : 'User'),
    h('pre', {}, msg.content.replace(/(<document[^>]*>)\n([\s\S]*?)\n<\/document>/g, (all, open, inner) =>
      `${open}\n… the printed text, ${fmt(inner.trim().split(/\s+/).length)} words (see the documents below) …\n</document>`)))));
}

function prettyContent(data) {
  const content = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

// ---- 6. The four printed documents (no AI) ----------------------------------------------

function documentsView(m) {
  const r = running.has(m.id) ? null : results.get(m.id);
  const claims = r ? r.claims.filter((c) => c.quoteFound === 'exact' || c.quoteFound === 'partial') : [];
  const card = ({ key }) => {
    const a = m.arguments[key];
    return h('article', { class: `doc ${a.side}`, id: `doc-${key}` },
      h('div', { class: 'claim-top' },
        h('span', { class: `chip ${a.side}` }, `${sideName(a.side)} side`),
        h('span', { class: 'chip' }, a.round === 'argument' ? 'Round 1 · argument' : 'Round 2 · rebuttal')),
      h('h3', {}, a.heading),
      h('p', { class: 'small muted', style: 'margin:0' }, `${fmt(a.wordCount)} words`,
        a.respondsTo ? ` · answers the ${sideName(m.arguments[a.respondsTo].side)} side’s argument` : ''),
      h('div', { class: 'doc-text' }, markedParagraphs(a.text, claims.filter((c) => c.key === key))),
      h('footer', {}, h('b', {}, 'Signed by '), a.signers.map((s) => `${s.name}${s.organization ? ` (${s.organization})` : ''}`).join('; '),
        h('p', { class: 'disclaimer inline', style: 'margin:6px 0 0' }, app.pack.meta.argumentDisclaimer)));
  };
  return h('section', { class: 'documents', id: 'documents' },
    h('div', { class: 'section-head' }, h('h2', {}, 'The four printed documents'), h('span', { class: 'badge cert' }, 'Certified text · no AI')),
    h('p', { class: 'small muted', style: 'margin:0' }, claims.length
      ? 'Exactly as the guide prints them. Highlighted passages are the words a claim above quotes: click one to go to its claim.'
      : 'Exactly as the guide prints them.'),
    h('div', { class: 'doc-texts' }, COMPARE_DOCS.map(card)));
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a quote sits in the printed text, found the way js/compare.js matches quotes: the same
 * words in order, whatever the punctuation, capitals or apostrophes, and "Prop." for "Proposition".
 */
function findQuote(text, quote) {
  const words = quoteWords(quote).split(' ').filter(Boolean);
  if (!words.length) return null;
  const word = (w) => (w === 'prop' ? 'prop(?:osition)?' : [...w].map(escapeRe).join('[\'’]?'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(word).join('[^\\p{L}\\p{N}$%]+')}(?![\\p{L}\\p{N}])`, 'iu');
  const found = re.exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : null;
}

/** The printed text in paragraphs, with every quoted passage marked; overlapping quotes share one mark. */
function markedParagraphs(text, claims) {
  const spans = claims.map((c) => ({ ...findQuote(text, c.quote), ids: [c.id] })).filter((s) => s.start != null)
    .sort((a, b) => a.start - b.start);
  const marks = [];
  for (const s of spans) {
    const last = marks[marks.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      last.ids.push(...s.ids);
    } else {
      marks.push(s);
    }
  }
  const ranges = [];
  let at = 0;
  for (const gap of text.matchAll(/\n{2,}/g)) {
    ranges.push([at, gap.index]);
    at = gap.index + gap[0].length;
  }
  ranges.push([at, text.length]);
  return ranges.filter(([s, e]) => text.slice(s, e).trim()).map(([s, e]) => {
    const parts = [];
    let pos = s;
    for (const mk of marks) {
      if (mk.end <= s || mk.start >= e) continue;
      const from = Math.max(mk.start, s);
      const to = Math.min(mk.end, e);
      if (from > pos) parts.push(text.slice(pos, from));
      parts.push(h('mark', { class: 'q', 'data-claims': mk.ids.join(' '), title: `Quoted by ${mk.ids.join(', ')}`, onclick: () => jumpTo(mk.ids[0]) },
        text.slice(from, to)));
      pos = to;
    }
    if (pos < e) parts.push(text.slice(pos, e));
    return h('p', { class: isShout(text.slice(s, e)) ? 'shout' : null }, parts);
  });
}

/** Short, mostly upper-case lines in the arguments are the authors' own headlines. */
function isShout(para) {
  const letters = para.match(/\p{L}/gu) || [];
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  return para.length < 160 && letters.length > 0 && upper / letters.length > 0.7;
}

// ---- 7. Replay a saved test run (free) ----------------------------------------------------

function devTools() {
  const input = h('input', { type: 'text', value: 's12-final', 'aria-label': 'Saved run tag' });
  return h('details', { class: 'more dev' },
    h('summary', {}, 'For testing: replay a saved test run (free)'),
    h('p', { class: 'small muted' }, 'tools/eval-compare.mjs saves every test run in tools/.cache/eval/ (not committed). '
      + 'Replaying one runs its saved model output through the same code as a live comparison, with no API call. A comparison you paid for is kept, not replaced.'),
    h('div', { class: 'dev-row' }, input,
      h('button', { type: 'button', class: 'secondary', onclick: async () => { await replay(input.value.trim()); draw(); } }, 'Replay')));
}

async function replay(tag) {
  if (!tag) return;
  let saved;
  try {
    const response = await fetch(`tools/.cache/eval/${encodeURIComponent(tag)}.json`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    saved = await response.json();
  } catch (err) {
    replayNote = { kind: 'bad', text: `Could not load the saved run “${tag}” from tools/.cache/eval/${tag}.json (${err.message}). Saved runs come from node tools/eval-compare.mjs --tag ${tag}.` };
    return;
  }
  const done = [];
  const kept = [];
  for (const run of saved.results || []) {
    const m = app.pack.measures.find((x) => x.id === run.measure);
    if (!m || run.error || !Array.isArray(run.raw) || done.includes(m.label) || kept.includes(m.label)) continue;
    const current = results.get(m.id);
    if (current && !current.replay) { kept.push(m.label); continue; }
    const replies = run.raw.map((content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0 } }));
    let next = 0;
    const result = await compareSides(m, async () => replies[next++], {
      disclaimer: app.pack.meta.argumentDisclaimer, model: saved.model, backersModel: saved.backersModel || saved.model,
    });
    keepResult(m.id, { ...result, at: Date.now(), ms: run.ms, replay: { tag, cost: run.cost, promptVersion: saved.promptVersion } });
    done.push(m.label);
  }
  replayNote = done.length
    ? { kind: 'info', text: `Replayed the saved test run “${tag}” (prompt ${saved.promptVersion}) for ${done.join(', ')}: no API call, $0.${kept.length ? ` Kept your own comparison of ${kept.join(', ')}.` : ''}` }
    : { kind: 'warn', text: `The saved run “${tag}” has nothing this page can replay${kept.length ? ` (kept your own comparison of ${kept.join(', ')})` : ''}. Runs from before the two-call design (s1 to s6) cannot be replayed.` };
}
