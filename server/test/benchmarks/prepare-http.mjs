import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output) throw new Error('Usage: node test/benchmarks/prepare-http.mjs OUTPUT_DIRECTORY, after building server');
const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../..');
const hashTree = async (directory) => {
  const hash = createHash('sha256');
  const visit = async (path, prefix = '') => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), relative + '/');
      else if (entry.isFile())
        hash
          .update(relative + '\0')
          .update(await readFile(join(path, entry.name)))
          .update('\0');
    }
  };
  await visit(directory);
  return hash.digest('hex');
};
await mkdir(output, { recursive: true });
await cp(join(server, 'dist'), resolve(output, 'current-server/dist'), { recursive: true });
for (const name of [
  'http-candidate.Dockerfile',
  'http-compose.yaml',
  'http-config.json',
  'http-upload.py',
  'analyze-http.py',
  'analyze-media-ready.py',
  'run-http.sh',
]) {
  await cp(join(here, name), resolve(output, name));
}
await writeFile(
  resolve(output, 'candidate-build.json'),
  JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: server, encoding: 'utf8' }).trim(),
      sourceTreeSha256: await hashTree(join(server, 'src')),
      distTreeSha256: await hashTree(join(server, 'dist')),
      diff: execFileSync('git', ['diff', '--', 'src'], { cwd: server, encoding: 'utf8' }),
      buildCommand: 'Node 24 node_modules/@nestjs/cli/bin/nest.js build, from server/',
      packaging:
        'Full freshly compiled server/dist over existing immich-perf:local production dependencies/native codecs. No web/CLI rebuild. No native build or dependency installation.',
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  resolve(output, '.dockerignore'),
  '*\n!current-server/\n!current-server/**\n!http-candidate.Dockerfile\n',
);
