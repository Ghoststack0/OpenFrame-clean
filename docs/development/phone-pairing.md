# Phone pairing contract

Phone pairing adds three authentication routes. Existing login routes, response fields, and session validation remain compatible.

## HTTP API

All paths below are relative to `/api`. Pairing responses use `Cache-Control: no-store`.

| Method and path             | Authentication      | Request                                           | Response                                                      |
| --------------------------- | ------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `POST /auth/pairing`        | User session        | Empty                                             | `PairingResponseDto`: `id`, `code`, `expiresAt`, `serverUrls` |
| `POST /auth/pairing/redeem` | Public              | `PairingRedeemDto`: `{ "code": "<id>.<secret>" }` | Existing `LoginResponseDto`, including `accessToken`          |
| `GET /auth/pairing/{id}`    | The issuing session | UUID path parameter                               | `PairingStatusDto`: `{ "status": "pending                     | redeemed | expired | locked" }` |

Codes expire after five minutes. Only the latest code issued by each session remains valid. Issuing another code invalidates its predecessor. Polling a removed code returns 401. Pending codes also disappear when their issuing session is revoked.

Redemption returns 401 for unknown, expired, used, or incorrect codes. Five incorrect secrets permanently lock that pairing record. Later attempts, including the correct secret, return 429 until a new code is issued. Malformed codes fail DTO validation with 400. API keys and shared links cannot issue or poll codes. Restrictions return 403 when issuing, and invalid pending credentials return 401 when redeeming.

Pairing is disabled when both password login and OAuth are disabled. Issuance and redemption require an active, undeleted account without a pending mandatory password change for an existing password. Passwordless OAuth accounts can retain the default password-change flag and still pair. OAuth-only installations can pair phones.

The phone receives a normal session with device type, OS, and application version parsed through the existing login request headers. The session inherits the issuer's explicit expiration, parent restriction, OAuth session ID, and OAuth logout token. Its PIN expiration is null. Existing session listing, individual revocation, revoke-all, password-change revocation, and OAuth backchannel revocation apply. Pairing does not unlock locked assets.

The external domain from system configuration is the first candidate URL. The request origin is the fallback and an additional candidate when different. The existing system configuration normalizes the external domain to its origin. Payload parsing and formatting preserve URL subpaths and remove trailing slashes. The server rejects URL credentials, query strings, fragments, and schemes other than HTTP or HTTPS.

There is no new websocket event. The web helper polls the authenticated status route once per second and stops on a terminal status, expiration, cancellation, or an HTTP error.

## QR payload version 1

The code is a UUID, a dot, and a 32-byte random secret encoded as 43 unpadded base64url characters. Only its SHA-256 digest is stored in PostgreSQL.

URI form, with query values URL-encoded:

```text
openframe://pair?v=1&server=https%3A%2F%2Fphotos.example.com&server=http%3A%2F%2F192.168.1.9%3A2283&code=<id>.<secret>
```

Plain JSON form:

```json
{
  "version": 1,
  "serverUrls": ["https://photos.example.com", "http://192.168.1.9:2283"],
  "code": "<id>.<secret>"
}
```

Candidate order expresses preference, not permission to broadcast the code. The mobile parser accepts up to eight candidates and 8192 input characters. It rejects duplicate URI version/code parameters, malformed credentials, URL user information, query strings, fragments, and non-HTTP URLs. Decoder errors omit scanned input.

## Web integration

`web/src/lib/services/phone-pairing.ts` exports:

- `createPhonePairing()`: creates a code using the signed-in SDK and returns `PairingResponseDto` plus `payload` and `jsonPayload` strings.
- `buildPairingPayload(pairing, format = 'uri')`: formats a response as a URI or JSON string.
- `waitForPhonePairing({ id, expiresAt }, abortSignal)`: resolves to `PairingState.Redeemed`, `Expired`, or `Locked`; request and abort errors reject.

The UI can render `payload` with the existing QR dependency. Its abort controller must cancel polling when the dialog closes or a code is replaced. Keep payloads in component memory and remove the QR after expiry or redemption.

## Mobile integration

`PairingPayload.parse(scannedText)` in `mobile/lib/models/auth/pairing_payload.model.dart` validates either envelope and exposes immutable `serverUrls` and `code` fields.

After showing the selected server, the scanner UI calls:

```dart
final payload = PairingPayload.parse(scannedText);
final response = await ref.read(authProvider.notifier).pairPhone(
  payload,
  serverUrl: payload.serverUrls.first,
);
```

`AuthNotifier.pairPhone` returns the existing mobile `LoginResponse`. It rejects an already signed-in device, resolves the chosen endpoint with the existing server discovery flow, rejects cross-origin discovery, sets device headers, redeems via `AuthApiRepository.redeemPairing`, and calls the existing `saveAuthInfo` flow. Endpoint, token, user state, and widget credentials follow the normal login storage path. It does not navigate or start the scanner. The UI must run the same post-login configuration and navigation steps as the existing login form. For password-change UI, also check the existing auth status `password` boolean, since a passwordless OAuth account can retain the default `shouldChangePassword` flag.

Alternate candidates require explicit selection. The provider never automatically retries a code against a different host. A network failure after a successful server commit may leave the code consumed without a saved phone session. Reissue a code from the web in that case.

Generated TypeScript operations are `createPairing`, `redeemPairing`, and `getPairingStatus`. The Dart API exposes the same operation names. Run `mise run open-api` to rebuild the OpenAPI spec and both clients. The Dart output under `mobile/generated/openapi` follows the repository's existing ignore rules.

## Security notes

A QR code grants account access to whoever can read it before expiry. It requires the same care as a password. Screenshots, screen sharing, extensions, and someone else's camera can expose it. The mobile UI must show the destination before redemption and must not silently replace an existing account. A malicious QR can sign someone into an attacker-controlled account or server.

Use HTTPS for remote access. HTTP remains available for existing LAN deployments and exposes the code and resulting session to anyone who can observe that network. Configure the external domain and trusted proxies correctly so the fallback origin reflects the public address. Protect the public endpoint with the installation's normal network request-volume controls; the application lockout is per pairing record, not per IP.

PostgreSQL row locking serializes attempts. Consuming a code and inserting its session occur in one transaction, so concurrent redemption cannot issue multiple sessions. Incorrect attempts commit before the service returns an error. Secret comparison uses fixed-length hashes and `timingSafeEqual`. The pairing secret is posted in a JSON body; the request logger redacts `code` values. Responses are not cached. Expired records are pruned during code issuance, and session deletion cascades to its pairing records.

Pairing reuses an existing session's authority. It does not ask the OAuth identity provider to authenticate again or transfer PIN elevation. Existing sessions and API clients retain their previous behavior.

## Implementation verification

The focused checks below passed on this branch:

| Check                      | Command                                                                                                                                                                                                                       | Result                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| OpenAPI and both clients   | `mise run open-api`                                                                                                                                                                                                           | Passed, including server build, TypeScript SDK build, and Dart generation |
| Server unit and HTTP tests | `mise exec -- pnpm --filter immich test --run src/services/auth-pairing.service.spec.ts src/services/auth.service.spec.ts src/controllers/auth.controller.spec.ts src/middleware/logging.interceptor.spec.ts`                 | 140 passed                                                                |
| PostgreSQL transactions    | `IMMICH_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:15439/mich mise exec -- pnpm --filter immich test:medium --run test/medium/specs/services/auth-pairing.service.spec.ts`                                      | 11 passed                                                                 |
| Server types               | `mise exec -- pnpm --filter immich exec tsc --noEmit`                                                                                                                                                                         | Passed                                                                    |
| Web helper tests           | `mise exec -- pnpm --filter immich-web test --run src/lib/services/phone-pairing.spec.ts`                                                                                                                                     | 8 passed                                                                  |
| Web types                  | `mise exec -- pnpm --filter immich-web exec tsc --noEmit`                                                                                                                                                                     | Passed                                                                    |
| Migration order            | `mise exec -- pnpm --filter immich run migrations:verify-order`                                                                                                                                                               | Passed, 104 migrations                                                    |
| Mobile dependencies        | From `mobile`: `flutter pub get`                                                                                                                                                                                              | Passed                                                                    |
| Existing mobile models     | From `mobile`: `dart run build_runner build`                                                                                                                                                                                  | Passed, generated 300 outputs                                             |
| Dart parser tests          | From `mobile`: `flutter test test/models/auth/pairing_payload_test.dart`                                                                                                                                                      | 6 passed                                                                  |
| Mobile types and lint      | From `mobile`: `dart analyze lib/models/auth/pairing_payload.model.dart lib/providers/auth.provider.dart lib/repositories/auth_api.repository.dart lib/services/auth.service.dart test/models/auth/pairing_payload_test.dart` | No issues found                                                           |

The PostgreSQL test used a disposable container on `yvm@192.168.1.9`, accessed through a loopback SSH tunnel. Its image was `ghcr.io/immich-app/postgres:14-vectorchord0.4.3`. All migrations ran successfully against that empty database. The container and tunnel were removed after testing.

Server lint passed with this command:

```bash
mise exec -- pnpm --filter immich exec eslint \
  src/controllers/auth.controller.ts src/controllers/auth.controller.spec.ts \
  src/dtos/auth.dto.ts src/middleware/logging.interceptor.ts \
  src/middleware/logging.interceptor.spec.ts src/repositories/session.repository.ts \
  src/schema/index.ts src/schema/tables/pairing.table.ts \
  src/services/auth.service.ts src/services/auth-pairing.service.spec.ts \
  test/medium/specs/services/auth-pairing.service.spec.ts
```

The normal web ESLint command crashed inside the existing `tscompat/tscompat` rule with `TypeError: Cannot read properties of undefined (reading 'Class')`. This command passed with that rule disabled for the invocation; no repository lint configuration was changed:

```bash
mise exec -- pnpm --filter immich-web exec eslint --fix \
  --rule 'tscompat/tscompat: off' \
  src/lib/services/phone-pairing.ts src/lib/services/phone-pairing.spec.ts
```

Initial test failures came from missing test mocks, a reused OAuth fixture session ID, and expecting a subpath that the existing configuration loader removes. These were corrected before the passing runs. Early Dart analysis ran before generated dependencies were ready; the final scoped analysis passed after code generation.

Full application builds, physical-device pairing, scanner/deep-link registration, and polished screens were outside this implementation. No dependencies were added. No push or PR was created.

## Changed files

Server and generated API contract:

- `server/src/controllers/auth.controller.ts`
- `server/src/controllers/auth.controller.spec.ts`
- `server/src/dtos/auth.dto.ts`
- `server/src/middleware/logging.interceptor.ts`
- `server/src/middleware/logging.interceptor.spec.ts`
- `server/src/repositories/session.repository.ts`
- `server/src/schema/index.ts`
- `server/src/schema/tables/pairing.table.ts`
- `server/src/schema/migrations/1793200000000-AddPhonePairing.ts`
- `server/src/schema/migrations/ORDER`
- `server/src/services/auth.service.ts`
- `server/src/services/auth-pairing.service.spec.ts`
- `server/test/medium/specs/services/auth-pairing.service.spec.ts`
- `open-api/immich-openapi-specs.json`
- `packages/sdk/src/fetch-client.ts`

Client logic and handoff:

- `mobile/lib/models/auth/pairing_payload.model.dart`
- `mobile/lib/providers/auth.provider.dart`
- `mobile/lib/repositories/auth_api.repository.dart`
- `mobile/lib/services/auth.service.dart`
- `mobile/test/models/auth/pairing_payload_test.dart`
- `web/src/lib/services/phone-pairing.ts`
- `web/src/lib/services/phone-pairing.spec.ts`
- `docs/development/phone-pairing.md`
