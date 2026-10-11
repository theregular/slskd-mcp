import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readConfig } from './config.js';
import { createSlskdClient } from './client.js';
import { createServer } from './server.js';
import { SlskdError } from './errors.js';

try {
  const slskd = createSlskdClient(readConfig(process.env));

  await createServer(slskd).connect(new StdioServerTransport());
} catch (error) {
  console.error(
    error instanceof SlskdError
      ? `Unable to start slskd-mcp: ${error.code}: ${error.message}`
      : 'Unable to start slskd-mcp.',
  );
  process.exitCode = 1;
}
