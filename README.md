# Represent!

A one-page guide to the November 3, 2026 California ballot, for CS160 PROG 02. AI models translate,
compare and explain; our code checks what they return, and everything they write or draw is labeled.

> Class project. Not official voter information.

## Run it

1. Copy `js/config.local.example.js` to `js/config.local.js` and paste your OpenRouter key into
   `OPENROUTER_API_KEY`. That file is in `.gitignore`: never commit it. Without a key the header says
   "No API key", and every part that needs no model still works.
2. Serve the folder (browsers block `fetch()` from `file://`):

   ```bash
   python3 -m http.server 8000
   ```

3. Open http://localhost:8000/guide.html

## The three tabs

| tab | address | what it does |
|---|---|---|
| Read a measure | `guide.html#read/prop-40` | Functionality 1: a measure at the reading level and length you pick, written from the legal text and fact-checked against it; voter topics of concern. |
| Compare the two sides | `guide.html#compare/prop-40` | Functionality 2: each side's claims from the printed arguments and rebuttals, side by side, and how the two sides answered each other. |
| Down-ballot offices | `guide.html#offices/ac-transit-ward-1` | Functionality 3: what an office decides and does not, every line citing the data pack, and an illustration. |

The address names the tab and what is picked, so Back, Forward and links work. The two measure tabs
share the picked measure. The session cost in the header adds up every call, with a subtotal per tab.

## Files

| file | what it is |
|---|---|
| `guide.html` | The page: header (tabs, session cost), the three tabs, footer. |
| `js/app.js` | What the tabs share: loads `data/datapack.json` once, switches tabs, keeps the address and the session cost. |
| `js/guide.js`, `css/guide.css` | Read a measure; `css/guide.css` also styles what every tab shares. |
| `js/prompts.js`, `js/checker.js`, `js/topics.js` | Rendering prompts and pipeline; the fact check and final fix; topics of concern. |
| `js/compare-view.js`, `js/compare.js`, `css/compare.css` | Compare the two sides: the tab; its prompts, schemas and no-AI checks. |
| `js/office-page.js`, `js/office.js`, `css/office.css` | Down-ballot offices: the tab; design data, prompts, checks, scene picks and image prompts. |
| `js/openrouter.js` | `chat()`, the one function that calls the API. |
| `js/fk.js`, `js/dom.js`, `js/legal-text.js` | Flesch–Kincaid reading grade; DOM helpers; drawing the certified text. |
| `js/config.local.example.js` | Copy to `js/config.local.js` and paste your key in. |
| `data/datapack.json` | The four measures and five offices. `official` is the state's own summary: shown to readers, never sent to a model. |
| `tools/` | Tests of the prompts and checks. Live runs need a key and write to `tools/.cache/` (not committed). |

## Tests

These need no API key and cost nothing:

```bash
node --test tools/test-office.mjs        # 21 tests of the office checks
node tools/topics-report.mjs             # topic word counts for every measure
node tools/eval-render.mjs --dry         # prompt sizes; eval-compare.mjs and eval-office.mjs also take --dry
```
