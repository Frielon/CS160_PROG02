// Represent! Functionality 3: what a down-ballot office decides, and what it does not.
//
// The data pack's own words come first, unchanged and marked as such. "Explain with AI" makes one
// Flash-Lite call (explainOffice() in js/office.js): the model may use only those facts, every line
// it writes cites one, and our checks (no AI) run on the reply before anyone reads it.
// "Draw an illustration" makes two calls: Flash-Lite picks one of two scenes we wrote for the office,
// then the image model draws it. Everything generated is labeled, every time.
//
// This is the guide's "Down-ballot offices" tab (guide.html#offices). It is a module: js/app.js loads
// the pack, shows the tab, remembers the office you picked, and keeps the session cost for all three tabs.

const OFFICE_TEXT_MODEL_NAME = 'Gemini 2.5 Flash-Lite';
const OFFICE_IMAGE_MODEL_NAME = 'Gemini 2.5 Flash Image';
// Shown before a call. The real cost comes back in usage.cost, and that is what the meter counts.
const OFFICE_ESTIMATE = { explain: 0.0005, draw: 0.039 };

const LIMIT_KINDS = {
  limit: { label: 'Stated in the pack', note: 'The data pack states this limit outright.' },
  'other-office': { label: 'Another office decides', note: 'The data pack gives this to a different office on your ballot.' },
  coverage: { label: 'From the pack’s wording', note: 'This follows from a limiting word in the data pack, such as “most”.' },
};

const explanations = new Map(); // office id → { result, at } or { error }
const pictures = new Map();     // office id → every picture drawn this visit, oldest first
const pictureErrors = new Map(); // office id → message
const shownPicture = new Map(); // office id → index of the picture on show (default: the newest)
const pending = new Map();      // "office id|explain" or "office id|draw" → { started }

const byId = (id) => document.getElementById(id);
const currentOffice = () => app.pack.offices.find((o) => o.id === app.officeId);

// ---- 1. Start: js/app.js calls drawPage() to show the tab ------------------------------------

registerView('offices', { draw: drawPage });

// The office is in the address (#offices/<id>), and js/app.js remembers it for the next visit.
function chooseOffice(id) {
  go({ officeId: id });
}

function drawPage() {
  drawPicker();
  drawOffice();
}

// ---- 2. Session cost: js/app.js keeps it for all three tabs (addCost, money) ----------------

// ---- 3. Picker and page ---------------------------------------------------------------------

function drawPicker() {
  byId('office-picker').replaceChildren(...app.pack.offices.map((o) => h('button', {
    type: 'button', class: 'pick', 'aria-pressed': String(o.id === app.officeId), onclick: () => chooseOffice(o.id),
  },
  h('span', { class: 'pick-label' }, o.name),
  h('span', { class: 'pick-title' }, o.jurisdiction))));
}

function drawOffice() {
  const office = currentOffice();
  byId('office-main').replaceChildren(
    sourceCard(office),
    h('div', { class: 'office-grid' },
      h('section', { class: 'office-col', 'aria-label': 'Explanation' }, explainPanel(office)),
      h('section', { class: 'office-col', 'aria-label': 'Illustration' }, picturePanel(office), sceneMenu(office))));
}

/** What the pack says, numbered the way the prompt numbers it, so every citation below points here. */
function sourceCard(office) {
  const { own, limits } = officeFacts(office, app.pack.offices);
  const sources = new Map((office.additionalContext || []).map((c) => [c.fact, c.source]));
  return h('article', { class: 'card certified source' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge cert' }, 'From the data pack'),
      h('span', { class: 'card-kind' }, `${office.name} · ${office.jurisdiction}`),
      h('p', { class: 'provenance' }, 'Exactly what data/datapack.json says about this office. Not generated: the AI explanation below may use these facts and nothing else.')),
    h('ol', { class: 'fact-list' }, [...own, ...limits].map((f) => h('li', { id: `fact-${f.id}`, title: sources.get(f.text) || office.source },
      h('span', { class: 'fact-id' }, f.id),
      h('span', {}, f.text, f.id.startsWith('B') && [' ', h('span', { class: 'kind limit' }, 'A limit the pack states')])))),
    h('p', { class: 'small muted' }, `Source: ${office.source}. That is all the pack says about this office.`));
}

function workingCard(title, text, key) {
  return h('article', { class: 'card ai working' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, title),
      h('span', { class: 'elapsed', 'data-key': key }, '0.0 s')),
    h('div', { class: 'progress' }, h('span')),
    h('p', {}, text),
    h('p', { class: 'small muted' }, 'You can look at another office meanwhile; this keeps running.'));
}

setInterval(() => {
  if (!pending.size) return;
  for (const el of document.querySelectorAll('.elapsed[data-key]')) {
    const job = pending.get(el.dataset.key);
    if (job) el.textContent = `${((Date.now() - job.started) / 1000).toFixed(1)} s`;
  }
}, 200);

function errorNotice(message, retry) {
  return h('div', { class: 'notice bad' }, h('b', {}, 'The call failed: '), message,
    h('p', {}, h('button', { type: 'button', class: 'primary', onclick: retry }, 'Try again')));
}

// ---- 4. The explanation -----------------------------------------------------------------------

function explainPanel(office) {
  const key = `${office.id}|explain`;
  const saved = explanations.get(office.id);
  if (pending.has(key)) {
    return workingCard('Explanation', `${OFFICE_TEXT_MODEL_NAME} is reading the facts about the ${office.name} and writing an everyday explanation…`, key);
  }
  if (saved?.error) return errorNotice(saved.error, () => explain(office));
  if (saved) return explanationCard(office, saved);
  return h('div', { class: 'ready' },
    h('p', { class: 'eyebrow' }, 'Explanation'),
    h('h2', {}, 'Explain this office'),
    h('p', {}, `One call to ${OFFICE_TEXT_MODEL_NAME} turns the facts above into everyday words, and says what this office does not decide. `
      + 'It may use those facts and nothing else. Every line it writes shows which fact it came from, and our code checks the reply before you see it.'),
    h('p', {}, h('button', { type: 'button', class: 'primary', onclick: () => explain(office) }, 'Explain with AI')),
    h('p', { class: 'small muted' }, `About ${money(OFFICE_ESTIMATE.explain)} and 2 seconds.`));
}

async function explain(office) {
  const key = `${office.id}|explain`;
  if (pending.has(key)) return;
  pending.set(key, { started: Date.now() });
  drawOffice();
  const send = async (messages, opts) => {
    const data = await chat(messages, opts);
    addCost(`${office.name} · explanation`, data.usage?.cost ?? 0, 'offices');
    return data;
  };
  try {
    explanations.set(office.id, { result: await explainOffice(office, app.pack.offices, send), at: Date.now() });
  } catch (err) {
    explanations.set(office.id, { error: err.message });
  } finally {
    pending.delete(key);
    if (app.officeId === office.id) drawOffice();
  }
}

function explanationCard(office, { result, at }) {
  const x = result.explanation;
  const check = result.check;
  const facts = new Map(officeFacts(office, app.pack.offices).all.map((f) => [f.id, f]));
  const problems = check.flags.filter((f) => f.level === 'bad');
  const list = (title, items, line) => items.length > 0 && h('div', { class: 'ex-section' },
    h('h3', {}, title), h('ul', {}, items.map((it) => h('li', {}, line(it)))));

  return h('article', { class: 'card ai explainer' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated'),
      h('span', { class: 'card-kind' }, 'Explanation'),
      h('p', { class: 'provenance' }, `Written by ${OFFICE_TEXT_MODEL_NAME} from the data-pack facts above and nothing else. `
        + 'The tag after each line shows the fact it came from. It can still get things wrong.')),
    problems.length > 0 && h('div', { class: 'notices' },
      problems.map((f) => h('p', { class: 'notice bad' }, h('b', {}, 'Our check: '), f.text))),
    h('h2', { class: 'ex-title' }, x.title),
    h('p', { class: 'ex-summary' }, x.summary),
    list('What it decides', x.decides, (it) => [it.text, cites(it.facts, facts)]),
    list('What it does not decide', x.doesNotDecide, (it) => [kindTag(it.kind), ' ', it.text, cites(it.facts, facts)]),
    list('About this seat', x.aboutTheSeat, (it) => [it.text, cites(it.facts, facts)]),
    list('Questions the data pack does not answer', x.openQuestions, (q) => q),
    h('p', { class: 'ai-foot' }, `AI-generated by ${OFFICE_TEXT_MODEL_NAME} · ${(result.ms / 1000).toFixed(1)} s · ${money(result.cost)} · `
      + `${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
    checkList(check),
    h('details', { class: 'more' }, h('summary', {}, 'What we sent the model'), promptView(result.messages)),
    h('p', { class: 'again' },
      h('button', { type: 'button', class: 'secondary', onclick: () => explain(office) }, 'Write a new version'),
      h('span', { class: 'small muted' }, ` another call, about ${money(OFFICE_ESTIMATE.explain)}`)));
}

/** Citation tags. Hovering one lights up its fact above; another office's tag opens that office. */
function cites(ids, facts) {
  return h('span', { class: 'cites' }, ids.map((id) => {
    const f = facts.get(id);
    if (f?.officeId) {
      return h('button', { type: 'button', class: 'cite other', title: `${f.name}: ${f.text}`, onclick: () => chooseOffice(f.officeId) },
        f.name.replace(/,.*$/, ''));
    }
    const light = (on) => byId(`fact-${id}`)?.classList.toggle('lit', on);
    return h('button', {
      type: 'button', class: 'cite', title: f ? `${id}: ${f.text}` : id,
      onmouseenter: () => light(true), onmouseleave: () => light(false), onfocus: () => light(true), onblur: () => light(false),
      onclick: () => byId(`fact-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    }, id);
  }));
}

function kindTag(kind) {
  const k = LIMIT_KINDS[kind] || { label: kind, note: '' };
  return h('span', { class: `kind ${kind}`, title: k.note }, k.label);
}

function checkList(check) {
  const rows = [
    ...check.boundaries.map((b) => ({ ok: b.ok, text: `Keeps the pack’s limit: ${b.fact}` })),
    ...check.keyFacts.map((k) => ({ ok: k.ok, text: `Mentions that ${k.fact}` })),
    { ok: !check.bad, text: check.bad ? `${check.bad} rule break${check.bad === 1 ? '' : 's'}, shown above`
      : 'No name, number or power the data pack does not give' },
  ];
  const looks = check.flags.filter((f) => f.level === 'warn');
  return h('div', { class: 'facts' },
    h('p', { class: 'facts-head' }, 'What our code checked ', h('span', { class: 'muted' }, '(word checks, no AI; they can miss a rewording)')),
    h('ul', {}, rows.map((r) => h('li', { class: r.ok ? 'ok' : 'off' },
      h('span', { class: 'mark', 'aria-hidden': 'true' }, r.ok ? '✓' : '✗'), h('span', { class: 'sr' }, r.ok ? 'Passed: ' : 'Failed: '), r.text))),
    looks.length > 0 && h('ul', { class: 'looks' }, looks.map((f) => h('li', { class: 'off' },
      h('span', { class: 'mark', 'aria-hidden': 'true' }, '!'), h('span', { class: 'sr' }, 'Worth a look: '), f.text))));
}

function promptView(messages) {
  return h('div', { class: 'prompt' }, messages.map((m) => h('div', { class: 'prompt-msg' },
    h('div', { class: 'prompt-role' }, m.role === 'system' ? 'System' : 'User'),
    h('pre', {}, m.content))));
}

// ---- 5. The illustration ----------------------------------------------------------------------

function picturePanel(office) {
  const key = `${office.id}|draw`;
  const list = pictures.get(office.id) || [];
  if (pending.has(key)) {
    return workingCard('Illustration', `Flash-Lite is picking one of two scenes, then ${OFFICE_IMAGE_MODEL_NAME} draws it. Usually 8 to 12 seconds.`, key);
  }
  const error = pictureErrors.get(office.id) && errorNotice(pictureErrors.get(office.id), () => draw(office));
  if (list.length) return [error, pictureCard(office, list)];
  const scenes = OFFICE_DESIGN[office.id]?.scenes || [];
  return [error, h('div', { class: 'ready' },
    h('p', { class: 'eyebrow' }, 'Illustration'),
    h('div', { class: 'art-empty' }, 'No picture yet'),
    h('p', {}, `Flash-Lite picks one of two scenes we wrote for this office (${scenes.length} in all), and ${OFFICE_IMAGE_MODEL_NAME} draws it.`),
    h('p', {}, h('button', { type: 'button', class: 'primary', onclick: () => draw(office), disabled: !scenes.length }, 'Draw an illustration')),
    h('p', { class: 'small muted' }, `About ${money(OFFICE_ESTIMATE.draw)} and 10 seconds per picture.`))];
}

async function draw(office) {
  const key = `${office.id}|draw`;
  if (pending.has(key)) return;
  pending.set(key, { started: Date.now() });
  drawOffice();
  const send = async (messages, opts) => {
    const data = await chat(messages, opts);
    addCost(`${office.name} · scene pick`, data.usage?.cost ?? 0, 'offices');
    return data;
  };
  const sendImage = async (prompt, opts) => {
    const data = await requestImage(prompt, opts);
    addCost(`${office.name} · illustration`, data.usage?.cost ?? 0, 'offices');
    return data;
  };
  const list = pictures.get(office.id) || [];
  try {
    const { data, image, ...r } = await illustrateOffice(office, send, sendImage, {
      exclude: list.map((p) => p.scene.id),
      explanation: explanations.get(office.id)?.result?.explanation.summary || '',
    });
    const original = `data:${image.mediaType};base64,${image.b64}`;
    list.push({ ...r, original, display: (await trimFrame(original)) || original, at: Date.now() });
    pictures.set(office.id, list);
    shownPicture.delete(office.id);
    pictureErrors.delete(office.id);
  } catch (err) {
    pictureErrors.set(office.id, err.message);
  } finally {
    pending.delete(key);
    if (app.officeId === office.id) drawOffice();
  }
}

/** POST /api/v1/images, the same request as examples/06-image.js. */
async function requestImage(prompt, { model, aspectRatio }) {
  if (typeof OPENROUTER_API_KEY === 'undefined' || OPENROUTER_API_KEY.startsWith('YOUR_')) {
    throw new Error('No API key. Copy js/config.local.example.js to js/config.local.js and paste your key in.');
  }
  const response = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENROUTER_API_KEY },
    body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: aspectRatio }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || response.statusText);
  return data;
}

function pictureCard(office, list) {
  const i = shownPicture.get(office.id) ?? list.length - 1;
  const p = list[i];
  const label = (id) => OFFICE_DESIGN[office.id].scenes.find((s) => s.id === id)?.label || id;
  return h('figure', { class: 'card ai art' },
    h('header', { class: 'card-head' },
      h('span', { class: 'badge ai' }, 'AI-generated image'),
      h('span', { class: 'card-kind' }, p.scene.label),
      h('p', { class: 'provenance' }, `Drawn by ${OFFICE_IMAGE_MODEL_NAME}. Not a photograph: the place and the people are invented. `
        + `It illustrates “${p.scene.shows}” from the data pack.`)),
    h('div', { class: 'art-frame' }, h('img', { src: p.display, alt: `AI-generated illustration: ${p.scene.label}` })),
    h('figcaption', { class: 'ai-foot' }, `AI-generated · ${(p.ms / 1000).toFixed(1)} s · ${money(p.cost)} · `,
      h('a', { href: p.original, download: `${office.id}-${p.scene.id}.png` }, 'Download')),
    list.length > 1 && h('div', { class: 'thumbs', 'aria-label': 'Pictures drawn for this office' }, list.map((q, j) => h('button', {
      type: 'button', class: 'thumb', 'aria-pressed': String(i === j), title: q.scene.label,
      onclick: () => { shownPicture.set(office.id, j); drawOffice(); },
    }, h('img', { src: q.display, alt: q.scene.label })))),
    h('p', { class: 'again' },
      h('button', { type: 'button', class: 'secondary', onclick: () => draw(office) }, 'Draw another'),
      h('span', { class: 'small muted' }, ` a different scene, about ${money(OFFICE_ESTIMATE.draw)}`)),
    h('details', { class: 'more' }, h('summary', {}, 'How this scene was chosen'),
      h('p', { class: 'small' }, `Our code offered ${p.pick.offered.map((id) => `“${label(id)}”`).join(' or ')}. `,
        p.pick.fallback ? 'Flash-Lite’s answer was not one of them, so we used the first.' : `Flash-Lite picked “${p.scene.label}”.`)),
    h('details', { class: 'more' }, h('summary', {}, 'The image prompt'), h('div', { class: 'prompt' }, h('pre', {}, p.prompt))));
}

/** Every scene this office can get: the visual system, in the open. */
function sceneMenu(office) {
  const scenes = OFFICE_DESIGN[office.id]?.scenes || [];
  const drawnIds = new Set((pictures.get(office.id) || []).map((p) => p.scene.id));
  return h('details', { class: 'more scenes' },
    h('summary', {}, `All ${scenes.length} scenes we wrote for this office`),
    h('ul', { class: 'scene-list' }, scenes.map((s) => h('li', { class: drawnIds.has(s.id) ? 'drawn' : '' },
      h('b', {}, s.label), ` shows “${s.shows}”`, drawnIds.has(s.id) ? ' (drawn)' : ''))));
}

/**
 * Image models sometimes paint a plain white margin around the picture (3 of our 7 test images).
 * Trim it, so every picture fills its card the same way. Returns a new data URL, or null if no frame.
 */
function trimFrame(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      const w = img.naturalWidth;
      const ht = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = ht;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, w, ht).data;
      const pale = (x, y) => { const i = 4 * (y * w + x); return px[i] > 228 && px[i + 1] > 228 && px[i + 2] > 228; };
      if (![[0, 0], [w - 1, 0], [0, ht - 1], [w - 1, ht - 1]].every(([x, y]) => pale(x, y))) return resolve(null);
      // A line is margin when nearly every pixel sampled along it is pale.
      const blank = (n, at) => { let dark = 0; for (let k = 0; k < n; k += 3) if (!at(k)) dark++; return dark <= n / 300; };
      let top = 0;
      let bottom = ht;
      let left = 0;
      let right = w;
      while (top < ht * 0.2 && blank(w, (x) => pale(x, top))) top++;
      while (bottom > ht * 0.8 && blank(w, (x) => pale(x, bottom - 1))) bottom--;
      while (left < w * 0.2 && blank(ht, (y) => pale(left, y))) left++;
      while (right > w * 0.8 && blank(ht, (y) => pale(right - 1, y))) right--;
      if (top + left + (ht - bottom) + (w - right) < 12) return resolve(null);
      const out = document.createElement('canvas');
      out.width = right - left;
      out.height = bottom - top;
      out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
      resolve(out.toDataURL('image/jpeg', 0.92));
    };
    img.src = src;
  });
}
