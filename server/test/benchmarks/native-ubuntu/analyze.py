"""Compare paired loopback HTTP samples; retain warmups in the source JSONL."""

import json
import math
import statistics
import sys
from pathlib import Path

source, output = map(Path, sys.argv[1:])
rows = [json.loads(line) for line in source.read_text().splitlines()]
paired = {}
for row in rows:
    version, separator, round_number = row["label"].partition("-r")
    if not separator or version not in {"baseline", "candidate"}:
        continue
    key = (int(round_number), row["kind"], row.get("sample", 0))
    assert version not in paired.setdefault(key, {}), "Duplicate timed sample"
    paired[key][version] = row
assert len(paired) == 39, (
    "Expected three rounds, each with six photos, six videos and one parity row"
)
metrics = {"uploadMs": [], "readyMs": [], "milliseconds": []}
for key, pair in paired.items():
    assert pair.keys() == {"baseline", "candidate"}, f"Incomplete pair: {key}"
    before, after = pair["baseline"], pair["candidate"]
    if before["kind"] == "parity":
        for row in [before, after]:
            assert (
                row["smartSearch"] and row["queuesDrained"] and row["failedJobs"] == 0
            )
        continue
    assert (
        before["fixtureSha256"] == after["fixtureSha256"]
        and before["bytes"] == after["bytes"]
    )
    if before["kind"] == "photo":
        assert before["previewSha256"] == after["previewSha256"], (
            "Paired preview bytes changed"
        )
    for metric, values in metrics.items():
        if metric in before:
            values.append((before[metric], after[metric]))
result = {
    "method": "Three alternating pairs of the same native build, reverting only the three measured changes for baseline. Warm filesystem cache; normal workers and CPU ML. Timed photo readiness ends at preview response, not completion of ML jobs.",
    "metrics": {},
}
for metric, values in metrics.items():
    assert len(values) == 18
    ratios = [before / after for before, after in values]
    result["metrics"][metric] = {
        "pairedSamples": len(values),
        "baselineMedianMs": statistics.median(before for before, _ in values),
        "candidateMedianMs": statistics.median(after for _, after in values),
        "geometricMeanSpeedup": math.exp(
            statistics.mean(math.log(ratio) for ratio in ratios)
        ),
        "minimumPairedSpeedup": min(ratios),
        "maximumPairedSpeedup": max(ratios),
        "slowerCandidateSamples": sum(ratio < 1 for ratio in ratios),
    }
result["allPairedPreviewBytesIdentical"] = True
result["allPairedFixtureHashesIdentical"] = True
result["requested2to5xGainEstablished"] = False
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
