import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { browseUserOutput, browseDirectoryOutput, userInfoOutput } from '../src/peers.js';
import { readPeerConfig } from '../src/config.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const [username, directory] = args;
if (args.length !== 2 || !username?.trim() || !directory?.trim()) {
  console.error('Usage: pnpm check:browse -- "username" "exact remote directory"');
  process.exitCode = 1;
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const client = new Client({ name: 'slskd-browse-check', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env,
    stderr: 'inherit',
  });
  try {
    const timeout = readPeerConfig(env).timeout + 5000;
    await client.connect(transport);
    const { tools } = await client.listTools();
    const expected = ['browse_user', 'browse_directory', 'user_info'];
    assert(expected.every((name) => tools.some((tool) => tool.name === name)));
    console.log('Discovered tools:', tools.map((tool) => tool.name).join(', '));

    async function call(name: string, input: Record<string, unknown>) {
      console.log(`\n> ${name} ${JSON.stringify(input)}`);
      const result = await client.callTool({ name, arguments: input }, { timeout });
      console.log(JSON.stringify(result.structuredContent, null, 2));
      assert(!result.isError, 'Tool failed; inspect the printed error.');
      return result.structuredContent;
    }

    userInfoOutput.parse(await call('user_info', { username }));
    const library = browseUserOutput.parse(
      await call('browse_user', { username, directoryContains: directory, limit: 5 }),
    );
    const files = browseDirectoryOutput.parse(
      await call('browse_directory', { username, directory, limit: 5 }),
    );
    const summary = library.items.find((item) => item.directory === directory);
    if (summary) {
      console.log(
        `\nLibrary reported ${summary.fileCount} files; directory lookup returned ${files.matchedCount} unlocked, deduplicated files.`,
      );
    }
    console.log('\nPASS: peer info, library summaries, and directory files returned through MCP.');
    console.log('Only peer lookups were performed. No searches or downloads were created.');
  } catch {
    console.error(
      'Browse check failed. Inspect printed responses and peer availability. No automatic retry was attempted.',
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
