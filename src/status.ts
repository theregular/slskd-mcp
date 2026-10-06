import { z } from 'zod';

export type Environment = Record<string, string | undefined>;

export class StatusError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const serverState = z.object({
  isConnected: z.boolean(),
  isLoggedIn: z.boolean(),
  state: z.string().optional(),
});

export function readConfig(env: Environment) {
  let url: URL;
  try {
    url = new URL(env.SLSKD_URL?.trim() || 'http://127.0.0.1:5030');
  } catch {
    throw new StatusError('CONFIG_ERROR', 'SLSKD_URL must be an absolute HTTP or HTTPS URL.');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new StatusError(
      'CONFIG_ERROR',
      'Use an HTTP(S) base URL without credentials, query parameters, or a fragment.',
    );
  }

  const apiKey = env.SLSKD_API_KEY?.trim();
  const token = env.SLSKD_BEARER_TOKEN?.trim();
  if (!apiKey && !token)
    throw new StatusError(
      'AUTH_NOT_CONFIGURED',
      'Set SLSKD_API_KEY, or SLSKD_BEARER_TOKEN for a temporary session.',
    );
  if (apiKey && token)
    throw new StatusError('CONFIG_ERROR', 'Set only one of SLSKD_API_KEY and SLSKD_BEARER_TOKEN.');

  const timeout = Number(env.SLSKD_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) {
    throw new StatusError(
      'CONFIG_ERROR',
      'SLSKD_TIMEOUT_MS must be an integer between 100 and 30000.',
    );
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  else headers.Authorization = `Bearer ${token}`;

  return { base: url.href.replace(/\/+$/, ''), timeout, headers };
}

export async function connectionStatus(env: Environment = process.env) {
  const config = readConfig(env);
  const signal = AbortSignal.timeout(config.timeout);

  async function get(path: '/server' | '/application/version'): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${config.base}/api/v0${path}`, {
        method: 'GET',
        headers: config.headers,
        signal,
        redirect: 'error',
      });
    } catch {
      if (signal.aborted)
        throw new StatusError('TIMEOUT', 'slskd did not respond before the request timeout.');

      throw new StatusError(
        'UNREACHABLE',
        'Cannot reach slskd. Check that it is running and SLSKD_URL is correct. Redirects are not followed.',
      );
    }

    if (response.status === 401)
      throw new StatusError(
        'UNAUTHORIZED',
        'slskd rejected the credentials. Check the API key or renew the temporary session token.',
      );

    if (response.status === 403)
      throw new StatusError(
        'FORBIDDEN',
        'slskd denied this request. Check the credential permissions, allowed IPs, and server mode.',
      );

    if (response.status === 404)
      throw new StatusError(
        'NOT_FOUND',
        'slskd API endpoint not found. Use its base URL, including any URL prefix, but omit /api/v0.',
      );

    if (!response.ok)
      throw new StatusError('HTTP_ERROR', `slskd returned HTTP ${response.status}.`);

    try {
      return await response.json();
    } catch {
      if (signal.aborted)
        throw new StatusError(
          'TIMEOUT',
          'slskd did not finish its response before the request timeout.',
        );

      throw new StatusError(
        'INVALID_RESPONSE',
        'slskd returned invalid JSON. Check the URL and server version.',
      );
    }
  }

  // Both are read-only endpoints. No health response is mistaken for a network login.
  const [rawState, rawVersion] = await Promise.all([get('/server'), get('/application/version')]);

  const state = serverState.safeParse(rawState);
  const version = z.string().min(1).safeParse(rawVersion);
  if (!state.success || !version.success) {
    throw new StatusError(
      'INVALID_RESPONSE',
      'slskd returned an unexpected status or version shape.',
    );
  }

  const connected = state.data.isConnected;
  const loggedIn = state.data.isLoggedIn;

  return {
    reachable: true,
    authenticated: true,
    version: version.data,
    connected,
    loggedIn,
    readyToSearch: connected && loggedIn,
    state: state.data.state ?? null,
  };
}
