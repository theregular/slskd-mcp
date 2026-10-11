import { z } from 'zod';
import { type HttpClient } from './http.js';
import { SlskdError } from './errors.js';
import {
  compareText,
  fileFiltersSchema,
  fileRecordSchema,
  matchesFilters,
  nonnegativeInteger,
  page,
  pageInputShape,
  projectFile,
  upstreamFileSchema,
  type FileRecord,
} from './files.js';

// Validate without trimming: usernames and remote paths are exact identities.
const nonblank = z.string().refine((value) => value.trim().length > 0);
export const usernameSchema = nonblank.max(500).refine((value) => {
  // URL parsers normalize entire dot segments even when their dots are percent-encoded.
  if (value === '.' || value === '..') {
    return false;
  }
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
});
export const userInfoInput = z.object({ username: usernameSchema }).strict();
export const browseUserInput = z
  .object({
    username: usernameSchema,
    directoryContains: z.string().optional(),
    ...pageInputShape,
  })
  .strict();
export const browseDirectoryInput = z
  .object({
    username: usernameSchema,
    directory: nonblank,
    filters: fileFiltersSchema.default({}),
    ...pageInputShape,
  })
  .strict();

const pageOutputShape = {
  offset: nonnegativeInteger,
  limit: nonnegativeInteger,
  matchedCount: nonnegativeInteger,
  hasMore: z.boolean(),
  fetchedAt: z.iso.datetime(),
  consistency: z.literal('live'),
};
export const browseUserOutput = z.object({
  username: z.string(),
  items: z.array(z.object({ directory: z.string(), fileCount: nonnegativeInteger })),
  ...pageOutputShape,
});
export const browseDirectoryOutput = z.object({
  username: z.string(),
  directory: z.string(),
  items: z.array(fileRecordSchema),
  ...pageOutputShape,
});
export const userInfoOutput = z.object({
  username: z.string(),
  status: z.string().nullable(),
  description: z.string().nullable(),
  descriptionTruncated: z.boolean(),
  uploadSlots: nonnegativeInteger.nullable(),
  queueLength: nonnegativeInteger.nullable(),
  hasFreeUploadSlot: z.boolean().nullable(),
  fetchedAt: z.iso.datetime(),
});

// slskd 0.26.0 returns Soulseek.NET 10.0.2 BrowseResponse, not the array
// advertised by its controller annotation. LockedDirectories are intentionally omitted.
const browseResponse = z.object({
  directories: z.array(z.object({ name: nonblank, fileCount: nonnegativeInteger })),
});
const directoryResponse = z.array(z.object({ name: nonblank, files: z.array(upstreamFileSchema) }));
const infoResponse = z.object({
  description: z.string().nullish(),
  uploadSlots: nonnegativeInteger.nullish(),
  queueLength: nonnegativeInteger.nullish(),
  hasFreeUploadSlot: z.boolean().nullish(),
});
const statusResponse = z.object({ presence: z.string().min(1).nullish() });

function parse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  code: 'INVALID_ARGUMENT' | 'INVALID_RESPONSE',
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new SlskdError(
      code,
      code === 'INVALID_ARGUMENT'
        ? 'Invalid peer arguments. Check the tool input schema.'
        : 'slskd returned an unexpected peer response shape.',
    );
  }
  return result.data;
}

function userPath(username: string) {
  return `/users/${encodeURIComponent(username)}`;
}

function fullFilename(directory: string, basename: string) {
  // Match the dashboard's separator preference, with the Soulseek default for root names.
  // Never use path.join/resolve: these are peer-supplied paths, not local filesystem paths.
  const separator = directory.includes('\\') ? '\\' : directory.includes('/') ? '/' : '\\';
  return `${directory}${directory.endsWith(separator) ? '' : separator}${basename}`;
}

export function createPeerOperations(client: HttpClient) {
  async function browseUser(raw: unknown, signal?: AbortSignal) {
    const args = parse(browseUserInput, raw, 'INVALID_ARGUMENT');
    const response = await client.requestPeer(`${userPath(args.username)}/browse`, {
      signal,
    });
    const { directories } = parse(browseResponse, response, 'INVALID_RESPONSE');
    const needle = args.directoryContains?.toLowerCase() ?? '';
    const items = directories
      .filter((directory) => directory.name.toLowerCase().includes(needle))
      .map((directory) => ({ directory: directory.name, fileCount: directory.fileCount }))
      .sort((a, b) => compareText(a.directory, b.directory));
    return { username: args.username, ...page(items, args.offset, args.limit) };
  }

  async function browseDirectory(raw: unknown, signal?: AbortSignal) {
    const args = parse(browseDirectoryInput, raw, 'INVALID_ARGUMENT');
    const response = await client.requestPeer(`${userPath(args.username)}/directory`, {
      method: 'POST',
      readOnly: true,
      body: { directory: args.directory },
      signal,
    });
    const directories = parse(directoryResponse, response, 'INVALID_RESPONSE');
    const matching = directories.filter((directory) => directory.name === args.directory);
    if (directories.length && !matching.length) {
      throw new SlskdError('INVALID_RESPONSE', 'slskd returned a different remote directory.');
    }

    const files = new Map<string, FileRecord>();
    for (const directory of matching) {
      for (const file of directory.files) {
        if (file.isLocked) {
          continue;
        }
        const projected = projectFile(
          { ...file, filename: fullFilename(directory.name, file.filename) },
          args.username,
        );
        const identity = JSON.stringify([projected.filename, projected.sizeBytes]);
        if (!files.has(identity)) {
          files.set(identity, projected);
        }
      }
    }
    const items = [...files.values()]
      .filter((file) => matchesFilters(file, args.filters))
      .sort((a, b) => compareText(a.filename, b.filename) || a.sizeBytes - b.sizeBytes);
    return {
      username: args.username,
      directory: args.directory,
      ...page(items, args.offset, args.limit),
    };
  }

  async function userInfo(raw: unknown, signal?: AbortSignal) {
    const { username } = parse(userInfoInput, raw, 'INVALID_ARGUMENT');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const [rawInfo, rawStatus] = await Promise.all([
        client.requestPeer(`${userPath(username)}/info`, { signal: combined }),
        client.requestPeer(`${userPath(username)}/status`, { signal: combined }),
      ]);
      const info = parse(infoResponse, rawInfo, 'INVALID_RESPONSE');
      const status = parse(statusResponse, rawStatus, 'INVALID_RESPONSE');
      const description: string[] | null = info.description == null ? null : [];
      if (description !== null) {
        for (const character of info.description!) {
          description.push(character);
          if (description.length > 2000) {
            break;
          }
        }
      }
      return {
        username,
        status: status.presence ?? null,
        description: description?.slice(0, 2000).join('') ?? null,
        descriptionTruncated: description !== null && description.length > 2000,
        uploadSlots: info.uploadSlots ?? null,
        queueLength: info.queueLength ?? null,
        hasFreeUploadSlot: info.hasFreeUploadSlot ?? null,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      controller.abort();
    }
  }

  return { browseUser, browseDirectory, userInfo };
}
