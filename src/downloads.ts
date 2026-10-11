import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig, readPeerConfig, type Environment } from './config.js';
import { requestJson } from './client.js';
import { SlskdError, unknownOutcome } from './errors.js';
import { compareText, nonnegativeInteger, page, pageInputShape } from './files.js';
import { usernameSchema } from './peers.js';

const username = usernameSchema.refine((value) => !value.includes('\0'));
const remoteFilename = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 && !value.includes('\0') && !value.split(/[\\/]/).includes('..'),
  );
const fileInput = z.object({ filename: remoteFilename, sizeBytes: nonnegativeInteger }).strict();
export const downloadQueueInput = z
  .object({
    username,
    files: z
      .array(fileInput)
      .min(1)
      .max(100)
      .refine((files) => new Set(files.map((file) => file.filename)).size === files.length),
    requestId: z
      .uuid()
      .refine((value) => value !== '00000000-0000-0000-0000-000000000000')
      .optional(),
    searchId: z.uuid().optional(),
  })
  .strict();
export const downloadListInput = z
  .object({
    username: username.optional(),
    states: z.array(z.string()).optional(),
    includeRemoved: z.boolean().default(false),
    ...pageInputShape,
  })
  .strict();
export const downloadStatusInput = z
  .object({
    batchId: z.uuid().optional(),
    username: username.optional(),
    transferId: z.uuid().optional(),
    offset: nonnegativeInteger.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((args) =>
    args.batchId !== undefined
      ? args.username === undefined && args.transferId === undefined
      : args.username !== undefined &&
        args.transferId !== undefined &&
        args.offset === undefined &&
        args.limit === undefined,
  );
export const downloadCancelInput = z
  .object({ username, transferId: z.uuid(), remove: z.boolean().default(false) })
  .strict();
export const downloadClearInput = z.object({}).strict();

const upstreamTransfer = z.object({
  id: z.uuid(),
  batchId: z.uuid().nullable().optional(),
  username: z.string().min(1),
  direction: z.literal('Download'),
  filename: z.string().min(1),
  size: nonnegativeInteger,
  bytesTransferred: nonnegativeInteger,
  state: z.string().min(1),
  removed: z.boolean(),
  averageSpeed: z.number().nonnegative().nullish(),
  startedAt: z.iso.datetime({ offset: true }).nullish(),
  endedAt: z.iso.datetime({ offset: true }).nullish(),
});
const upstreamBatch = z.object({
  id: z.uuid(),
  username: z.string().min(1),
  direction: z.literal('Download'),
  transfers: z.array(upstreamTransfer),
});
const queueResponse = z.object({
  batch: upstreamBatch,
  failures: z.array(z.object({ filename: z.string(), message: z.string().nullish() })),
});
const groupedDownloads = z.array(
  z.object({
    username: z.string().min(1),
    directories: z.array(z.object({ files: z.array(upstreamTransfer) })),
  }),
);

export const transferOutput = z.object({
  transferId: z.uuid(),
  username: z.string(),
  filename: z.string(),
  sizeBytes: nonnegativeInteger,
  bytesTransferred: nonnegativeInteger,
  state: z.string(),
  isComplete: z.boolean().nullable(),
  isSuccessful: z.boolean().nullable(),
  percentComplete: z.number().nonnegative().nullable(),
  averageSpeedBytesPerSecond: z.number().nonnegative().nullable(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  removed: z.boolean(),
});
const pageShape = {
  offset: nonnegativeInteger,
  limit: nonnegativeInteger,
  matchedCount: nonnegativeInteger,
  hasMore: z.boolean(),
  fetchedAt: z.iso.datetime(),
  consistency: z.literal('live'),
};
export const downloadListOutput = z.object({ items: z.array(transferOutput), ...pageShape });
export const downloadStatusOutput = z.object({
  kind: z.enum(['batch', 'transfer']),
  batchId: z.uuid().optional(),
  item: transferOutput.optional(),
  items: z.array(transferOutput.extend({ available: z.boolean() })).optional(),
  offset: nonnegativeInteger.optional(),
  limit: nonnegativeInteger.optional(),
  matchedCount: nonnegativeInteger.optional(),
  hasMore: z.boolean().optional(),
  fetchedAt: z.iso.datetime(),
  consistency: z.literal('live').optional(),
});
export const downloadQueueOutput = z.object({
  batchId: z.uuid(),
  outcome: z.enum(['accepted', 'partial', 'rejected']),
  requestedCount: nonnegativeInteger,
  acceptedCount: nonnegativeInteger,
  failedCount: nonnegativeInteger,
  accepted: z.array(fileInput.extend({ transferId: z.uuid().nullable() })),
  failures: z.array(
    z.object({ filename: z.string(), code: z.literal('ENQUEUE_REJECTED'), message: z.string() }),
  ),
});
export const downloadCancelOutput = z.object({
  username: z.string(),
  transferId: z.uuid(),
  cancelRequested: z.literal(true),
  removed: z.boolean(),
});
export const downloadClearOutput = z.object({
  cleared: z.literal(true),
  scope: z.literal('all_completed'),
});

function parse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  code: 'INVALID_ARGUMENT' | 'INVALID_RESPONSE',
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new SlskdError(
      code,
      code === 'INVALID_ARGUMENT'
        ? 'Invalid download arguments. Check exact file identities and the tool schema.'
        : 'slskd returned an unexpected download response shape.',
    );
  }
  return parsed.data;
}
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const stateKey = (state: string) =>
  state
    .split(',')
    .map((flag) => flag.trim())
    .sort()
    .join(',');
const activeStates = new Set(
  [
    'None',
    'Requested',
    'Queued',
    'Queued, Locally',
    'Queued, Remotely',
    'Initializing',
    'InProgress',
  ].map(stateKey),
);
const failedStates = new Set(
  ['Cancelled', 'TimedOut', 'Errored', 'Rejected', 'Aborted'].map((flag) =>
    stateKey(`Completed, ${flag}`),
  ),
);
export function transferCompletion(state: string) {
  const key = stateKey(state);
  if (key === stateKey('Completed, Succeeded')) {
    return { isComplete: true, isSuccessful: true };
  }
  if (key === 'Completed' || failedStates.has(key)) {
    return { isComplete: true, isSuccessful: false };
  }
  if (activeStates.has(key)) {
    return { isComplete: false, isSuccessful: false };
  }
  return { isComplete: null, isSuccessful: null };
}
function project(transfer: z.infer<typeof upstreamTransfer>) {
  return {
    transferId: transfer.id,
    username: transfer.username,
    filename: transfer.filename,
    sizeBytes: transfer.size,
    bytesTransferred: transfer.bytesTransferred,
    state: transfer.state,
    ...transferCompletion(transfer.state),
    percentComplete: transfer.size === 0 ? 0 : (transfer.bytesTransferred / transfer.size) * 100,
    averageSpeedBytesPerSecond: transfer.averageSpeed ?? null,
    startedAt: transfer.startedAt ?? null,
    endedAt: transfer.endedAt ?? null,
    removed: transfer.removed,
  };
}
function order(a: { transferId: string }, b: { transferId: string }) {
  return compareText(a.transferId.toLowerCase(), b.transferId.toLowerCase());
}
function validateBatch(batch: z.infer<typeof upstreamBatch>, batchId: string) {
  if (
    !sameId(batch.id, batchId) ||
    new Set(batch.transfers.map((item) => item.id.toLowerCase())).size !== batch.transfers.length ||
    batch.transfers.some(
      (item) => item.username !== batch.username || !item.batchId || !sameId(item.batchId, batchId),
    )
  ) {
    throw new SlskdError(
      'INVALID_RESPONSE',
      'slskd returned inconsistent batch or transfer identities.',
    );
  }
}

export async function downloadQueue(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = parse(downloadQueueInput, raw, 'INVALID_ARGUMENT');
  const batchId = args.requestId ?? randomUUID();
  const response = await requestJson(readPeerConfig(env), '/transfers/downloads/batches', {
    method: 'POST',
    operationId: batchId,
    signal,
    body: {
      id: batchId,
      username: args.username,
      files: args.files.map((file) => ({ filename: file.filename, size: file.sizeBytes })),
      ...(args.searchId ? { searchId: args.searchId } : {}),
    },
  });
  try {
    const { batch, failures } = parse(queueResponse, response, 'INVALID_RESPONSE');
    validateBatch(batch, batchId);
    if (batch.username !== args.username) {
      throw new Error('Wrong peer.');
    }
    const requested = new Map(args.files.map((file) => [file.filename, file]));
    const failed = new Set(failures.map((failure) => failure.filename));
    if (
      failed.size !== failures.length ||
      failures.some((failure) => !requested.has(failure.filename))
    ) {
      throw new Error('Unexpected failures.');
    }
    const associations = new Map<string, string>();
    for (const transfer of batch.transfers) {
      if (
        requested.get(transfer.filename)?.sizeBytes !== transfer.size ||
        associations.has(transfer.filename)
      ) {
        throw new Error('Unexpected transfer.');
      }
      associations.set(transfer.filename, transfer.id);
    }
    const accepted = args.files
      .filter((file) => !failed.has(file.filename))
      .map((file) => ({ ...file, transferId: associations.get(file.filename) ?? null }));
    return {
      batchId,
      outcome:
        accepted.length === 0
          ? ('rejected' as const)
          : failures.length
            ? ('partial' as const)
            : ('accepted' as const),
      requestedCount: args.files.length,
      acceptedCount: accepted.length,
      failedCount: failures.length,
      accepted,
      failures: failures.map((failure) => ({
        filename: failure.filename,
        code: 'ENQUEUE_REJECTED' as const,
        message:
          'slskd did not accept this file for enqueueing. It may already be queued or an upstream error occurred.',
      })),
    };
  } catch {
    throw unknownOutcome(batchId);
  }
}

export async function downloadList(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = parse(downloadListInput, raw, 'INVALID_ARGUMENT');
  const response = await requestJson(
    readConfig(env),
    `/transfers/downloads?includeRemoved=${args.includeRemoved}`,
    { signal },
  );
  const groups = parse(groupedDownloads, response, 'INVALID_RESPONSE');
  const transfers: z.infer<typeof transferOutput>[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const directory of group.directories) {
      for (const item of directory.files) {
        if (item.username !== group.username || seen.has(item.id.toLowerCase())) {
          throw new SlskdError(
            'INVALID_RESPONSE',
            'slskd returned inconsistent grouped transfer identities.',
          );
        }
        seen.add(item.id.toLowerCase());
        if (
          (!args.includeRemoved && item.removed) ||
          (args.username !== undefined && item.username !== args.username) ||
          (args.states?.length && !args.states.includes(item.state))
        ) {
          continue;
        }
        transfers.push(project(item));
      }
    }
  }
  return page(transfers.sort(order), args.offset, args.limit);
}

async function singleTransfer(
  username: string,
  transferId: string,
  env: Environment,
  signal?: AbortSignal,
) {
  const response = await requestJson(
    readConfig(env),
    `/transfers/downloads/${encodeURIComponent(username)}/${transferId}`,
    { signal },
  );
  const transfer = parse(upstreamTransfer, response, 'INVALID_RESPONSE');
  if (transfer.username !== username || !sameId(transfer.id, transferId)) {
    throw new SlskdError(
      'INVALID_ARGUMENT',
      'The returned transfer does not match the requested username and ID.',
    );
  }
  return transfer;
}

export async function downloadStatus(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = parse(downloadStatusInput, raw, 'INVALID_ARGUMENT');
  if (args.batchId !== undefined) {
    const response = await requestJson(
      readConfig(env),
      `/transfers/downloads/batches/${args.batchId}`,
      { signal },
    );
    const batch = parse(upstreamBatch, response, 'INVALID_RESPONSE');
    validateBatch(batch, args.batchId);
    const items = batch.transfers
      .map((item) => ({ ...project(item), available: !item.removed }))
      .sort(order);
    return {
      kind: 'batch' as const,
      batchId: args.batchId,
      ...page(items, args.offset ?? 0, args.limit ?? 25),
    };
  }
  const transfer = await singleTransfer(args.username!, args.transferId!, env, signal);
  return {
    kind: 'transfer' as const,
    item: project(transfer),
    fetchedAt: new Date().toISOString(),
  };
}

export async function downloadCancel(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const args = parse(downloadCancelInput, raw, 'INVALID_ARGUMENT');
  await singleTransfer(args.username, args.transferId, env, signal);
  await requestJson(
    readConfig(env),
    `/transfers/downloads/${encodeURIComponent(args.username)}/${args.transferId}?remove=${args.remove}`,
    {
      method: 'DELETE',
      emptyResponseStatus: 204,
      operationId: args.transferId,
      signal,
    },
  );
  return {
    username: args.username,
    transferId: args.transferId,
    cancelRequested: true as const,
    removed: args.remove,
  };
}

export async function downloadClearCompleted(
  raw: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  parse(downloadClearInput, raw, 'INVALID_ARGUMENT');
  await requestJson(readConfig(env), '/transfers/downloads/all/completed', {
    method: 'DELETE',
    emptyResponseStatus: 204,
    signal,
  });
  return { cleared: true as const, scope: 'all_completed' as const };
}
