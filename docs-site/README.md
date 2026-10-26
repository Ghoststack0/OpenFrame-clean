# a.yash0.in site template

A boilerplate for docs and performance write-ups hosted at `https://a.yash0.in/<slug>/`. It uses the also.codes design. Charts, stat tiles, code blocks, callouts and tables are built in, with no dependencies and no build step.

```sh
node ~/code/a-site-template/scripts/site.mjs new my-report ~/code/my-report --title "My report"
cd ~/code/my-report
npm run dev       # preview at http://localhost:4321/my-report/
npm run deploy    # publish and add to the a.yash0.in index
```

Each site deploys as its own Cloudflare Worker, `a-site-<slug>`, that serves static assets on `a.yash0.in/<slug>/*`. `deploy` also adds the site to `~/code/a-index` and redeploys that index. Set `A_INDEX_DIR` if the index lives somewhere else, or pass `--no-index` to skip it. Wrangler must be logged in to the Cloudflare account that owns `yash0.in`.

See [AGENTS.md](AGENTS.md) for page structure, components and chart specs. `npm run dev` also serves the same reference as a live page at `/components.html`.
