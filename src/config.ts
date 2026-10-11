import { SlskdError } from './errors.js';

export type Environment = Record<string, string | undefined>;

export type SlskdConfig = Readonly<{
  base: string;
  timeout: number;
  peerTimeout: number;
  headers: Readonly<Record<string, string>>;
}>;

export function readConfig(env: Environment): SlskdConfig {
  let url: URL;
  try {
    url = new URL(env.SLSKD_URL?.trim() || 'http://127.0.0.1:5030');
  } catch {
    throw new SlskdError('CONFIG_ERROR', 'SLSKD_URL must be an absolute HTTP or HTTPS URL.');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SlskdError(
      'CONFIG_ERROR',
      'Use an HTTP(S) base URL without credentials, query parameters, or a fragment.',
    );
  }

  const apiKey = env.SLSKD_API_KEY?.trim();
  const token = env.SLSKD_BEARER_TOKEN?.trim();
  if (apiKey && token) {
    throw new SlskdError('CONFIG_ERROR', 'Set only one of SLSKD_API_KEY and SLSKD_BEARER_TOKEN.');
  }

  const timeout = Number(env.SLSKD_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) {
    throw new SlskdError(
      'CONFIG_ERROR',
      'SLSKD_TIMEOUT_MS must be an integer between 100 and 30000.',
    );
  }

  const peerTimeout = Number(env.SLSKD_PEER_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(peerTimeout) || peerTimeout < 100 || peerTimeout > 120000) {
    throw new SlskdError(
      'CONFIG_ERROR',
      'SLSKD_PEER_TIMEOUT_MS must be an integer between 100 and 120000.',
    );
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return Object.freeze({
    base: url.href.replace(/\/+$/, ''),
    timeout,
    peerTimeout,
    headers: Object.freeze(headers),
  });
}
