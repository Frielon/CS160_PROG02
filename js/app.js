// Represent! The voter guide is one page with three tabs. This file is the part they share: it loads
// data/datapack.json once, switches tabs, and keeps the session cost that every API call adds to.
//
//   #read/<measure id>     Read a measure          js/guide.js          functionality 1
//   #compare/<measure id>  Compare the two sides   js/compare-view.js   functionality 2
//   #offices/<office id>   Down-ballot offices     js/office-page.js    functionality 3
//
// The two measure tabs share the measure you picked, so moving between them keeps your place.
// Each tab's file is loaded as a module, so its own names (state, draw, ...) stay its own; it reaches
// this file through registerView(), go(), addCost() and money().

const TABS = [
  { id: 'read', label: 'Read a measure' },
  { id: 'compare', label: 'Compare the two sides' },
  { id: 'offices', label: 'Down-ballot offices' },
];

const app = { pack: null, tab: 'read', measureId: null, officeId: null, views: new Map() };
const drawnFor = new Map(); // tab id → the measure or office it was last drawn for

/** Each tab's file calls this once: init() runs when the pack is in, draw() when the tab is shown. */
function registerView(tab, view) {
  app.views.set(tab, view);
}

// ---- 1. Tabs and the address bar -----------------------------------------------------------

/** "#compare/prop-40" → { tab: 'compare', id: 'prop-40' }. An unknown tab reads as the first one. */
function readHash() {
  const [tab, id] = location.hash.slice(1).split('/');
  return { tab: TABS.some((t) => t.id === tab) ? tab : TABS[0].id, id };
}

const pickFor = (tab) => (tab === 'offices' ? app.officeId : app.measureId);
const hashFor = (tab) => `#${tab}/${pickFor(tab)}`;

/**
 * Change tab and/or what is picked: go({ tab: 'compare' }), go({ measureId: 'prop-40' }), go({ officeId }).
 * A new tab is a new history entry, so Back returns to the last tab; a new pick replaces the entry.
 */
function go(change) {
  const newTab = Boolean(change.tab) && change.tab !== app.tab;
  pick(change);
  history[newTab ? 'pushState' : 'replaceState'](null, '', hashFor(app.tab));
  showTab(newTab);
}

/** Keep the valid parts of a change, and remember the picks for the next visit. */
function pick({ tab, measureId, officeId }) {
  if (TABS.some((t) => t.id === tab)) app.tab = tab;
  if (app.pack.measures.some((m) => m.id === measureId)) app.measureId = measureId;
  if (app.pack.offices.some((o) => o.id === officeId)) app.officeId = officeId;
  try {
    localStorage.setItem('represent.measure', app.measureId);
    localStorage.setItem('represent.office', app.officeId);
  } catch { /* storage blocked: fine */ }
}

// A tab link, Back and Forward, or an address typed by hand.
window.addEventListener('hashchange', () => {
  if (!app.pack) return;
  const { tab, id } = readHash();
  const newTab = tab !== app.tab;
  pick(tab === 'offices' ? { tab, officeId: id } : { tab, measureId: id });
  history.replaceState(null, '', hashFor(app.tab)); // "#compare" → "#compare/prop-40"
  showTab(newTab);
});

/** Show the current tab and hide the others. A tab is drawn again only when its pick has changed. */
function showTab(newTab = false) {
  for (const t of TABS) {
    document.getElementById(`tab-${t.id}`).hidden = t.id !== app.tab;
    const a = document.querySelector(`.tabs a[data-tab="${t.id}"]`);
    if (app.pack) a.href = hashFor(t.id);
    if (t.id === app.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${TABS.find((t) => t.id === app.tab).label} · Represent! Voter Guide`;
  if (!app.pack) return;

  const panel = document.getElementById(`tab-${app.tab}`);
  const view = app.views.get(app.tab);
  if (!view && !panel.querySelector('.view-error')) {
    panel.prepend(h('p', { class: 'notice bad view-error' }, 'This part of the guide did not load. The browser console says why.'));
  }
  if (view && drawnFor.get(app.tab) !== pickFor(app.tab)) {
    drawnFor.set(app.tab, pickFor(app.tab));
    view.draw();
  }
  if (newTab) {
    window.scrollTo(0, 0);
    // A link inside the old tab is hidden now: move keyboard focus to the new tab's heading.
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.closest('[hidden]')) panel.querySelector('h1')?.focus({ preventScroll: true });
  }
}

// ---- 2. Start: the pack, then every tab ------------------------------------------------------

app.tab = readHash().tab;
showTab(); // the tab the address names, right away, while the pack loads

// guide.html loads this file as a plain script before the tabs' modules, and modules run before
// DOMContentLoaded, so by then every tab has registered.
const domReady = new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve);
  else resolve();
});

const packReady = fetch('data/datapack.json').then((response) => {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}.`);
  return response.json();
});

Promise.all([packReady, domReady]).then(([pack]) => startGuide(pack), (err) => {
  document.querySelector('main').replaceChildren(h('div', { class: 'notice bad' },
    h('b', {}, 'Could not load data/datapack.json. '), err.message,
    ' Serve this folder (python3 -m http.server 8000) and open http://localhost:8000/guide.html.'));
});

function startGuide(pack) {
  app.pack = pack;
  document.getElementById('election').textContent = pack.meta.election;
  const saved = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  app.measureId = pack.measures[0].id;
  app.officeId = pack.offices[0].id;
  pick({ measureId: saved('represent.measure'), officeId: saved('represent.office') });
  const { tab, id } = readHash();
  pick(tab === 'offices' ? { tab, officeId: id } : { tab, measureId: id });
  for (const view of app.views.values()) view.init?.();
  history.replaceState(null, '', hashFor(app.tab));
  showTab();
}

// ---- 3. Session cost: every call any tab makes, with the cost OpenRouter reported ---------------

const session = loadSession();
drawMeter();

function loadSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('represent.session'));
    if (saved && typeof saved.total === 'number' && Array.isArray(saved.calls)) return saved;
  } catch { /* storage blocked */ }
  return { total: 0, calls: [] };
}

/** Every API call is counted here: label says what it was, tab which part of the guide made it. */
function addCost(label, cost, tab) {
  session.total += cost;
  session.calls.push({ label, cost, tab, at: Date.now() });
  try { sessionStorage.setItem('represent.session', JSON.stringify(session)); } catch { /* fine */ }
  drawMeter();
}

function drawMeter() {
  const n = session.calls.length;
  const parts = TABS.map((t) => ({ label: t.label, calls: session.calls.filter((c) => c.tab === t.id) }))
    .filter((p) => p.calls.length);
  document.getElementById('meter-total').textContent = money(session.total);
  document.getElementById('meter-calls').textContent = `${n} call${n === 1 ? '' : 's'}`;
  document.getElementById('meter-panel').replaceChildren(
    h('p', { class: 'small muted' }, 'Every API call this browser tab made, with the cost OpenRouter reported for it.'),
    parts.length > 0 && h('ul', { class: 'meter-parts' }, parts.map((p) => h('li', {},
      h('span', {}, p.label, h('span', { class: 'muted' }, ` · ${p.calls.length} call${p.calls.length === 1 ? '' : 's'}`)),
      h('span', { class: 'num' }, money(p.calls.reduce((sum, c) => sum + c.cost, 0)))))),
    n
      ? h('ol', { class: 'calls', reversed: true }, [...session.calls].reverse().map((c) => h('li', {},
        h('span', { class: 'num' }, money(c.cost)), h('span', {}, c.label))))
      : h('p', { class: 'small' }, 'No calls yet. The certified text, the printed arguments and the data pack never make one.'));
}

function money(n) {
  return '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
}

// ---- 4. No key, no AI: say so up front instead of on the first click ----------------------------

document.getElementById('key-missing').hidden = typeof OPENROUTER_API_KEY !== 'undefined' && !OPENROUTER_API_KEY.startsWith('YOUR_');
