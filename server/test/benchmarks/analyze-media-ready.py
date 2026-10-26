"""Analyze the predeclared default-worker experiment, without request-level independence."""
import json
import math
import random
import statistics
import sys
from pathlib import Path


def analyze(rows, metric):
    pairs = []
    for round_ in range(6):
        versions = {row['version']: row for row in rows if row['round'] == round_}
        assert set(versions) == {'upstream', 'candidate'}
        assert [(sample['index'], sample['bytes']) for sample in versions['upstream']['uploadSamples']] == [(sample['index'], sample['bytes']) for sample in versions['candidate']['uploadSamples']]
        medians = {}
        for version, row in versions.items():
            assert len(row['uploadSamples']) == 20
            assert all(row['database'][key] == 'on' for key in ('fsync', 'full_page_writes', 'synchronous_commit'))
            medians[version] = statistics.median(sample[metric] for sample in row['uploadSamples'])
        pairs.append({'round': round_, **medians})
    ratios = [math.log(pair['candidate'] / pair['upstream']) for pair in pairs]
    rng = random.Random(0)
    draws = sorted(100 * math.expm1(statistics.mean(rng.choices(ratios, k=6))) for _ in range(10000))
    low, high = draws[249], draws[9749]
    status = 'regression' if low > 5 else ('within_5_percent_budget' if high <= 5 else 'inconclusive')
    strict = 'evidence_of_slowdown' if low > 0 else ('interval_entirely_faster_or_equal' if high <= 0 else 'inconclusive')
    return {'status': status, 'strictZeroPercentReference': strict, 'pairedDeploymentMediansMs': pairs,
            'geometricMeanIncreasePercent': 100 * math.expm1(statistics.mean(ratios)),
            'exploratory95PercentBlockBootstrapInterval': [low, high]}


def self_check():
    rows = [{'round': i, 'version': version, 'database': dict.fromkeys(('fsync', 'full_page_writes', 'synchronous_commit'), 'on'),
             'uploadSamples': [{'index': index, 'bytes': 1, 'elapsedMs': value} for index in range(20)]}
            for i in range(6) for version, value in [('upstream', 100), ('candidate', 110)]]
    assert analyze(rows, 'elapsedMs')['status'] == 'regression'
    assert analyze(rows, 'elapsedMs')['strictZeroPercentReference'] == 'evidence_of_slowdown'
    for row in rows:
        for sample in row['uploadSamples']:
            sample['elapsedMs'] = 100
    assert analyze(rows, 'elapsedMs')['status'] == 'within_5_percent_budget'
    assert analyze(rows, 'elapsedMs')['strictZeroPercentReference'] == 'interval_entirely_faster_or_equal'


if __name__ == '__main__':
    self_check()
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
        result = json.loads(path.read_text())
        assert result['mediaReady'] and not result['controlled'] and result['behaviorStatus'] == 'passed'
        assert len(result['rounds']) == 12
        assert result['workload']['workersInclude'] == 'api,microservices'
        assert result['predeclaredGate']['budgetPercent'] == 5
        result['limitations'] = 'One shared two-core host; six alternating deployment pairs, fresh disposable durable database/storage per deployment. Default API/microservices workers; ML disabled. API and geodata startup plus one media-ready warmup finish before measurement. Sequential synthetic PNGs over loopback HTTP; no concurrent backlog, video, ML, WAN/TLS/mobile or populated-library claim. Media-ready means thumbnail and preview HTTP image responses, not completion of every background queue; 50 ms unsuccessful-poll sleep plus HTTP observer cost. Candidate reuses recorded production dependencies/native codecs with freshly compiled server dist, not a release image. Exploratory bootstrap interval cannot certify the whole application.'
        result['workload']['volumeLifecycle'] = 'Fresh volumes before every deployment, removed after each deployment'
        result['workload']['mediaReadyPollSleepMs'] = 50
        for version in ('upstream', 'candidate'):
            result['summary'][version]['mediaReadyMedianMs'] = statistics.median(sample['mediaReadyMs'] for row in result['rounds'] if row['version'] == version for sample in row['uploadSamples'])
        metrics = {metric: analyze(result['rounds'], metric) for metric in ('elapsedMs', 'mediaReadyMs')}
        statuses = [metric['status'] for metric in metrics.values()]
        result['performanceGate'] = {'status': 'regression' if 'regression' in statuses else ('within_5_percent_budget' if all(status == 'within_5_percent_budget' for status in statuses) else 'inconclusive'), 'metrics': metrics}
        path.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result['performanceGate'], indent=2))
