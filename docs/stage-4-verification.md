# Stage 4 verification

Verified 2026-10-11 against slskd 0.26.0.0. Stage 4 provides five download
tools and a console smoke client. The separate Stage 3 dashboard comparison
remains pending; this verification does not claim that comparison was performed.

## Source and implementation

- [Transfers controller](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/Controllers/TransfersController.cs): batch enqueue, grouped listing, batch/single status, cancellation, and global terminal-history cleanup.
- [Batch request](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/DTO/EnqueueDownloadBatchRequest.cs) and [response](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/API/DTO/EnqueueDownloadBatchResponse.cs): request IDs and per-file acceptance/failures.
- [Batch service](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/Downloads/BatchService.cs): full transfer records included in batch retrieval.
- [Transfer categories](https://github.com/slskd/slskd/blob/0.26.0/src/slskd/Transfers/Types/TransferStateCategories.cs) and [Soulseek.NET flags](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/TransferStates.cs): active, successful, and failed terminal categories.

The server snapshots configuration at creation and registers all fourteen tools
by default. The original Stage 4 implementation used a download feature flag;
that flag was subsequently removed at the user's request. Obsolete values are
ignored. The live smoke run below preceded that removal and explicitly enabled
the tools for its process. No additional live download was needed for this change.

## Automated verification

The complete `pnpm check` suite covers lint, formatting, TypeScript build, and
71 tests, including 16 new download tests. Contract coverage:

- D1: all fourteen tools available without credentials or a feature flag; tool use
  still requires credentials, and obsolete flag values do not affect discovery or calls.
- D2: exact username/path/size/search-ID payload, UUID reconciliation, malformed
  selectors, duplicates, unsafe sizes, null characters, and parent traversal.
- D3: accepted, partial, and rejected responses, status/body disagreement,
  sanitized per-file failures, and real stdio partial/rejected error semantics.
- D4: disconnects, timeouts, post-dispatch cancellation, malformed acceptance,
  duplicate-ID conflict, rate limits, one-write request counts, and status reconciliation.
- D5: grouped flattening, identity validation, state categories, nullable metadata,
  zero-size progress, removed records, filtering, deterministic pages, and batch associations.
- D6: identity preflight, foreign username/ID rejection without DELETE, default
  remove=false, explicit remove=true, disappearance, and uncertain cancellation.
- D7: isolated global cleanup route and scope, no invented count or disk-deletion claim.

## Live selected-file check

The user explicitly selected one previously browsed 5,624,228-byte FLAC file.
The smoke client verified its exact remote identity and size against the directory
response before submitting one batch containing that file.

The real MCP stdio session discovered fourteen tools and recorded:

1. One accepted file, zero failures, with batch and transfer IDs.
2. Batch state progressing from `Requested` through `InProgress` to
   `Completed, Succeeded`, with intermediate byte/percentage updates.
3. Final `bytesTransferred: 5624228`, `percentComplete: 100`,
   `isComplete: true`, and `isSuccessful: true`.
4. Single-transfer status and the peer-filtered download list confirming the
   same successful transfer identity. Transfer duration was approximately 14 seconds.
5. A local file present in slskd's configured download directory with the exact
   expected size, 5,624,228 bytes. This checks presence and size, not audio fidelity.

Every call and structured response was printed to the console and saved outside
the repository. Private peer names, remote/local paths, and transfer IDs are not
included here. No fallback source or additional file was downloaded.

Cancellation and global history cleanup were exercised only against isolated
fixtures. Live transfer history and downloaded files were left in place.
