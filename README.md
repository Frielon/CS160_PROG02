# PROG 02 API examples (CS160)

Small, runnable examples of calling a language model on the Nov 3, 2026 California ballot measures.
Each example is one HTML page plus one short JS file. The page shows the exact prompt it sends,
the model's answer, and OpenRouter's full JSON reply (tokens and cost included).

> Class examples. Not official voter information.

## Run it

1. Copy `js/config.local.example.js` to `js/config.local.js` and paste your OpenRouter key in.
   Keep your key private: don't share or hand in `js/config.local.js`.
2. Serve the folder (browsers block `fetch()` from `file://`):

   ```bash
   python3 -m http.server 8000
   ```

3. Open http://localhost:8000

## Files

| file | what it is |
|---|---|
| `js/openrouter.js` | `askModel(prompt)`: the one function that calls the API. The model is set at the top. |
| `examples/01-summarize.*` | Pick a measure and a length; the model summarizes the legal text. |
| `js/fk.js` | Flesch–Kincaid reading level (no AI). |
| `examples/02-reading-level.*` | Compute a measure's reading level. No AI. |
| `examples/03-spending.*` | Ask OpenRouter how much your key has spent (`GET /api/v1/key`). Free. |
| `examples/04-reading-level-rewrite.*` | The model rewrites a measure for a chosen grade; `fk.js` checks what grade it actually wrote. |
| `examples/05-topic.*` | The model reads Prop 4 and explains what it means for one topic, "My Taxes": what the text says, then a labelled AI opinion. |
| `examples/06-image.*` | Generate an image from a text prompt (`POST /api/v1/images`). About $0.04 per image. |
| `data/datapack.json` | The ballot measures. Each has `label` (e.g. `"Prop 4"`) and `fullText`, the legal text; words in `[DELETED: ...]` are being removed from the law. `official` holds the state's own summary: show it to people, but don't send it to the model. |
| `pack.offices` (in `datapack.json`) | The five offices on the ballot, from the PROG 02 handout. Not used by these examples yet. |

## The voter guide (our app)

Open http://localhost:8000/guide.html. **The API key goes in `js/config.local.js`** (copy `js/config.local.example.js`, as above).
That is the only place the browser reads it; the scripts in `tools/` read it there too, or from the `OPENROUTER_API_KEY`
environment variable. Without a key the header shows "No API key", and everything that needs no model still works.

The guide is one page with three tabs. The address names the tab and what is picked, so Back, Forward and links work:

| tab | address | what it does |
|---|---|---|
| Read a measure | `guide.html#read/prop-40` | Functionality 1: a measure at the reading level and length you pick, and the voter topics of concern. |
| Compare the two sides | `guide.html#compare/prop-40` | Functionality 2: what each side claims, side by side, from the printed arguments and rebuttals. |
| Down-ballot offices | `guide.html#offices/ac-transit-ward-1` | Functionality 3: what an office decides and does not, and an illustration of something it affects. |

The two measure tabs share the measure you picked. One session cost meter in the header adds up every call from all
three tabs, with a subtotal for each. `compare.html` and `office.html` still work: they open their tab.

| file | what it is |
|---|---|
| `guide.html` | The page: the header (tabs, session cost), the three tabs and the footer. It loads every script below. |
| `js/app.js` | What the tabs share: loads `data/datapack.json` once, switches tabs and keeps the address in step, shares the picked measure between the two measure tabs, and keeps the session cost (`addCost()`, `money()`). Each tab's own script is loaded as a module, so its names stay its own. |
| `js/guide.js`, `css/guide.css` | The Read a measure tab (functionality 1). `css/guide.css` also styles what every tab shares: colors, header, tabs, cards and badges. |
| `js/prompts.js` | Every prompt, the reading levels and lengths, the no-AI checks (words, Flesch–Kincaid, key facts, known misreadings) and the draft → check → one revision pipeline. |
| `js/checker.js` | The fact check: a second model call (Gemini 2.5 Flash) spells out what each claim means, a third checks those meanings against the legal text and quotes it; our code confirms each quote is really in the legal text. Also the final fix: the model proposes edits to flagged sentences only, our code applies them, and each replacement is checked again before it is used. |
| `js/topics.js` | Voter topics of concern: keyword counts per topic (no AI) and the one-topic explanation (quotes checked by code, opinion labeled). |
| `js/legal-text.js`, `js/dom.js` | Draws the certified text with struck-out / italic changes; small DOM helpers. |
| `datapack.html`, `js/datapack.js`, `css/datapack.css` | Data pack explorer: every field of `datapack.json`, readable. No AI. |
| `tools/eval-render.mjs` | Tests the prompts against the API: `node tools/eval-render.mjs --measures all --revise --tag name`. Results go to `tools/.cache/eval/` (not committed). Use `--dry` to see prompt sizes for free; add `--fact-check` to include the fact check. |
| `tools/eval-checker.mjs`, `tools/checker-cases.json` | Tests the fact check on 22 labeled cases (real misreadings, planted errors, correct texts): `node tools/eval-checker.mjs --tag name`. |
| `tools/topics-report.mjs`, `tools/eval-topics.mjs` | Topic counts for every measure (free; `--context <measure> <topic>` shows each match), and a test of the topic explanation (`--tag name`, 20 calls). |
| `tools/eval-fix.mjs` | Tests the final fix on the flags from a saved fact-check run: `node tools/eval-fix.mjs --from c7-flashA-flashB --tag name`. Add `--final-fix` to `eval-render.mjs` for the whole pipeline. |
| `js/compare-view.js`, `css/compare.css` | The Compare the two sides tab (functionality 2). Who wrote and signed the four documents (no AI); on request, each side's claims side by side under five headings, each with its exact quote, AI wording labeled, and whether it was answered, left unanswered, or raised too late to answer; groups both sides claim; the four printed documents with every quoted passage highlighted. `guide.html?replay=s12-final#compare/prop-45` shows a saved test run for free. |
| `compare.html` | Opens the Compare tab; old links, `?replay=` included, keep working. |
| `js/compare.js` | Functionality 2: compare the two sides of a measure from its four printed arguments and rebuttals. Two calls at once return JSON: every claim with its exact quote and a dimension, plus which argument claim each rebuttal claim answers or repeats (Gemini 2.5 Flash); and who each side says stands with it (Flash-Lite). No-AI checks: every quote found in the printed text (side and round come from where it really is), every link checked, answered / not answered / new in a rebuttal worked out by code, groups both sides claim matched word by word, signers straight from the pack. |
| `tools/eval-compare.mjs` | Tests the comparison against the API: `node tools/eval-compare.mjs --measures all --tag name` (about $0.012 a measure). `--model` / `--backers-model` compare models, `--reasoning 2048` adds a thinking budget, `--dry` prints both prompts for free. |
| `js/office-page.js`, `css/office.css` | The Down-ballot offices tab (functionality 3): what the pack says about an office, an AI explanation with every line tagged with its fact, and an AI illustration. |
| `office.html` | Opens the Offices tab. |
| `js/office.js` | Functionality 3: explain a down-ballot office from the pack's facts only, every line citing a numbered fact, including what the office does *not* decide; pick an illustration scene and build the image prompt. No-AI checks: the pack's limits kept, real citations, no outside names or numbers, no powers handed to another office, known misreadings. |
| `tools/test-office.mjs` | Free tests of `js/office.js`, no API key: `node --test tools/test-office.mjs`. |
| `tools/eval-office.mjs` | Tests the office prompts against the API: `node tools/eval-office.mjs --runs 3 --judge --tag name` (about $0.01). `--picks 20` measures how much the scene choice varies; `--images 1` draws one picture per office (about $0.04 each; more than 5 need `--yes`) and writes a contact sheet to `tools/.cache/eval/<tag>/`. `--dry` is free. |


