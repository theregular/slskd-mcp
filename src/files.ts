import { z } from 'zod';

export const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const optionalNumber = nonnegativeInteger.nullish();

export const upstreamFileSchema = z.object({
  filename: z.string().min(1),
  size: nonnegativeInteger,
  extension: z.string().nullish(),
  bitRate: optionalNumber,
  length: optionalNumber,
  sampleRate: optionalNumber,
  bitDepth: optionalNumber,
  isLocked: z.boolean().optional(),
});

export const fileRecordSchema = z.object({
  username: z.string(),
  filename: z.string(),
  sizeBytes: nonnegativeInteger,
  extension: z.string().nullable(),
  bitRateKbps: nonnegativeInteger.nullable(),
  durationSeconds: nonnegativeInteger.nullable(),
  sampleRateHz: nonnegativeInteger.nullable(),
  bitDepth: nonnegativeInteger.nullable(),
});

export const fileFiltersSchema = z
  .object({
    extensions: z.array(z.string()).optional(),
    minBitRateKbps: nonnegativeInteger.optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .strict();

export const pageInputShape = {
  offset: nonnegativeInteger.default(0),
  limit: z.number().int().min(1).max(100).default(25),
};

export type FileRecord = z.infer<typeof fileRecordSchema>;

export function normalizeExtension(extension: string) {
  return extension.toLowerCase().replace(/^\./, '');
}

export function projectFile(
  file: z.infer<typeof upstreamFileSchema>,
  username: string,
): FileRecord {
  // The protocol's extension field is often empty; the remote filename still supplies a suffix.
  const basename = file.filename.split(/[\\/]/).at(-1) ?? '';
  const suffix = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : '';
  return {
    username,
    filename: file.filename,
    sizeBytes: file.size,
    extension: normalizeExtension(file.extension || suffix) || null,
    bitRateKbps: file.bitRate ?? null,
    durationSeconds: file.length ?? null,
    sampleRateHz: file.sampleRate ?? null,
    bitDepth: file.bitDepth ?? null,
  };
}

export function matchesFilters(file: FileRecord, filters: z.infer<typeof fileFiltersSchema>) {
  const path = file.filename.toLowerCase();
  return (
    (!filters.extensions?.length ||
      filters.extensions.some((ext) => normalizeExtension(ext) === file.extension)) &&
    (filters.minBitRateKbps === undefined ||
      (file.bitRateKbps !== null && file.bitRateKbps >= filters.minBitRateKbps)) &&
    (filters.include ?? []).every((part) => path.includes(part.toLowerCase())) &&
    !(filters.exclude ?? []).some((part) => path.includes(part.toLowerCase()))
  );
}

export function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNullable(a: number | null, b: number | null, descending = false) {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  return descending ? b - a : a - b;
}

export function page<T>(items: T[], offset: number, limit: number) {
  return {
    items: items.slice(offset, offset + limit),
    offset,
    limit,
    matchedCount: items.length,
    hasMore: offset + limit < items.length,
    fetchedAt: new Date().toISOString(),
    consistency: 'live' as const,
  };
}
