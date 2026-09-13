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
  chatsList: 'chats:list',
  chatsOpen: 'chats:open',
  chatsSendMessage: 'chats:sendMessage',
  chatsGeneration: 'chats:generation',
  chatsCancel: 'chats:cancel',
  chatsDelete: 'chats:delete',
  chatsToolPermission: 'chats:toolPermission',
  chatsEvent: 'chats:event',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  dockerStatus: 'docker:status',
  dialogPickDirectory: 'dialog:pickDirectory',
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
  | { type: 'tool_permission_request'; id: string; name: string; arguments: string }
  | { type: 'tool_permission_resolved'; id: string; approved: boolean }
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

/** A pending request for the user to approve or deny one host-tool execution. */
export interface ToolPermissionRequest {
  /** Tool-call id, echoed back when the decision is submitted. */
  id: string;
  /** Tool name, e.g. `host_bash`. */
  name: string;
  /** Raw JSON arguments as produced by the model, shown verbatim to the user. */
  arguments: string;
}

/** One message of a serialized conversation, as produced by `Message.toJSON()`. */
export interface SerializedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** Legacy camelCase tool-call id emitted by an earlier `ToolMessage.toJSON()`. */
  toolCallId?: string;
  name?: string;
  reasoning?: string | null;
  refusal?: string | null;
  finish_reason?: string | null;
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
  /**
   * Create-time configuration, echoed back so the renderer can pre-fill a new
   * chat from the current one (the "same settings" action in the UI).
   */
  allow_web?: boolean;
  host_tools?: boolean;
  system_prompt_ext?: string;
  volumes?: VolumeMount[];
}

/** Streaming state of the current generation, equivalent to `GET /chats/:id/generation`. */
export interface GenerationInfo {
  available: boolean;
  text?: string;
  thinking?: string;
  isDone?: boolean;
}

/** Access mode of a host directory mounted into the sandbox. */
export type VolumeMode = 'ro' | 'rw';

/**
 * One host directory mounted into the sandbox, as a Docker `-v` argument:
 * `[hostPath, containerPath]` or `[hostPath, containerPath, mode]`. Omitting the
 * mode leaves Docker's default (`rw`), which is what older saved chats contain.
 */
export type VolumeMount = [string, string, VolumeMode?];

/** Body of the old `POST /chats` request. */
export interface CreateChatRequest {
  model: string;
  project_name: string;
  temperature?: number;
  volumes?: VolumeMount[];
  env?: Record<string, string>;
  allow_web?: boolean;
  host_tools?: boolean;
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

/**
 * Full persisted state of a chat (one JSON file per chat under
 * `<userData>/chats/`). Versioned so the on-disk shape can evolve.
 */
export interface SavedChat {
  version: 1;
  id: string;
  title: string;
  project_name: string;
  model: string;
  temperature?: number;
  cost: number;
  allow_web: boolean;
  host_tools?: boolean;
  system_prompt_ext?: string;
  tools_prompt_ext?: string;
  external_tools: ExternalToolInput[];
  volumes?: VolumeMount[];
  env?: Record<string, string>;
  messages: SerializedMessage[];
  created_at: string;
  updated_at: string;
}

/** Lightweight listing entry for a saved chat (no message payload). */
export interface ChatSummary {
  id: string;
  title: string;
  project_name: string;
  model: string;
  cost: number;
  message_count: number;
  created_at: string;
  updated_at: string;
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
