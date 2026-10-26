from pathlib import Path
import shutil

root = Path.home() / "openframe-native-validation-20261026/app/server"
base = root / "dist-baseline"
assert not base.exists(), "Refusing to replace baseline"
shutil.copytree(root / "dist", base)
replacements = {
    "repositories/storage.repository.js": [(", highWaterMark: 1024 * 1024", "")],
    "utils/file.js": [
        ("options.highWaterMark = 256 * 1024;", "options.highWaterMark = 64 * 1024;")
    ],
    "repositories/media.repository.js": [
        (
            "        const dimension = fit === 'inside' ? Math.max(image.info.width, image.info.height) : Math.min(image.info.width, image.info.height);\n        const isUnchangedSize = size !== undefined && dimension <= size && image.info.channels >= 3;\n        if (edits.length === 0 && (!size || isUnchangedSize)) {",
            "        if (!size && edits.length === 0) {",
        )
    ],
}
for filename, changes in replacements.items():
    p = base / filename
    text = p.read_text()
    for before, after in changes:
        assert text.count(before) == 1, filename
        text = text.replace(before, after)
    p.write_text(text)
print(
    "Baseline copied; reverted only upload buffering, video buffering, and image no-op transform."
)
