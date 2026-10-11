# slskd-mcp

A TypeScript MCP server for slskd. Stages 1–4 provide connection status, search, search management, peer browsing,
and downloads through fourteen tools, all available by default.

It reads `GET /api/v0/server` and `GET /api/v0/application/version`. It reports API reachability/authentication, slskd version, Soulseek connection/login status, and readiness to search. A reachable dashboard alone does not mean Soulseek is logged in.

It does not start slskd, change settings, or register itself in Codex. Downloads require explicitly selected file identities.

## Specification and roadmap

The [staged specification](docs/spec.md) defines search, search management, peer browsing, and download tools, with contracts and acceptance checks for stages 1–4. Stages 1–4 are implemented; Stage 4 automated and selected-file live checks passed. Stage 3 automated and live API checks passed; its dashboard comparison remains pending.

## Setup

Use Node.js 22.13+ or 24+ (Node 24 recommended) and pnpm. Dependencies are pinned in `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Set `SLSKD_API_KEY` in `.env` to an API key configured in your own slskd. For a temporary test, you can use `SLSKD_BEARER_TOKEN` from a dashboard session instead. Set only one credential. No credentials are included or automatically collected by this project. A bearer token expires; use a dedicated API key for eventual persistent registration.

`SLSKD_URL` defaults to `http://127.0.0.1:5030`; omit `/api/v0`. `SLSKD_TIMEOUT_MS` defaults to 5000. Configuration is read and validated once at startup. Invalid URLs, timeouts, or conflicting credentials stop startup with a sanitized diagnostic. Missing credentials still allow MCP initialization and tool discovery; API operations return `AUTH_NOT_CONFIGURED` before sending a request.

## Run a single MCP test

Start slskd separately, then run:

```sh
pnpm check:connection
```

This builds the project, launches the MCP server as a child process, performs MCP initialization, lists tools, calls `connection_status`, prints the result, and closes the child process. It does not require Codex registration.

Example result:

```json
{
  "reachable": true,
  "authenticated": true,
  "version": "0.26.0",
  "connected": true,
  "loggedIn": true,
  "readyToSearch": true,
  "state": "Connected, LoggedIn"
}
```

A disconnected Soulseek session returns a successful status result with `readyToSearch: false`. Missing-credential, authentication, network, timeout and response-format failures return MCP `isError: true` and a concise error code. Raw HTTP error bodies are never returned. Redirects are not followed.

## Search

With slskd running and logged into Soulseek, run:

```sh
pnpm check:search -- "artist track"
```

This standalone MCP client starts **one** search with a 5-second inactivity timeout,
100-file and 20-response limits, then reads up to seven result pages at two-second
intervals. It prints the search ID, state, and first five results. Add `--summary`
before the query to omit peer names and file paths. It does not download, cancel,
or delete anything. A still-running search remains in slskd after the client exits.
Empty results are valid and depend on peer availability. File/response limits are
upstream stopping thresholds; a peer response can take the count over a threshold.

### Tool calls

Start a search (defaults: 15-second inactivity window, 10000 files, 100 responses):

```json
{
  "name": "search_start",
  "arguments": { "query": "artist track" }
}
```

Read results with the returned UUID:

```json
{
  "name": "search_results",
  "arguments": {
    "searchId": "550e8400-e29b-41d4-a716-446655440000",
    "filters": { "extensions": ["flac"], "include": ["album"], "exclude": ["live"] },
    "sort": "availability",
    "offset": 0,
    "limit": 25
  }
}
```

Filters and paging are local to the MCP. `include` requires every literal substring;
`exclude` rejects any match, both case-insensitively. `minBitRateKbps` excludes unknown
bitrates. Sort choices are `availability`, `bitrate`, and `filename`; unknown values
sort last. Deduplication preserves different peers and exact remote filenames.
Pages have a maximum of 100 items and can shift as new results arrive. Poll explicitly
using the same ID; no tool creates a replacement search automatically.

Each result reports `state`, nullable `isComplete`, counts, `fetchedAt`, and
`consistency: "live"`. Missing optional metadata is null. `freeUploadSlots` is a
boolean indicating whether a slot is available, not a count. Bitrates are kbps,
durations seconds, sample rates Hz, and peer speeds bytes/second. Extensions use the
peer field or, when empty, the filename suffix. Locked files are excluded. Audio
quality and metadata are not independently verified.

`searchTimeoutSeconds` is an inactivity window, separate from `SLSKD_TIMEOUT_MS`,
the HTTP deadline. For slskd 0.26.0 the request value is converted to milliseconds:
the upstream DTO's seconds comment disagrees with the pinned library implementation.

Search errors have stable codes and sanitized messages. A missing search is
`NOT_FOUND`; an empty search is a successful page. `CANCELLED` means the caller
cancelled a read or cancelled before dispatch. New read responses are capped at
32 MiB. If a submitted search loses its response or returns an invalid success,
`OUTCOME_UNKNOWN` includes the generated `operationId`. Inspect that ID using
`search_results` before deciding whether to start another search. No writes are
automatically retried, including after timeouts or 429 rate limits.

## Search management

- `search_list`: lists active and completed searches as compact summaries, with
  optional `queryContains` (case-insensitive literal substring), `offset`, and
  `limit`. Default page size is 25, maximum 100. Results are ordered by search ID;
  the page includes `matchedCount`, `hasMore`, `fetchedAt`, and `consistency: "live"`.
  Query text and peer metadata remain untrusted data.
- `search_stop`: takes `{ "searchId": "<UUID>" }` and requests that one search stop
  collecting results. Existing results remain available through `search_results`.
  `stopRequested: true` acknowledges the request; inspect results for the eventual
  state. An already completed search can also acknowledge a stop.
- `search_delete`: takes the same ID and removes that search and its retained
  results. It returns `deleted: true`. It does not delete downloaded files.

A missing search returns `NOT_FOUND`, including repeated deletion. Lists are live
snapshots: an ID can disappear between listing and stopping/deleting. No operation
implicitly cleans up searches when a client disconnects.

Stop/delete requests are never automatically retried. If a response is lost or a
server failure leaves the outcome uncertain, `OUTCOME_UNKNOWN.operationId` identifies
that search. Read `search_results` or `search_list` for the same ID before deciding
whether another operation is appropriate. A stop acknowledgment is not proof of
completion; a missing search after an uncertain delete reports its current absence,
not whether the earlier request performed the deletion.

### Watch a complete lifecycle in the console

```sh
pnpm check:lifecycle -- "artist track"
```

This standalone MCP client prints each tool call and its structured JSON response.
It checks connection readiness, creates one search, finds it in the list, waits two
seconds for results, stops it, reads retained results, deletes it, and verifies
`NOT_FOUND`. It only stops/deletes the ID created by that run. It never queues a
download. Results include up to five files per read; listing is filtered by the
supplied query and bounded to 100 pages. Console output can contain peer names,
paths, and search queries; keep any saved logs out of a public repository.

If an operation fails, the script stops and prints the known ID for reconciliation;
it does not retry a mutation or automatically delete an uncertain search. If search
creation itself is uncertain, use the `operationId` in its printed error. The
inactivity window is 30 seconds, with file/response thresholds of 10000/1000;
a fast search may complete before the stop request. Acknowledged stops are polled
for up to two seconds. See [Stage 2 verification](docs/stage-2-verification.md).

## Peer browsing

| Tool               | Input                                                                | Result                                                                              |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `browse_user`      | `username`, optional `directoryContains`, `offset`, `limit`          | Sorted directory summaries containing `directory` and `fileCount`.                  |
| `browse_directory` | `username`, exact `directory`, optional `filters`, `offset`, `limit` | Files in the requested folder with full remote filenames and shared audio metadata. |
| `user_info`        | `username`                                                           | Presence, description, upload slots, queue length, and free-slot availability.      |

All three tools perform peer lookups without initiating searches or downloads.
Use a username from a search result. Copy a directory returned by `browse_user`,
or remove the final filename component from a known search path; preserve case,
spaces, and separators. Usernames are encoded as individual URL segments and
are not trimmed. Blank names, names over 500 characters, invalid Unicode, and
entire URL dot segments (`.` or `..`) are rejected.

```json
{
  "name": "browse_directory",
  "arguments": {
    "username": "peer-name",
    "directory": "Music\\Artist\\Album",
    "filters": { "extensions": ["flac"] },
    "limit": 25
  }
}
```

`directoryContains` matches a literal, case-insensitive substring. Directory files
reuse search extension, bitrate, include, and exclude filters; sorting is by exact
full filename then size. Pages default to 25 items and are limited to 100.
Locked directories/files are excluded; directory lookup does not recursively
expand subfolders. An empty successful response returns an empty page. A response
containing only a different directory is rejected rather than presented as empty.

`browse_user` fetches the full peer library before projecting/filtering a page.
A small page does not reduce that upstream transfer. Responses above 32 MiB fail
with `RESPONSE_TOO_LARGE`. If you already know a folder from a search result,
`browse_directory` avoids fetching the full library and can work even when the
full library is too large. Neither tool silently truncates an upstream response.

Set `SLSKD_PEER_TIMEOUT_MS` to control peer request deadlines (default 30000,
valid 100–120000 milliseconds). This is separate from `SLSKD_TIMEOUT_MS`, and
remains active through response-body reads. A timeout is `TIMEOUT`, caller
cancellation is `CANCELLED`, and an unavailable peer/resource is `NOT_FOUND`;
the latter does not establish whether the peer is offline or blocking requests.
Directory lookup uses a read-only POST, so failures use read semantics rather
than `OUTCOME_UNKNOWN`. Requests are never automatically retried.

`user_info.status` is the upstream presence string (typically `Online`, `Away`,
or `Offline`). Missing optional fields are null, and failures of either the info
or status request fail the entire tool. Descriptions are capped at 2000 Unicode
characters, with `descriptionTruncated` indicating omitted text. Profile pictures
and IP endpoints are never returned, and the endpoint lookup route is never
requested. Peer descriptions, filenames, and metadata are untrusted content;
metadata availability can differ between search and browse responses.

### Watch browsing in the console

```sh
pnpm check:browse -- "peer-name" 'Music\Artist\Album'
```

This client prints the calls and structured responses for peer info, a library
page filtered by the supplied directory, and the first five directory files.
It stops on errors without retries. The client request deadline accommodates
`SLSKD_PEER_TIMEOUT_MS`; other MCP hosts may need their own timeout adjusted for
long peer requests. Console output includes peer descriptions and paths; keep
saved logs out of public repositories. See [Stage 3 verification](docs/stage-3-verification.md).

## Downloads

All five download tools are registered alongside search and browsing. No feature
flag is needed; the former `SLSKD_ENABLE_DOWNLOADS` setting is ignored and can be
removed from existing configuration. slskd authentication still applies, and
queueing requires explicitly selected peer/file identities.

| Tool                       | Input                                                                                                  | Result                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `download_queue`           | `username`, 1–100 `files` with exact `filename` and `sizeBytes`; optional UUID `requestId`, `searchId` | Batch ID, accepted/partial/rejected outcome, counts, accepted files and sanitized per-file failures. |
| `download_status`          | Either `batchId` with optional `offset`, `limit`, or `username` plus `transferId`                      | Batch page or single transfer.                                                                       |
| `download_list`            | Optional `username`, exact raw `states`, `includeRemoved`, `offset`, `limit`                           | Transfer page, ordered by ID; removed entries excluded by default.                                   |
| `download_cancel`          | `username`, `transferId`, optional `remove` (default false)                                            | Cancellation acknowledgment after verifying the returned transfer identity.                          |
| `download_clear_completed` | Empty object                                                                                           | Clears **all terminal download history**, including failures; returns `scope: "all_completed"`.      |

Supply identities explicitly selected from search/browse results or equivalent
user input. The tools do not expand directories, select sources, or try another
peer automatically. Files go to slskd's configured download destination.

```json
{
  "name": "download_queue",
  "arguments": {
    "username": "peer-name",
    "files": [{ "filename": "Music\\Artist\\Album\\01 Track.flac", "sizeBytes": 5624228 }]
  }
}
```

Queue acceptance is asynchronous. Poll `download_status` with the returned
`batchId`; accepted file records also include a transfer ID when the response
provides a verified association. Partial acceptance preserves both accepted and
failed files; fully rejected batches return MCP `isError: true` with the batch
result. Raw upstream failure messages are omitted.

Transfers report exact identity, bytes, percent complete, speed in bytes/second,
timestamps, raw state, `isComplete`, `isSuccessful`, and `removed`. Unknown states
have nullable completion/success. Zero-size files report zero percent. Batch
status retains removed records with `available: false`. Pages default to 25,
maximum 100, and are marked `consistency: "live"`; progress can change between calls.

Writes are never retried automatically. An uncertain enqueue returns
`OUTCOME_UNKNOWN.operationId` containing the submitted batch ID; inspect that ID
with `download_status` before considering another submission. A supplied
`requestId` supports reconciliation, not automatic retries: duplicate IDs return
`CONFLICT`. A missing batch does not prove an in-flight request cannot finish.

Cancellation acknowledges a request, not immediate completion. `remove: true`
and global history cleanup do not promise deletion of downloaded bytes from disk.
Cleanup returns no count because the upstream endpoint supplies none.

### Watch one selected download in the console

```sh
pnpm check:download -- "peer-name" 'Music\Artist\Album\01 Track.flac' 5624228
```

This client requires one exact file of at most 20 MiB. It verifies the
selected file against its peer directory, queues once, polls the batch for a
bounded period, and reads single-transfer status and a short peer download list.
Every call and structured response is printed. A pending transfer remains queued
when polling ends; the client prints its reconciliation ID and never retries,
cancels, clears history, or switches sources. Console logs can contain peer names,
paths, and transfer IDs; keep them outside public repositories. See
[Stage 4 verification](docs/stage-4-verification.md).

## Development

```sh
pnpm test
pnpm build
pnpm start
```

`pnpm start` runs the stdio server and waits for MCP protocol messages; it is not an interactive prompt. Server stdout is reserved for MCP. The human-readable test output comes from the separate smoke-test client.

Tests use local fake HTTP services plus a real MCP stdio exchange. No account credentials or external Soulseek traffic are needed to run them.

## Linting and formatting

ESLint uses the recommended JavaScript and TypeScript rules, requires braces for control flow and consistent type imports, and rejects stdout console logging in server code. Prettier handles layout separately, with two-space indentation, single quotes, semicolons, trailing commas, and a 100-column target. `eslint-config-prettier` prevents conflicting formatting rules.

```sh
pnpm lint          # Check code quality
pnpm lint:fix      # Apply safe automatic lint fixes
pnpm format        # Format source, tests, config, and documentation
pnpm format:check  # Check formatting without changing files
pnpm typecheck     # Check TypeScript without writing dist
pnpm check         # Lint + formatting check + build + tests
```

Generated output, dependencies, and local environment files are excluded. Enable your editor's Prettier formatter to use the committed configuration; `.editorconfig` supplies the basic whitespace defaults. No Git hooks are installed.

TypeScript and typescript-eslint are pinned to compatible versions. Update them together when upgrading the toolchain.

## Client structure

`src/index.ts` reads the environment once, creates a configured slskd client, and passes it to the MCP server. Status, search, peer, and download operations retain their shared HTTP client in closures. Operation calls accept arguments and an optional cancellation signal; they do not read environment variables. Each client keeps its own configuration snapshot, so tests can create independent clients without changing global state.

```ts
const config = readConfig(process.env);
const slskd = createSlskdClient(config);
const server = createServer(slskd);

await slskd.searchList({ queryContains: 'artist' }, signal);
```

Changing configuration requires constructing a new client. The HTTP transport owns credentials, URL prefixes, ordinary and peer request deadlines, and response/error handling.

## Files

- `src/status.ts`: existing connection-status projection.
- `src/config.ts`: environment parsing and validated, immutable configuration.
- `src/client.ts`: configured slskd client combining status, search, peer, and download operations.
- `src/http.ts`, `src/errors.ts`: shared HTTP transport and sanitized errors.
- `src/search.ts`, `src/files.ts`: search and lifecycle tools, runtime schemas, filters, sorting, and pages.
- `src/peers.ts`: peer info, library summaries, and directory file projections.
- `src/downloads.ts`: batch enqueue, transfer status, cancellation, and history cleanup.
- `src/server.ts`: MCP tool registration and sanitized error output.
- `src/index.ts`: stdio entry point.
- `scripts/check-connection.ts`: one-shot status client.
- `scripts/check-search.ts`: bounded search/read MCP smoke client.
- `scripts/check-search-lifecycle.ts`: narrated start/list/stop/read/delete smoke client.
- `scripts/check-browse.ts`: narrated peer info/library/directory smoke client.
- `scripts/check-download.ts`: narrated selected-file download smoke client.
- `test/client.test.ts`: client isolation, configuration snapshots, missing credentials, and startup diagnostics.
- `test/downloads.test.ts`: download contracts, failures, and stdio tests.
- `test/status.test.ts`, `test/search.test.ts`, `test/lifecycle.test.ts`, `test/peers.test.ts`: fake-HTTP and real-stdio regression tests.

## References

- https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Core/API/Controllers/ServerController.cs
- https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Core/API/Controllers/ApplicationController.cs
- https://modelcontextprotocol.io/docs/develop/build-server

The official SDK v2 server/client packages are used. All fourteen tools are registered by default. Codex configuration and slskd configuration are intentionally managed separately.
