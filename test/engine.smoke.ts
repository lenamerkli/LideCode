/**
 * Headless smoke test for the application engine.
 *
 * Covers the request validation and error mapping that previously lived in the
 * Express routes. Anything that reaches Docker is skipped unless
 * `LIDECODE_SMOKE_DOCKER=1` is set (building the sandbox image takes minutes).
 */

import { configurePaths } from '../src/config.js';
import { ApiError, Engine } from '../src/engine.js';

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

  await engine.shutdown();

  if (failures > 0) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('All engine smoke checks passed');
}

void main();
