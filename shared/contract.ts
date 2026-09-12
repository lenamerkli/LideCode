/**
 * Transport contract shared between the Electron main process (engine) and
 * the Angular renderer.
 *
 * This module must stay free of Node- and browser-only imports so it can be
 * bundled into both the main process and the renderer.
 */

/** IPC channel names. `invoke` channels are request/response, `push` channels are one-way. */
export const IPC = {
  modelsList: 'models:list',
  chatsCreate: 'chats:create',
  chatsGet: 'chats:get',
  chatsSendMessage: 'chats:sendMessage',
  chatsGeneration: 'chats:generation',
  chatsCancel: 'chats:cancel',
  chatsDelete: 'chats:delete',
  chatsEvent: 'chats:event',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  dockerStatus: 'docker:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * Events emitted by a chat for the entire duration of a user turn. A turn
 * spans one or more generation streams plus the tool executions between them.
 * Subscribing is purely observational: it never influences the turn.
 */
export type ChatEvent =
  | { type: 'generation_started' }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'generation_finished'; finish_reason: string | null; tool_calls: { id: string; name: string; arguments: string }[] }
  | { type: 'tool_started'; id: string; name: string }
  | { type: 'tool_finished'; id: string; name: string }
  | { type: 'turn_finished' }
  | { type: 'error'; message: string }
  | { type: 'closed' };

/** Envelope pushed to the renderer for every chat event. */
export interface ChatEventEnvelope {
  chatId: string;
  event: ChatEvent;
}

export interface ModelInfo {
  name: string;
  tech_name: string;
  provider: string;
  supports_vision: boolean;
  supports_tool_calls: boolean;
  max_context: number;
}

/** One message of a serialized conversation, as produced by `Message.toJSON()`. */
export interface SerializedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** Full state of a chat, equivalent to the old `GET /chats/:id` response body. */
export interface ChatState {
  id: string;
  project_name: string;
  model: string;
  temperature: number | undefined;
  finished: boolean;
  cost: number;
  messages: SerializedMessage[];
  error?: string;
}

/** Streaming state of the current generation, equivalent to `GET /chats/:id/generation`. */
export interface GenerationInfo {
  available: boolean;
  text?: string;
  thinking?: string;
  isDone?: boolean;
}

/** Body of the old `POST /chats` request. */
export interface CreateChatRequest {
  model: string;
  project_name: string;
  temperature?: number;
  volumes?: [string, string][];
  env?: Record<string, string>;
  allow_web?: boolean;
  system_prompt_ext?: string;
  tools_prompt_ext?: string;
  external_tools?: ExternalToolInput[];
}

/** One entry of the `external_tools` array of a create-chat request. */
export interface ExternalToolInput {
  url: string;
  definition: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      };
    };
  };
  headers?: Record<string, string>;
}

/** Body of the old `POST /chats/:id/messages` request. */
export interface SendMessageRequest {
  message: string;
  generate?: boolean;
}

/** User-configurable settings, persisted in the Electron userData directory. */
export interface Settings {
  openrouter_api_key?: string;
  brave_search_api_key?: string;
  default_model?: string;
  default_project_name?: string;
}

export interface DockerStatus {
  available: boolean;
  version?: string;
  message?: string;
}

/** Result envelope returned by every `invoke` handler. */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; status?: number } };
