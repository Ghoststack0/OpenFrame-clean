# Import Google Takeout or iCloud Photos

Use the built-in `openframe import` commands to migrate an export. The `immich` alias accepts the same commands.
The importer reads your exports without modifying or deleting them.

## Check the export

For Google Takeout, select Google Photos and download **all** archive parts. Pass the parts together so media and JSON sidecars can match across archives:

```bash
openframe import takeout ~/Downloads/takeout-*.zip --dry-run
openframe import takeout ~/Downloads/takeout-*.tgz --dry-run
```

You can also pass extracted folders, or mix folders and archive parts. ZIP, TGZ, and TAR.GZ media stream through one temporary staging file at a time. Allow temporary disk space for the largest media file. Metadata indexes remain in memory.

For iCloud Photos, extract the export into one folder. Keep `Photo Details.csv` and album CSVs with the media:

```bash
openframe import icloud ~/Downloads/icloud-export --dry-run
```

Review the printed media counts, matched and unmatched sidecars, album names, and Live Photo pair count. Open the JSON report at the printed path to inspect problems. Dry-run works offline and creates neither assets nor resume state.

## Import and resume

Log in with the existing CLI login command. Use an API key with `asset.upload`, `asset.read`, `asset.update`, `album.read`, `album.create`, `album.update`, `user.read`, and `apiKey.read` permissions, or `all`.

```bash
openframe import takeout ~/Downloads/takeout-*.zip
openframe import icloud ~/Downloads/icloud-export
```

Rerun the same command after an interruption. The importer uses a local journal under `<config-directory>/imports/`, bound to the server and user. It skips completed files and retries incomplete metadata, album membership, and Live Photo links. Checksum deduplication also reuses assets already on the server. Explicit sidecar metadata applies to reused assets too.

To choose the journal and report locations, pass `--progress-file <file>` and `--report <file>`. Each report requires a new filename. Both locations must be outside the export. Keep the journal when moving between machines. Preserve the export paths to retain file-level resume checks.

If a process is forcibly killed, remove its `<progress-file>.lock` only after confirming that no importer is using it. The importer recovers an incomplete final journal record automatically. Reports and journals contain filenames and metadata, so keep them private.

## Review metadata and skipped items

Takeout matching prefers the exact sidecar name, then its `title`, edited-file fallback, and 46- or 47-character truncations. It handles numbering such as `IMG(1).jpg` with `IMG.jpg(1).json`, plain `.json`, `.metadata.json`, and `.supplemental-metadata.json` suffixes, including truncated supplemental suffixes. Ambiguous matches and invalid matching sidecars skip the media and appear in the report.

The importer applies capture time, description, favorites, archive status, and GPS coordinates. It ignores the `0,0` GPS placeholder and tries `geoDataExif` when `geoData` has no location. Album folders become albums, using `metadata.json` titles when present. Automatic `Photos from YYYY` folders do not become albums.

Trashed and explicitly marked partner-shared items are skipped by default. To include them, add `--include-trashed` or `--include-partner` to the Takeout command. Included trash becomes an ordinary asset. Exports without a partner-sharing marker cannot identify those items.

iCloud CSVs must use UTF-8. Recognized filename columns include `imgName`, `File Name`, and `Original Filename`. Capture dates accept ISO timestamps and `YYYY-MM-DD HH:mm:ss UTC`. Dates without a timezone use UTC. Favorites accept `yes`, `true`, or `1`. Album CSVs use an `Album Name` column, or the CSV filename when that column is absent. `Photo Details.csv` itself does not create an album. Ambiguous filenames and unrecognized CSV data appear in the report. Missing CSV metadata falls back to embedded file metadata.

Separate images and videos with the same stem in the same export folder become Live Photos when the pair is unambiguous. Names such as `photo.jpg` with `photo.jpg.mp4` also match. Other assets stay separate. Embedded Motion Photo handling remains part of the existing server upload pipeline.

Keep the report and inspect the imported library before removing your original exports.
