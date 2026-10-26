import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const output = process.argv[2];
const gitOptions = { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' };
if (!output) throw new Error('Usage: node test/benchmarks/prepare-upload-check.mjs OUTPUT_DIRECTORY');
const source = await readFile(new URL('../../src/services/asset-media.service.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('asset-media.service.ts', source, ts.ScriptTarget.Latest, true);
const service = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'AssetMediaService');
const method = service?.members.find(
  (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'bulkUploadCheck',
);
if (!method) throw new Error('AssetMediaService.bulkUploadCheck not found');
const methodSource = method.getText(ast);
const code = ts.transpileModule(
  `import { fromChecksum } from '/usr/src/app/server/dist/utils/request.js';
   import { AssetUploadAction, AssetRejectReason } from '/usr/src/app/server/dist/dtos/asset-media-response.dto.js';
   export class Candidate { ${methodSource} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } },
).outputText;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'candidate.mjs'), code);
await writeFile(
  resolve(output, 'candidate-source.json'),
  JSON.stringify(
    {
      source: 'server/src/services/asset-media.service.ts',
      head: execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim(),
      diff: execFileSync('git', ['diff', '--', 'server/src/services/asset-media.service.ts'], gitOptions),
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      methodSha256: createHash('sha256').update(methodSource).digest('hex'),
      methodSource,
      compilerVersion: ts.version,
      compiledSha256: createHash('sha256').update(code).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
