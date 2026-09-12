/**
 * Transport-agnostic application engine.
 *
 * Holds the in-memory chat store and implements every operation that used to
 * live in the Express route handlers of `server.ts`. The Electron IPC layer
 * (and any future transport) drives this class directly, so it contains no
 * HTTP, Express or Electron types.
 */

import { execFile } from 'node:child_process';
import { Chat, cleanup_stale_containers } from './chat.js';
import { deleteSavedChat, listSavedChats, loadSavedChat, saveSavedChat } from './persistence.js';
import { MODELS } from './models.js';
import { Model } from './types.js';
import { DEFAULT_TOOLS, ExternalTool, Tool, ToolParameters, VIEWIMAGE_TOOL, WEBSEARCH_TOOL } from './tool_definitions.js';
import type {
  ChatEvent,
  ChatState,
  ChatSummary,
  DockerStatus,
  GenerationInfo,
  ModelInfo,
  SerializedMessage,
} from '../shared/contract.js';

/** Error carrying an HTTP-like status code, surfaced to the renderer as-is. */
export class ApiError extends Error {
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

/** Resolve the version of the Docker CLI, or an explanatory failure. */
function probeDocker(): Promise<DockerStatus> {
  return new Promise<DockerStatus>((resolve) => {
    execFile('docker', ['--version'], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve({
          available: false,
          message: 'The Docker CLI could not be run. Install Docker and make sure the daemon is running.',
        });
        return;
      }
      resolve({ available: true, version: stdout.toString().trim() });
    });
  });
}

export class Engine {
  /** Debounce window before a changed chat is written to disk. */
  private static readonly PERSIST_DELAY_MS = 500;
  private readonly chats = new Map<string, Chat>();
  private readonly listeners = new Set<(chatId: string, event: ChatEvent) => void>();
  /** Timers for chats with unsaved changes, keyed by chat id. */
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chats awaiting a debounced save. */
  private readonly pendingSaves = new Map<string, Chat>();

  /** Prepare the environment (removes leftover sandbox containers from crashes). */
  async init(): Promise<void> {
    try {
      await cleanup_stale_containers();
    } catch (error: unknown) {
      console.warn('Failed to clean up leftover Docker containers: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  listModels(): ModelInfo[] {
    return MODELS.map((model) => ({
      name: model.name,
      tech_name: model.tech_name,
      provider: model.provider,
      supports_vision: model.supports_vision,
      supports_tool_calls: model.supports_tool_calls,
      max_context: model.max_context,
    }));
  }

  dockerStatus(): Promise<DockerStatus> {
    return probeDocker();
  }

  /** Subscribe to every chat event. Returns an unsubscribe function. */
  subscribe(listener: (chatId: string, event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(chatId: string, event: ChatEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(chatId, event);
      } catch (error: unknown) {
        console.error('Engine event listener failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Route a chat's change notifications into the debounced save queue. */
  private attachPersistence(chat: Chat): void {
    chat.onChanged = () => this.schedulePersist(chat);
  }

  private schedulePersist(chat: Chat): void {
    this.pendingSaves.set(chat.id, chat);
    if (this.persistTimers.has(chat.id)) {
      return;
    }
    const timer = setTimeout(() => {
      this.persistTimers.delete(chat.id);
      const target = this.pendingSaves.get(chat.id);
      this.pendingSaves.delete(chat.id);
      if (target) {
        void this.persistChat(target);
      }
    }, Engine.PERSIST_DELAY_MS);
    timer.unref();
    this.persistTimers.set(chat.id, timer);
  }

  private cancelPendingPersist(id: string): void {
    const timer = this.persistTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
    }
    this.pendingSaves.delete(id);
  }

  private async persistChat(chat: Chat): Promise<void> {
    try {
      await saveSavedChat(chat.toSnapshot());
    } catch (error: unknown) {
      console.error(`Failed to save chat ${chat.id}: ` + (error instanceof Error ? error.message : String(error)));
    }
  }

  /** Write every debounced-but-unsaved chat immediately (used on shutdown). */
  private async flushPendingSaves(): Promise<void> {
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    const chats = [...this.pendingSaves.values()];
    this.pendingSaves.clear();
    await Promise.all(chats.map((chat) => this.persistChat(chat)));
  }

  /** List every chat saved on disk, newest first. */
  listChats(): Promise<ChatSummary[]> {
    return listSavedChats();
  }

  /**
   * Rehydrate a saved chat into memory. Cheap: it restores the conversation
   * but does not start the sandbox container, which happens lazily on the
   * next message. Opening an already-open chat returns it as-is.
   */
  async openChat(id: string): Promise<ChatState> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError(400, 'A chat id is required');
    }
    const existing = this.chats.get(id);
    if (existing) {
      return this.chatState(id, existing);
    }
    const doc = await loadSavedChat(id);
    if (doc === null) {
      throw new ApiError(404, `No chat found for id "${id}"`);
    }
    let chat: Chat;
    try {
      chat = Chat.fromSnapshot(doc);
    } catch (error: unknown) {
      throw new ApiError(500, `Failed to restore chat "${id}": ${error instanceof Error ? error.message : String(error)}`);
    }
    this.attachPersistence(chat);
    chat.subscribe((event) => this.emit(id, event));
    this.chats.set(id, chat);
    return this.chatState(id, chat);
  }

  private getChat(id: string): Chat {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError(400, 'A chat id is required');
    }
    const chat = this.chats.get(id);
    if (!chat) {
      throw new ApiError(404, `No chat found for id "${id}"`);
    }
    return chat;
  }

  private chatState(id: string, chat: Chat): ChatState {
    const state: ChatState = {
      id,
      project_name: chat.project_name,
      model: chat.model.name,
      temperature: chat.temperature,
      finished: !chat.busy,
      cost: chat.cost,
      messages: chat.conversation.messages.map((message) => message.toJSON() as SerializedMessage),
    };
    if (chat.error !== undefined) {
      state.error = chat.error;
    }
    return state;
  }

  /**
   * Parse the optional "external_tools" field of a create-chat request. Returns
   * an empty array when the field is absent. Throws an ApiError(400) when
   * present but malformed, so that typos in tool definitions fail fast instead
   * of silently producing tools the model cannot call.
   */
  private parseExternalTools(body: Record<string, unknown>): ExternalTool[] {
    const value = body['external_tools'];
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new ApiError(400, 'The field "external_tools" must be an array of {definition, url, headers?} objects');
    }
    const external_tools: ExternalTool[] = [];
    const names = new Set<string>();
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ApiError(400, `external_tools[${index}] must be an object`);
      }
      const external = entry as Record<string, unknown>;
      if (typeof external['url'] !== 'string' || external['url'].length === 0) {
        throw new ApiError(400, `external_tools[${index}].url is required and must be a non-empty string`);
      }
      const definition = external['definition'];
      if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
        throw new ApiError(400, `external_tools[${index}].definition is required and must be an object`);
      }
      const def = definition as Record<string, unknown>;
      if (def['type'] !== 'function') {
        throw new ApiError(400, `external_tools[${index}].definition.type must be "function"`);
      }
      const fn = def['function'];
      if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) {
        throw new ApiError(400, `external_tools[${index}].definition.function is required and must be an object`);
      }
      const fun = fn as Record<string, unknown>;
      if (typeof fun['name'] !== 'string' || fun['name'].length === 0) {
        throw new ApiError(400, `external_tools[${index}].definition.function.name is required and must be a non-empty string`);
      }
      if (typeof fun['description'] !== 'string' || fun['description'].length === 0) {
        throw new ApiError(400, `external_tools[${index}].definition.function.description is required and must be a non-empty string`);
      }
      const parameters = fun['parameters'];
      if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
        throw new ApiError(400, `external_tools[${index}].definition.function.parameters must be an object with type "object" and a "properties" object`);
      }
      const params = parameters as Record<string, unknown>;
      if (params['type'] !== 'object' || typeof params['properties'] !== 'object'
        || params['properties'] === null || Array.isArray(params['properties'])) {
        throw new ApiError(400, `external_tools[${index}].definition.function.parameters must be an object with type "object" and a "properties" object`);
      }
      if (params['required'] !== undefined
        && (!Array.isArray(params['required']) || !params['required'].every((part: unknown) => typeof part === 'string'))) {
        throw new ApiError(400, `external_tools[${index}].definition.function.parameters.required must be an array of strings`);
      }
      const name = fun['name'] as string;
      const description = fun['description'] as string;
      if (names.has(name)) {
        throw new ApiError(400, `The tool name "${name}" appears more than once in external_tools`);
      }
      if (DEFAULT_TOOLS.some((tool) => tool.function.name === name)
        || name === WEBSEARCH_TOOL.function.name || name === VIEWIMAGE_TOOL.function.name) {
        throw new ApiError(400, `The tool name "${name}" conflicts with a built-in tool`);
      }
      names.add(name);
      const tool: Tool = {
        type: 'function',
        function: {
          name,
          description,
          parameters: {
            type: 'object',
            properties: params['properties'] as ToolParameters['properties'],
          }
        }
      };
      if (params['required'] !== undefined) {
        tool.function.parameters.required = params['required'] as string[];
      }
      let headers: Record<string, string> | undefined = undefined;
      if (external['headers'] !== undefined) {
        if (typeof external['headers'] !== 'object' || external['headers'] === null || Array.isArray(external['headers'])
          || !Object.values(external['headers']).every((part) => typeof part === 'string')) {
          throw new ApiError(400, `external_tools[${index}].headers must be an object mapping strings to strings`);
        }
        headers = external['headers'] as Record<string, string>;
      }
      const external_tool: ExternalTool = { url: external['url'], definition: tool };
      if (headers !== undefined) {
        external_tool.headers = headers;
      }
      external_tools.push(external_tool);
    }
    return external_tools;
  }

  /** Create a chat and start its Docker sandbox container. */
  async createChat(body: unknown): Promise<ChatState> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'A JSON request body is required');
    }
    const request = body as Record<string, unknown>;
    const modelName = requireString(request, 'model');
    const projectName = requireString(request, 'project_name');
    const model: Model | undefined = MODELS.find((candidate) => candidate.name === modelName);
    if (!model) {
      throw new ApiError(400, `Unknown model "${modelName}". See the model list for available models.`);
    }
    let temperature: number | undefined = undefined;
    if (request['temperature'] !== undefined) {
      if (typeof request['temperature'] !== 'number' || !Number.isFinite(request['temperature'])) {
        throw new ApiError(400, 'The field "temperature" must be a number');
      }
      temperature = request['temperature'];
    }
    let volumes: [string, string][] | undefined = undefined;
    if (request['volumes'] !== undefined) {
      if (!Array.isArray(request['volumes']) || !request['volumes'].every(
        (volume) => Array.isArray(volume) && volume.length === 2 && volume.every((part) => typeof part === 'string')
      )) {
        throw new ApiError(400, 'The field "volumes" must be an array of [host, container] string pairs');
      }
      volumes = request['volumes'] as [string, string][];
    }
    let env: Record<string, string> | undefined = undefined;
    if (request['env'] !== undefined) {
      if (typeof request['env'] !== 'object' || request['env'] === null || Array.isArray(request['env'])
        || !Object.values(request['env']).every((value) => typeof value === 'string')) {
        throw new ApiError(400, 'The field "env" must be an object mapping strings to strings');
      }
      env = request['env'] as Record<string, string>;
    }

    let allowWeb = true;
    if (request['allow_web'] !== undefined) {
      if (typeof request['allow_web'] !== 'boolean') {
        throw new ApiError(400, 'The field "allow_web" must be a boolean');
      }
      allowWeb = request['allow_web'];
    }

    let systemPromptExt: string | undefined = undefined;
    if (request['system_prompt_ext'] !== undefined) {
      if (typeof request['system_prompt_ext'] !== 'string' || request['system_prompt_ext'].length === 0) {
        throw new ApiError(400, 'The field "system_prompt_ext" must be a non-empty string');
      }
      systemPromptExt = request['system_prompt_ext'];
    }

    let toolsPromptExt: string | undefined = undefined;
    if (request['tools_prompt_ext'] !== undefined) {
      if (typeof request['tools_prompt_ext'] !== 'string' || request['tools_prompt_ext'].length === 0) {
        throw new ApiError(400, 'The field "tools_prompt_ext" must be a non-empty string');
      }
      toolsPromptExt = request['tools_prompt_ext'];
    }

    const externalTools = this.parseExternalTools(request);
    const chat = new Chat(model, temperature, projectName, externalTools, allowWeb, systemPromptExt, toolsPromptExt);
    const id = chat.id;
    this.attachPersistence(chat);
    chat.subscribe((event) => this.emit(id, event));
    try {
      await chat.start_docker(volumes, env);
    } catch (error: unknown) {
      this.cancelPendingPersist(id);
      chat.close();
      throw new ApiError(500, `Failed to start the docker container: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.chats.set(id, chat);
    // Persist immediately so the chat exists on disk as soon as it is created;
    // this supersedes the debounced save scheduled during container start.
    this.cancelPendingPersist(id);
    await this.persistChat(chat);
    return this.chatState(id, chat);
  }

  getState(id: string): ChatState {
    return this.chatState(id, this.getChat(id));
  }

  getGeneration(id: string): GenerationInfo {
    const chat = this.getChat(id);
    const handle = chat.generation_handle;
    if (!handle) {
      return { available: false };
    }
    return {
      available: true,
      text: handle.text,
      thinking: handle.thinking,
      isDone: handle.isDone,
    };
  }

  /** Send a user message and optionally start a generation. */
  async sendMessage(id: string, body: unknown): Promise<ChatState> {
    const chat = this.getChat(id);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'A JSON request body is required');
    }
    const request = body as Record<string, unknown>;
    const message = requireString(request, 'message');
    let generate = true;
    if (request['generate'] !== undefined) {
      if (typeof request['generate'] !== 'boolean') {
        throw new ApiError(400, 'The field "generate" must be a boolean');
      }
      generate = request['generate'];
    }
    // Chats restored from disk start their container lazily, on first use.
    try {
      await chat.ensure_started();
    } catch (error: unknown) {
      throw new ApiError(500, `Failed to start the docker container: ${error instanceof Error ? error.message : String(error)}`);
    }
    chat.send_user_message(message);
    if (generate) {
      try {
        chat.generate();
      } catch (error: unknown) {
        throw new ApiError(409, error instanceof Error ? error.message : String(error));
      }
    }
    return this.chatState(id, chat);
  }

  cancel(id: string): ChatState {
    const chat = this.getChat(id);
    chat.cancel_generation();
    return this.chatState(id, chat);
  }

  /** Delete a chat, stop its Docker container and remove its saved file. */
  async deleteChat(id: string): Promise<void> {
    const chat = this.getChat(id);
    this.cancelPendingPersist(id);
    try {
      await chat.stop_docker();
    } catch (error: unknown) {
      // Deleting must succeed even when the container is gone or Docker is
      // unavailable (e.g. a restored chat that never started a container).
      console.warn(`Failed to stop the container for chat ${id}: ` + (error instanceof Error ? error.message : String(error)));
    } finally {
      // Emits the 'closed' event (ending any open streams) before dropping listeners.
      chat.close();
      this.chats.delete(id);
    }
    await deleteSavedChat(id);
  }

  /** Stop every sandbox container. Called on application shutdown. */
  async shutdown(): Promise<void> {
    // Flush debounced saves first so the last turn is not lost on quit.
    await this.flushPendingSaves();
    const entries = [...this.chats.entries()];
    this.chats.clear();
    await Promise.all(entries.map(async ([id, chat]) => {
      try {
        chat.cancel_generation();
        await chat.stop_docker();
      } catch (error: unknown) {
        console.error(`Failed to stop chat ${id}: ` + (error instanceof Error ? error.message : String(error)));
      } finally {
        chat.close();
      }
    }));
  }
}
