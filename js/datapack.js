// Data pack explorer: every field of data/datapack.json, laid out for reading. No AI.
// Reading grades come from js/fk.js; everything else is read straight from the pack.

// ---- 1. Load the pack, then draw the view the #hash names --------------------
const view = document.getElementById('view');
let pack;

fetch('data/datapack.json')
  .then((response) => response.json())
  .then((data) => {
    pack = data;
    document.getElementById('election').textContent = pack.meta.election;
    buildNav();
    route();
  })
  .catch((err) => {
    view.replaceChildren(h('div', { class: 'callout warn' },
      h('p', {}, h('b', {}, 'Could not load data/datapack.json. '), err.message),
      h('p', {}, 'Browsers block fetch() from file://. Serve the folder instead: ',
        h('code', {}, 'python3 -m http.server 8000'), ', then open ',
        h('code', {}, 'http://localhost:8000/datapack.html'), '.')));
  });

window.addEventListener('hashchange', route);

function views() {
  return [
    { id: 'overview', label: 'Overview', draw: drawOverview },
    ...pack.measures.map((m) => ({ id: m.id, label: m.label, draw: () => drawMeasure(m) })),
    { id: 'offices', label: 'Offices', draw: drawOffices },
    { id: 'structure', label: 'JSON structure', draw: drawStructure },
  ];
}

function buildNav() {
  document.getElementById('nav').replaceChildren(
    ...views().map((v) => h('a', { href: '#' + v.id, 'data-view': v.id }, v.label)));
}

// #prop-40 opens a view; #prop-40/arguments also scrolls to that part of it.
function route() {
  if (!pack) return;
  const all = views();
  const [viewId, part] = location.hash.slice(1).split('/');
  const current = all.find((v) => v.id === viewId) || all[0];
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.view === current.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.replaceChildren(current.draw());
  document.title = `${current.label} · Data Pack Explorer`;
  const target = part && document.getElementById(`${current.id}-${part}`);
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

// ---- 2. Small helpers ---------------------------------------------------------

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function section(id, title, ...children) {
  return h('section', { id, class: 'block' }, h('h2', {}, title), ...children);
}

function fieldKey(path) {
  return h('code', { class: 'field' }, path);
}

function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('flash');
}

function jumpNav(items) {
  return h('nav', { class: 'jump', 'aria-label': 'On this page' },
    ...items.map(([id, label]) => h('button', { type: 'button', onclick: () => scrollToId(id) }, label)));
}

/** "California Taxpayers Association (CalTax)" and "california taxpayers association" match. */
function normalizeOrg(name) {
  return name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Numbers we derive from each measure (not stored in the pack).
const statsCache = new Map();

function measureStats(m) {
  if (!statsCache.has(m.id)) {
    const args = Object.values(m.arguments);
    statsCache.set(m.id, {
      legal: fleschKincaid(operativeText(m.fullText)), // from js/fk.js
      summary: fleschKincaid(m.official.summary),
      tokens: Math.round(m.fullText.length / 4), // rough rule of thumb: 1 token ≈ 4 characters
      argWords: args.reduce((n, a) => n + a.wordCount, 0),
      signatures: args.reduce((n, a) => n + a.signers.length, 0),
    });
  }
  return statsCache.get(m.id);
}

/** A horizontal bar split into new / deleted / unchanged words. */
function changeBar(amendatory, widthPercent = 100) {
  const { italicWords, deletedWords, totalWords } = amendatory;
  const unchanged = Math.max(0, totalWords - italicWords - deletedWords);
  const pct = (n) => (100 * n) / totalWords + '%';
  return h('div', {
    class: 'bar', style: `width:${widthPercent}%`, role: 'img',
    'aria-label': `${fmt(italicWords)} new, ${fmt(deletedWords)} deleted, ${fmt(unchanged)} unchanged words`,
  },
  h('span', { class: 'seg new', style: `width:${pct(italicWords)}`, title: `${fmt(italicWords)} new (italic) words` }),
  h('span', { class: 'seg deleted', style: `width:${pct(deletedWords)}`, title: `${fmt(deletedWords)} deleted (strikeout) words` }),
  h('span', { class: 'seg unchanged', style: `width:${pct(unchanged)}`, title: `${fmt(unchanged)} unchanged words` }));
}

function barLegend() {
  return h('p', { class: 'legend' },
    h('span', { class: 'swatch new' }), 'new words (italic in the guide) ',
    h('span', { class: 'swatch deleted' }), 'deleted words (strikeout) ',
    h('span', { class: 'swatch unchanged' }), 'unchanged existing law');
}

function disclaimerBox() {
  return h('p', { class: 'disclaimer' }, h('b', {}, 'From the guide: '), '“', pack.meta.argumentDisclaimer, '”');
}

// ---- 3. Overview --------------------------------------------------------------

function drawOverview() {
  const { meta, measures, offices } = pack;
  const longest = measures.reduce((a, b) => (b.wordCount > a.wordCount ? b : a));
  const shortest = measures.reduce((a, b) => (b.wordCount < a.wordCount ? b : a));
  const maxWords = Math.max(...measures.map((m) => m.amendatory.totalWords));

  return h('div', {},
    h('p', { class: 'eyebrow' }, meta.guide),
    h('h1', {}, 'What’s in the data pack'),
    h('p', { class: 'lead' },
      `${measures.length} ballot measures and ${offices.length} down-ballot offices for the `,
      meta.election, '. This file is the only source of facts your app is allowed to have.'),
    h('p', { class: 'muted small' }, 'Built by ', h('code', {}, meta.generatedBy), ' at ',
      new Date(meta.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), '.'),

    section('notes', 'How to read the pack (meta.notes)',
      h('ol', { class: 'notes' }, meta.notes.map((n) => h('li', {}, n)))),

    section('measures', 'The four measures',
      h('p', {}, `The spread is deliberate: ${longest.label} is ${Math.round(longest.wordCount / shortest.wordCount)}× `
        + `longer than ${shortest.label}, and you pay for every word on every call. Bars share one scale.`),
      barLegend(),
      h('div', { class: 'table-wrap' }, h('table', { class: 'measures-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Measure'), h('th', { class: 'bar-col' }, 'Legal text length'),
          h('th', { class: 'num' }, 'Words'), h('th', { class: 'num' }, '≈ Tokens'),
          h('th', { class: 'num' }, 'Grade: legal text'), h('th', { class: 'num' }, 'Grade: official summary'),
          h('th', { class: 'num' }, 'Argument words'))),
        h('tbody', {}, measures.map((m) => {
          const s = measureStats(m);
          return h('tr', {},
            h('td', {}, h('a', { href: '#' + m.id, class: 'strong' }, m.label),
              h('div', { class: 'tiny muted' }, m.official.title)),
            h('td', { class: 'bar-col' }, changeBar(m.amendatory, (100 * m.amendatory.totalWords) / maxWords)),
            h('td', { class: 'num' }, fmt(m.wordCount)),
            h('td', { class: 'num' }, fmt(s.tokens)),
            h('td', { class: 'num' }, s.legal.grade),
            h('td', { class: 'num' }, s.summary.grade),
            h('td', { class: 'num' }, fmt(s.argWords)));
        })))),
      h('p', { class: 'muted small' }, 'Grades are Flesch–Kincaid (js/fk.js); the legal text is graded with deleted words removed. '
        + 'Tokens are estimated as characters ÷ 4; the API reports the real count.')),

    section('map', 'Which part of the assignment reads which field', assignmentMap()),

    section('offices-summary', 'The five offices',
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Office'), h('th', {}, 'Jurisdiction'),
          h('th', { class: 'num' }, 'Extra facts'), h('th', {}, 'Boundary stated in pack?'))),
        h('tbody', {}, offices.map((o) => {
          const boundaries = o.additionalContext.filter((c) => c.kind === 'boundary').length;
          return h('tr', {},
            h('td', {}, h('a', { href: '#offices', class: 'strong' }, o.name)),
            h('td', {}, o.jurisdiction),
            h('td', { class: 'num' }, o.additionalContext.length),
            h('td', {}, boundaries ? h('span', { class: 'chip boundary' }, 'yes') : h('span', { class: 'muted' }, 'no')));
        })))),
      h('p', { class: 'muted small' }, 'Only some offices state what they do not control. For the rest, '
        + 'the boundary has to come from the description itself, which is where a model will invent one if you let it.')),

    section('repeat-signers', 'Organizations that sign on more than one measure', repeatSigners()));
}

function assignmentMap() {
  const rows = [
    ['1. Render a measure at a reading level and length, plus topics of concern',
      ['measures[].fullText', 'measures[].fullTextMarked', 'measures[].sources.legalTextPdf'],
      'Send fullText to the model. “As written” shows the text itself, no model. official.* is only for comparing.'],
    ['2. Compare the two sides',
      ['measures[].arguments.*.text', '.signers', '.side', '.round', '.respondsTo', 'meta.argumentDisclaimer'],
      'The model extracts claims as JSON. Show the disclaimer wherever argument text appears.'],
    ['3. Explain a down-ballot office and illustrate it',
      ['offices[].description', 'offices[].additionalContext'],
      'kind: "boundary" facts say what an office does not control.'],
    ['4. Show where everything came from',
      ['measures[].sources.*', 'measures[].official.url', 'offices[].source'],
      'Every generated piece links back to the original.'],
    ['5. Show what it costs', [], 'Not in the pack: read usage.cost from each API reply.'],
    ['Answer key (never send to a model)', ['measures[].official.*'],
      'Show it to people and compare your output against it in the report.'],
  ];
  return h('div', { class: 'table-wrap' }, h('table', { class: 'map' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Functionality'), h('th', {}, 'Fields'), h('th', {}, 'Notes'))),
    h('tbody', {}, rows.map(([what, fields, note]) => h('tr', {},
      h('td', { class: 'strong' }, what),
      h('td', {}, fields.length ? fields.map((f) => fieldKey(f)) : h('span', { class: 'muted' }, '—')),
      h('td', {}, note))))));
}

function repeatSigners() {
  const byOrg = new Map(); // normalized org -> { name, uses: Map(measure label -> Set(side)) }
  for (const m of pack.measures) {
    for (const a of Object.values(m.arguments)) {
      for (const s of a.signers) {
        if (!s.organization) continue;
        const key = normalizeOrg(s.organization);
        if (!byOrg.has(key)) byOrg.set(key, { name: s.organization, uses: new Map() });
        const uses = byOrg.get(key).uses;
        if (!uses.has(m.label)) uses.set(m.label, new Set());
        uses.get(m.label).add(a.side);
      }
    }
  }
  const repeats = [...byOrg.values()].filter((o) => o.uses.size > 1);
  if (!repeats.length) return h('p', { class: 'muted' }, 'None.');
  return h('div', {},
    h('p', {}, 'From the signer blocks of the arguments and rebuttals. Not a finding about any single measure, '
      + 'but it shows who is active across the ballot.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Organization'),
        ...pack.measures.map((m) => h('th', { class: 'center' }, m.label)))),
      h('tbody', {}, repeats.map((o) => h('tr', {},
        h('td', {}, o.name),
        ...pack.measures.map((m) => h('td', { class: 'center' },
          [...(o.uses.get(m.label) || [])].map((side) => h('span', { class: 'chip ' + side }, side.toUpperCase()))))))))));
}

// ---- 4. One measure: everything the pack holds about it -----------------------

function drawMeasure(m) {
  const s = measureStats(m);
  const index = pack.measures.indexOf(m);
  const id = (part) => `${m.id}-${part}`;

  return h('article', { class: 'measure' },
    h('p', { class: 'eyebrow' }, `Measure ${index + 1} of ${pack.measures.length} · id “${m.id}” · number ${m.number}`),
    h('h1', {}, m.label),
    h('p', { class: 'official-title' }, m.official.title),
    h('p', { class: 'byline' }, m.official.preparedBy, ' · ',
      link(m.sources.officialPage, 'Official guide page'), ' · ',
      link(m.sources.legalTextPdf, 'Legal text (PDF)'), ' · ',
      link(m.sources.argumentsPage, 'Arguments page')),

    jumpNav([[id('official'), 'Official summary'], [id('legal'), 'Full legal text'],
      [id('arguments'), 'Arguments & rebuttals'], [id('sources'), 'Sources'], [id('raw'), 'Raw JSON']]),

    h('div', { class: 'tiles' },
      tile('Legal text', `${fmt(m.wordCount)} words`, `≈ ${fmt(s.tokens)} tokens every time you send it`),
      tile('Reading grade · legal text', s.legal.grade,
        `Flesch–Kincaid, ${fmt(s.legal.sentences)} sentences, deleted words removed`),
      tile('Reading grade · official summary', s.summary.grade, `${s.summary.words} words in official.summary`),
      tile('Changes to the law', `${fmt(m.amendatory.italicWords)} new · ${fmt(m.amendatory.deletedWords)} deleted`,
        changeBar(m.amendatory)),
      tile('Arguments & rebuttals', `${fmt(s.argWords)} words`, `${s.signatures} signatures on 4 documents`)),

    section(id('official'), 'Official title & summary', officialView(m)),
    section(id('legal'), 'Full legal text, as written', legalTextViewer(m)),
    section(id('arguments'), 'Arguments & rebuttals', argumentsView(m)),
    section(id('sources'), 'Sources', sourcesView(m)),
    section(id('raw'), 'This measure as raw JSON',
      h('p', { class: 'muted small' }, 'The same object as it sits in the file. Long strings are cut short; click to see all of one.'),
      jsonTree(`measures[${index}]`, m, 'measures[]', 0, true)));
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    h('div', { class: 'tile-sub' }, sub));
}

// ---- 4a. The official answer key ----------------------------------------------

function officialView(m) {
  const o = m.official;
  const s = measureStats(m);
  const list = (text) => h('ul', { class: 'chips' }, text.split(/;\s*/).filter(Boolean).map((x) => h('li', {}, x)));
  const rows = [
    ['Title', 'title', o.title],
    ['Summary', 'summary', [o.summary, h('div', { class: 'tiny muted' },
      `${s.summary.words} words · Flesch–Kincaid grade ${s.summary.grade}`)]],
    ['Fiscal impact', 'fiscalImpact', o.fiscalImpact],
    ['A YES vote means', 'yesVoteMeans', o.yesVoteMeans],
    ['A NO vote means', 'noVoteMeans', o.noVoteMeans],
    ['Supporters listed', 'supportersListed', list(o.supportersListed)],
    ['Opponents listed', 'opponentsListed', list(o.opponentsListed)],
    ['Prepared by', 'preparedBy', o.preparedBy],
    ['Official page', 'url', link(o.url, o.url)],
  ];
  return h('div', {},
    h('p', { class: 'answer-key' }, h('b', {}, 'Answer key. '),
      'Show this to people and compare your generated text against it, but never send any of ',
      fieldKey('official.*'), ' to a model.'),
    h('dl', { class: 'fields' }, rows.map(([label, key, value]) => [
      h('dt', {}, label, fieldKey('official.' + key)),
      h('dd', {}, value)])),
    h('details', { class: 'more' },
      h('summary', {}, 'official.summaryFull: summary, fiscal impact, supporters and opponents as one string'),
      h('p', {}, o.summaryFull)));
}

// ---- 4b. The full legal text (parsing and drawing live in js/legal-text.js) ----

function legalTextViewer(m) {
  const paragraphs = parseMarked(m.fullTextMarked);
  let mode = 'marked'; // or 'clean': the law as it would read if passed
  let marks = [];
  let current = -1;

  const body = h('div', { class: 'legal tint' });
  const toc = h('div', { class: 'toc' });
  const count = h('span', { class: 'find-count', 'aria-live': 'polite' });
  const input = h('input', {
    type: 'search', class: 'find', 'aria-label': 'Find words in the legal text',
    placeholder: 'Find words: rent, tenant*, home*',
  });

  const modeButtons = [['marked', 'Marked changes'], ['clean', 'As it would read if passed']].map(([value, label]) =>
    h('button', { type: 'button', 'data-mode': value, 'aria-pressed': String(value === mode), onclick: () => {
      mode = value;
      for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === value));
      render();
    } }, label));

  function render() {
    const headings = [];
    body.replaceChildren(...paragraphs
      .map((runs, i) => renderLegalParagraph(runs, mode, `${m.id}-p${i}`, headings))
      .filter(Boolean));
    toc.replaceChildren(
      h('span', { class: 'toc-label' }, headings.length ? 'Jump to' : 'No section headings found'),
      ...headings.map((x) => h('button', { type: 'button', class: 'toc-item level-' + x.level, onclick: () => scrollToId(x.id) }, x.label)));
    find();
  }

  function find() {
    const terms = input.value.split(',').map((t) => t.trim()).filter((t) => t.replace(/\*$/, ''));
    marks = terms.length ? highlightMatches(body, termsRegex(terms)) : [];
    current = -1;
    if (!terms.length) { count.textContent = ''; return; }
    const perTerm = terms.map((t) => {
      const re = termsRegex([t], true);
      return `${t} ×${marks.filter((mk) => re.test(mk.textContent)).length}`;
    });
    count.textContent = `${marks.length} match${marks.length === 1 ? '' : 'es'}` + (terms.length > 1 ? ` (${perTerm.join(' · ')})` : '');
  }

  function step(delta) {
    if (!marks.length) return;
    if (marks[current]) marks[current].classList.remove('current');
    current = (current + delta + marks.length) % marks.length;
    marks[current].classList.add('current');
    marks[current].scrollIntoView({ behavior: 'smooth', block: 'center' });
    count.textContent = count.textContent.replace(/^(\d+ of )?/, `${current + 1} of `);
  }

  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(find, 200); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); });

  const tint = h('input', { type: 'checkbox', checked: true, onchange: (e) => body.classList.toggle('tint', e.target.checked) });

  render();
  return h('div', {},
    h('p', {}, 'Rendered from ', fieldKey('fullTextMarked'), '. This is the “As written” mode: the certified text, no model. ',
      'The model gets ', fieldKey('fullText'), ', where only deleted words are marked.'),
    h('div', { class: 'toolbar' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Text view' }, modeButtons),
      h('label', { class: 'check' }, tint, ' Tint new text'),
      h('div', { class: 'find-box' }, input,
        h('button', { type: 'button', 'aria-label': 'Previous match', onclick: () => step(-1) }, '↑'),
        h('button', { type: 'button', 'aria-label': 'Next match', onclick: () => step(1) }, '↓'),
        count)),
    h('p', { class: 'legend' },
      h('ins', {}, 'italic: new words'), ' · ', h('del', {}, 'strikeout: deleted words'), ' · ',
      'Find matches whole words; end with * for a prefix; separate several with commas. It counts the text as shown.'),
    toc,
    body);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word matching; a trailing * matches any ending. anchored=true tests one whole match. */
function termsRegex(terms, anchored = false) {
  const parts = terms.map((t) => {
    const prefix = t.endsWith('*');
    const core = escapeRegExp(prefix ? t.slice(0, -1) : t);
    return core + (prefix ? '[\\w’\'-]*' : '');
  });
  const body = `\\b(?:${parts.join('|')})\\b`;
  return anchored ? new RegExp(`^${body}$`, 'i') : new RegExp(body, 'gi');
}

/** Wrap every match inside container's text in <mark>. Returns the marks in document order. */
function highlightMatches(container, re) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    const found = [...text.matchAll(re)];
    if (!found.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const f of found) {
      const mark = h('mark', {}, f[0]);
      frag.append(text.slice(pos, f.index), mark);
      marks.push(mark);
      pos = f.index + f[0].length;
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
  return marks;
}

// ---- 4c. Arguments and rebuttals ----------------------------------------------

const DOC_NAMES = {
  argumentInFavor: 'Argument in Favor',
  rebuttalToFavor: 'Rebuttal to Argument in Favor',
  argumentAgainst: 'Argument Against',
  rebuttalToAgainst: 'Rebuttal to Argument Against',
};

function argumentsView(m) {
  const entries = Object.entries(m.arguments);
  return h('div', {},
    disclaimerBox(),
    h('p', {}, 'Each side writes one argument, then gets exactly one rebuttal to answer the other side’s argument. ',
      'Careful with the names: the ', h('b', {}, 'Rebuttal to Argument in Favor'), ' is written by the ', h('b', {}, 'NO'),
      ' side. Use ', fieldKey('side'), ', ', fieldKey('round'), ' and ', fieldKey('respondsTo'), ' rather than the heading.'),
    h('div', { class: 'debate' },
      h('div', { class: 'col-head yes' }, 'YES side', h('small', {}, 'urges a YES vote')),
      h('div', { class: 'col-head no' }, 'NO side', h('small', {}, 'urges a NO vote')),
      entries.map(([key, a]) => argumentCard(m, key, a, entries))),
    h('h3', {}, 'Who signed'),
    signersView(m));
}

function argumentCard(m, key, a, entries) {
  const answeredBy = entries.find(([, other]) => other.respondsTo === key);
  const docLink = (k) => h('button', { type: 'button', class: 'linkish', onclick: () => scrollToId(`${m.id}-arg-${k}`) },
    `${DOC_NAMES[k] || k} (${m.arguments[k].side.toUpperCase()} side)`);
  const grade = fleschKincaid(a.text).grade;

  return h('article', { class: `arg ${a.side}`, id: `${m.id}-arg-${key}`, 'data-side': a.side, 'data-round': a.round },
    h('header', {},
      h('div', { class: 'chips-row' },
        h('span', { class: 'chip ' + a.side }, `${a.side.toUpperCase()} side`),
        h('span', { class: 'chip' }, a.round === 'argument' ? 'Round 1 · argument' : 'Round 2 · rebuttal'),
        fieldKey(key)),
      h('h4', {}, a.heading),
      h('p', { class: 'tiny muted' }, `${fmt(a.wordCount)} words · Flesch–Kincaid grade ${grade}`),
      a.respondsTo && h('p', { class: 'relation' }, '↩ Answers: ', docLink(a.respondsTo)),
      answeredBy && h('p', { class: 'relation' }, '↪ Answered by: ', docLink(answeredBy[0]))),
    h('div', { class: 'arg-text' }, a.text.split(/\n{2,}/).map((para) =>
      h('p', { class: isShout(para) ? 'shout' : null }, para))),
    h('footer', {},
      h('div', { class: 'tiny strong' }, 'Signed by'),
      h('ul', { class: 'signers' }, a.signers.map((s) => {
        const role = [s.title, s.organization].filter(Boolean).join(', ');
        return h('li', {}, h('b', {}, s.name), role && ', ' + role);
      })),
      h('p', { class: 'disclaimer inline' }, pack.meta.argumentDisclaimer)));
}

/** Short, mostly upper-case lines in the arguments are the authors' own headlines. */
function isShout(para) {
  const letters = para.match(/\p{L}/gu) || [];
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  return para.length < 160 && letters.length > 0 && upper / letters.length > 0.7;
}

function signersView(m) {
  const rows = [];
  const orgsBySide = { yes: new Map(), no: new Map() };
  const docsByPerson = new Map();
  for (const [key, a] of Object.entries(m.arguments)) {
    for (const s of a.signers) {
      rows.push({ key, a, s });
      if (s.organization) orgsBySide[a.side].set(normalizeOrg(s.organization), s.organization);
      docsByPerson.set(s.name, (docsByPerson.get(s.name) || 0) + 1);
    }
  }
  const both = [...orgsBySide.yes.keys()].filter((k) => orgsBySide.no.has(k));

  return h('div', {},
    both.length
      ? h('p', { class: 'callout finding' }, h('b', {}, 'Same organization on both sides: '),
        both.map((k) => `${orgsBySide.yes.get(k)} / ${orgsBySide.no.get(k)}`).join('; '))
      : h('p', { class: 'muted small' }, `No organization signs for both sides of ${m.label} `
        + '(matched by name, ignoring case and parentheses). A side can still claim the same group in its text.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Side'), h('th', {}, 'Document'), h('th', {}, 'Name'),
        h('th', {}, 'Title'), h('th', {}, 'Organization'))),
      h('tbody', {}, rows.map(({ key, a, s }) => h('tr', {},
        h('td', {}, h('span', { class: 'chip ' + a.side }, a.side.toUpperCase())),
        h('td', {}, DOC_NAMES[key] || key),
        h('td', {}, s.name, docsByPerson.get(s.name) > 1
          && h('div', { class: 'tiny muted' }, `signs ${docsByPerson.get(s.name)} of the 4 documents`)),
        h('td', {}, s.title || h('span', { class: 'muted' }, '—')),
        h('td', {}, s.organization || h('span', { class: 'muted' }, '(none given)'))))))));
}

function sourcesView(m) {
  const rows = [
    ['Full legal text (PDF)', 'sources.legalTextPdf', m.sources.legalTextPdf],
    ['Official guide page', 'sources.officialPage', m.sources.officialPage],
    ['Arguments & rebuttals page', 'sources.argumentsPage', m.sources.argumentsPage],
  ];
  return h('dl', { class: 'fields' }, rows.map(([label, key, url]) => [
    h('dt', {}, label, fieldKey(key)), h('dd', {}, link(url, url))]));
}

// ---- 5. Offices -----------------------------------------------------------------

function drawOffices() {
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'offices[]'),
    h('h1', {}, 'Down-ballot offices'),
    h('p', { class: 'lead' }, 'Everything the pack says about each office. The less it says, the more a model will be tempted to fill in.'),
    h('div', { class: 'offices' }, pack.offices.map((o) => h('article', { class: 'office', id: o.id },
      h('p', { class: 'eyebrow' }, o.jurisdiction),
      h('h2', {}, o.name),
      h('p', {}, o.description, ' ', fieldKey('description')),
      o.additionalContext.length
        ? h('ul', { class: 'facts' }, o.additionalContext.map((c) => h('li', { class: c.kind === 'boundary' ? 'boundary' : null },
          c.kind === 'boundary' && h('span', { class: 'chip boundary' }, 'Boundary: what it does not control'),
          h('div', {}, c.fact),
          h('div', { class: 'tiny muted' }, 'Source: ', c.source))))
        : h('p', { class: 'muted small' }, 'No additionalContext in the pack.'),
      h('p', { class: 'tiny muted' }, 'id ', h('code', {}, o.id), ' · source: ', o.source)))));
}

// ---- 6. The raw JSON as an annotated tree -----------------------------------------

const FIELD_NOTES = {
  meta: 'About the pack itself.',
  'meta.argumentDisclaimer': 'Show this wherever argument text appears.',
  'meta.notes': 'How to read fullText, official and arguments.',
  measures: 'The 4 ballot measures, in handout order.',
  'measures[].fullText': 'Send this to the model. Deleted words appear as [DELETED: …]; new words are not marked.',
  'measures[].fullTextMarked': 'Same text, with new words also marked [NEW: …]. Use it to draw italic / strikeout.',
  'measures[].wordCount': 'Words in the legal text.',
  'measures[].official': 'ANSWER KEY: show it to people, never send it to a model.',
  'measures[].amendatory': 'Word counts of struck-out (deleted) and italic (new) text.',
  'measures[].arguments': 'Input for the comparison view. 4 documents per measure.',
  'measures[].arguments.*.side': '"yes" = the side urging a YES vote.',
  'measures[].arguments.*.round': '"argument" or "rebuttal".',
  'measures[].arguments.*.respondsTo': 'For a rebuttal: the key of the argument it answers. null for an argument.',
  'measures[].arguments.*.signers': 'Who signed, and for which organization.',
  'measures[].sources': 'Links to the originals: keep them one click from anything generated.',
  offices: 'The 5 down-ballot offices.',
  'offices[].additionalContext': 'Extra facts. kind "boundary" = something the office does NOT control.',
};

function noteFor(path) {
  return FIELD_NOTES[path] || FIELD_NOTES[path.replace(/arguments\.\w+/, 'arguments.*')];
}

function drawStructure() {
  return h('div', {},
    h('p', { class: 'eyebrow' }, 'data/datapack.json'),
    h('h1', {}, 'JSON structure'),
    h('p', { class: 'lead' }, 'The whole file as a tree. Open any branch; the notes say what a field is for in PROG 02.'),
    h('div', { class: 'tree-wrap' }, jsonTree('pack', pack, '', 0, true)));
}

/** A collapsible tree. Children are built the first time a branch opens, so huge strings cost nothing until asked for. */
function jsonTree(key, value, path, depth, open = false) {
  const note = noteFor(path);
  const noteEl = note && h('span', { class: 'jt-note' + (path.endsWith('official') ? ' key' : '') }, note);
  const keyEl = h('span', { class: 'jt-key' }, key);

  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'jt-leaf' }, keyEl, h('span', { class: 'jt-type' }, value === null ? 'null' : typeof value),
      leafValue(value), noteEl);
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const hint = (v) => (v && typeof v === 'object' && (v.id || v.name || v.label)) || '';
  const node = h('details', { class: 'jt-node', open },
    h('summary', {}, keyEl,
      h('span', { class: 'jt-type' }, isArray ? `array [${value.length}]` : `object {${entries.length}}`), noteEl));
  let built = false;
  const build = () => {
    if (built || !node.open) return;
    built = true;
    node.append(h('div', { class: 'jt-children' }, entries.map(([k, v]) => {
      const childKey = isArray ? `[${k}]${hint(v) ? ' ' + hint(v) : ''}` : k;
      const childPath = isArray ? `${path}[]` : path ? `${path}.${k}` : k;
      return jsonTree(childKey, v, childPath, depth + 1, depth < 0);
    })));
  };
  node.addEventListener('toggle', build);
  build();
  return node;
}

function leafValue(value) {
  if (typeof value !== 'string') return h('span', { class: 'jt-value ' + (value === null ? 'null' : typeof value) }, String(value));
  const LIMIT = 140;
  if (value.length <= LIMIT) return h('span', { class: 'jt-value string' }, JSON.stringify(value));
  const span = h('span', { class: 'jt-value string' }, JSON.stringify(value.slice(0, LIMIT)).slice(0, -1) + '…"');
  const more = h('button', { type: 'button', class: 'linkish tiny', onclick: () => {
    span.replaceWith(h('div', { class: 'jt-full' }, value));
    more.remove();
  } }, `show all ${fmt(value.length)} characters`);
  return h('span', {}, span, ' ', more);
}
