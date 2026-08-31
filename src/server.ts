import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Chat, cleanup_stale_containers } from './chat.js';
import { MODELS } from './models.js';
import { Model } from './types.js';

// Load variables from .env into process.env before anything reads them.
dotenv.config();

const app = express();
const PORT = process.env.PORT || 9876;

// Serve the static web interface from ../public (relative to dist/).
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Middleware to parse JSON
app.use(express.json());

// In-memory chat store, keyed by project id. No listing endpoint so that
// multi-user support can be added later without leaking cross-user chats.
const chats = new Map<string, Chat>();

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, `The field "${field}" is required and must be a non-empty string`);
  }
  return value;
}

function getChat(id: string | string[] | undefined): { id: string, chat: Chat } {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApiError(400, 'A chat id is required');
  }
  const chat = chats.get(id);
  if (!chat) {
    throw new ApiError(404, `No chat found for id "${id}"`);
  }
  return { id, chat };
}

function chatState(id: string, chat: Chat): Record<string, unknown> {
  const state: Record<string, unknown> = {
    id: id,
    project_name: chat.project_name,
    model: chat.model.name,
    temperature: chat.temperature,
    finished: !chat.busy,
    cost: chat.cost,
    messages: chat.conversation.messages.map((message) => message.toJSON()),
  };
  if (chat.error !== undefined) {
    state['error'] = chat.error;
  }
  return state;
}
// List the available models.
app.get('/models', (_req: Request, res: Response) => {
  res.status(200).json({
    models: MODELS.map((model) => ({
      name: model.name,
      tech_name: model.tech_name,
      provider: model.provider,
      supports_vision: model.supports_vision,
      supports_tool_calls: model.supports_tool_calls,
      max_context: model.max_context,
    })),
  });
});

// Create a new chat. The model is referenced by its unique display name.
app.post('/chats', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'A JSON request body is required');
  }
  const modelName = requireString(body, 'model');
  const projectName = requireString(body, 'project_name');
  const model: Model | undefined = MODELS.find((candidate) => candidate.name === modelName);
  if (!model) {
    throw new ApiError(400, `Unknown model "${modelName}". See GET /models for available models.`);
  }
  let temperature: number | undefined = undefined;
  if (body['temperature'] !== undefined) {
    if (typeof body['temperature'] !== 'number' || !Number.isFinite(body['temperature'])) {
      throw new ApiError(400, 'The field "temperature" must be a number');
    }
    temperature = body['temperature'];
  }
  let volumes: [string, string][] | undefined = undefined;
  if (body['volumes'] !== undefined) {
    if (!Array.isArray(body['volumes']) || !body['volumes'].every(
      (volume) => Array.isArray(volume) && volume.length === 2 && volume.every((part) => typeof part === 'string')
    )) {
      throw new ApiError(400, 'The field "volumes" must be an array of [host, container] string pairs');
    }
    volumes = body['volumes'] as [string, string][];
  }
  let env: Record<string, string> | undefined = undefined;
  if (body['env'] !== undefined) {
    if (typeof body['env'] !== 'object' || body['env'] === null || Array.isArray(body['env'])
      || !Object.values(body['env']).every((value) => typeof value === 'string')) {
      throw new ApiError(400, 'The field "env" must be an object mapping strings to strings');
    }
    env = body['env'] as Record<string, string>;
  }

  const id = randomUUID();
  const chat = new Chat(model, temperature, projectName);
  try {
    await chat.start_docker(volumes, env);
  } catch (error: unknown) {
    throw new ApiError(500, `Failed to start the docker container: ${error instanceof Error ? error.message : String(error)}`);
  }
  chats.set(id, chat);
  res.status(201).json(chatState(id, chat));
});

// Get the current state of a chat.
app.get('/chats/:id', (req: Request, res: Response) => {
  const { id, chat } = getChat(req.params.id);
  res.status(200).json(chatState(id, chat));
});

// Send a user message and optionally start a generation. The request returns
// immediately with the current state; poll GET /chats/:id for the result.
app.post('/chats/:id/messages', (req: Request, res: Response) => {
  const { id, chat } = getChat(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'A JSON request body is required');
  }
  const message = requireString(body, 'message');
  let generate = true;
  if (body['generate'] !== undefined) {
    if (typeof body['generate'] !== 'boolean') {
      throw new ApiError(400, 'The field "generate" must be a boolean');
    }
    generate = body['generate'];
  }
  chat.send_user_message(message);
  if (generate) {
    try {
      chat.generate();
    } catch (error: unknown) {
      throw new ApiError(409, error instanceof Error ? error.message : String(error));
    }
  }
  res.status(200).json(chatState(id, chat));
});

// Get the current streaming state of the generation, if one is available.
app.get('/chats/:id/generation', (req: Request, res: Response) => {
  const { chat } = getChat(req.params.id);
  const handle = chat.generation_handle;
  if (!handle) {
    res.status(200).json({ available: false });
    return;
  }
  res.status(200).json({
    available: true,
    text: handle.text,
    thinking: handle.thinking,
    isDone: handle.isDone,
  });
});

// Cancel the current generation.
app.post('/chats/:id/cancel', (req: Request, res: Response) => {
  const { id, chat } = getChat(req.params.id);
  chat.cancel_generation();
  res.status(200).json(chatState(id, chat));
});

// Delete a chat and stop its docker container.
app.delete('/chats/:id', async (req: Request, res: Response) => {
  const { id, chat } = getChat(req.params.id);
  try {
    await chat.stop_docker();
  } finally {
    chats.delete(id);
  }
  res.status(204).send();
});

// Central error handler: everything thrown above ends up here.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof ApiError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: message });
});


// Start the server
(async () => {
  try {
    await cleanup_stale_containers();
  } catch (error: unknown) {
    console.warn('Failed to clean up leftover Docker containers: ' + (error instanceof Error ? error.message : String(error)));
  }
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
})();
