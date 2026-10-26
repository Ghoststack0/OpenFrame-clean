"""Validate gate completeness/parity and summarize dry runs or alternating pairs."""

import argparse
import hashlib
import json
import math
import statistics
import tempfile
from pathlib import Path


def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def summarize(directory):
    rows = [json.loads(line) for line in (directory / "metrics.jsonl").read_text().splitlines()]
    counts = {kind: sum(row["kind"] == kind for row in rows) for kind in {row["kind"] for row in rows}}
    assert counts == {"warmup": 1, "batch": 3, "single": 1, "grid": 2, "video-ready": 1, "seek": 16, "transfer": 3, "parity": 1}, counts
    assert sorted(row["concurrency"] for row in rows if row["kind"] == "batch") == [1, 4, 8]
    parity = next(row for row in rows if row["kind"] == "parity")
    assert parity["originalIntegrity"] and parity["smartSearch"] and parity["queuesDrained"] and parity["failedJobs"] == 0 and parity["artifactCount"] == 323
    artifacts = json.loads((directory / "artifacts.json").read_text())
    assert len(artifacts["artifacts"]) == 323
    for artifact in artifacts["artifacts"]:
        assert hashlib.sha256((directory / artifact["file"]).read_bytes()).hexdigest() == artifact["sha256"], artifact["file"]
    values = {}
    for row in rows:
        if row["kind"] == "batch":
            assert row["photos"] == 20 and row["originalIntegrity"]
            for key in ["uploadWallMs", "allReadyMs", "mlDoneMs"]:
                values[f"batch-c{row['concurrency']}.{key}"] = row[key]
        elif row["kind"] == "single":
            values["single.previewReadyMs"] = row["previewReadyMs"]
            values["single.uploadMs"] = row["uploadMs"]
        elif row["kind"] == "grid":
            assert row["thumbnails"] == 200 and row["connectionLimit"] == 6 and row["connectionsUsed"] == 6
            assert row["status"] == (200 if row["cache"] == "cold" else 304)
            for key in ["requestsPerSecond", "p95Ms", "wallMs"]:
                values[f"grid-{row['cache']}.{key}"] = row[key]
        elif row["kind"] == "video-ready":
            assert row["width"] == 3840 and row["height"] == 2160
            for key in ["previewReadyMs", "thumbnailReadyMs", "allReadyMs"]:
                values[f"video-4k.{key}"] = row[key]
    seeks = [row for row in rows if row["kind"] == "seek"]
    transfers = [row for row in rows if row["kind"] == "transfer"]
    assert all(row["integrity"] for row in seeks + transfers)
    values["video-seek.medianTtfbMs"] = statistics.median(row["ttfbMs"] for row in seeks)
    values["video-seek.p95TtfbMs"] = percentile([row["ttfbMs"] for row in seeks], 0.95)
    values["video-transfer.medianMiBPerSecond"] = statistics.median(row["mibPerSecond"] for row in transfers)
    resources = json.loads((directory / "resources.json").read_text())
    assert resources["hostIdleDuringRun"] and not resources.get("failed"), "Host-idle/resource gate failed"
    for key in ["backendCpuSeconds", "peakRssBytes", "peakStackRssBytes"]:
        assert resources[key] > 0
        values[f"resources.{key}"] = resources[key]
    values["resources.ancillaryCpuSecondsLowerBound"] = resources["ancillaryCpuSecondsLowerBound"]
    values["resources.stackCpuSecondsLowerBound"] = resources["backendCpuSeconds"] + resources["ancillaryCpuSecondsLowerBound"]
    assert all(value > 0 and math.isfinite(value) for value in values.values())
    return values, artifacts



def compare_artifacts(before_dir, after_dir):
    before = json.loads((before_dir / "artifacts.json").read_text())
    after = json.loads((after_dir / "artifacts.json").read_text())
    assert before["manifestSha256"] == after["manifestSha256"], "Fixture manifests differ"
    key = lambda item: f"{item['fixture']}/{item['size']}"
    x = {key(item): item for item in before["artifacts"]}
    y = {key(item): item for item in after["artifacts"]}
    assert len(x) == len(y) == 323 and x.keys() == y.keys()
    result = []
    for name, baseline in x.items():
        candidate = y[name]
        assert (baseline["width"], baseline["height"]) == (candidate["width"], candidate["height"]), name
        assert baseline["sha256"] == candidate["sha256"], f"Preview bytes changed: {name}"
        result.append({"fixture": name, "baselineSha256": baseline["sha256"], "candidateSha256": candidate["sha256"], "byteEqual": True})
    return result


def self_test():
    assert percentile(list(range(1, 21)), 0.95) == 19
    assert math.exp(statistics.mean([math.log(2), math.log(0.5)])) == 1
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        before, after = root / "before", root / "after"
        before.mkdir()
        after.mkdir()
        a, b = b"baseline rendition", b"changed rendition"
        (before / "a.bin").write_bytes(a)
        (after / "a.bin").write_bytes(a)
        items = [{"fixture": str(i), "size": "thumbnail", "file": "a.bin", "sha256": hashlib.sha256(a).hexdigest(), "width": 32, "height": 32} for i in range(323)]
        original = {"manifestSha256": "same", "artifacts": items}
        (before / "artifacts.json").write_text(json.dumps(original))
        (after / "artifacts.json").write_text(json.dumps(original))
        assert all(row["byteEqual"] for row in compare_artifacts(before, after))
        items[0] = {**items[0], "sha256": hashlib.sha256(b).hexdigest()}
        (after / "artifacts.json").write_text(json.dumps(original))
        try:
            compare_artifacts(before, after)
        except AssertionError as error:
            assert "Preview bytes changed" in str(error)
        else:
            raise AssertionError("Changed preview bytes passed")
    print("Gate self-check passed: pairing math, exact bytes and rejection of every changed rendition.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    assert args.directory
    directories = sorted(path for path in args.directory.iterdir() if path.is_dir() and (path / "metrics.jsonl").exists())
    assert directories, "No gate runs"
    series = json.loads((args.directory / "series.json").read_text())
    assert {path.name for path in directories} == set(series["runOrder"]), "Incomplete series"
    values = {path.name: summarize(path)[0] for path in directories}
    dry = list(values) == ["candidate-dry-run"]
    result = {"mode": "candidate dry run, no speedup claim" if dry else "alternating actual-upstream/candidate pairs", "runs": values, "pairedMetrics": {}, "pairedVideoSamples": {}, "parity": [], "analyzerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if not dry:
        builds = json.loads((args.directory / "builds.json").read_text())
        assert builds["baseline"]["sourceCommit"] == "256eb55dbe92ac77e02794442f9487e88ffed2b1"
        rounds = sorted({int(name.rsplit("-r", 1)[1]) for name in values})
        assert rounds == list(range(series["pairs"]))
        expected_order = [f"{variant}-r{number}" for number in rounds for variant in (["baseline", "candidate"] if number % 2 == 0 else ["candidate", "baseline"])]
        assert series["runOrder"] == expected_order, "Runs were not alternating pairs"
        assert set(values) == {f"{variant}-r{number}" for number in rounds for variant in ["baseline", "candidate"]}, "Incomplete paired series"
        video_samples = {"seek.ttfbMs": [], "transfer.mibPerSecond": []}
        for number in rounds:
            before_rows = [json.loads(line) for line in (args.directory / f"baseline-r{number}/metrics.jsonl").read_text().splitlines()]
            after_rows = [json.loads(line) for line in (args.directory / f"candidate-r{number}/metrics.jsonl").read_text().splitlines()]
            assert next(row for row in before_rows if row["kind"] == "warmup")["systemConfigSha256"] == next(row for row in after_rows if row["kind"] == "warmup")["systemConfigSha256"], "Server policies differ between variants"
            assert [(row["sample"], row["offset"]) for row in before_rows if row["kind"] == "seek"] == [(row["sample"], row["offset"]) for row in after_rows if row["kind"] == "seek"]
            for key, samples in video_samples.items():
                kind, metric = key.split(".")
                before = {row["sample"]: row for row in before_rows if row["kind"] == kind}
                after = {row["sample"]: row for row in after_rows if row["kind"] == kind}
                assert before.keys() == after.keys()
                samples.extend((before[index][metric], after[index][metric]) for index in before)
            result["parity"].append({"round": number, "fixtures": compare_artifacts(args.directory / f"baseline-r{number}", args.directory / f"candidate-r{number}")})
        for metric in next(iter(values.values())):
            pairs = [(values[f"baseline-r{number}"][metric], values[f"candidate-r{number}"][metric]) for number in rounds]
            higher_better = metric.endswith(("requestsPerSecond", "MiBPerSecond"))
            ratios = [after / before if higher_better else before / after for before, after in pairs]
            result["pairedMetrics"][metric] = {"pairs": len(pairs), "baselineMedian": statistics.median(before for before, _ in pairs), "candidateMedian": statistics.median(after for _, after in pairs), "geometricMeanSpeedup": math.exp(statistics.mean(math.log(value) for value in ratios)), "slowerCandidatePairs": sum(value < 1 for value in ratios)}
        for key, samples in video_samples.items():
            higher_better = key.endswith("mibPerSecond")
            ratios = [after / before if higher_better else before / after for before, after in samples]
            result["pairedVideoSamples"][key] = {"pairedSamples": len(samples), "baselineMedian": statistics.median(before for before, _ in samples), "candidateMedian": statistics.median(after for _, after in samples), "geometricMeanSpeedup": math.exp(statistics.mean(math.log(value) for value in ratios)), "slowerCandidateSamples": sum(value < 1 for value in ratios)}
    (args.directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"mode": result["mode"], "runs": values, "pairedMetrics": result["pairedMetrics"]}, indent=2))


if __name__ == "__main__":
    main()
