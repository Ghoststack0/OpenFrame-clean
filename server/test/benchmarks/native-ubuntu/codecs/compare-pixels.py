"""Compare the raw stages written by pixels.mjs, without relaxing the parity gate."""

import json
import math
import sys
from pathlib import Path

before, after, output = map(Path, sys.argv[1:])
metadata = [json.loads((path / "stages.json").read_text()) for path in [before, after]]
results = {}
for stage in ["initial", "resized", "decodedPreview"]:
    infos = [item[stage]["info"] for item in metadata]
    if any(infos[0][key] != infos[1][key] for key in ["width", "height", "channels", "depth"]):
        raise ValueError(f"Pixel dimensions or depth changed: {stage}")
    a, b = [(path / f"{stage}.rgb").read_bytes() for path in [before, after]]
    if len(a) != len(b):
        raise ValueError(f"Pixel buffer lengths changed: {stage}")
    count = maximum = squared = 0
    for first, second in zip(a, b, strict=True):
        difference = abs(first - second)
        count += difference != 0
        maximum = max(maximum, difference)
        squared += difference * difference
    results[stage] = {
        "dockerInfo": infos[0],
        "nativeInfo": infos[1],
        "samples": len(a),
        "differingSamples": count,
        "maximumDifference": maximum,
        "psnr": "infinity" if not squared else 10 * math.log10(255 * 255 / (squared / len(a))),
    }
output.write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
