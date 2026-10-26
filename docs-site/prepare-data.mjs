#!/usr/bin/env node
// Builds the report's chart data and public raw JSON from the benchmark evidence in
// server/test/benchmarks/results, then checks that the pages quote the same numbers.
// Rerun after the evidence changes:  node prepare-data.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.resolve(HERE, '../server/test/benchmarks/results');
const SRC = path.join(HERE, 'src');
const DATA = path.join(SRC, 'data');
const RAW = path.join(DATA, 'raw');
const BASE_REF = '256eb55dbe92ac77e02794442f9487e88ffed2b1';
const CPU = '13th Gen Intel(R) Core(TM) i5-13420H';

const read = (name) => JSON.parse(fs.readFileSync(path.join(RESULTS, `${name}.json`), 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const round = (n, digits) => Number(n.toFixed(digits));

// ---------- sanitize ----------

const PRIVATE = [/\/home\/[^/\s"']+/g, /\bunix:\/\/\/tmp\/[^\s"']+/g, /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, /\b[a-z0-9-]+\.dpdns\.org\b/g, /\byvm@/g];
const REPLACE = ['~', 'unix:///<local-docker-socket>', '<lan-host>', '<private-origin>', ''];
const scrub = (value) => {
  if (typeof value === 'string') return PRIVATE.reduce((s, re, i) => s.replace(re, REPLACE[i]), value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'hostname').map(([k, v]) => [k, scrub(v)]));
  }
  return value;
};
const numbers = (value) =>
  typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(numbers) : [];
const assertPublic = (name, value) => {
  const text = JSON.stringify(value);
  for (const re of [/\/home\//, /\/tmp\//, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /dpdns/, /yvm/, /"hostname"/, /credential/i, /admin-credentials/, /curl-auth/]) {
    assert.ok(!re.test(text), `${name}: public JSON still matches ${re}`);
  }
};

// ---------- evidence ----------

const person = read('person-linux-db');
const bcrypt = read('bcrypt-local');
const media = read('media-local');
const hosted = read('hosted-network');
const deployment = read('deployment');
const upload = read('upload-check-linux-summary');
const uploadRuns = upload.runFiles.map((name) => read(name.replace(/\.json$/, '')));
const httpSmoke = read('http-upload-linux');
const httpControlled = read('http-upload-linux-controlled');
const httpMedia = read('http-upload-media-ready');
const fonts = JSON.parse(fs.readFileSync(path.join(HERE, 'font-payload.json'), 'utf8'));
for (const font of fonts.after) {
  const data = fs.readFileSync(path.resolve(HERE, '..', font.path));
  assert.equal(data.length, font.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), font.sha256);
}
for (const run of [httpSmoke, httpControlled, httpMedia]) {
  assert.equal(run.behaviorStatus, 'passed');
  assert.equal(run.baselineRelease.commit, upload.baselineRelease.commit);
  for (const version of ['upstream', 'candidate']) {
    const rows = run.rounds.filter((row) => row.version === version);
    assert.equal(rows.length, run.workload.rounds);
    assert.ok(rows.every((row) => row.uploadSamples.length === run.workload.measuredUploadsPerRound));
    near(run.summary[version].uploadMedianMs, median(rows.flatMap((row) => row.uploadSamples.map((sample) => sample.elapsedMs))), 'HTTP upload median');
    near(run.summary[version].bulkCheckMedianMs, median(rows.flatMap((row) => row.bulkCheckSamplesMs)), 'HTTP preflight median');
  }
}
assert.equal(httpControlled.controlled, true);
assert.equal(httpControlled.workload.rounds, 6);
assert.equal(httpControlled.workload.workersInclude, 'api');
assert.equal(httpSmoke.performanceGate.status, 'inconclusive');
const paired = httpControlled.performanceGate;
for (const [metric, analysis] of Object.entries(httpMedia.performanceGate.metrics)) {
  const pairs = analysis.pairedDeploymentMediansMs;
  for (const pair of pairs) {
    for (const version of ['upstream', 'candidate']) {
      const row = httpMedia.rounds.find((row) => row.round === pair.round && row.version === version);
      near(pair[version], median(row.uploadSamples.map((sample) => sample[metric])), 'default-worker paired median');
    }
  }
  near(analysis.geometricMeanIncreasePercent, 100 * Math.expm1(pairs.reduce((sum, row) => sum + Math.log(row.candidate / row.upstream), 0) / pairs.length), 'default-worker paired estimate');
  assert.ok(analysis.exploratory95PercentBlockBootstrapInterval[1] < 0, 'strict zero-slowdown reference');
}
assert.equal(httpMedia.mediaReady, true);
assert.equal(httpMedia.controlled, false);
assert.equal(httpMedia.workload.rounds, 6);
assert.equal(httpMedia.workload.workersInclude, 'api,microservices');
assert.ok(paired.pairedBlocks.every((row) => row.candidateMedianMs < row.upstreamMedianMs));
near(paired.geometricMeanIncreasePercent, 100 * Math.expm1(paired.pairedBlocks.reduce((sum, row) => sum + Math.log(row.candidateMedianMs / row.upstreamMedianMs), 0) / paired.pairedBlocks.length), 'HTTP paired estimate');
assert.equal(uploadRuns.length, 3);
assert.equal(upload.results.length, 9);
assert.ok(upload.results.every((row) => row.candidateMedianMs < row.baselineMedianMs));
for (const [index, row] of upload.results.entries()) {
  const samples = uploadRuns.map((run) => {
    const measured = run.results[index];
    assert.equal(measured.count, row.count);
    assert.equal(measured.duplicateFraction, row.duplicateFraction);
    assert.equal(run.release.commit, upload.baselineRelease.commit);
    assert.equal(run.candidate.methodSha256, upload.candidate.methodSha256);
    return Object.fromEntries(measured.medians.map((item) => [item.version, item.elapsedMs]));
  });
  near(row.baselineMedianMs, median(samples.map((s) => s.baseline)), 'upload baseline');
  near(row.candidateMedianMs, median(samples.map((s) => s.candidate)), 'upload candidate');
  near(row.medianReductionPercent, median(samples.map((s) => 100 * (1 - s.candidate / s.baseline))), 'upload reduction');
}

for (const d of [person, bcrypt, media]) assert.equal(d.baselineRef, BASE_REF, 'baseline ref');
assert.equal(person.platform.client.cpu, CPU);
assert.equal(bcrypt.platform.cpu, CPU);
assert.equal(media.platform.cpu, CPU);

// Face query: recompute every median from the samples.
const faces = person.results.map((r) => {
  const get = (list, v) => list.find((x) => x.version === v);
  const out = { eligible: r.eligibleFaces };
  for (const v of ['original', 'modified']) {
    const samples = r.samples.filter((s) => s.version === v).map((s) => s.elapsedMs);
    assert.equal(samples.length, person.method.measuredRounds, `${r.eligibleFaces} ${v} sample count`);
    near(median(samples), get(r.medians, v).medianMs, `${r.eligibleFaces} ${v} median`);
    out[v] = { medianMs: median(samples), rows: get(r.returned, v).rows, bytes: get(r.returned, v).approximateJsonBytes };
  }
  return out;
});
assert.deepEqual(faces.map((f) => f.eligible), [1, 1000, 10000]);
assert.deepEqual(faces.map((f) => f.original.rows), [1, 1000, 10000]);
assert.deepEqual(faces.map((f) => f.modified.rows), [1, 1, 1]);
assert.ok(person.method.transfer.includes('not PostgreSQL wire bytes'));

// bcrypt: event-loop delay and completion counts.
const bc = {};
for (const v of ['original', 'modified']) {
  const rows = bcrypt.results.filter((r) => r.version === v);
  assert.equal(rows.length, bcrypt.method.rounds);
  assert.ok(rows.every((r) => r.completedAtCheckpoint === (v === 'original' ? 4 : 0)), `${v} completion counts`);
  bc[v] = { checkpoint: median(rows.map((r) => r.checkpointMs)), total: median(rows.map((r) => r.totalMs)), rounds: rows };
  near(bc[v].checkpoint, bcrypt.summary[v].medianCheckpointMs, `bcrypt ${v} checkpoint`);
  near(bc[v].total, bcrypt.summary[v].medianTotalMs, `bcrypt ${v} total`);
}
assert.equal(bcrypt.method.input.bcryptCost, 10);
assert.equal(bcrypt.method.input.comparisonsPerBatch, 4);

// Media: fs.access calls and per-scenario medians.
const SCENARIOS = { thumbnail: 'Thumbnail (200)', cached: 'Conditional (304)', range: 'Range (206)' };
const mediaRows = Object.keys(SCENARIOS).map((scenario) => {
  const out = { scenario };
  for (const name of ['original', 'current']) {
    const samples = media.samples.filter((s) => s.name === name && s.scenario === scenario);
    assert.equal(samples.length, media.method.rounds, `${name} ${scenario} samples`);
    const summary = media.summary.find((s) => s.name === name && s.scenario === scenario);
    near(median(samples.map((s) => s.ms)), summary.medianMsPer200Requests, `${name} ${scenario} median`);
    assert.equal(summary.requests, 1000);
    assert.equal(samples.reduce((n, s) => n + s.accessCalls, 0), summary.accessCalls);
    out[name] = { medianMs: summary.medianMsPer200Requests, accessCalls: summary.accessCalls };
  }
  assert.equal(out.original.accessCalls, 1000);
  assert.equal(out.current.accessCalls, 0);
  return out;
});
// The thumbnail median got slower and the other two got faster; the page has to say so.
assert.ok(mediaRows[0].current.medianMs > mediaRows[0].original.medianMs);
assert.ok(mediaRows[1].current.medianMs < mediaRows[1].original.medianMs);
assert.ok(mediaRows[2].current.medianMs < mediaRows[2].original.medianMs);

// Hosted smoke test and checks.
assert.equal(hosted.rateLimitBytesPerSecond, 128 * 1024);
assert.deepEqual(hosted.results.map((r) => r.http_code), [200, 304, 206]);
assert.equal(hosted.results[0].size_download, hosted.originalBytes);
const c = deployment.checks;
assert.deepEqual([c.focusedUnitTestsPassed, c.personPostgresTestsPassed, c.workerTestsPassed], [384, 40, 2]);
assert.equal(c.focusedUnitTestsPassed + c.personPostgresTestsPassed + c.workerTestsPassed, 426);
assert.equal(c.typescript, 'passed');
assert.equal(c.productionBuild, 'passed');
assert.match(c.opusReview, /Caching404 finding fixed and re-reviewed/);

// ---------- public raw JSON ----------

const publicDeployment = {
  note: 'Sanitized summary. The temporary test deployment and its proxy have been stopped; host, paths and URLs are omitted.',
  baselineRef: BASE_REF,
  sourceVersion: deployment.sourceVersion,
  machineLearningEnabled: deployment.machineLearningEnabled,
  deployedCompiledSha256: deployment.deployedCompiledSha256,
  checks: deployment.checks,
  publicSmoke: Object.fromEntries(Object.entries(deployment.publicSmoke).filter(([k]) => k !== 'url')),
  nativeCodecs: deployment.nativeCodecs,
};
const raw = {
  'person-linux-db': person,
  'bcrypt-local': bcrypt,
  'media-local': media,
  'hosted-network': { ...hosted, origin: 'temporary test deployment (stopped)' },
  deployment: publicDeployment,
  'upload-check-linux-summary': upload,
  'http-upload-linux': httpSmoke,
  'http-upload-linux-controlled': httpControlled,
  'http-upload-media-ready': httpMedia,
  'font-payload': fonts,
  ...Object.fromEntries(upload.runFiles.map((name, index) => [name.replace(/\.json$/, ''), uploadRuns[index]])),
};
fs.rmSync(RAW, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });
for (const [name, value] of Object.entries(raw)) {
  const clean = scrub(value);
  assertPublic(name, clean);
  // Sanitizing must only touch text: every measured number survives unchanged.
  assert.deepEqual(numbers(clean), numbers(value), `${name}: numbers changed while sanitizing`);
  write(path.join(RAW, `${name}.json`), clean);
}

// ---------- chart specs ----------

const SERIES = ['Before (256eb55)', 'After'];
const charts = {
  'face-latency': {
    type: 'line',
    title: 'getRandomFace median latency by group size',
    subtitle: `Median of ${person.method.measuredRounds} rounds after ${person.method.warmupRounds} warm-ups. Lower is better.`,
    unit: 'ms',
    better: 'lower',
    xLabel: 'Eligible faces in the group',
    x: faces.map((f) => f.eligible.toLocaleString('en-US')),
    series: [
      { name: SERIES[0], values: faces.map((f) => round(f.original.medianMs, 2)) },
      { name: SERIES[1], values: faces.map((f) => round(f.modified.medianMs, 2)) },
    ],
  },
  'bcrypt-delay': {
    type: 'compare',
    title: 'Four bcrypt checks at cost 10, median of 6 rounds',
    better: 'lower',
    unit: 'ms',
    labels: ['compareSync (before)', 'compare (after)'],
    rows: [
      { label: 'Delay before a queued callback runs', before: round(bc.original.checkpoint, 2), after: round(bc.modified.checkpoint, 2) },
      { label: 'Time until all four checks finish', before: round(bc.original.total, 2), after: round(bc.modified.total, 2) },
    ],
  },
  'bcrypt-rounds': {
    type: 'bar',
    title: 'Event-loop callback delay in each round',
    unit: 'ms',
    better: 'lower',
    xLabel: 'Round',
    x: bc.original.rounds.map((r) => `Round ${r.round + 1}`),
    series: [
      { name: SERIES[0], values: bc.original.rounds.map((r) => round(r.checkpointMs, 2)) },
      { name: SERIES[1], values: bc.modified.rounds.map((r) => round(r.checkpointMs, 2)) },
    ],
  },
  'media-access': {
    type: 'compare',
    title: 'fs.access calls per 1,000 media requests',
    better: 'lower',
    labels: ['Before', 'After'],
    rows: mediaRows.map((r) => ({ label: SCENARIOS[r.scenario], before: r.original.accessCalls, after: r.current.accessCalls })),
  },
  'media-latency': {
    type: 'bar',
    title: 'Median time per 200 loopback requests',
    subtitle: 'Median of 5 rounds. The spread between rounds is larger than these differences.',
    unit: 'ms',
    better: 'lower',
    x: mediaRows.map((r) => SCENARIOS[r.scenario]),
    series: [
      { name: SERIES[0], values: mediaRows.map((r) => round(r.original.medianMs, 1)) },
      { name: SERIES[1], values: mediaRows.map((r) => round(r.current.medianMs, 1)) },
    ],
  },
};
for (const f of fs.readdirSync(DATA)) if (f.endsWith('.json')) fs.rmSync(path.join(DATA, f));
for (const [name, spec] of Object.entries(charts)) write(path.join(DATA, `${name}.json`), spec);

// Generate the latest-release table from the same checked evidence that is published below.
const uploadRows = upload.results.map((row) => `<tr><td class="num">${row.count.toLocaleString('en-US')}</td><td class="num">${row.duplicateFraction * 100}%</td><td class="num">${row.baselineMedianMs.toFixed(3)}</td><td class="num">${row.candidateMedianMs.toFixed(3)}</td><td class="num">${row.medianReductionPercent.toFixed(1)}%</td></tr>`).join('\n');
fs.writeFileSync(path.join(SRC, 'release-comparison.html'), `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload preflight against Immich ${upload.baselineRelease.tag_name} · OpenFrame</title>
<meta name="description" content="Measured elapsed method time for upload duplicate checks against the latest stable Immich release. Includes raw samples and measurement limits.">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/site.css">
<script src="site.config.js"></script><script src="assets/site.js" defer></script>
</head><body><main class="doc-main">
<header class="doc-head"><p class="eyebrow cap">Latest-release comparison · upload preflight CPU</p>
<h1>Decode upload checksums once</h1>
<p class="lede">OpenFrame reuses decoded checksums when matching duplicate uploads. This removes a second decode for each file. The table measures that method's CPU work against Immich ${upload.baselineRelease.tag_name}, not file-transfer speed.</p>
<div class="doc-meta"><span>Measured <b>2026-10-26</b></span><span>Linux test bench</span><span class="badge warn">In-memory repository</span></div></header>
<article class="doc-body"><h2>Measured results</h2>
<p>Median of three process medians, in milliseconds per batch. All nine measured workloads had lower elapsed method time in the candidate. This is evidence for this method and these workloads only.</p>
<table><thead><tr><th>Files</th><th>Duplicates</th><th>Immich, ms</th><th>OpenFrame, ms</th><th>Method time reduction</th></tr></thead><tbody>${uploadRows}</tbody></table>
<h2>Method and versions</h2>
<p>The baseline is the method shipped in the official <a href="${upload.baselineRelease.html_url}">Immich ${upload.baselineRelease.tag_name} release</a>, commit <code>${upload.baselineRelease.commit}</code>. The candidate method comes from OpenFrame commit <code>${upload.candidate.head}</code> plus the exact patch and source hashes in the <a href="data/raw/upload-check-linux-summary.json">raw summary</a>.</p>
<p>Both methods run on the same Linux box with an AMD A4-9125 CPU, inside the same pinned upstream server image with Node ${uploadRuns[0].runtime.node}. Each process uses five warmup rounds and 30 measured rounds with alternating execution order. The repository is in memory. Each run includes 100, 1,000 and 10,000 checksums with 0%, 50% and 100% duplicates. Raw process files contain hardware, image digest, workload settings, individual samples and correctness checks.</p>
<p>Commands and the benchmark harness are in <a href="https://github.com/Ghoststack0/OpenFrame/tree/HEAD/server/test/benchmarks">server/test/benchmarks</a>. The preparation script takes an output directory and compiles the actual working-tree method. The run script verifies the upstream release and image before executing the prepared benchmark on the Linux box.</p>
<h2>Limits and regressions</h2>
<div class="callout warn"><p class="cap">Not an end-to-end upload benchmark</p><p>This test excludes database queries, network transfer, storage writes, thumbnail generation and mobile clients. It cannot establish that OpenFrame as a whole is faster or has no regressions. Runs two and three overlapped dependency copying on the host. The observed process variation is not a confidence interval.</p></div>
<p>Correctness checks cover mixed hex and base64 encodings, repeated checksums, empty input, output order, duplicate rejection and trashed status. A baseline-versus-baseline control is retained in the repository. See the separate <a href="http-comparison.html">HTTP upload comparison</a> for real database and storage measurements.</p>
<h2>Raw evidence</h2><ul>${upload.runFiles.map((name) => `<li><a href="data/raw/${name}">${name}</a></li>`).join('')}<li><a href="data/raw/upload-check-linux-summary.json">Summary, patch and source hashes</a></li></ul>
</article></main></body></html>\n`);

const defaultUpload = httpMedia.performanceGate.metrics.elapsedMs;
const defaultMedia = httpMedia.performanceGate.metrics.mediaReadyMs;
const interval = (analysis) => `${(-analysis.exploratory95PercentBlockBootstrapInterval[1]).toFixed(2)}–${(-analysis.exploratory95PercentBlockBootstrapInterval[0]).toFixed(2)}% lower`;
const mediaRowsHtml = [
  ['HTTP completion', 'uploadMedianMs', defaultUpload],
  ['Thumbnail and preview ready', 'mediaReadyMedianMs', defaultMedia],
].map(([label, key, analysis]) => `<tr><td>${label}</td><td class="num">${httpMedia.summary.upstream[key].toFixed(2)}</td><td class="num">${httpMedia.summary.candidate[key].toFixed(2)}</td><td class="num">${(-analysis.geometricMeanIncreasePercent).toFixed(2)}% lower</td><td class="num">${interval(analysis)}</td></tr>`).join('\n');
fs.writeFileSync(path.join(SRC, 'http-comparison.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTTP and media-ready comparison · OpenFrame</title><meta name="description" content="OpenFrame and Immich v3.3.5 tested with default workers, authenticated HTTP, durable PostgreSQL and disposable storage. Raw evidence and measurement limits.">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="assets/site.css"><script src="site.config.js"></script><script src="assets/site.js" defer></script>
</head><body><main class="doc-main"><header class="doc-head"><p class="eyebrow cap">Latest-release comparison · default workers</p><h1>Lower upload and media-ready latency in this test</h1>
<p class="lede">Across six paired deployments, the OpenFrame candidate had ${(-defaultUpload.geometricMeanIncreasePercent).toFixed(2)}% lower HTTP upload completion latency and ${(-defaultMedia.geometricMeanIncreasePercent).toFixed(2)}% lower thumbnail/preview readiness latency than Immich ${httpMedia.baselineRelease.tag_name}. These are scoped, exploratory results from one shared host.</p><div class="doc-meta"><span>2026-10-26</span><span>AMD A4-9125 Linux box</span><span class="badge warn">ML disabled</span></div></header>
<article class="doc-body"><h2>Default-worker result</h2><table><thead><tr><th>Metric</th><th>Immich median, ms</th><th>OpenFrame median, ms</th><th>Paired change</th><th>Exploratory 95% interval</th></tr></thead><tbody>${mediaRowsHtml}</tbody></table>
<p>The millisecond columns are pooled request medians. Percentage changes use the geometric mean of six paired deployment-median ratios, so they differ from the pooled median ratio. Each build completed 120 measured uploads across six deployments, with order alternating between builds. One pair favored upstream on both metrics. Two upstream deployments were much slower than the others, so host variation affects the estimate.</p>
<h2>What ran</h2><p>Both builds used default API and microservices workers, with only ML disabled. Every deployment started with fresh disposable PostgreSQL and upload volumes. API readiness, geodata import and one complete media warmup finished before measurement. Twenty unique seeded 512 × 512 PNGs followed sequentially per deployment, with identical bytes across builds. PostgreSQL fsync, full-page writes and synchronous commit stayed enabled; Redis and storage writes were real.</p>
<p>HTTP completion includes reading the full upload response. Media-ready time starts before that upload and ends when authenticated thumbnail and preview endpoints both return image content. Unsuccessful readiness polls sleep 50 ms, and polling HTTP cost is included. This is client-observed image readiness, not exact worker execution time or completion of every queue.</p>
<h2>Earlier experiments remain visible</h2><table><thead><tr><th>Experiment</th><th>Immich HTTP median, ms</th><th>OpenFrame HTTP median, ms</th><th>Interpretation</th></tr></thead><tbody>
<tr><td>Small default-worker smoke</td><td class="num">${httpSmoke.summary.upstream.uploadMedianMs.toFixed(3)}</td><td class="num">${httpSmoke.summary.candidate.uploadMedianMs.toFixed(3)}</td><td>4.7% higher candidate median; inconclusive</td></tr>
<tr><td>Controlled API only</td><td class="num">${httpControlled.summary.upstream.uploadMedianMs.toFixed(3)}</td><td class="num">${httpControlled.summary.candidate.uploadMedianMs.toFixed(3)}</td><td>${(-paired.geometricMeanIncreasePercent).toFixed(2)}% lower paired latency; background workers excluded</td></tr></tbody></table>
<p>The controlled experiment's exploratory interval is ${interval(paired)}. The later default-worker protocol used a fixed six pairs and separate readiness measurements. No samples were added after seeing results, and the earlier slower smoke was retained.</p>
<h2>Versions and correctness</h2><p>The baseline is official Immich ${httpMedia.baselineRelease.tag_name}, commit <code>${httpMedia.baselineRelease.commit}</code>. The candidate is the full compiled OpenFrame server identified by source hash <code>${httpMedia.candidateBuild.sourceTreeSha256}</code>. It reuses the recorded candidate production dependencies and native codecs; its web and CLI builds were not refreshed. Current backend source and compiled output match the measured hashes.</p>
<p>All twelve deployments passed original byte equality, unauthorized requests returning 401, ranges returning 206, conditional requests returning 304, duplicate identity, ordered mixed-encoding preflight checks and thumbnail/preview readability.</p>
<h2>Regression interpretation and limits</h2><div class="callout warn"><p class="cap">Not application-wide qualification</p><p>Both intervals lie below the strict zero-slowdown reference, separately from meeting the predeclared exploratory 5% budget. This supports lower latency within this experiment. Shared-host variance and six paired blocks limit confidence. The media-ready interval is only 0.38 percentage points from zero at its near boundary; 50 ms polling further limits interpretation of small differences.</p></div>
<p>Video, concurrent backlogs, populated libraries, ML, WAN, TLS and mobile clients were not measured. The image reuses recorded dependencies with newly compiled server code; it is not a fresh release image. These results do not prove every workload is faster or regression-free.</p>
<h2>Reproduce and inspect</h2><p>The <a href="https://github.com/Ghoststack0/OpenFrame/blob/main/server/test/benchmarks/MEDIA-READY-PROTOCOL.md">fixed protocol</a> and <a href="https://github.com/Ghoststack0/OpenFrame/blob/main/server/test/benchmarks/MEDIA-READY-RESULTS.md">handoff with hashes and limitations</a> accompany the harness. Analysis resamples whole paired deployment blocks 10,000 times, seed 0. Disposable containers, volumes and networks were removed.</p>
<ul><li><a href="data/raw/http-upload-media-ready.json">Default-worker media-ready run, all samples and paired analysis</a></li><li><a href="data/raw/http-upload-linux.json">Original default-worker smoke, including its slower median</a></li><li><a href="data/raw/http-upload-linux-controlled.json">Controlled API-only run</a></li><li><a href="https://github.com/Ghoststack0/OpenFrame/blob/main/server/test/benchmarks/results/media-ready-evidence.tar.gz">Evidence archive with logs, protocol and script hashes</a></li></ul></article></main></body></html>\n`);

// ---------- pages quote the evidence ----------

const fix = (n, d) => n.toFixed(d);
const [f1, f1000, f10000] = faces;
const expected = {
  'performance.html': [
    `data-value="${fix(f10000.modified.medianMs, 1)}" data-before="${fix(f10000.original.medianMs, 1)}"`,
    `data-value="1" data-before="${f10000.original.rows}"`,
    `data-value="${fix(bc.modified.checkpoint, 2)}" data-before="${fix(bc.original.checkpoint, 1)}"`,
    `data-value="0" data-before="1000"`,
    ...faces.flatMap((f) => [
      `<td class="num">${fix(f.original.medianMs, 2)} ms</td><td class="num">${fix(f.modified.medianMs, 2)} ms</td>`,
      `<td class="num">${f.original.rows.toLocaleString('en-US')} → ${f.modified.rows}</td>`,
      `<td class="num">${f.original.bytes.toLocaleString('en-US')} → ${f.modified.bytes}</td>`,
    ]),
    `${fix(f1000.original.medianMs / f1000.modified.medianMs, 0)}×`,
    `${fix(f10000.original.medianMs / f10000.modified.medianMs, 0)}×`,
    ...mediaRows.map((r) => `<td class="num">${fix(r.original.medianMs, 1)} ms</td><td class="num">${fix(r.current.medianMs, 1)} ms</td>`),
    ...hosted.results.map((r) => `<td class="num">${r.http_code}</td><td class="num">${r.size_download.toLocaleString('en-US')}</td><td class="num">${fix(r.time_total, 2)} s</td>`),
    `${c.focusedUnitTestsPassed} unit`,
    `${c.personPostgresTestsPassed} PostgreSQL`,
    `${c.workerTestsPassed} proxy`,
  ],
  'methodology.html': [CPU, BASE_REF, ...['person-linux-db', 'bcrypt-local', 'media-local', 'hosted-network', 'deployment'].map((n) => `href="data/raw/${n}.json"`)],
  'release-comparison.html': [upload.baselineRelease.commit, upload.candidate.head, ...upload.runFiles.map((name) => `href="data/raw/${name}"`)],
  'http-comparison.html': [httpControlled.baselineRelease.commit, httpMedia.candidateBuild.sourceTreeSha256, 'href="data/raw/http-upload-media-ready.json"', `href="data/raw/http-upload-linux.json"`, `href="data/raw/http-upload-linux-controlled.json"`],
  // The OpenFrame overview repeats two headline tiles and must quote them exactly.
  'index.html': [
    'href="release-comparison.html"',
    `${(-defaultUpload.geometricMeanIncreasePercent).toFixed(2)}%`,
    `${(-defaultMedia.geometricMeanIncreasePercent).toFixed(2)}%`,
    `${fonts.before.filter((font) => font.preloaded).reduce((sum, font) => sum + font.bytes, 0).toLocaleString('en-US')} → ${fonts.after.filter((font) => font.preloaded).reduce((sum, font) => sum + font.bytes, 0).toLocaleString('en-US')}`,
    `${Math.min(...upload.results.map((row) => row.medianReductionPercent)).toFixed(1)}–${Math.max(...upload.results.map((row) => row.medianReductionPercent)).toFixed(1)}%`,
    `data-value="${fix(f10000.modified.medianMs, 1)}" data-before="${fix(f10000.original.medianMs, 1)}"`,
    `data-value="${fix(bc.modified.checkpoint, 2)}" data-before="${fix(bc.original.checkpoint, 1)}"`,
  ],
  'contributing.html': [],
};
for (const [page, snippets] of Object.entries(expected)) {
  const html = fs.readFileSync(path.join(SRC, page), 'utf8');
  for (const s of snippets) assert.ok(html.includes(s), `${page} is missing: ${s}`);
  // Guard against claims the evidence doesn't support.
  assert.ok(!/\d+× faster|(?:makes|made) immich \d|(?:uses|using) less (?:RAM|memory|bandwidth)|(?:RAM|memory|bandwidth) (?:reduced|reduction|savings?)/i.test(html), `${page} makes an unsupported claim`);
}
assert.ok(f1.original.medianMs > 0);

console.log(`ok: ${Object.keys(charts).length} charts, ${Object.keys(raw).length} raw files, ${Object.values(expected).flat().length} page checks`);
