"""Paired deployment-block analysis; never treats behavior success as a speed gate."""
import json
import math
import random
import statistics
import sys
from pathlib import Path

path = Path(sys.argv[1])
result = json.loads(path.read_text())
assert result['behaviorStatus'] == 'passed'
assert result['controlled'] and result['workload']['rounds'] == 6
assert result['workload']['measuredUploadsPerRound'] == 20 and len(result['rounds']) == 12
pairs = []
for round_ in range(result['workload']['rounds']):
    rows = {row['version']: row for row in result['rounds'] if row['round'] == round_}
    assert set(rows) == {'upstream', 'candidate'}
    assert all(len(row['uploadSamples']) == 20 for row in rows.values())
    upstream = rows['upstream']['uploadSamples']
    candidate = rows['candidate']['uploadSamples']
    assert [(sample['index'], sample['bytes']) for sample in upstream] == [(sample['index'], sample['bytes']) for sample in candidate]
    u = statistics.median(sample['elapsedMs'] for sample in upstream)
    c = statistics.median(sample['elapsedMs'] for sample in candidate)
    pairs.append({'round': round_, 'upstreamMedianMs': u, 'candidateMedianMs': c,
                  'increasePercent': 100 * (c / u - 1)})
ratios = [math.log(pair['candidateMedianMs'] / pair['upstreamMedianMs']) for pair in pairs]
rng = random.Random(0)
bootstrap = sorted(100 * math.expm1(statistics.mean(rng.choices(ratios, k=len(ratios)))) for _ in range(10000))
low, high = bootstrap[249], bootstrap[9749]
# Predeclared exploratory budget, scoped to this controlled upload request path.
if low > 5:
    status = 'regression_detected_in_measured_upload_path'
elif high <= 5:
    status = 'regression_above_5_percent_not_detected_in_measured_upload_path'
else:
    status = 'inconclusive'
result['performanceGate'] = {
    'status': status,
    'scope': 'Controlled API-only authenticated HTTP upload completion, not media-ready throughput or whole application',
    'pairedBlocks': pairs,
    'geometricMeanIncreasePercent': 100 * math.expm1(statistics.mean(ratios)),
    'exploratory95PercentBlockBootstrapInterval': [low, high],
    'budgetPercent': 5,
    'method': 'Each deployment round is one paired block; log ratio of its 20-upload medians. Resample whole paired blocks 10000 times, seed 0. Positive means candidate slower. No individual-request independence assumption.',
    'limitations': 'Six paired blocks on one host give limited precision; bootstrap interval is exploratory, not a formal release qualification. The 5% budget was chosen before this controlled run completed. Default-background-work smoke remains inconclusive regardless of this result.',
}
path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result['performanceGate'], indent=2))
