# Asset processing status

`POST /api/assets/processing-status` reports processing stages for readable assets. It requires `asset.read` and supports normal sessions, API keys, and shared links. The existing asset-read rules cover ownership, shared albums, partners, and locked assets. An inaccessible or missing ID rejects the entire batch with HTTP 400, without returning partial status.

The request is `AssetProcessingStatusRequestDto`:

```json
{ "assetIds": ["00000000-0000-4000-a000-000000000000"] }
```

The batch accepts 1–100 UUIDv4 IDs. Duplicate IDs count toward that limit. Each distinct ID returns one result. Response order is unspecified. The response is `AssetProcessingStatusResponseDto[]`:

```json
[
  {
    "assetId": "00000000-0000-4000-a000-000000000000",
    "stages": [
      { "stage": "uploaded", "state": "complete" },
      { "stage": "metadata", "state": "complete" },
      { "stage": "thumbnails", "state": "pending" },
      { "stage": "video", "state": "skipped" },
      { "stage": "smartSearch", "state": "pending" },
      { "stage": "faces", "state": "pending" }
    ]
  }
]
```

`AssetProcessingStage` has six values, always returned in the order shown above. Each stage has an independent `AssetProcessingState`: `pending`, `complete`, `skipped`, or `failed`. `pending` means there is no known completion or failure; it does not distinguish queued jobs from running jobs. Jobs can run concurrently, so the stages are not a linear percentage.

| Stage         | Completion evidence                             | Skipped when                                                                                                   |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `uploaded`    | Asset record exists after receipt of bytes      | Never                                                                                                          |
| `metadata`    | `asset_job_status.metadataExtractedAt`          | Never                                                                                                          |
| `thumbnails`  | Both unedited thumbnail and preview files exist | Asset is hidden                                                                                                |
| `video`       | Unedited encoded-video file exists              | Asset is not a video, conversion is disabled, or the current conversion policy requires no conversion or remux |
| `smartSearch` | Smart-search embedding row exists               | Global ML or CLIP is disabled, or asset is hidden                                                              |
| `faces`       | `asset_job_status.facesRecognizedAt`            | Global ML or facial recognition is disabled, or asset is hidden                                                |

`faces` means detection finished, including a result with zero faces. It does not mean every face has been assigned to a person. Skipped stages take precedence over saved completion evidence and failures under the current system configuration.

Returned job failures and thrown job errors set a stage failure marker in the existing queue Redis instance. Markers expire after seven days and are cleared when a stage starts again or finishes successfully. Failures from before this feature, expired markers, and markers lost with Redis cannot be reconstructed; those stages can report `pending`. There is no database migration and no duplicate database completion state. Status-notification errors are logged and do not fail processing jobs.

The websocket event is `AssetProcessingStatusV1`, sent only to the asset owner's authenticated room. Its generated payload type is `AssetProcessingEventV1`:

```json
{
  "assetId": "00000000-0000-4000-a000-000000000000",
  "stage": "metadata",
  "state": "complete"
}
```

Events report upload creation, stage completion, failure, and retry starts. Notifications coalesce for 100 ms and read at most 100 assets per database query. Failure lookups use one Redis MGET per batch. Job event handlers only enqueue notifications in memory; they do not await status database or Redis operations. Multiple updates to the same stage within a batch report the latest state. Pending notifications drain on graceful shutdown. Abrupt termination can lose notifications and recent failure markers; a status fetch recovers durable completion evidence. This batching behavior is covered by unit tests; upload throughput and job latency have not been benchmarked.

Events contain no job error text, file paths, embeddings, or face data. Clients with shared read access use the batch endpoint; they do not receive the owner's events. Reconnection requires a status fetch to recover missed events. Upload-only shared links without asset-read access cannot fetch status.

The generated TypeScript SDK exposes `getAssetProcessingStatus({ assetProcessingStatusRequestDto: { assetIds } })`, plus the request, response, event, stage, and state types. `mise run open-api` regenerates OpenAPI, TypeScript, and Dart. Dart output lives in the repository-ignored `mobile/generated/openapi` directory.

The web data layer exports `assetProcessingStore` and `createAssetProcessingStore()` from `$lib/stores/asset-processing`:

| Method             | Behavior                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `subscribe`        | Standard Svelte readable store of `Map<string, AssetProcessingStatusResponseDto>` keyed by server asset ID |
| `track(assetId)`   | Seed uploaded completion and schedule a batched status fetch; repeated calls are ignored                   |
| `update(event)`    | Apply a stage event for an already tracked asset                                                           |
| `refresh()`        | Fetch all tracked IDs in batches of at most 100; retain websocket updates received during the fetch        |
| `dismiss(assetId)` | Remove an asset from session tracking                                                                      |
| `reset()`          | Clear all status and invalidate responses from earlier sessions                                            |

The store retains the latest 1,000 uploads in memory. The upload store starts tracking server IDs immediately after successful upload responses, before album assignment. Duplicate uploads are excluded. Clearing a completed upload row preserves its processing status. Websocket reconnects and configuration changes refresh status. Logout clears tracking, and asset deletion events dismiss affected IDs. Failed fetches retain the last known state; a later refresh can retry. The store has no polling. The web upload panel (`web/src/routes/UploadPanel.svelte`) renders it: `web/src/lib/stores/upload-processing.ts` joins the store with the file name and type of each upload (the status carries neither) and derives one row per upload plus a summary. A pending stage is drawn as in progress only when the stage it depends on (metadata, then thumbnails, then video, smart search and faces) is complete or skipped, because the API does not tell queued from running jobs. The video stage is hidden for images. The panel stays open while any item is unfinished or failed, and closes three seconds after everything finished without a failure; "Clear finished" calls `dismiss(assetId)` for fully processed items.
