/**
 * Headless smoke test for the application engine.
 *
 * Covers the request validation and error mapping that previously lived in the
 * Express routes. Anything that reaches Docker is skipped unless
 * `LIDECODE_SMOKE_DOCKER=1` is set (building the sandbox image takes minutes).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePaths } from '../src/config.js';
import { ApiError, Engine } from '../src/engine.js';
import { Chat } from '../src/chat.js';
import { deleteSavedChat, deriveTitle, listSavedChats, loadSavedChat, saveSavedChat } from '../src/persistence.js';
import type { SavedChat, SerializedMessage } from '../shared/contract.js';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    console.log('ok   - ' + name);
  } else {
    failures++;
    console.error('FAIL - ' + name);
  }
}

async function expectApiError(name: string, status: number, invoke: () => Promise<unknown>): Promise<void> {
  try {
    await invoke();
    check(name, false);
  } catch (error: unknown) {
    const ok = error instanceof ApiError && error.status === status;
    check(name + (ok ? '' : ` (got ${error instanceof Error ? error.message : String(error)})`), ok);
  }
}

async function main(): Promise<void> {
  configurePaths({ dataDir: '/tmp/lidecode-smoke', dockerContextDir: '/tmp/lidecode-smoke/docker' });
  const engine = new Engine();

  const models = engine.listModels();
  const first = models[0];
  check('listModels returns at least one model', models.length > 0);
  check('listModels returns serializable entries', first !== undefined
    && typeof first.name === 'string'
    && typeof first.max_context === 'number'
    && typeof first.supports_vision === 'boolean');

  const docker = await engine.dockerStatus();
  check('dockerStatus reports availability', typeof docker.available === 'boolean');

  await expectApiError('createChat rejects a missing body', 400, () => engine.createChat(null));
  await expectApiError('createChat requires a model', 400, () => engine.createChat({ project_name: 'p' }));
  await expectApiError('createChat requires a project name', 400, () => engine.createChat({ model: first?.name }));
  await expectApiError('createChat rejects an unknown model', 400,
    () => engine.createChat({ model: '__nope__', project_name: 'p' }));
  await expectApiError('createChat rejects malformed volumes', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', volumes: ['oops'] }));
  await expectApiError('createChat rejects malformed env', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', env: { A: 1 } }));
  await expectApiError('createChat rejects malformed external_tools', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', external_tools: [{ url: 'http://x' }] }));
  await expectApiError('getState rejects an unknown chat', 404, () => Promise.resolve(engine.getState('missing')));
  await expectApiError('openChat rejects an unknown chat', 404, () => engine.openChat('missing'));
  await expectApiError('getGeneration rejects an unknown chat', 404,
    () => Promise.resolve(engine.getGeneration('missing')));
  await expectApiError('sendMessage rejects an unknown chat', 404,
    () => Promise.resolve(engine.sendMessage('missing', { message: 'hi' })));
  await expectApiError('deleteChat rejects an unknown chat', 404, () => engine.deleteChat('missing'));

  let eventCount = 0;
  const unsubscribe = engine.subscribe(() => {
    eventCount++;
  });
  unsubscribe();
  check('subscribe returns an unsubscribe function', eventCount === 0);

  if (process.env['LIDECODE_SMOKE_DOCKER'] === '1' && first !== undefined) {
    const state = await engine.createChat({ model: first.name, project_name: 'smoke' });
    check('createChat returns a chat id', typeof state.id === 'string' && state.id.length > 0);
    check('createChat reports the model name', state.model === first.name);
    await engine.deleteChat(state.id);
  } else {
    console.log('skip - docker-backed createChat (set LIDECODE_SMOKE_DOCKER=1 to enable)');
  }

  // --- chat persistence round-trip (pure, no Docker) ------------------------
  if (first !== undefined) {
    // Isolate the store so prior runs cannot influence the assertions.
    configurePaths({ dataDir: mkdtempSync(join(tmpdir(), 'lidecode-smoke-chats-')) });

    const messages: SerializedMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello there' },
      {
        role: 'assistant',
        content: 'Hi',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        reasoning: 'thinking',
      },
      { role: 'tool', toolCallId: 'c1', content: 'file.txt' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64') },
          },
        ],
      },
    ];
    const doc: SavedChat = {
      version: 1,
      id: 'smoke-chat-1',
      title: deriveTitle(messages),
      project_name: 'smoke',
      model: first.name,
      cost: 1.25,
      allow_web: true,
      external_tools: [],
      messages,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    check('deriveTitle uses the first user message', doc.title === 'Hello there');

    await saveSavedChat(doc);
    const loaded = await loadSavedChat('smoke-chat-1');
    check('loadSavedChat returns the saved chat', loaded !== null && loaded.id === 'smoke-chat-1');
    check('loadSavedChat preserves message count', loaded !== null && loaded.messages.length === messages.length);

    const summaries = await listSavedChats();
    check('listSavedChats includes the saved chat', summaries.some((summary) => summary.id === 'smoke-chat-1'));
    const engineSummaries = await engine.listChats();
    check('Engine.listChats returns summaries', Array.isArray(engineSummaries));

    const restored = Chat.fromSnapshot(doc);
    const roundTrip = restored.toSnapshot();
    check('Chat.fromSnapshot restores the conversation', roundTrip.messages.length === messages.length);
    check('Chat.fromSnapshot restores cost and model', roundTrip.cost === 1.25 && roundTrip.model === doc.model);
    check('snapshot round-trips messages byte-for-byte',
      JSON.stringify(roundTrip.messages) === JSON.stringify(messages));

    const opened = await engine.openChat('smoke-chat-1');
    check('Engine.openChat rehydrates a saved chat', opened.id === 'smoke-chat-1' && opened.cost === 1.25);
    check('Engine.openChat reports the restored messages', opened.messages.length === messages.length);

    await deleteSavedChat('smoke-chat-1');
    check('deleteSavedChat removes the chat', (await loadSavedChat('smoke-chat-1')) === null);

    // The restored chat never started a container, so deleting it must not hit
    // Docker at all (it would otherwise fail without the daemon).
    await engine.deleteChat('smoke-chat-1');
    check('Engine.deleteChat closes a restored chat', (await loadSavedChat('smoke-chat-1')) === null);
  } else {
    console.log('skip - persistence round-trip (no models available)');
  }

  await engine.shutdown();

  if (failures > 0) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('All engine smoke checks passed');
}

void main();
