# Stage 1 verification

Verified 2026-10-06 against slskd 0.26.0.0.

## Automated checks

`pnpm check` passed: lint, formatting, TypeScript compilation, and all 33 tests.
The stage adds 21 search tests alongside the 12 status tests. Coverage maps to the
specification's A1–A7 acceptance checks:

- Status configuration, credentials, readiness, error codes, redirect behavior,
  and stdio calls remain compatible. Tool discovery now expects three tools.
- Search POST payloads include a generated ID and convert seconds to milliseconds;
  later GETs see additional results without posting again.
- Running, complete, empty, absent, and unknown-state searches are distinct.
- Filters, literal matching, null metadata, ordering, deduplication, source
  identity, Unicode paths, locked files, and pagination use representative fixtures.
- HTTP errors, malformed JSON, unexpected schemas, unsafe integers, caller
  cancellation, body-read timeout, and both declared/chunked size limits are covered.
- Ambiguous writes return an operation ID with no automatic retry.
- A real stdio client checks initialization, all three tools, schemas, search calls,
  equivalent text/structured output, strict arguments, and sanitized errors.

Run all project checks with `pnpm check`. Tests need permission to bind temporary
loopback HTTP ports; they do not use real credentials or external Soulseek traffic.

## Live smoke check

Using the existing local credentials without changing slskd configuration:

1. The connection tool reported API authentication, connected/logged-in status,
   and readiness to search on version 0.26.0.0.
2. The standalone stdio client started one search for `Bach Brandenburg`, with a
   5-second inactivity window, file threshold 100, and response threshold 20.
3. The first read was `InProgress`, incomplete, with zero results.
4. Two seconds later it returned `Completed, FileLimitReached`, complete, with
   120 file entries and 120 matches. The requested five-item page had more results.
5. Results included sample-rate and peer-speed metadata. Missing bitrate metadata
   was preserved as null. Output was limited to counts/state and metadata-presence
   indicators; peer names and file paths were not saved in this report.

The count above 100 reflects upstream threshold handling of peer response batches.
The MCP does not truncate the entire received collection to the search threshold;
it bounds the page returned to the caller.

No downloads, search deletion, settings changes, or Codex registration were performed.
The test search remains in slskd. Future searches need not reproduce these counts.

## Scope

Stage 1 is implemented. Search lifecycle management, browsing, and downloads remain
unimplemented stages 2–4. No additional dependencies were needed.
