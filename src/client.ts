import { type SlskdConfig } from './config.js';
import { createHttpClient } from './http.js';
import { createStatusOperations } from './status.js';
import { createSearchOperations } from './search.js';
import { createPeerOperations } from './peers.js';
import { createDownloadOperations } from './downloads.js';

export function createSlskdClient(config: SlskdConfig) {
  const http = createHttpClient(config);

  return Object.freeze({
    ...createStatusOperations(http),
    ...createSearchOperations(http),
    ...createPeerOperations(http),
    ...createDownloadOperations(http),
  });
}

export type SlskdClient = ReturnType<typeof createSlskdClient>;
