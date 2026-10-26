#!/usr/bin/env node
// Build, preview and publish a static site at https://a.yash0.in/<slug>/.
//
//   node scripts/site.mjs new <slug> [dir] [--title "Title"]   copy this template into a new site folder
//   node scripts/site.mjs build                                 check links and write dist/
//   node scripts/site.mjs dev [--port 4321]                     preview with rebuild on change
//   node scripts/site.mjs deploy [--replace] [--no-index] [--dry-run]   publish and list it on a.yash0.in
//   node scripts/site.mjs remove --yes                          take the site down and unlist it
//
// Each site is its own Cloudflare Worker (static assets only) routed to a.yash0.in/<slug>/*.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HOST = 'a.yash0.in';
const ZONE = 'yash0.in';
const ACCOUNT_ID = 'bb13c5aed893f0140aacff72cab0747b';
const TEMPLATE_SLUG = 'example-perf';
const INDEX_DIR = process.env.A_INDEX_DIR || path.join(os.homedir(), 'code/a-index');
const MAX_FILE = 25 * 1024 * 1024;
const MAX_FILES = 20000;

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const STATE = path.join(ROOT, '.a-site.json');

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').match(/^--(port|title)$/));
const opt = (name, fallback) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : fallback;
};

function fail(msg) {
  console.error('\x1b[31m✖\x1b[0m ' + msg);
  process.exit(1);
}
const ok = (msg) => console.log('\x1b[32m✔\x1b[0m ' + msg);

function validSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug);
}

function readConfig() {
  const file = path.join(SRC, 'site.config.js');
  if (!fs.existsSync(file)) fail(`No src/site.config.js in ${ROOT}. Run this from a site folder.`);
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const site = sandbox.window.SITE;
  if (!site) fail('src/site.config.js must set window.SITE.');
  if (!validSlug(site.slug)) fail(`Invalid slug "${site.slug}". Use 1-48 lowercase letters, digits and dashes.`);
  if (!site.title) fail('src/site.config.js needs a title.');
  return site;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? walk(p) : [p];
  });
}

// ---------- build ----------

function build({ quiet = false } = {}) {
  const site = readConfig();
  const files = walk(SRC);
  const errors = [];
  if (!fs.existsSync(path.join(SRC, 'index.html'))) errors.push('src/index.html is missing.');
  if (files.length > MAX_FILES) errors.push(`${files.length} files; the limit is ${MAX_FILES}.`);

  for (const f of files) {
    const rel = path.relative(SRC, f);
    const size = fs.statSync(f).size;
    if (size > MAX_FILE) errors.push(`${rel} is ${(size / 1048576).toFixed(1)} MiB; the limit is 25 MiB per file.`);
    if (!/\.(html|css)$/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const refs = [
      ...[...text.matchAll(/\b(?:href|src|data-src|action|poster)\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]),
      ...[...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]),
    ];
    for (const ref of refs) {
      if (!ref || /^(#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue; // anchors, https:, mailto:, data:
      if (ref.startsWith('/')) {
        // The site lives under /<slug>/, so root paths escape it. "/" alone links to the a.yash0.in index.
        if (ref !== '/' && rel !== '404.html') errors.push(`${rel}: "${ref}" starts with "/". Use a relative path like "${ref.replace(/^\/+/, '')}".`);
        continue;
      }
      if (rel === '404.html') continue;
      const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
      if (!clean) continue;
      let target = path.resolve(path.dirname(f), clean);
      if (clean.endsWith('/') || (fs.existsSync(target) && fs.statSync(target).isDirectory())) target = path.join(target, 'index.html');
      if (!target.startsWith(SRC + path.sep)) errors.push(`${rel}: "${ref}" points outside src/.`);
      else if (!fs.existsSync(target)) errors.push(`${rel}: "${ref}" not found.`);
    }
  }
  if (errors.length) fail('Build failed:\n  ' + errors.join('\n  '));

  fs.rmSync(DIST, { recursive: true, force: true });
  const out = path.join(DIST, 'public', site.slug);
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(SRC, out, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });

  // The 404 page can be served at any depth, so pin its asset paths to the site root.
  const notFound = path.join(out, '404.html');
  if (fs.existsSync(notFound)) {
    fs.writeFileSync(notFound, fs.readFileSync(notFound, 'utf8').replace(/\b(href|src)="(?!\/|#|[a-z]+:)([^"]+)"/g, `$1="/${site.slug}/$2"`));
  }

  const config = {
    name: `a-site-${site.slug}`,
    account_id: ACCOUNT_ID,
    compatibility_date: new Date().toISOString().slice(0, 10),
    workers_dev: false,
    assets: { directory: './public', html_handling: 'auto-trailing-slash', not_found_handling: '404-page' },
    routes: [
      { pattern: `${HOST}/${site.slug}`, zone_name: ZONE },
      { pattern: `${HOST}/${site.slug}/*`, zone_name: ZONE },
    ],
  };
  fs.writeFileSync(path.join(DIST, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
  if (!quiet) ok(`Built ${files.length} files into dist/public/${site.slug}/`);
  return { site, config };
}

// ---------- dev ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv' };

function dev() {
  let { site } = build();
  const port = Number(opt('port', 4321));
  const pub = path.join(DIST, 'public');
  let timer;
  fs.watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { ({ site } = build({ quiet: true })); ok('Rebuilt'); } catch (e) { console.error(e); }
    }, 120);
  });
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/' + site.slug) { res.writeHead(302, { Location: `/${site.slug}/` }); return res.end(); }
    let file = path.join(pub, p);
    if (!file.startsWith(pub)) { res.writeHead(400); return res.end(); }
    if (p.endsWith('/')) file = path.join(file, 'index.html');
    else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    let status = 200;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { status = 404; file = path.join(pub, site.slug, '404.html'); }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => ok(`Preview at http://localhost:${port}/${site.slug}/  (rebuilds on save)`));
}

// ---------- deploy ----------

const DRY = flags.has('--dry-run');

function run(args, cwd = ROOT) {
  if (DRY) return console.log(`[dry-run] (cd ${cwd} && npx wrangler ${args.join(' ')})`);
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], { cwd, stdio: 'inherit' });
  if (r.status !== 0) fail(`wrangler ${args[0]} failed (exit ${r.status}).`);
}

async function status(url) {
  try { return (await fetch(url, { redirect: 'manual' })).status; } catch { return 0; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

async function deploy() {
  const { site, config } = build();
  if (site.slug === TEMPLATE_SLUG && !flags.has('--allow-example')) fail(`Set a real slug in src/site.config.js (it is still "${TEMPLATE_SLUG}").`);
  const url = `https://${HOST}/${site.slug}/`;
  const state = readState();
  const live = state?.slug === site.slug || flags.has('--replace') ? 404 : await status(url);
  if (live && live !== 404) {
    fail(`${url} is already live and this folder didn't publish it. Pick another slug, or pass --replace if you mean to overwrite it.`);
  }
  run(['deploy', '--config', 'dist/wrangler.json']);
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify({ slug: site.slug, worker: config.name, url, deployedAt: new Date().toISOString() }, null, 2) + '\n');

  if (!flags.has('--no-index')) updateIndex(site.slug, site.title);

  if (DRY) return ok(`Dry run finished; nothing was published. Would be live at ${url}`);
  let code = 0;
  for (let i = 0; i < 15 && code !== 200; i++) {
    code = await status(url);
    if (code !== 200) await new Promise((r) => setTimeout(r, 2000));
  }
  if (code !== 200) fail(`Deployed, but ${url} answered ${code}. Check again in a minute.`);
  ok(`Live at ${url}`);
}

function indexFiles() {
  const html = path.join(INDEX_DIR, 'index.html');
  if (!fs.existsSync(html)) {
    console.warn(`! No index at ${html}; skipping the a.yash0.in listing. Set A_INDEX_DIR to fix.`);
    return null;
  }
  return { html, check: path.join(INDEX_DIR, 'check.py') };
}

function writeIndex(files, html) {
  const count = (html.match(/<li><a href="\//g) || []).length;
  if (DRY) {
    console.log('[dry-run] index would list:\n  ' + [...html.matchAll(/<li><a href="([^"]+)">([^<]*)/g)].map((m) => `${m[1]}  ${m[2]}`).join('\n  '));
    return;
  }
  fs.writeFileSync(files.html, html);
  if (fs.existsSync(files.check)) {
    fs.writeFileSync(files.check, fs.readFileSync(files.check, 'utf8')
      .replace(/len\(parser\.paths\) == \d+/, `len(parser.paths) == ${count}`)
      .replace(/Homepage has all \d+ links/, `Homepage has all ${count} links`));
  }
  run(['deploy'], INDEX_DIR);
  ok(`a.yash0.in index lists ${count} sites`);
}

function updateIndex(slug, title) {
  const files = indexFiles();
  if (!files) return;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const item = `<li><a href="/${slug}/">${esc(title)}<small>/${slug}/</small></a></li>`;
  let html = fs.readFileSync(files.html, 'utf8');
  const existing = new RegExp(`<li><a href="/${slug}/">.*?</li>`);
  if (existing.test(html)) {
    if (html.match(existing)[0] === item) return ok('Already listed on a.yash0.in');
    html = html.replace(existing, item);
  } else {
    const items = [...html.matchAll(/<li><a href="\/([^"]+)\/">.*?<\/li>/g)];
    const after = items.find((m) => m[1] > slug);
    if (after) html = html.slice(0, after.index) + item + html.slice(after.index);
    else if (items.length) {
      const last = items[items.length - 1];
      html = html.slice(0, last.index + last[0].length) + item + html.slice(last.index + last[0].length);
    } else html = html.replace('</ul>', item + '</ul>');
  }
  writeIndex(files, html);
}

async function remove() {
  const site = readConfig();
  if (!flags.has('--yes')) fail(`This deletes ${HOST}/${site.slug}/ and its Worker. Re-run with --yes to confirm.`);
  run(['delete', '--name', `a-site-${site.slug}`, '--force']);
  const files = indexFiles();
  if (files) {
    const html = fs.readFileSync(files.html, 'utf8').replace(new RegExp(`<li><a href="/${site.slug}/">.*?</li>`), '');
    writeIndex(files, html);
  }
  fs.rmSync(STATE, { force: true });
  ok(`Removed ${HOST}/${site.slug}/`);
}

// ---------- new ----------

function create() {
  const slug = positional[0];
  if (!validSlug(slug)) fail('Usage: node scripts/site.mjs new <slug> [dir] [--title "Title"]  (slug: lowercase letters, digits, dashes)');
  const dir = path.resolve(positional[1] || slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail(`${dir} already exists and isn't empty.`);
  const skip = new Set(['dist', 'node_modules', '.wrangler', '.a-site.json', '.git']);
  fs.cpSync(TEMPLATE_ROOT, dir, { recursive: true, filter: (p) => !skip.has(path.basename(p)) });
  const title = opt('title', slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  const cfg = path.join(dir, 'src/site.config.js');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace(`slug: '${TEMPLATE_SLUG}'`, `slug: '${slug}'`)
    .replace(/title: '[^']*'/, `title: ${JSON.stringify(title)}`)
    .replace(/updated: '[^']*'/, `updated: '${new Date().toISOString().slice(0, 10)}'`));
  const pkg = path.join(dir, 'package.json');
  fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace(/"name": "[^"]*"/, `"name": "a-site-${slug}"`));
  ok(`Created ${dir}`);
  const shown = path.relative(process.cwd(), dir);
  console.log(`  Next: cd ${shown.startsWith('..') ? dir : shown || '.'} && npm run dev`);
  console.log('  Replace the example pages in src/, then npm run deploy.');
}

const commands = { new: create, build: () => build(), dev, deploy, remove };
if (!commands[cmd]) fail('Usage: node scripts/site.mjs <new|build|dev|deploy|remove>');
await commands[cmd]();
