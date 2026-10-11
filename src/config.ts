import { z } from 'zod';
import { SlskdError } from './errors.js';

function timeoutSchema(name: string, maximum: number, fallback: number) {
  const error = { error: `${name} must be an integer between 100 and ${maximum}.` };
  return z.coerce.number(error).int(error).min(100, error).max(maximum, error).default(fallback);
}

const baseUrlSchema = z
  .string({ error: 'SLSKD_URL must be an absolute HTTP or HTTPS URL.' })
  .trim()
  .default('')
  .transform((value) => value || 'http://127.0.0.1:5030')
  .pipe(z.url({ error: 'SLSKD_URL must be an absolute HTTP or HTTPS URL.' }))
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    { error: 'Use an HTTP(S) base URL without credentials, query parameters, or a fragment.' },
  )
  .transform((url) => url.href.replace(/\/+$/, ''));

const environmentSchema = z
  .object({
    SLSKD_URL: baseUrlSchema,
    SLSKD_API_KEY: z.string().trim().optional(),
    SLSKD_BEARER_TOKEN: z.string().trim().optional(),
    SLSKD_TIMEOUT_MS: timeoutSchema('SLSKD_TIMEOUT_MS', 30000, 5000),
    SLSKD_PEER_TIMEOUT_MS: timeoutSchema('SLSKD_PEER_TIMEOUT_MS', 120000, 30000),
  })
  .refine((env) => !(env.SLSKD_API_KEY && env.SLSKD_BEARER_TOKEN), {
    error: 'Set only one of SLSKD_API_KEY and SLSKD_BEARER_TOKEN.',
  })
  .transform((env) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (env.SLSKD_API_KEY) {
      headers['X-API-Key'] = env.SLSKD_API_KEY;
    } else if (env.SLSKD_BEARER_TOKEN) {
      headers.Authorization = `Bearer ${env.SLSKD_BEARER_TOKEN}`;
    }

    return {
      base: env.SLSKD_URL,
      timeout: env.SLSKD_TIMEOUT_MS,
      peerTimeout: env.SLSKD_PEER_TIMEOUT_MS,
      headers,
    };
  });

type ParsedConfig = z.output<typeof environmentSchema>;

export type SlskdConfig = Readonly<ParsedConfig>;

export function readConfig(env: unknown): SlskdConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    // Expose only a validation message, never the full error or environment values.
    throw new SlskdError('CONFIG_ERROR', result.error.issues[0]!.message);
  }
  return result.data;
}
