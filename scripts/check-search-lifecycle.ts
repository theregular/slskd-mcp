import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  searchStartOutput,
  searchResultsOutput,
  searchListOutput,
  searchStopOutput,
  searchDeleteOutput,
} from '../src/search.js';

const query = process.argv
  .slice(2)
  .filter((arg) => arg !== '--')
  .join(' ')
  .trim();
if (!query) {
  console.error('Usage: pnpm check:lifecycle -- "artist track"');
  process.exitCode = 1;
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const client = new Client({ name: 'slskd-lifecycle-check', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env,
    stderr: 'inherit',
  });
  let searchId: string | undefined;

  async function call(name: string, args: Record<string, unknown>, expectedError?: string) {
    console.log(`\n> ${name} ${JSON.stringify(args)}`);
    const result = await client.callTool({ name, arguments: args });
    console.log(JSON.stringify(result.structuredContent, null, 2));
    if (expectedError) {
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as Record<string, unknown>)?.code, expectedError);
    } else {
      assert(!result.isError, 'Tool returned an error; inspect the printed response.');
    }
    return result.structuredContent;
  }

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const expected = [
      'connection_status',
      'search_start',
      'search_results',
      'search_list',
      'search_stop',
      'search_delete',
    ];
    assert(expected.every((name) => tools.some((tool) => tool.name === name)));
    console.log('Discovered tools:', tools.map((tool) => tool.name).join(', '));
    const status = await call('connection_status', {});
    assert.equal((status as Record<string, unknown>)?.readyToSearch, true);

    const started = searchStartOutput.parse(
      await call('search_start', {
        query,
        searchTimeoutSeconds: 30,
        fileLimit: 10000,
        responseLimit: 1000,
      }),
    );
    searchId = started.searchId;

    let found = false;
    for (let offset = 0; offset < 10000; offset += 100) {
      const list = searchListOutput.parse(
        await call('search_list', { queryContains: query, offset, limit: 100 }),
      );
      found = list.items.some((item) => item.searchId === searchId);
      if (found || !list.hasMore) {
        break;
      }
    }
    assert(found, 'Created search was not found within the bounded list scan.');
    await delay(2000);
    const before = searchResultsOutput.parse(
      await call('search_results', { searchId, limit: 5, sort: 'filename' }),
    );
    searchStopOutput.parse(await call('search_stop', { searchId }));

    let after = searchResultsOutput.parse(
      await call('search_results', { searchId, limit: 5, sort: 'filename' }),
    );
    for (let attempt = 0; !after.isComplete && attempt < 8; attempt++) {
      await delay(250);
      after = searchResultsOutput.parse(
        await call('search_results', { searchId, limit: 5, sort: 'filename' }),
      );
    }
    assert.equal(
      after.isComplete,
      true,
      'Stop was acknowledged, but completion was not observed within the polling window.',
    );
    assert(
      after.matchedCount >= before.matchedCount,
      'Previously collected results disappeared after stop.',
    );
    searchDeleteOutput.parse(await call('search_delete', { searchId }));
    await call('search_results', { searchId }, 'NOT_FOUND');
    console.log(
      '\nPASS: created, listed, stopped, read retained results, deleted, and confirmed absence.',
    );
    console.log(
      'Only the search created by this run was stopped/deleted. No downloads were queued.',
    );
  } catch {
    console.error(
      'Lifecycle check failed. Inspect the printed responses; no automatic retry or cleanup was attempted.',
    );
    if (searchId) {
      console.error(`Reconcile this search ID before another run: ${searchId}`);
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
