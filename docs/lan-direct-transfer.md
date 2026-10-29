# Automatic LAN direct transfer

The mobile app tries authenticated discovery using the saved login URL on startup, app resume, connectivity events, and network settings changes. It restores that public route before probing a new network, then selects the fastest verified candidate. Failed discovery, unreachable candidates, unsupported older servers, and identity mismatches keep the public route active. Existing manual SSID switching takes precedence whenever `network.autoEndpointSwitching` is enabled.

Bootstrap also restores the saved public URL before session work starts. An automatic LAN URL saved during the previous run must pass discovery again before use. Logout prevents pending probes from restarting selection while background sync cancellation is still running.

## Server contract

Both endpoints use the existing `/api` prefix. Existing ping responses are unchanged.

- `GET /api/server/lan-candidates?nonce=<64 lowercase hex characters>` requires normal authentication. Returns `ServerLanCandidatesResponseDto { serverId: string, proof: string, urls: string[] }`.
- `GET /api/server/identity?nonce=<64 lowercase hex characters>` is public and returns `ServerIdentityResponseDto { serverId: string, proof: string }`. It never returns addresses or configuration.
- Both responses set `Cache-Control: no-store`. `serverId` is the SHA-256 fingerprint of a persistent, random instance secret. `proof` is the hexadecimal HMAC-SHA256 of the client nonce using that secret. The client generates a fresh cryptographically random nonce for each discovery and compares both fields on every candidate.
- The secret lives in the existing `system_metadata` table under `lan-identity`. Concurrent workers use insert-on-conflict-do-nothing and read back the winning value. No schema migration or existing data rewrite is required. Back up this metadata with the database; a database clone also clones the identity.

Optional admin-only system config fields, available through the existing config APIs and config file:

```json
{
  "server": {
    "localUrls": ["https://photos.home.example", "http://192.168.1.10:2283"],
    "autoDetectLocalUrls": false
  }
}
```

Defaults are `[]` and `false`. URLs must use HTTP or HTTPS and cannot contain credentials, query parameters, or fragments. Up to 16 configured URLs are accepted. URLs may include a reverse proxy prefix and may already end in `/api`; the client appends `/api` when absent.

Opt-in auto-detection adds HTTP URLs using the actual server listen port for RFC1918 IPv4 and IPv6 unique-local interface addresses. Loopback, link-local, and public addresses are excluded. Results are deduplicated and limited to 16. A container may advertise addresses the phone cannot reach, or the internal container port rather than the published host port. Configure explicit URLs in those deployments.

## Mobile UI contract

Import `package:immich_mobile/providers/lan_direct_transfer.provider.dart` and watch `lanDirectTransferProvider`. It exposes `LanRouteState`:

- `route`: `LanRoute.lan` or `LanRoute.public`.
- `url`: current API URL, or null before initialization/after logout.
- `lastProbeResult`: `idle`, `verified`, `noCandidates`, `unreachable`, `identityMismatch`, `insecureHttpRefused`, `discoveryFailed`, `disabled`, or `manualOverride`.
- `probes`: immutable list of `LanProbe` with `url`, `result`, and optional `latency` for verified responses.

During discovery the state reports the public URL with `idle`. A manual route reports `manualOverride` and does not run automatic probes. `ref.read(authProvider.notifier).setOpenApiServiceEndpoint()` refreshes routing using the existing endpoint entry point. Concurrent calls are serialized; stale network/account results and results after disposal are discarded.

Persistent settings, written through `settingsProvider`:

- `SettingsKey.networkAutomaticLanTransfer` / `AppConfig.network.automaticLanTransfer`: defaults to `true`.
- `SettingsKey.networkAllowInsecureLanTransfer` / `AppConfig.network.allowInsecureLanTransfer`: defaults to `false`.
- Existing `networkAutoEndpointSwitching`, preferred SSID, local URL, and external URLs retain their manual behavior and override automatic selection. If no manual external endpoint works, the saved public URL is restored.

The UI must explain that allowing insecure LAN transfer permits unencrypted credentials and media, and that HTTP cannot authenticate against an active network attacker. Use `insecureHttpRefused` to offer this explicit opt-in. Never silently enable it based on an HTTP candidate or on the saved public URL being HTTP. Logout clears both new settings.

`LanDirectTransferService.select(publicUrl:, allowInsecureHttp:)` returns a route without changing global endpoints. Discovery uses the existing authenticated native HTTP client. Probes use fresh credential-free HTTP clients, do not follow redirects, enforce normal TLS validation, and close after a two-second deadline. Candidates are probed concurrently and ranked by elapsed response time. Only after verification does `ApiService.activateEndpoint()` update the API client, persisted endpoint, and native credential routing used by uploads and downloads. The saved login URL is retained for future discovery and fallback.

Candidate validation rejects embedded credentials. Credentials already present in a trusted saved login URL retain their existing behavior and are never copied into a candidate probe. Login and manual URL resolution keep their existing credential-routing behavior; `activateEndpoint()` handles the verified automatic route and the trusted public fallback.

## Security and operational limits

Authenticated discovery prevents disclosure of LAN addresses to anonymous or shared-link callers. No public-address-disclosure option is provided. A fresh proof detects a different instance and rejects a copied fingerprint without the matching proof. HTTPS certificate validation remains essential: an attacker can relay challenge responses over HTTP. Explicit HTTP consent accepts that risk, along with unencrypted traffic. Existing manually configured routes retain their prior trust model.

Discovery must reach the saved public URL on each refresh. Candidates and proofs are not cached for offline discovery. A public URL outage therefore falls back to that URL even if a previously used LAN URL could still be reachable. There is no multicast discovery, subnet scanning, certificate bypass, or migration of requests already in flight. Connectivity notifications and resume hooks trigger new selection; they cannot revoke bytes already sent by the operating system during a network handoff.

The generated Dart client and Freezed/Drift outputs remain ignored under the repository's existing rules. Regenerate them with the normal mise tasks after checkout. The OpenAPI JSON and generated TypeScript SDK are committed.

## WIP review

The implementation retains the WIP's authenticated discovery endpoint, public credential-free identity challenge, opt-in interface detection, race-safe instance-secret insertion, optional config fields, manual-route precedence, Riverpod state, and concurrent bounded probes.

The completed version restores the public route during bootstrap, prevents selection during logout cancellation, discards state updates after disposal during activation, and preserves the existing login/manual resolver's credential-routing behavior. Candidate URLs remain strict, while trusted saved login URLs retain support for embedded credentials. It also rejects empty query and fragment markers in admin URLs, adds endpoint history, fixes two WIP lint errors, and adds compatibility, race, and literal HMAC-vector tests. OpenAPI, TypeScript, Dart, Freezed, Drift, native bindings, and translations were regenerated with the repository tasks.

## Verification on 2026-10-28

Flutter 3.47.2 and Dart 3.13.2 were available. Commands below ran from the repository root unless a mobile working directory is specified.

- `mise run open-api`: passed, including server/plugin/SDK builds and Dart client generation. Generated Dart files remain ignored by the repository.
- `flutter pub get --enforce-lockfile` in `mobile/`: passed.
- `mise run //mobile:codegen`: initially failed because ffigen could not find `stdarg.h`. `C_INCLUDE_PATH=/usr/lib/clang/23/include mise run //mobile:codegen` passed without changing project configuration.
- `mise run //server:check`: passed.
- `mise run //server:lint`: initially failed on two WIP test lint errors, both fixed. The final full run passed. The subsequently added persistent-identity repository test also passed `pnpm --filter immich exec eslint src/repositories/system-metadata.repository.spec.ts --max-warnings 0`. Its logging callback initially failed type checking and lint because it returned the result of `push`; an explicit void callback fixed both.
- `git diff --check`: passed.
- Dart formatting for all 13 changed Dart files: passed with no changes.
- Prettier for all changed TypeScript source files and this document, excluding generated SDK output: passed.
- `mise run //server:format`: failed on unchanged `server/test/benchmarks/image-preview.mjs`. That unrelated file was left unchanged. A broad root Prettier check also flagged the generator's native SDK/spec formatting; those files retain the exact generator output.
- An early Dart analysis before Freezed/translation generation reported missing generated members/files. The final analysis below passed with no issues.

Server tests passed: 180 tests in eight files, plus three persistent-identity repository tests. The latter use the real PostgreSQL query compiler with a dummy driver to check conflict-safe SQL and the winning-secret result; they do not simulate PostgreSQL concurrency.

```sh
mise run //server:test --run src/controllers/server.controller.spec.ts src/controllers/config.controller.spec.ts src/services/server.service.spec.ts src/services/system-config.service.spec.ts src/repositories/server-info.repository.spec.ts src/repositories/crypto.repository.spec.ts src/middleware/auth.guard.spec.ts src/services/auth.service.spec.ts
mise run //server:test --run src/repositories/system-metadata.repository.spec.ts
```

Mobile tests passed: 91 tests in four files, including SQLite-backed settings persistence. Run from `mobile/`:

```sh
flutter test test/services/lan_direct_transfer.service_test.dart test/services/auth.service_test.dart test/unit/repositories/settings_repository_test.dart test/medium/repositories/settings_repository_test.dart
```

Dart analysis passed with no issues. Run from `mobile/`:

```sh
dart analyze lib/services/api.service.dart lib/services/auth.service.dart lib/services/lan_direct_transfer.service.dart lib/providers/lan_direct_transfer.provider.dart lib/providers/app_life_cycle.provider.dart lib/repositories/auth.repository.dart lib/domain/models/config/network_config.dart lib/domain/models/config/app_config.dart lib/domain/models/settings_key.dart lib/utils/bootstrap.dart test/services/lan_direct_transfer.service_test.dart test/services/auth.service_test.dart test/unit/repositories/settings_repository_test.dart
```

No phone/emulator handoff, packet capture, real multi-worker PostgreSQL race, or full application test suite was run. The bootstrap change was analyzed and reviewed, but not driven through a live mobile startup. UI work is outside this change. HTTP relay exposure, database-clone identity, container addresses/ports, and public-URL-outage behavior remain as described above.

## Changed files

Paths relative to the repository root, compared with base `303e3ad`:

```text
docs/lan-direct-transfer.md
mobile/lib/domain/models/config/app_config.dart
mobile/lib/domain/models/config/network_config.dart
mobile/lib/domain/models/settings_key.dart
mobile/lib/providers/app_life_cycle.provider.dart
mobile/lib/providers/lan_direct_transfer.provider.dart
mobile/lib/repositories/auth.repository.dart
mobile/lib/services/api.service.dart
mobile/lib/services/auth.service.dart
mobile/lib/services/lan_direct_transfer.service.dart
mobile/lib/utils/bootstrap.dart
mobile/test/services/auth.service_test.dart
mobile/test/services/lan_direct_transfer.service_test.dart
mobile/test/unit/repositories/settings_repository_test.dart
open-api/immich-openapi-specs.json
packages/sdk/src/fetch-client.ts
server/src/controllers/config.controller.spec.ts
server/src/controllers/server.controller.spec.ts
server/src/controllers/server.controller.ts
server/src/dtos/config.dto.ts
server/src/dtos/server.dto.ts
server/src/enum.ts
server/src/repositories/crypto.repository.spec.ts
server/src/repositories/crypto.repository.ts
server/src/repositories/server-info.repository.spec.ts
server/src/repositories/server-info.repository.ts
server/src/repositories/system-metadata.repository.spec.ts
server/src/repositories/system-metadata.repository.ts
server/src/services/server.service.spec.ts
server/src/services/server.service.ts
server/src/services/system-config.service.spec.ts
server/src/types.ts
server/test/repositories/crypto.repository.mock.ts
server/test/repositories/system-metadata.repository.mock.ts
```
