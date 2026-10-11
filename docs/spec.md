# slskd-mcp specification

Status: Stages 1–4 implemented. Stage 3 automated and live API checks passed, but
its dashboard comparison remains pending. See [Stage 1 verification](stage-1-verification.md),
[Stage 2 verification](stage-2-verification.md), [Stage 3 verification](stage-3-verification.md), and [Stage 4 verification](stage-4-verification.md).
Stage 4 automated and selected-file live checks passed.
Updated: 2026-10-11.
Repository baseline: `84084ab`.
Compatibility target: slskd 0.26.0; upstream controller review also covered commit `7c302a753b1814345fcb26eb78dec97db6b698df`.

## 1. Outcome and baseline

Let an MCP client turn requests such as “find this track in FLAC, show the available sources, browse the album, and download these selected files” into small, explicit slskd operations. A search must be useful before browsing or downloading is implemented.

At the baseline, the TypeScript stdio server had one tool, `connection_status`. It checks API access, version, and Soulseek login separately. Its current input, output, error codes, and initialization behavior are compatibility requirements. See [server registration](../src/server.ts), [status implementation](../src/status.ts), and [existing tests](../test/status.test.ts).

Use the existing SDK, Zod, pnpm, Node support range, TypeScript, ESLint, and Prettier configuration. This specification proposes new MCP behavior; its defaults are design choices, not claims about slskd defaults or settings already applied.

## 2. Scope and stages

| Stage | Useful outcome                                      | New tools                                                                                           | Depends on                                                       |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | Start a search and inspect filtered, ranked results | `search_start`, `search_results`                                                                    | Existing status tool                                             |
| 2     | Find, stop, and remove retained searches            | `search_list`, `search_stop`, `search_delete`                                                       | Stage 1                                                          |
| 3     | Inspect a peer and browse its shared directories    | `browse_user`, `browse_directory`, `user_info`                                                      | Stage 1 shared client and result models; delivered after stage 2 |
| 4     | Queue selected files and manage downloads           | `download_queue`, `download_status`, `download_list`, `download_cancel`, `download_clear_completed` | Stages 1–3                                                       |

These are thirteen new tools, fourteen including `connection_status`. Implement and verify one stage at a time. Shared infrastructure belongs to the first stage that uses it.

Out of scope: installing or launching slskd, managing Soulseek credentials or shares, configuring Codex, chat messages, uploads, admin/settings APIs, arbitrary HTTP proxying, wishlists, scheduled searches, SignalR subscriptions, fuzzy music identification, transcoding, and automatic source selection or downloading. A filename or extension is peer-supplied information, not proof of audio quality.

## 3. Requirements and traceability

“Must” defines required behavior for this draft. Stage 1 verification is recorded in `docs/stage-1-verification.md`; Stage 2 verification is recorded in `docs/stage-2-verification.md`. Stage 3 evidence and its pending dashboard comparison are recorded in `docs/stage-3-verification.md`. Stage 4 evidence is recorded in `docs/stage-4-verification.md`.

| ID  | Requirement                                                                                                                                                    | Stage                       | Checks                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------- |
| R1  | Existing status behavior and credential handling must survive the shared-client refactor.                                                                      | 1 and regression thereafter | A1, A6                    |
| R2  | Starting a search must return an identifier without waiting for all network results. Reads must distinguish unfinished, finished, empty, and missing searches. | 1                           | A2, A3                    |
| R3  | Results must support explicit local filters, bounded pages, deterministic ordering, and exact source/file identity without inventing missing metadata.         | 1                           | A4, A5                    |
| R4  | Tool failures must have sanitized, stable codes; ambiguous writes must never be silently repeated.                                                             | All                         | A6, A7, B4, D4            |
| R5  | Search lifecycle tools must distinguish stopping collection from deleting retained results.                                                                    | 2                           | B1–B4                     |
| R6  | Browsing must preserve remote paths, distinguish unavailable data from empty data, and never initiate downloads.                                               | 3                           | C1–C4                     |
| R7  | Download tools must be available by default and enqueue only explicitly supplied files.                                                                        | 4                           | D1, D2                    |
| R8  | Download results must expose per-file acceptance/failure, stable IDs, and asynchronous transfer status.                                                        | 4                           | D3–D5                     |
| R9  | Cancellation and history cleanup must expose their precise scope and never claim files were deleted from disk.                                                 | 4                           | D6, D7                    |
| R10 | Each stage must ship with automated checks, a real stdio smoke path, and portable documentation.                                                               | All                         | Each stage exit condition |

## 4. Shared contracts and design

### Configuration and API client

Extract reusable HTTP/configuration/error handling from `src/status.ts` without changing its public tool contract. Suggested modules are `src/client.ts`, `src/errors.ts`, and domain modules under `src/tools/`; the exact layout is an implementation choice.

Retain `SLSKD_URL` (default `http://127.0.0.1:5030`, without `/api/v0`), exactly one of `SLSKD_API_KEY` or `SLSKD_BEARER_TOKEN`, and `SLSKD_TIMEOUT_MS` (default 5000, valid 100–30000 milliseconds). Preserve supported URL path prefixes and reject URL credentials, query strings, and fragments. Encode usernames as individual route segments. Do not follow redirects or take a target URL from tool arguments.

Proposed additions, introduced with their consumers:

| Setting                 | Default | Validation and purpose                                                      |
| ----------------------- | ------- | --------------------------------------------------------------------------- |
| `SLSKD_PEER_TIMEOUT_MS` | 30000   | Integer 100–120000; stage 3 peer browse/info and stage 4 enqueue operations |

Read and validate environment configuration once in the entry point. Create one configured slskd client per MCP server; domain operations retain the shared HTTP client and accept operation arguments and optional cancellation signals. Tests construct independent clients with fixture configuration. Invalid URLs, deadlines, or conflicting credentials stop startup with sanitized diagnostics. Missing credentials must not prevent MCP initialization; reject API operations with `AUTH_NOT_CONFIGURED` before HTTP dispatch. All fourteen tools are registered unconditionally. The obsolete `SLSKD_ENABLE_DOWNLOADS` setting is ignored.

For new endpoints, abort response reading above 32 MiB, even when Content-Length is absent. A read size limit must produce `RESPONSE_TOO_LARGE`, never a silently truncated success. An oversized mutation response produces `OUTCOME_UNKNOWN`, since the write may have succeeded. Keep timeout protection active through body reading. These are response bounds, not file-download limits; slskd transfers file bytes itself.

No automatic retries in these stages. In particular, do not retry POST, PUT, or DELETE after a timeout or lost response. A failed HTTP exchange does not prove the operation failed to execute. Cancellation of the MCP request aborts its local HTTP request where the SDK supports it; it does not implicitly stop a Soulseek search or transfer.

### Tool results and errors

Every new tool uses a strict input schema, a declared output schema, `structuredContent`, and one text content item containing the same JSON. Retain the existing status tool's shape. Expected domain failures return `isError: true` with `{code, message}` plus only the documented optional fields below. Protocol-level invalid arguments may be rejected by the SDK before a handler runs.

Reuse the existing codes: `CONFIG_ERROR`, `AUTH_NOT_CONFIGURED`, `TIMEOUT`, `UNREACHABLE`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `HTTP_ERROR`, `INVALID_RESPONSE`, and `INTERNAL_ERROR`.

New tools additionally use:

`CANCELLED` indicates caller cancellation of a read or cancellation before dispatch. A mutation cancelled after dispatch yields `OUTCOME_UNKNOWN`.

| Code                 | Meaning                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`   | Domain validation failed before making an HTTP request                                                                  |
| `CONFLICT`           | Upstream 409; no claim that retrying is safe                                                                            |
| `RATE_LIMITED`       | Upstream 429; optional validated `retryAfterSeconds`, no automatic sleep/retry                                          |
| `RESPONSE_TOO_LARGE` | New-endpoint response exceeded the byte cap                                                                             |
| `OUTCOME_UNKNOWN`    | A mutating operation may have been submitted, but its result could not be established; include `operationId` when known |

Map upstream 400 to `INVALID_ARGUMENT`, 401/403/404 to their corresponding codes, and other failures to `HTTP_ERROR`. After a potentially submitted mutation, transport/body timeout, malformed success, or ambiguous server failure must not be presented as a definite non-execution; use `OUTCOME_UNKNOWN`. Failures known to precede dispatch retain the appropriate connection/configuration code. For peer-facing 404s, describe the peer/resource as unavailable; do not assert a precise reason such as offline versus blacklisted without evidence.

Do not return raw error bodies, request headers, credentials, or stacks. Validate JSON bodies at runtime; tolerate unknown upstream fields but validate the fields actually consumed. New success/error fields should be intentionally projected rather than exposing entire upstream objects. Stdout remains reserved for MCP.

### File records, filtering, and pagination

Use a shared `FileRecord` with `username`, `filename` (exact full remote path), `sizeBytes`, `extension`, `bitRateKbps`, `durationSeconds`, `sampleRateHz`, and `bitDepth`. Nullable metadata stays `null` when absent. Return only finite, nonnegative numbers; file sizes used for queuing must be safe integers. Reject unsafe sizes instead of rounding them. The pinned slskd search file DTO already exposes `bitRate`, `length`, `sampleRate`, and `bitDepth`; project these directly. The protocol units are kbps, seconds, Hz, and bits. Use normalized peer extension or the filename suffix when it is empty. Locked files are omitted from selectable results; `receivedFileCount` counts the regular `files` collection before local processing, excluding the separate `lockedFiles` collection.

Search records additionally include `freeUploadSlots` (boolean indicating slot availability, not a count), `queueLength`, and `uploadSpeedBytesPerSecond`, each nullable if unavailable. Do not merge different peers into a single source. Deduplicate only identical `(username, filename, sizeBytes)` entries; prefer the first observed entry deterministically.

`FileFilters` has optional `extensions: string[]`, `minBitRateKbps: integer >= 0`, `include: string[]`, and `exclude: string[]`. Normalize extensions to lowercase without a leading dot. Empty arrays impose no constraint. All include strings must match the full path as case-insensitive literal substrings; any exclude match removes the file. A bitrate minimum excludes records with unknown bitrate. Do not provide regex matching or interpret filename text as instructions.

List tools accept `offset` (integer >= 0, default 0) and `limit` (integer 1–100, default 25). They return:

```typescript
{
  items: T[];
  offset: number;
  limit: number;
  matchedCount: number;
  hasMore: boolean;
  fetchedAt: string; // ISO 8601 UTC
  consistency: 'live';
}
```

Fetch the relevant upstream collection, project, deduplicate where specified, filter, sort, and then page locally. An offset beyond the end returns an empty page. Counts describe that fetch, not all possible Soulseek results. slskd's search response API does not supply these local filter/page features.

Each call is a fresh view. Pages may shift while searches or downloads change; document this limitation, and recommend reading a finished search for more stable paging. No persistent cache, cursor database, or background polling is required. A cached snapshot mechanism can be proposed later if this limitation becomes a practical problem.

### MCP annotations

Annotations describe effects, not HTTP verbs or an authorization mechanism. Set `readOnlyHint: true` for result/list/status/browse/info tools, including the read-only directory lookup that uses POST. Search creation/stop/deletion and download queue/cancel/cleanup are not read-only. Mark search deletion, download cancellation, and download cleanup destructive; mark creation non-idempotent. Describe external peer access with `openWorldHint: true` for search creation, browse/info, and download enqueue. Retain existing status annotations. Confirm the remaining annotations against actual effects during implementation.

## 5. Stage 1 — Search and inspect results

Outcome: ask for a track with preferences, start a search, and inspect a useful shortlist without downloading anything.

### Interfaces

| Tool             | Inputs                                                                                                                                                                                              | Result and upstream mapping                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_start`   | `query`: nonblank string, max 500 characters; optional `searchTimeoutSeconds`: integer 5–120, default 15; `fileLimit`: integer 1–10000, default 10000; `responseLimit`: integer 1–1000, default 100 | POST `/api/v0/searches`, mapping `query` to `searchText` and timeout to `searchTimeout` in milliseconds (`searchTimeoutSeconds * 1000`). Generate and submit a UUID `id`. Return `{searchId, query, state, isComplete, searchTimeoutSeconds, fileLimit, responseLimit}`. |
| `search_results` | `searchId`: UUID; optional `filters: FileFilters`, `sort: 'availability' \| 'bitrate' \| 'filename'` (default `availability`); `offset`, `limit`                                                    | GET `/api/v0/searches/{id}?includeResponses=true`. Return page of search file records plus `{searchId, query, state, isComplete, receivedFileCount}`.                                                                                                                    |

`search_start` returns after slskd accepts the request. `searchTimeoutSeconds` is slskd's inactivity window since the last response, not the HTTP timeout or a promised total duration. The slskd 0.26.0 DTO comment says seconds, but `ToSearchOptions` passes the value unchanged to Soulseek.NET 10.0.2, which measures milliseconds. This implementation follows the executable dependency. Do not invent upstream extension/bitrate parameters. Leave other upstream search options at their defaults.

`state` preserves the upstream state text. Derive `isComplete` from verified terminal flags, not from whether results are empty. If a future state is unrecognized, return `isComplete: null` rather than guessing. Results expose the generated ID in `OUTCOME_UNKNOWN.operationId` so a caller can inspect it with `search_results` before considering another search.

For `availability`, rank known free slots first, then known queue length ascending, then known upload speed descending. For `bitrate`, use known bitrate descending. For `filename`, use filename ascending. Break ties using exact username, filename, then size, with a fixed locale-independent string comparison. Unknown values sort last within the relevant sort key. Do not rank a missing bitrate as zero or equate bitrate across different codecs with sound quality.

Upstream file/response limits are stopping thresholds; a whole peer response can overshoot them. `receivedFileCount` counts upstream file entries before local deduplication/filtering; `matchedCount` counts the projected set after both. A successful, unfinished search with zero results is not a missing search.

### Tasks

- [x] Extract and test the shared client/error boundary while preserving R1.
- [x] Add runtime schemas and projections for search state and file metadata.
- [x] Implement both tools, shared filters/order/page helpers, and annotations (R2–R4).
- [x] Add fake-server tests and a standalone MCP search smoke client accepting a query argument.
- [x] Document examples, timeout units, result metadata limits, and asynchronous follow-up calls.

### Acceptance checks

- **A1 (R1):** Existing status assertions pass; only tool discovery expectations expand from one tool to three; status still reports disconnected login as a successful result with `readyToSearch: false`.
- **A2 (R2):** A fake slskd accepts a POST and delays results. The tool returns its search ID on acceptance; subsequent reads show additional files without issuing another POST.
- **A3 (R2):** Empty running, empty finished, and unknown ID cases produce distinct state/completion/404 outcomes. An unknown state has nullable completion.
- **A4 (R3):** Mixed-format fixtures demonstrate combined filters, literal matching, null bitrate exclusion, deterministic tie-breaking, and preservation of multiple sources.
- **A5 (R3):** More than one page returns correct local counts and bounds; an out-of-range offset returns no items. Oversize bodies fail explicitly. Exact remote names and safe file sizes survive projection.
- **A6 (R1, R4):** Bad credentials, prefix URLs, redirects, malformed JSON, body-read timeout, 429, and new-endpoint 409 map to safe errors without credential leakage.
- **A7 (R4):** A POST accepted upstream followed by a dropped response yields `OUTCOME_UNKNOWN` with the submitted ID and no repeated POST.

Exit: `pnpm check` passes; a real stdio initialization/list/call test covers the new tools; a live search records actual state and metadata compatibility without requiring a particular peer or a nonzero result count. Record live evidence separately from automated test results.

## 6. Stage 2 — Manage searches

Outcome: return to a retained search, stop collecting more results, or remove a search intentionally.

### Interfaces

| Tool            | Inputs                                                                          | Result and upstream mapping                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_list`   | Optional `queryContains`: literal case-insensitive substring; `offset`, `limit` | GET `/api/v0/searches`; local query filter and ID-ascending order. Page of `{searchId, query, state, isComplete}`. No response bodies embedded.                  |
| `search_stop`   | `searchId`: UUID                                                                | PUT `/api/v0/searches/{id}`; return `{searchId, stopRequested: true}` after upstream 200. Does not claim the search was running or has reached a terminal state. |
| `search_delete` | `searchId`: UUID                                                                | DELETE `/api/v0/searches/{id}`; return `{searchId, deleted: true}` after 204. Retained search/results are removed.                                               |

Do not auto-delete searches when reading results or closing the MCP. slskd owns their persistence and collection lifetime. A missing ID yields `NOT_FOUND`; deletion is not converted into a success merely because the desired absence already holds. PUT may return 200 even for a search that has already completed.

### Tasks

- [x] Implement lifecycle tools and compact search summaries (R5).
- [x] Extend protocol tests to discover and call all six total tools.
- [x] Add lifecycle smoke steps using only the search created by that smoke run.
- [x] Document stop versus delete and the `OUTCOME_UNKNOWN` reconciliation path.

### Acceptance checks

- **B1 (R5):** Starting a search makes it discoverable through the list fixture; filters and pagination do not embed all files.
- **B2 (R5):** Stopping preserves previously collected results; a completed search can acknowledge a stop without pretending it was active.
- **B3 (R5):** Deleting removes the retained search. Its next read, stop, or delete returns `NOT_FOUND`.
- **B4 (R4, R5):** Concurrent disappearance and dropped mutation responses produce accurate errors without retrying or touching other search IDs.

Exit: `pnpm check` and stdio checks pass; live start/list/stop/read/delete behavior is demonstrated on a test search, with unrelated searches left alone.

## 7. Stage 3 — Browse peers

Outcome: inspect the source of a search result and locate the rest of an album before choosing files.

### Interfaces

| Tool               | Inputs                                                                                                                             | Result and upstream mapping                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browse_user`      | `username`: nonblank string <= 500 characters; optional `directoryContains`: literal case-insensitive substring; `offset`, `limit` | GET `/api/v0/users/{username}/browse`; return directory-summary page with `{directory, fileCount}` items plus `username`. Sort exact directory path ascending.                                     |
| `browse_directory` | `username`; `directory`: nonblank exact remote directory path; optional `filters: FileFilters`; `offset`, `limit`                  | POST `/api/v0/users/{username}/directory` with `{directory}`. Return FileRecord page plus `username` and requested `directory`, ordered by filename then size.                                     |
| `user_info`        | `username`                                                                                                                         | GET `/api/v0/users/{username}/info` and `/status`; return `{username, status, description, uploadSlots, queueLength, hasFreeUploadSlot, fetchedAt}`, using null for unavailable optional metadata. |

Browse calls may wait for the remote peer. Use the peer timeout; do not start an unbounded poll or pretend a timed-out operation is an empty directory. `browse_user` returns compact directory summaries even though the upstream request may fetch a full share listing. Directory browsing must return exact full paths usable for downloads, composing directory and basename only when required by the verified upstream schema.

`user_info` fails if either required upstream request fails; it does not convert an incomplete result into a successful “offline” status. Normalize fields from a verified fixture, and omit any binary profile image. Limit returned description text to 2000 characters and expose `descriptionTruncated: boolean`. Do not request or return the peer IP endpoint. Peer descriptions and filenames are untrusted content, never tool instructions.

### Verified response details

- Full browse returns a `BrowseResponse` object with `directories` and
  `lockedDirectories`; the controller annotation advertising an array is stale.
  Summaries project `directories[].name` and `fileCount`, omitting locked shares.
- Directory lookup returns an array of `{name, files}` directories. Only entries
  whose name exactly matches the requested directory are included. Empty arrays
  are valid empty results; a nonempty response without a matching directory is
  `INVALID_RESPONSE`. Child directories are not expanded.
- File names in directory responses are basenames. Prefix the exact directory
  and its separator (backslash preferred if present, otherwise slash if present,
  otherwise the Soulseek backslash default). Avoid adding an extra separator if
  the directory already ends in one. Do not normalize dot components or repeated
  separators. Project the same direct metadata fields as search results; missing
  browse metadata can be null even when search metadata was populated.
- `/status` supplies `presence`, projected as `status`; `/info` supplies
  `description`, `uploadSlots`, `queueLength`, and `hasFreeUploadSlot`. Description
  limits count Unicode code points and do not split surrogate pairs.
- Directory POST is explicitly a read for timeout/cancellation/error handling.
  A failed directory lookup is never treated as an uncertain transfer mutation.
- Preserve username spelling; reject invalid Unicode and entire dot segments
  `.`/`..`, which URL parsers otherwise normalize out of the route.

### Tasks

- [x] Verify pinned peer response schemas, units, and path composition before implementing projections.
- [x] Add directory summaries, peer info, configurable peer deadlines, and shared file filters (R6).
- [x] Add Unicode/path, slow-peer, unavailable-peer, malformed-response, and paging tests.
- [x] Document the full-share-fetch cost and how to use a directory path from prior results.

### Acceptance checks

- **C1 (R6):** User browse returns sorted directory summaries; directory browse returns exact downloadable full paths, including spaces, Unicode, and backslashes, without filesystem normalization.
- **C2 (R6):** Empty directory, unavailable peer, and timeout have distinct outcomes. A body-read timeout also aborts correctly.
- **C3 (R6):** Info projection excludes images/endpoints; bounded descriptions expose truncation; a partial info/status failure is explicit.
- **C4 (R6):** Browse calls make only the expected read operations, including POST directory lookup; no search creation, transfer enqueue, or settings writes occur. Oversize share responses fail explicitly.

Exit: `pnpm check` and stdio tests pass; a known, available peer is browsed live and directory output is checked against the dashboard. If no peer is available, record that limitation and leave live verification incomplete.

## 8. Stage 4 — Queue and manage downloads

Outcome: enqueue selected file identities, inspect progress, cancel a transfer, and clear completed history.

### Availability and selection

Register all five download tools unconditionally alongside search and browsing. Explicit file selection and slskd authorization govern actual operations. Some upstream writes allow `AuthPolicy.Any`; do not claim a nominal read-only API key prevents every mutation.

The client must supply exact username/path/size identities from a search or browse result, or equivalent explicit user input. Do not automatically choose the first result, expand an album directory, fall back to another peer, or download as a side effect of searching. No special confirmation argument is required; existing user authorization and host tool approvals govern actual use.

### Interfaces

| Tool                       | Inputs                                                                                                 | Result and upstream mapping                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `download_queue`           | `username`; `files`: 1–100 objects `{filename, sizeBytes}`; optional UUID `requestId`, UUID `searchId` | POST `/api/v0/transfers/downloads/batches` with `{id, username, files:[{filename,size}], searchId?}`. Use `requestId` as `id`, or generate a UUID. Return the batch outcome described below.                                                      |
| `download_status`          | Exactly one selector: `{batchId: UUID, offset?, limit?}` or `{username, transferId: UUID}`             | GET `/api/v0/transfers/downloads/batches/{id}` or `/api/v0/transfers/downloads/{username}/{id}`. Return `{kind:'batch', batchId, ...page}` or `{kind:'transfer', item, fetchedAt}`; batch pages use the same transfer projection and ID ordering. |
| `download_list`            | Optional `username`, `states: string[]`; `includeRemoved: boolean` default false; `offset`, `limit`    | GET `/api/v0/transfers/downloads?includeRemoved=...`; flatten user/directory groups, locally filter, and order by transfer ID. Return transfer page. State filters use exact raw state strings returned by this API.                              |
| `download_cancel`          | `username`; `transferId`: UUID; `remove: boolean` default false                                        | DELETE `/api/v0/transfers/downloads/{username}/{id}?remove=...`; return `{username, transferId, cancelRequested:true, removed:remove}` after 204.                                                                                                 |
| `download_clear_completed` | Empty object                                                                                           | DELETE `/api/v0/transfers/downloads/all/completed`; return `{cleared:true, scope:'all_completed'}` after 204.                                                                                                                                     |

Downloads go to slskd's configured destination. Custom destination/externalId options and active queue-position refresh are deferred. Reject duplicate filenames within one batch, negative or unsafe sizes, null characters, and parent traversal components using either separator. Preserve legitimate remote path spelling; never reinterpret a remote path as a local file to read or write.

Upstream transfer-by-ID lookup and cancellation may not enforce the username in the route. Before cancellation, fetch the transfer and verify its returned username and ID match the requested identity. A mismatch returns `INVALID_ARGUMENT` without a DELETE; an absent transfer returns `NOT_FOUND`. Apply the same identity check when returning single-transfer status.

A transfer projection contains `transferId`, `username`, `filename`, `sizeBytes`, `bytesTransferred`, `state`, `isComplete`, `isSuccessful`, and nullable `percentComplete`, `averageSpeedBytesPerSecond`, `startedAt`, `endedAt`. Nullable completion/success handle unknown future states. Use verified upstream state categories; do not equate terminal with successful. For a zero-size file, avoid division by zero. Do not return local absolute filesystem paths.

### Batch results and uncertain outcomes

Return `{batchId, outcome, requestedCount, acceptedCount, failedCount, accepted, failures}`. `accepted` contains `{filename, sizeBytes, transferId}` where the upstream association is available, otherwise `transferId:null`; `failures` contains `{filename, code, message}` with a projected, sanitized reason. `outcome` is `accepted`, `partial`, or `rejected`. HTTP acceptance means queued, not downloaded.

The upstream batch endpoint uses 201 for full acceptance, 207 for partial acceptance, and can return 200 when every file failed. Validate the response and derive the outcome from its batch/failure contents, not just HTTP status. For a fully rejected batch return `isError:true` while preserving this batch result; mixed acceptance remains a structured partial result. If failure details cannot be safely classified, use a generic reason instead of returning raw upstream text.

A supplied request ID supports reconciliation; it does not guarantee transparent retry semantics. On duplicate-ID 409 return `CONFLICT` with `operationId`, and do not silently return the existing batch as if it matched the new request. On ambiguous enqueue return `OUTCOME_UNKNOWN` with that ID; query `download_status` before deciding whether to submit anything again. A missing batch after uncertainty is not proof that an in-flight enqueue cannot still complete.

The pinned batch detail endpoint includes full transfer records with batch IDs.
Validate batch/peer/transfer associations before projecting records; no filename-only
join is used. Retain removed records with `removed: true` and `available: false`.
A reference-only or malformed response returns `INVALID_RESPONSE` rather than
silently dropping records or guessing an association.

Verified terminal categories are `Completed, Succeeded` for success and
`Completed` combined with `Cancelled`, `TimedOut`, `Errored`, `Rejected`, or
`Aborted` for failure. Bare `Completed` is terminal but unsuccessful. Active
categories are `None`, `Requested`, `Queued` (optionally `Locally` or `Remotely`),
`Initializing`, and `InProgress`. Unknown flag combinations remain nullable.
Progress is bytes transferred divided by size, times 100; zero-size progress is
zero, matching upstream. Speed is bytes per second; missing speed/timestamps are null.

History cleanup affects all terminal downloads, including failures, rather than only successful files or the current batch. Do not report an exact cleared count: the endpoint returns no such count, and before/after inference can race. Neither cleanup nor `remove:true` promises removal of downloaded bytes from disk. Cancellation acknowledges a request; use status to observe the eventual state.

### Tasks

- [x] Verify batch/transfer response schemas and terminal categories against source and sanitized fixtures.
- [x] Add unconditional registration, batch enqueue, status/list projections, identity checks, and cancellation/cleanup (R7–R9).
- [x] Cover partial/rejected outcomes, duplicate IDs, uncertain writes, foreign username/ID pairs, and zero-size progress.
- [x] Document default availability, exact selection, scope of cleanup, and reconciliation.
- [x] Add an explicitly invoked live smoke flow for one explicitly chosen small file. Global history cleanup is tested with isolated fixtures unless the user specifically authorizes clearing live history.

### Acceptance checks

- **D1 (R7):** With default configuration, MCP tool discovery exposes all fourteen tools, including all five download tools. Missing credentials still allow discovery and produce authentication configuration errors on tool use. Obsolete flag values do not change availability or execution.
- **D2 (R7):** Only the supplied peer/files are sent; malformed or duplicated entries fail before HTTP; no fallback download is attempted.
- **D3 (R8):** 201 accepted, 207 mixed, and 200 all-failed fixtures produce correct counts, item failures, batch ID, and MCP error semantics. Queuing never claims completion.
- **D4 (R4, R8):** Dropped response after enqueue produces one POST and an ID-bearing `OUTCOME_UNKNOWN`; duplicate IDs surface a conflict. A subsequent status call can inspect the existing batch.
- **D5 (R8):** Grouped listings and batch references map to correct IDs, progress, terminal/success distinctions, removed records, and bounded pages; unknown future states remain explicit.
- **D6 (R9):** Cancellation verifies username/ID, defaults to `remove=false`, and does not claim immediate completion or disk deletion. A mismatched pair sends no DELETE.
- **D7 (R9):** Cleanup calls the all-completed route once, identifies its global terminal-history scope, includes failed transfers in that scope, and does not invent a removal count or file deletion.

Exit: `pnpm check` and stdio tests pass with all fourteen tools available by default; an explicitly selected live file can be queued and tracked. Destructive/global behaviors are proven against fixtures unless separately authorized live. Record what was actually exercised.

## 9. Verification, decisions, and maintenance

Run `pnpm check` at every stage; it includes linting, formatting, build, and tests. Use local fake HTTP servers to test payloads, failures, and request counts, plus a real MCP stdio client to test discovery and wire-format results. Live checks supplement fixtures; they must not make the ordinary test suite require credentials or depend on a particular peer.

Update the README with only implemented tools and configuration. Keep `.env` and personal logs out of commits. Store sanitized representative fixtures when useful, and do not capture secrets or personal account information. Commit boundaries may follow stages; this spec does not itself request a commit, release, or tool registration.

| Decision or evidence gap                   | Treatment                                                                                        | When to resolve                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Polling versus live events                 | Explicit follow-up tool calls; no persistent worker or SignalR                                   | Chosen for these four stages               |
| Stable pages while state changes           | Fresh offset pages, explicitly marked live                                                       | Revisit only if actual use needs snapshots |
| Defaults and limits                        | Proposed MCP limits in this draft; tune with evidence and update contracts together              | Before or during the relevant stage        |
| File attribute identifiers and speed units | Stage 1 DTO fields verified; recheck browse schemas in stage 3                                   | Stage 3                                    |
| Search/transfer terminal flags             | Search flags verified in stage 1; transfer categories verified in stage 4                        | Stage 4                                    |
| Batch-to-transfer association schema       | Full transfer records and batch IDs verified; direct projection implemented                      | Resolved in Stage 4                        |
| Missing feature in an installed version    | Return a clear compatibility error; never silently switch to an unverified legacy write endpoint | Relevant stage live check                  |

None of these later-stage schema checks prevents starting stage 1. Before implementing a stage, refresh only the relevant upstream evidence if the dependency/version has changed. If that evidence changes a contract, revise the requirement and acceptance check together. Do not mark a stage complete while its required integration check remains unverified.

## 10. Evidence and methodology

Reviewed 2026-10-06. The earlier API reference report informed scope; the links below make this spec usable without the original chat or report. The target is the pinned release, not a promise to follow an unpinned branch automatically.

- [Search controller, 0.26.0](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/API/Controllers/SearchesController.cs): search creation, retrieval, retained responses, stop, and delete.
- [Search request, 0.26.0](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/API/DTO/SearchRequest.cs): validation and timeout units.
- [Users controller, 0.26.0](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Users/API/Controllers/UsersController.cs): browse, directory, info, and status.
- [Transfers controller, 0.26.0](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/Controllers/TransfersController.cs): batch status codes, grouped listings, ID lookup, cancellation, and cleanup.
- [Batch request](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/DTO/EnqueueDownloadBatchRequest.cs) and [batch response](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/DTO/EnqueueDownloadBatchResponse.cs): input validation and per-file failures.
- [Reviewed upstream commit](https://github.com/slskd/slskd/tree/7c302a753b1814345fcb26eb78dec97db6b698df): newer source comparison used by the API report.

Format is a lightweight synthesis of [GitHub Spec Kit](https://github.github.com/spec-kit/) (intent, planning, tasks, verification) and [Kiro Quick Spec](https://kiro.dev/docs/specs/quick-spec/) (requirements, design, tasks, explicit acceptance criteria). This is a project-specific specification, not an installation of either framework.

### Stage 1 source clarifications

- [Soulseek.NET 10.0.2 SearchOptions](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/Options/SearchOptions.cs): the search timeout is milliseconds.
- [SearchStates](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchStates.cs) and [slskd Search model](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/Types/Search.cs): `Completed` is the terminal flag; unrecognized state flags remain nullable in the MCP.
- [slskd File](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/Types/File.cs) and [Response](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/Types/Response.cs): serialized metadata and `hasFreeUploadSlot` boolean.
- [Nicotine+ protocol attributes](https://nicotine-plus.org/doc/SLSKPROTOCOL.html#file-attribute-types): sample rate is Hz, despite the library enum's kHz comment.
