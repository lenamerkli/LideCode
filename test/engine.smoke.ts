/**
 * Headless smoke test for the application engine.
 *
 * Covers the request validation and error mapping that previously lived in the
 * Express routes. Anything that reaches Docker is skipped unless
 * `LIDECODE_SMOKE_DOCKER=1` is set (building the sandbox image takes minutes).
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePaths } from '../src/config.js';
import { ApiError, Engine } from '../src/engine.js';
import { Chat, volumeArgument } from '../src/chat.js';
import { MODELS } from '../src/models.js';
import { hostBash, hostReadFile, hostReplaceInFile, hostWriteToFile } from '../src/host_tools.js';
import { deleteSavedChat, deriveTitle, listSavedChats, loadSavedChat, saveSavedChat } from '../src/persistence.js';
import { ToolCall, ToolCallFunction, ToolMessage } from '../src/types.js';
import type { ChatEvent, SavedChat, SerializedMessage } from '../shared/contract.js';

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
  await expectApiError('createChat rejects an unknown volume mode', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', volumes: [['/host', '/c', 'rwx']] }));
  await expectApiError('createChat rejects a volume entry with a non-string path', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', volumes: [['/host', 7, 'ro']] }));
  await expectApiError('createChat rejects an over-long volume entry', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', volumes: [['/host', '/c', 'ro', 'x']] }));
  await expectApiError('createChat rejects malformed env', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', env: { A: 1 } }));
  await expectApiError('createChat rejects malformed external_tools', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', external_tools: [{ url: 'http://x' }] }));
  await expectApiError('createChat rejects a non-boolean host_tools', 400,
    () => engine.createChat({ model: first?.name, project_name: 'p', host_tools: 'yes' }));
  await expectApiError('createChat rejects an external tool that shadows a host tool', 400,
    () => engine.createChat({
      model: first?.name,
      project_name: 'p',
      external_tools: [{
        url: 'http://x',
        definition: {
          type: 'function',
          function: {
            name: 'host_bash',
            description: 'shadow',
            parameters: { type: 'object', properties: {} },
          },
        },
      }],
    }));
  await expectApiError('getState rejects an unknown chat', 404, () => Promise.resolve(engine.getState('missing')));
  await expectApiError('openChat rejects an unknown chat', 404, () => engine.openChat('missing'));
  await expectApiError('getGeneration rejects an unknown chat', 404,
    () => Promise.resolve(engine.getGeneration('missing')));
  await expectApiError('sendMessage rejects an unknown chat', 404,
    () => Promise.resolve(engine.sendMessage('missing', { message: 'hi' })));
  await expectApiError('deleteChat rejects an unknown chat', 404, () => engine.deleteChat('missing'));
  await expectApiError('resolveToolPermission rejects an unknown chat', 404,
    () => Promise.resolve(engine.resolveToolPermission('missing', 'c1', true)));

  let eventCount = 0;
  const unsubscribe = engine.subscribe(() => {
    eventCount++;
  });
  unsubscribe();
  check('subscribe returns an unsubscribe function', eventCount === 0);

  // --- volume mount formatting (pure, no Docker) -----------------------------
  check('volumeArgument keeps Docker\'s default for a plain mount',
    volumeArgument('/host/data', '/home/agent/data', undefined) === '/host/data:/home/agent/data');
  check('volumeArgument appends a read-only mode',
    volumeArgument('/host/data', '/home/agent/data', 'ro') === '/host/data:/home/agent/data:ro');
  check('volumeArgument appends an explicit read-write mode',
    volumeArgument('/host/data', '/home/agent/data', 'rw') === '/host/data:/home/agent/data:rw');

  // --- host tools (pure, no Docker) -----------------------------------------
  const hostDir = mkdtempSync(join(tmpdir(), 'lidecode-host-'));
  const hostFile = join(hostDir, 'sample.txt');
  const writeResult = await hostWriteToFile({ path: hostFile, content: 'alpha\nbeta\ngamma\n' });
  check('hostWriteToFile creates the file and reports its size',
    writeResult === 'Wrote 17 characters to ' + hostFile
    && readFileSync(hostFile, 'utf8') === 'alpha\nbeta\ngamma\n');
  const readResult = await hostReadFile({ path: hostFile, start_line: 1, end_line: 1, start_char: 0, end_char: 0 });
  check('hostReadFile returns the selected line range', readResult.includes('<content>alpha\n</content>'));
  const missingResult = await hostReadFile({ path: join(hostDir, 'missing.txt') });
  check('hostReadFile reports a missing file',
    missingResult === 'File not found: ' + join(hostDir, 'missing.txt'));
  const replaceResult = await hostReplaceInFile({ path: hostFile, search: 'beta', replace: 'BETA' });
  check('hostReplaceInFile replaces literal text',
    replaceResult.includes('Made 1 replacement(s)') && readFileSync(hostFile, 'utf8').includes('BETA'));
  const bashResult = await hostBash({ command: 'echo host-ok' });
  check('hostBash returns the command output',
    bashResult.includes('host-ok') && bashResult.includes('<returncode>0</returncode>'));

  // --- host tool permission gate (pure, no Docker) ---------------------------
  const gatedModel = MODELS.find((candidate) => candidate.name === first?.name);
  if (gatedModel !== undefined) {
    const gated = new Chat(gatedModel, undefined, 'p', [], true, undefined, undefined, true);
    const events: ChatEvent[] = [];
    gated.subscribe((event) => events.push(event));
    const messagesBefore = gated.conversation.messages.length;
    const pending = gated.call_tool(new ToolCall('perm-1', new ToolCallFunction('host_bash', '{"command":"echo should-not-run"}')));
    const request = events.find((event) => event.type === 'tool_permission_request');
    check('a host tool call asks the user for permission first',
      request !== undefined
      && request.type === 'tool_permission_request'
      && request.name === 'host_bash'
      && request.id === 'perm-1');
    check('a host tool call does not run before the user answers',
      gated.conversation.messages.length === messagesBefore);
    check('resolving an unknown permission request is rejected',
      gated.resolve_tool_permission('nope', true) === false);
    check('resolving a pending permission request succeeds',
      gated.resolve_tool_permission('perm-1', false) === true);
    await pending;
    const lastMessage = gated.conversation.messages[gated.conversation.messages.length - 1];
    check('a denied host tool call reports the denial back to the model',
      lastMessage instanceof ToolMessage && lastMessage.content.includes('denied by the user'));
    check('the permission resolution is announced',
      events.some((event) => event.type === 'tool_permission_resolved' && event.approved === false));
    check('answering the same request twice is rejected',
      gated.resolve_tool_permission('perm-1', true) === false);
    gated.close();
  } else {
    console.log('skip - host tool permission gate (no matching model)');
  }

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
      host_tools: true,
      temperature: 0.5,
      system_prompt_ext: 'Be terse.',
      external_tools: [],
      volumes: [
        ['/host/data', '/home/agent/data', 'ro'],
        ['/host/src', '/home/agent/src'],
      ],
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
    check('snapshot round-trips volume mounts with their access mode',
      JSON.stringify(roundTrip.volumes)
      === JSON.stringify([['/host/data', '/home/agent/data', 'ro'], ['/host/src', '/home/agent/src']]));
    check('snapshot round-trips the host_tools flag', roundTrip.host_tools === true);

    const legacyDoc: SavedChat = { ...doc };
    delete legacyDoc.host_tools;
    check('a chat saved before host tools existed restores with them disabled',
      Chat.fromSnapshot(legacyDoc).toSnapshot().host_tools === false);

    const opened = await engine.openChat('smoke-chat-1');
    check('Engine.openChat rehydrates a saved chat', opened.id === 'smoke-chat-1' && opened.cost === 1.25);
    check('Engine.openChat reports the restored messages', opened.messages.length === messages.length);
    check('Engine.openChat exposes the flags used to pre-fill a new chat',
      opened.allow_web === true && opened.host_tools === true
      && opened.system_prompt_ext === 'Be terse.' && opened.temperature === 0.5);
    check('Engine.openChat exposes the mounted directories',
      JSON.stringify(opened.volumes)
      === JSON.stringify([['/host/data', '/home/agent/data', 'ro'], ['/host/src', '/home/agent/src']]));

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
