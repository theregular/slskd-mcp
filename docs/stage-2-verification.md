# Stage 2 verification

Verified 2026-10-11 against slskd 0.26.0.0.

## Implementation

Six tools are registered: the existing connection and Stage 1 search tools plus
`search_list`, `search_stop`, and `search_delete`. Listing projects compact search
summaries, applies literal case-insensitive query filtering, and paginates in ID
order. Stop preserves retained results; delete removes one specified search.

The shared client accepts the endpoint-specific empty responses (200 for stop,
204 for delete). Unexpected successful statuses, transport loss, post-dispatch
cancellation, timeouts, and ambiguous server failures return `OUTCOME_UNKNOWN`
with the affected ID, without retrying. Known rejection responses retain their
sanitized error codes. See the pinned [upstream controller](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Search/API/Controllers/SearchesController.cs).

## Automated checks

The suite contains 41 tests: the existing 33 plus eight lifecycle tests covering
multiple input, failure, and transport scenarios. All passed. Lint, formatting,
and TypeScript build checks also passed.

- B1: a created search is listed through real MCP stdio; fixture checks cover
  compact projection, literal query matching, ordering, pagination, empty lists,
  malformed data, and unknown state flags.
- B2: stopping retains fixture file records, and a second stop on the completed
  search returns only an acknowledgment.
- B3: deleting removes the fixture search; subsequent read, stop, and delete
  return `NOT_FOUND`. An unrelated search remains present.
- B4: disappearance between list and mutation returns `NOT_FOUND`; lost responses,
  timeout, cancellation, server failures, and unexpected success statuses carry
  the correct operation ID and never retry. Strict inputs reject bulk actions
  and invalid IDs before HTTP dispatch. Credentials/error bodies are not echoed.
- Real stdio coverage discovers and calls all six tools, checks declared output
  schemas and annotations, and compares text JSON with structured responses.

Tests require local loopback socket access. The sandbox initially denied that
access; the complete suite passed when run with permission for those sockets.

## Live MCP checks

The narrated `check:lifecycle` client exercised the real stdio MCP exchange and
printed requests plus structured responses using existing local credentials.

1. `Bach Brandenburg`: the new search appeared in `search_list`. After two seconds
   it had already reached `Completed, FileLimitReached`, with 9,987 retained file
   entries. `search_stop` acknowledged the completed search. The next read kept
   the same count and five-item page. Deletion succeeded; the subsequent read
   returned `NOT_FOUND`.
2. `Bach Brandenburg Wendy Carlos`: the new search was still `InProgress` with
   zero results after two seconds. Stop was acknowledged, and the next read
   reported `Completed, Cancelled`. Deletion succeeded and a read confirmed
   `NOT_FOUND`.

The first run verifies a stop acknowledgment on a completed search with retained
results. The second verifies an active search actually transitions to cancellation;
it had no files to preserve. Preservation of populated active-search results is
also covered by the stateful fixture test. Counts depend on live peers and are
not expectations for subsequent runs. The retained-file count is a projection
of received responses, not the upstream internal threshold counter.

Only the two searches created by these runs were stopped/deleted. Existing searches
were not targeted. No downloads or settings changes occurred. Local console logs
are kept outside this repository; no credentials, peer names, or paths are included
in this report.

## Repeat

```sh
pnpm check
pnpm check:lifecycle -- "artist track"
```

Stage 2 is implemented. Peer browsing and download management remain planned
Stages 3 and 4.
