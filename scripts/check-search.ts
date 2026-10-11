import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { searchStartOutput, searchResultsOutput } from '../src/search.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const summaryOnly = args[0] === '--summary';
if (summaryOnly) {
  args.shift();
}
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: pnpm check:search -- [--summary] "artist track"');
  process.exitCode = 1;
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const client = new Client({ name: 'slskd-search-check', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env,
    stderr: 'inherit',
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['connection_status', 'search_start', 'search_results']) {
      if (!tools.some((tool) => tool.name === name)) {
        throw new Error('Missing tool.');
      }
    }

    const result = await client.callTool({
      name: 'search_start',
      arguments: { query, searchTimeoutSeconds: 5, fileLimit: 100, responseLimit: 20 },
    });
    if (result.isError) {
      console.error(JSON.stringify(result.structuredContent));
      process.exitCode = 1;
    } else {
      const started = searchStartOutput.parse(result.structuredContent);
      console.log(JSON.stringify(started, null, 2));
      for (let attempt = 0; attempt < 7; attempt++) {
        if (attempt > 0) {
          await delay(2000);
        }
        const response = await client.callTool({
          name: 'search_results',
          arguments: { searchId: started.searchId, limit: 5 },
        });
        if (response.isError) {
          console.error(JSON.stringify(response.structuredContent));
          process.exitCode = 1;
          break;
        }
        const page = searchResultsOutput.parse(response.structuredContent);
        if (summaryOnly) {
          const { items, ...summary } = page;
          console.log(
            JSON.stringify(
              {
                ...summary,
                returnedCount: items.length,
                metadataObserved: {
                  sampleRate: items.some((file) => file.sampleRateHz !== null),
                  bitRate: items.some((file) => file.bitRateKbps !== null),
                  uploadSpeed: items.some((file) => file.uploadSpeedBytesPerSecond !== null),
                },
              },
              null,
              2,
            ),
          );
        } else {
          console.log(JSON.stringify(page, null, 2));
        }
        if (page.isComplete === true) {
          break;
        }
        if (attempt === 6) {
          console.log(
            'Search is still collecting. Read search_results later with the printed searchId.',
          );
        }
      }
    }
  } catch {
    console.error(
      'Search smoke check failed. Check the build, slskd configuration, and response compatibility.',
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
