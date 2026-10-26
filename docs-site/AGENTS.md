# a.yash0.in site

A static docs and performance-report site published at `https://a.yash0.in/<slug>/`. It uses the also.codes look: dark, orange accent, Geist Pixel headings. There is no build tool and nothing to install. Pages are plain HTML, and `assets/` holds the shared CSS, page shell and charts.

## Start a site

From the template, run `node ~/code/a-site-template/scripts/site.mjs new <slug> <dir> --title "Title"`. The slug is the URL path: lowercase letters, digits and dashes. Then work inside `<dir>`:

```sh
npm run dev      # http://localhost:4321/<slug>/ and rebuilds on save
npm run build    # checks links and limits, then writes dist/
npm run deploy   # publishes the site and adds it to the a.yash0.in index
```

`deploy` refuses a slug that is already live unless this folder published it (`.a-site.json`). Don't pass `--replace` unless the user asked you to overwrite that site. `npm run remove -- --yes` takes the site down and removes it from the index. Only run it when the user asks.

## Files

| Path | Edit? | Purpose |
|---|---|---|
| `src/site.config.js` | yes | Slug, title, updated date, sidebar `nav`, top bar `links` |
| `src/*.html` | yes | One file per page. Keep pages flat in `src/`, no subfolders. |
| `src/data/*.json` | yes | Chart data loaded with `data-src` |
| `src/assets/site.css`, `site.js`, `charts.js` | no | Shared kit. Fix bugs here, don't fork styles per page. |
| `src/404.html` | rarely | Not-found page |

`index.html` shows a full perf report. `components.html` shows every block with its markup. Read it before writing a page, then replace the example pages and drop `components.html` from `nav`. Delete the file too, unless the user wants to keep it.

## Page skeleton

Copy the `<head>` from `src/index.html`. Leave out `charts.js` on pages without charts. The body is always:

```html
<main class="doc-main">
  <header class="doc-head">
    <p class="eyebrow cap">Section</p>
    <h1>Lead with the result</h1>
    <p class="lede">One or two sentences.</p>
    <div class="doc-meta"><span>Commit <b>abc123</b></span><span class="badge ok">Shipped</span></div>
  </header>
  <article class="doc-body">
    <h2>…</h2>  <!-- each h2 becomes an "On this page" entry -->
  </article>
</main>
```

Add `<body data-layout="wide">` for a page with many charts. It drops the right-hand contents column.

## Blocks

- **Stat tile:** `<div class="stats"><div class="stat" data-label="p95" data-value="168" data-before="412" data-unit="ms" data-better="lower"></div></div>`. The kit computes the change and labels it better or worse.
- **Chart:** `<figure class="chart"><script type="application/json">{spec}</script><figcaption>source</figcaption></figure>`, or `<figure class="chart" data-src="data/x.json">`.
  - `line`: `{ "type": "line", "title", "unit", "x": [...], "series": [{ "name", "values": [...] }], "marks": [{ "x", "label" }] }`
  - `bar`: same shape as `line`, for comparing categories
  - `compare`: `{ "type": "compare", "better": "lower", "labels": ["Before","After"], "rows": [{ "label", "before", "after", "unit"?, "better"? }], "scale": "row"? }`
- **Callout:** `<div class="callout tip|warn"><p class="cap">Tip</p><p>…</p></div>`
- **Code:** `<pre data-title="terminal"><code>…</code></pre>`. Escape `<`, `>` and `&`. Mark diff lines with `<span class="add|del|dim">`.
- **Table:** plain `<table>`. Use `class="num"` on numeric cells.
- **Others:** `.badge ok|warn|bad`, `ol.steps > li > div`, `.cards > a.card` with `<b>` and `<span>`

## Chart rules

- Use `compare` for before and after, `line` for change over time or across sizes, and `bar` for categories. Use a stat tile for a single headline number.
- Up to 5 series. Colours follow series order, so keep the same series order on every chart in a site.
- Use one unit per chart and never two y-axes. Split measures with different units into separate charts.
- Always set `better` on `compare` and stat tiles. Never colour a change green by hand.
- Put real measured numbers in the charts. Say in the figcaption or the Methodology page how they were measured, including run count, machine and median or mean.

## Paths

The site lives under `/<slug>/`, so every link and asset path must be relative (`assets/site.css`, `methodology.html`, `./`). `href="/"` is the only allowed root path, and it links to the a.yash0.in index. `build` fails on anything else, and on links to missing files.

Limits are 25 MiB per file and 20,000 files. Hosting is static only: no server code, no build step and no npm packages in the page.
