import { z } from 'zod';

import { readConfig, type Environment } from './config.js';
import { SlskdError as StatusError } from './errors.js';
import { requestJson } from './client.js';

export { readConfig, type Environment } from './config.js';
export { SlskdError as StatusError } from './errors.js';

const serverState = z.object({
  isConnected: z.boolean(),
  isLoggedIn: z.boolean(),
  state: z.string().optional(),
});

export async function connectionStatus(env: Environment = process.env) {
  const config = readConfig(env);
  const signal = AbortSignal.timeout(config.timeout);
  const [rawState, rawVersion] = await Promise.all([
    requestJson(config, '/server', { signal, legacyStatus: true }),
    requestJson(config, '/application/version', { signal, legacyStatus: true }),
  ]);

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
