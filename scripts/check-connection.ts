import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

// Exercise the real MCP initialize -> tools/list -> tools/call exchange over stdio.
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  env,
  stderr: 'inherit',
});
const client = new Client({ name: 'slskd-mcp-check', version: '0.1.0' });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  if (tools.length !== 1 || tools[0]?.name !== 'connection_status')
    throw new Error('Unexpected tool list.');

  const result = await client.callTool({ name: 'connection_status', arguments: {} });
  for (const content of result.content as { type: string; text?: string }[]) {
    if (content.type === 'text') console.log(content.text);
  }

  if (result.isError) process.exitCode = 1;
} catch {
  console.error('MCP smoke check failed. Rebuild the project and check its configuration.');
  process.exitCode = 1;
} finally {
  await client.close();
}
