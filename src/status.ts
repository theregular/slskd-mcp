import { z } from 'zod';

import { SlskdError } from './errors.js';
import { type HttpClient } from './http.js';

const serverState = z.object({
  isConnected: z.boolean(),
  isLoggedIn: z.boolean(),
  state: z.string().optional(),
});

export function createStatusOperations(client: HttpClient) {
  async function connectionStatus() {
    const signal = AbortSignal.timeout(client.timeout);
    const [rawState, rawVersion] = await Promise.all([
      client.request('/server', { signal, legacyStatus: true }),
      client.request('/application/version', { signal, legacyStatus: true }),
    ]);

    const state = serverState.safeParse(rawState);
    const version = z.string().min(1).safeParse(rawVersion);
    if (!state.success || !version.success) {
      throw new SlskdError(
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

  return { connectionStatus };
}
