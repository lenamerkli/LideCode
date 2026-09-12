import type {
  ChatEventEnvelope,
  ChatState,
  ChatSummary,
  CreateChatRequest,
  DockerStatus,
  GenerationInfo,
  ModelInfo,
  SendMessageRequest,
  Settings,
} from '../../../shared/contract';

/**
 * The API surface exposed by the Electron preload script on `window.lidecode`.
 * Mirrors `electron/preload.ts` without pulling Electron types into the renderer.
 */
export interface LidecodeBridge {
  models: {
    list(): Promise<ModelInfo[]>;
  };
  chats: {
    create(request: CreateChatRequest): Promise<ChatState>;
    get(id: string): Promise<ChatState>;
    list(): Promise<ChatSummary[]>;
    open(id: string): Promise<ChatState>;
    sendMessage(id: string, request: SendMessageRequest): Promise<ChatState>;
    generation(id: string): Promise<GenerationInfo>;
    cancel(id: string): Promise<ChatState>;
    remove(id: string): Promise<void>;
    onEvent(callback: (envelope: ChatEventEnvelope) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    set(settings: Settings): Promise<Settings>;
  };
  docker: {
    status(): Promise<DockerStatus>;
  };
}

declare global {
  interface Window {
    lidecode: LidecodeBridge;
  }
}

/** Access the main-process bridge. */
export function bridge(): LidecodeBridge {
  return window.lidecode;
}
