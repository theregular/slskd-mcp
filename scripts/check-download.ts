import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readConfig } from '../src/config.js';
import { browseDirectoryOutput } from '../src/peers.js';
import { downloadQueueInput, downloadQueueOutput, downloadStatusOutput } from '../src/downloads.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length !== 3) {
  console.error('Usage: pnpm check:download -- "username" "exact remote filename" sizeBytes');
  process.exitCode = 1;
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const client = new Client({ name: 'slskd-download-check', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env,
    stderr: 'inherit',
  });
  const requestId = randomUUID();
  try {
    const selection = downloadQueueInput.parse({
      username: args[0],
      requestId,
      files: [{ filename: args[1], sizeBytes: Number(args[2]) }],
    });
    const file = selection.files[0]!;
    assert(
      file.sizeBytes <= 20 * 1024 * 1024,
      'Smoke test is limited to one file of at most 20 MiB.',
    );
    const timeout = readConfig(env).peerTimeout + 5000;
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert(tools.some((tool) => tool.name === 'download_queue'));
    console.log('Discovered tools:', tools.map((tool) => tool.name).join(', '));

    async function call(name: string, input: Record<string, unknown>) {
      console.log(`\n> ${name} ${JSON.stringify(input)}`);
      const result = await client.callTool({ name, arguments: input }, { timeout });
      console.log(JSON.stringify(result.structuredContent, null, 2));
      assert(!result.isError, 'Tool returned an error. Inspect its printed response.');
      return result.structuredContent;
    }

    const separatorIndex = Math.max(
      file.filename.lastIndexOf('\\'),
      file.filename.lastIndexOf('/'),
    );
    if (separatorIndex > 0) {
      const directory = file.filename.slice(0, separatorIndex);
      const verified = browseDirectoryOutput.parse(
        await call('browse_directory', {
          username: selection.username,
          directory,
          filters: { include: [file.filename] },
          limit: 100,
        }),
      );
      assert(
        verified.items.some(
          (item) => item.filename === file.filename && item.sizeBytes === file.sizeBytes,
        ),
        'Selected path and size are no longer present in the directory.',
      );
    }
    const queued = downloadQueueOutput.parse(await call('download_queue', selection));
    assert.equal(queued.acceptedCount, 1);
    let observed = false;
    let completed = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      if (attempt) {
        await delay(2000);
      }
      const status = downloadStatusOutput.parse(
        await call('download_status', { batchId: requestId, limit: 100 }),
      );
      const item = status.items?.find(
        (item) =>
          item.username === selection.username &&
          item.filename === file.filename &&
          item.sizeBytes === file.sizeBytes,
      );
      if (!item) {
        continue;
      }
      observed = true;
      if (item.isComplete) {
        assert.equal(item.isSuccessful, true, 'The selected transfer ended unsuccessfully.');
        await call('download_status', { username: item.username, transferId: item.transferId });
        completed = true;
        break;
      }
    }
    assert(observed, 'The accepted file was not observed in the batch within the polling window.');
    await call('download_list', { username: selection.username, limit: 5 });
    console.log(
      completed
        ? '\nPASS: selected file queued, tracked, and completed successfully.'
        : '\nPASS: selected file queued and tracked; completion is still pending.',
    );
    console.log(
      'No cancellation, history cleanup, fallback source, or additional download was requested.',
    );
  } catch {
    console.error('Download check failed. Inspect printed responses and the exact file selection.');
    console.error(
      `Reconcile batch ${requestId} before any retry if enqueue was attempted. No automatic retry or cleanup was performed.`,
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
