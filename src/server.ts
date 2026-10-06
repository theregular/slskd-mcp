import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { connectionStatus, StatusError, type Environment } from './status.js';

export function createServer(env: Environment = process.env) {
  const server = new McpServer({ name: 'slskd-mcp', version: '0.1.0' });

  server.registerTool(
    'connection_status',
    {
      title: 'slskd connection status',
      description:
        'Check slskd API access, application version, and whether it is connected and logged into the Soulseek network. Does not connect, search, download, or change settings.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await connectionStatus(env);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        // Never echo HTTP response bodies or credentials into tool output.
        const result =
          error instanceof StatusError
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected error while checking slskd.' };
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
    },
  );

  return server;
}
