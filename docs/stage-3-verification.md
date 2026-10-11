# Stage 3 verification

Implementation and automated/live API checks verified 2026-10-11 against
slskd 0.26.0.0. **The dashboard comparison remains pending.** App access was not
approved; no browser comparison was performed. The full Stage 3 exit condition
is therefore not yet satisfied.

## Implementation and source evidence

Nine tools are registered, including `browse_user`, `browse_directory`, and
`user_info`. Peer operations use `SLSKD_PEER_TIMEOUT_MS` (default 30000,
100–120000 allowed), including response-body consumption. Read-only directory
POSTs use read error semantics, retain the 32 MiB response cap, and never retry.

Verified against the pinned sources:

- [slskd UsersController](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Users/API/Controllers/UsersController.cs): browse GET, directory POST, info GET, and status GET.
- [Soulseek.NET BrowseResponse](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/BrowseResponse.cs): object wrapper with separate ordinary/locked directories, despite the controller's array annotation.
- [Soulseek.NET Directory](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/Directory.cs) and [File](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/File.cs): directory name/count/files and direct file metadata fields.
- [slskd Info](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Users/Types/Info.cs) and [Status](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Users/Types/Status.cs): description, slots, queue, availability, and presence.
- [Dashboard Browse](https://github.com/slskd/slskd/blob/0.26.0/src/web/src/components/Browse/Browse.jsx) and [Selection](https://github.com/slskd/slskd/blob/0.26.0/src/web/src/components/Browse/Selection.jsx): separator detection and basename-to-remote-path composition. This source inspection is not a live dashboard comparison.

## Automated checks

55 tests passed: the previous 41 plus 14 peer tests. Lint, formatting, and
TypeScript compilation also passed.

- C1: compact directory summaries, exact Unicode/spaces/backslashes, forward
  slashes, trailing/repeated separators, dot components, local literal filters,
  sorting, deduplication, pagination, locked-file exclusion, and child omission.
- C2: empty results, unavailable resources, malformed schemas/JSON, wrong folder
  identity, body timeout, caller cancellation, and independent peer deadlines.
- C3: info/status projection, nullable optional data, partial upstream failure,
  Unicode-safe description truncation, and exclusion of profile pictures/IPs.
- C4: a real stdio test discovers nine tools and permits only the four expected
  peer lookup routes. Unknown arguments cannot request downloads. Advertised and
  streamed oversized responses fail explicitly, including read-only POSTs.
- Existing connection, search, lifecycle, and mutation uncertainty tests remain
  green after adding read-only POST handling.

Fixture content is synthetic and portable; no live descriptions, peer identities,
paths, credentials, or profile images are committed.

## Live API checks

1. A peer from earlier search results returned presence `Away`, upload metadata,
   and a long description with `descriptionTruncated: true`. Its full library
   exceeded the 32 MiB cap and returned `RESPONSE_TOO_LARGE` rather than a partial
   library. The narrated smoke client stopped without retrying.
2. A second known peer returned info, one matching directory summary containing
   16 files, and a directory page reporting 16 total files. The first five records
   included exact full paths, byte sizes, duration, 44100 Hz sample rates, and
   16-bit depth; unavailable bitrate stayed null. All three tools were called
   through the real MCP stdio exchange.
3. A targeted handler check compared two files' full paths and byte sizes from
   that directory against the earlier live search output; both matched exactly.
4. Direct directory lookup on the oversized-library peer succeeded with 13 files.
   A known full path and size matched its earlier search result. Browse audio
   metadata was absent for that peer and remained null rather than being guessed
   or copied from a previous search.

Only peer lookups were performed. No search creation, download, peer-IP request,
or settings write was made by these checks. Console logs remain outside the
repository. Live peer availability and counts are not guaranteed to repeat.

## Repeat and remaining check

```sh
pnpm check
pnpm check:browse -- "peer-name" 'Music\Artist\Album'
```

Remaining: with dashboard access, browse the same peer/folder in slskd and compare
its visible directory/file records with the MCP output. Stage 4 remains planned.
