import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig, type Environment } from './config.js';
import { requestJson } from './client.js';
import { SlskdError, unknownOutcome } from './errors.js';
import {
  compareNullable,
  compareText,
  fileFiltersSchema,
  fileRecordSchema,
  matchesFilters,
  nonnegativeInteger,
  page,
  pageInputShape,
  projectFile,
  upstreamFileSchema,
} from './files.js';

export const searchStartInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    searchTimeoutSeconds: z.number().int().min(5).max(120).default(15),
    fileLimit: z.number().int().min(1).max(10000).default(10000),
    responseLimit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const searchResultsInput = z
  .object({
    searchId: z.uuid(),
    filters: fileFiltersSchema.default({}),
    sort: z.enum(['availability', 'bitrate', 'filename']).default('availability'),
    ...pageInputShape,
  })
  .strict();

const summaryShape = {
  searchId: z.uuid(),
  query: z.string(),
  state: z.string(),
  isComplete: z.boolean().nullable(),
};

export const searchStartOutput = z.object({
  ...summaryShape,
  searchTimeoutSeconds: z.number().int(),
  fileLimit: z.number().int(),
  responseLimit: z.number().int(),
});

export const searchFileSchema = fileRecordSchema.extend({
  freeUploadSlots: z.boolean().nullable(),
  queueLength: nonnegativeInteger.nullable(),
  uploadSpeedBytesPerSecond: nonnegativeInteger.nullable(),
});

type SearchFile = z.infer<typeof searchFileSchema>;

export const searchResultsOutput = z.object({
  ...summaryShape,
  receivedFileCount: nonnegativeInteger,
  items: z.array(searchFileSchema),
  offset: nonnegativeInteger,
  limit: nonnegativeInteger,
  matchedCount: nonnegativeInteger,
  hasMore: z.boolean(),
  fetchedAt: z.iso.datetime(),
  consistency: z.literal('live'),
});

const upstreamSummary = z.object({
  id: z.uuid(),
  searchText: z.string(),
  state: z.string().min(1),
});

const upstreamSearch = upstreamSummary.extend({
  responses: z.array(
    z.object({
      username: z.string().min(1),
      hasFreeUploadSlot: z.boolean().nullish(),
      queueLength: nonnegativeInteger.nullish(),
      uploadSpeed: nonnegativeInteger.nullish(),
      files: z.array(upstreamFileSchema),
    }),
  ),
});

// Soulseek.NET 10.0.2 SearchStates is a flags enum; Completed is the terminal flag.
const knownStates = new Set([
  'None',
  'Requested',
  'InProgress',
  'Completed',
  'Cancelled',
  'TimedOut',
  'ResponseLimitReached',
  'FileLimitReached',
  'Errored',
  'Queued',
]);

export function searchCompletion(state: string): boolean | null {
  const flags = state.split(',').map((flag) => flag.trim());
  return flags.every((flag) => knownStates.has(flag)) ? flags.includes('Completed') : null;
}

function summary(search: z.infer<typeof upstreamSummary>) {
  return {
    searchId: search.id,
    query: search.searchText,
    state: search.state,
    isComplete: searchCompletion(search.state),
  };
}

function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SlskdError(
      'INVALID_ARGUMENT',
      'Invalid search arguments. Check the tool input schema.',
    );
  }
  return parsed.data;
}

export async function searchStart(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = input(searchStartInput, raw);
  const config = readConfig(env);
  const id = randomUUID();
  const response = await requestJson(config, '/searches', {
    method: 'POST',
    operationId: id,
    signal,
    body: {
      id,
      searchText: args.query,
      // slskd's DTO comment says seconds, but ToSearchOptions passes this straight to milliseconds.
      searchTimeout: args.searchTimeoutSeconds * 1000,
      fileLimit: args.fileLimit,
      responseLimit: args.responseLimit,
    },
  });
  const parsed = upstreamSummary.safeParse(response);
  if (!parsed.success || parsed.data.id.toLowerCase() !== id.toLowerCase()) {
    throw unknownOutcome(id);
  }

  return {
    ...summary(parsed.data),
    searchTimeoutSeconds: args.searchTimeoutSeconds,
    fileLimit: args.fileLimit,
    responseLimit: args.responseLimit,
  };
}

function order(a: SearchFile, b: SearchFile, sort: z.infer<typeof searchResultsInput>['sort']) {
  let primary: number;
  if (sort === 'availability') {
    primary =
      compareNullable(
        a.freeUploadSlots === null ? null : Number(a.freeUploadSlots),
        b.freeUploadSlots === null ? null : Number(b.freeUploadSlots),
        true,
      ) ||
      compareNullable(a.queueLength, b.queueLength) ||
      compareNullable(a.uploadSpeedBytesPerSecond, b.uploadSpeedBytesPerSecond, true);
  } else if (sort === 'bitrate') {
    primary = compareNullable(a.bitRateKbps, b.bitRateKbps, true);
  } else {
    primary = compareText(a.filename, b.filename);
  }
  return (
    primary ||
    compareText(a.username, b.username) ||
    compareText(a.filename, b.filename) ||
    a.sizeBytes - b.sizeBytes
  );
}

export async function searchResults(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = input(searchResultsInput, raw);
  const response = await requestJson(
    readConfig(env),
    `/searches/${args.searchId}?includeResponses=true`,
    { signal },
  );
  const parsed = upstreamSearch.safeParse(response);
  if (!parsed.success || parsed.data.id.toLowerCase() !== args.searchId.toLowerCase()) {
    throw new SlskdError(
      'INVALID_RESPONSE',
      'slskd returned an unexpected search response shape or identity.',
    );
  }

  const files = new Map<string, SearchFile>();
  let receivedFileCount = 0;
  for (const peer of parsed.data.responses) {
    for (const file of peer.files) {
      receivedFileCount++;
      // Locked results cannot be treated as ordinary selectable downloads.
      if (file.isLocked) {
        continue;
      }
      const identity = JSON.stringify([peer.username, file.filename, file.size]);
      if (!files.has(identity)) {
        files.set(identity, {
          ...projectFile(file, peer.username),
          freeUploadSlots: peer.hasFreeUploadSlot ?? null,
          queueLength: peer.queueLength ?? null,
          uploadSpeedBytesPerSecond: peer.uploadSpeed ?? null,
        });
      }
    }
  }

  const matched = [...files.values()].filter((file) => matchesFilters(file, args.filters));
  matched.sort((a, b) => order(a, b, args.sort));
  return { ...summary(parsed.data), receivedFileCount, ...page(matched, args.offset, args.limit) };
}

export const searchListInput = z
  .object({ queryContains: z.string().optional(), ...pageInputShape })
  .strict();

export const searchIdInput = z.object({ searchId: z.uuid() }).strict();

export const searchListOutput = z.object({
  items: z.array(z.object(summaryShape)),
  offset: nonnegativeInteger,
  limit: nonnegativeInteger,
  matchedCount: nonnegativeInteger,
  hasMore: z.boolean(),
  fetchedAt: z.iso.datetime(),
  consistency: z.literal('live'),
});

export const searchStopOutput = z.object({
  searchId: z.uuid(),
  stopRequested: z.literal(true),
});

export const searchDeleteOutput = z.object({
  searchId: z.uuid(),
  deleted: z.literal(true),
});

export async function searchList(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = input(searchListInput, raw);
  const response = await requestJson(readConfig(env), '/searches', { signal });
  const parsed = z.array(upstreamSummary).safeParse(response);
  if (!parsed.success) {
    throw new SlskdError('INVALID_RESPONSE', 'slskd returned an unexpected search list shape.');
  }

  const query = args.queryContains?.toLowerCase() ?? '';
  const matched = parsed.data
    .filter((search) => search.searchText.toLowerCase().includes(query))
    .map(summary)
    .sort((a, b) => compareText(a.searchId.toLowerCase(), b.searchId.toLowerCase()));
  return page(matched, args.offset, args.limit);
}

export async function searchStop(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const { searchId } = input(searchIdInput, raw);
  await requestJson(readConfig(env), `/searches/${searchId}`, {
    method: 'PUT',
    emptyResponseStatus: 200,
    operationId: searchId,
    signal,
  });
  return { searchId, stopRequested: true as const };
}

export async function searchDelete(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const { searchId } = input(searchIdInput, raw);
  await requestJson(readConfig(env), `/searches/${searchId}`, {
    method: 'DELETE',
    emptyResponseStatus: 204,
    operationId: searchId,
    signal,
  });
  return { searchId, deleted: true as const };
}
