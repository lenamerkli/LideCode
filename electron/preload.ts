/**
 * Preload script: the only bridge between the sandboxed Angular renderer and
 * the main process. It exposes a narrow, typed API on `window.lidecode` and
 * never hands the renderer raw `ipcRenderer` access.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/contract.js';
import type {
  ChatEventEnvelope,
  ChatState,
  CreateChatRequest,
  DockerStatus,
  GenerationInfo,
  IpcResult,
  ModelInfo,
  SendMessageRequest,
  Settings,
} from '../shared/contract.js';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result || result.ok !== true) {
    const message = result && result.ok === false ? result.error.message : 'Unknown IPC failure';
    throw new Error(message);
  }
  return result.value;
}

const lidecode = {
  models: {
    list: (): Promise<ModelInfo[]> => invoke<ModelInfo[]>(IPC.modelsList),
  },
  chats: {
    create: (request: CreateChatRequest): Promise<ChatState> => invoke<ChatState>(IPC.chatsCreate, request),
    get: (id: string): Promise<ChatState> => invoke<ChatState>(IPC.chatsGet, id),
    sendMessage: (id: string, request: SendMessageRequest): Promise<ChatState> =>
      invoke<ChatState>(IPC.chatsSendMessage, id, request),
    generation: (id: string): Promise<GenerationInfo> => invoke<GenerationInfo>(IPC.chatsGeneration, id),
    cancel: (id: string): Promise<ChatState> => invoke<ChatState>(IPC.chatsCancel, id),
    remove: (id: string): Promise<void> => invoke<void>(IPC.chatsDelete, id),
    /** Subscribe to chat events. Returns an unsubscribe function. */
    onEvent: (callback: (envelope: ChatEventEnvelope) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, envelope: ChatEventEnvelope): void => callback(envelope);
      ipcRenderer.on(IPC.chatsEvent, listener);
      return () => {
        ipcRenderer.off(IPC.chatsEvent, listener);
      };
    },
  },
  settings: {
    get: (): Promise<Settings> => invoke<Settings>(IPC.settingsGet),
    set: (settings: Settings): Promise<Settings> => invoke<Settings>(IPC.settingsSet, settings),
  },
  docker: {
    status: (): Promise<DockerStatus> => invoke<DockerStatus>(IPC.dockerStatus),
  },
};

contextBridge.exposeInMainWorld('lidecode', lidecode);

export type LidecodeApi = typeof lidecode;
