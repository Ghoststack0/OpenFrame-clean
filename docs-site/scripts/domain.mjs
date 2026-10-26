#!/usr/bin/env node
// Publish this site at the root of its own domain, https://immich.yash0.in/, as a separate Worker.
// `npm run deploy` still publishes the a.yash0.in/<slug>/ copy; this doesn't touch it.
//   node scripts/domain.mjs build | deploy [--dry-run]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN = 'immich.yash0.in';
const WORKER = 'openframe-immich-site';
const OUT = path.join(ROOT, 'dist-domain');

const cmd = process.argv[2];
if (!['build', 'deploy'].includes(cmd)) {
  console.error('Usage: node scripts/domain.mjs build | deploy [--dry-run]');
  process.exit(1);
}

// Reuse the kit's checked build, then move the output from /<slug>/ to the domain root.
execFileSync(process.execPath, [path.join(ROOT, 'prepare-data.mjs')], { stdio: 'inherit', cwd: ROOT });
execFileSync(process.execPath, [path.join(ROOT, 'scripts/site.mjs'), 'build'], { stdio: 'inherit', cwd: ROOT });
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/wrangler.json'), 'utf8'));
const slug = config.name.replace(/^a-site-/, '');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist/public', slug), path.join(OUT, 'public'), { recursive: true });

// The 404 page is pinned to /<slug>/ for a.yash0.in. On its own domain the site is at /.
const notFound = path.join(OUT, 'public/404.html');
fs.writeFileSync(notFound, fs.readFileSync(notFound, 'utf8').replaceAll(`="/${slug}/`, '="/'));

fs.writeFileSync(
  path.join(OUT, 'wrangler.json'),
  JSON.stringify(
    {
      name: WORKER,
      account_id: config.account_id,
      compatibility_date: config.compatibility_date,
      workers_dev: false,
      assets: { directory: './public', html_handling: 'auto-trailing-slash', not_found_handling: '404-page' },
      routes: [{ pattern: DOMAIN, custom_domain: true }],
    },
    null,
    2,
  ) + '\n',
);
console.log(`Built dist-domain/ for https://${DOMAIN}/`);

if (cmd === 'deploy') {
  const args = ['wrangler', 'deploy', '--config', path.join(OUT, 'wrangler.json')];
  if (process.argv.includes('--dry-run')) args.push('--dry-run');
  execFileSync('npx', args, { stdio: 'inherit', cwd: OUT });
}
