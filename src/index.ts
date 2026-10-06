import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

try {
  await createServer().connect(new StdioServerTransport());
} catch {
  console.error('Unable to start slskd-mcp.');
  process.exitCode = 1;
}
