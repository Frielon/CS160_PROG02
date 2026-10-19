// The certified legal text, drawn the way the guide prints it. No AI.
//
// fullTextMarked wraps new words in [NEW: ...] and struck-out words in [DELETED: ...].
// Spans never nest and never cross a paragraph, but the law itself sometimes uses brackets,
// like “interest[s]”, so we match brackets instead of stopping at the first “]”.
// Needs js/dom.js.

const MARK_OPEN = /\[(NEW|DELETED): /g;
const SECTION_RE = /^(SECTION \d+\.|SEC\. \d+(?:\.\d+)?\.|PROPOSED (?:LAW|AMENDMENT\b.*))/;
const ARTICLE_RE = /Article \d+\. [^.]{3,120}? (?=\d{5}\. )/g;

/** @returns {Array<Array<{kind:'plain'|'new'|'deleted', text:string}>>} one array of runs per paragraph */
function parseMarked(marked) {
  return marked.split(/\n{2,}/).map(parseRuns);
}

function parseRuns(para) {
  const runs = [];
  let pos = 0;
  let match;
  MARK_OPEN.lastIndex = 0;
  while ((match = MARK_OPEN.exec(para))) {
    if (match.index > pos) runs.push({ kind: 'plain', text: para.slice(pos, match.index) });
    let depth = 1;
    let j = MARK_OPEN.lastIndex;
    for (; j < para.length && depth > 0; j++) {
      if (para[j] === '[') depth++;
      else if (para[j] === ']') depth--;
    }
    const end = depth === 0 ? j - 1 : para.length;
    runs.push({ kind: match[1].toLowerCase(), text: para.slice(MARK_OPEN.lastIndex, end) });
    pos = MARK_OPEN.lastIndex = j;
  }
  if (pos < para.length) runs.push({ kind: 'plain', text: para.slice(pos) });
  return runs;
}

/**
 * One paragraph as a <p>. mode 'marked' shows <ins>/<del>; 'clean' drops deleted words.
 * Section starts and Prop 45's run-in "Article N." headings get an id and are pushed onto headings.
 */
function renderLegalParagraph(runs, mode, id, headings) {
  const kept = mode === 'clean' ? runs.filter((r) => r.kind !== 'deleted') : runs;
  const plain = kept.map((r) => r.text).join('').trim();
  if (!plain) return null;

  const p = h('p');
  const sec = plain.match(SECTION_RE);
  if (sec) {
    p.id = id;
    p.className = 'sec-start';
    headings.push({ id, level: 1, label: shorten(plain, sec[0].length + 40) });
  }
  let n = 0;
  for (const run of kept) {
    const target = run.kind === 'plain' || mode === 'clean' ? p : p.appendChild(h(run.kind === 'new' ? 'ins' : 'del'));
    let pos = 0;
    for (const a of run.text.matchAll(ARTICLE_RE)) {
      const anchor = `${id}-a${n++}`;
      target.append(run.text.slice(pos, a.index), h('strong', { id: anchor, class: 'inline-head' }, a[0]));
      headings.push({ id: anchor, level: 2, label: a[0].trim() });
      pos = a.index + a[0].length;
    }
    target.append(run.text.slice(pos));
  }
  return p;
}

function shorten(text, max) {
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}
