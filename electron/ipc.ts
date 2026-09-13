/**
 * IPC bridge between the Angular renderer and the application engine.
 *
 * Every `invoke` handler returns an `IpcResult` envelope so that validation
 * errors (ApiError) survive the structured-clone boundary with their status
 * code intact. The preload script unwraps the envelope and rethrows a plain
 * Error for the renderer.
 */

import { BrowserWindow, dialog, ipcMain, webContents } from 'electron';
import { IPC } from '../shared/contract.js';
import type { IpcResult, Settings } from '../shared/contract.js';
import { ApiError, Engine } from '../src/engine.js';
import { loadSettings, saveSettings } from './settings.js';

type Handler = (...args: any[]) => unknown | Promise<unknown>;

/**
 * Native "choose a directory" dialog, used to pick the host side of a sandbox
 * volume mount. Returns the absolute host path, or `null` when cancelled.
 */
async function pickDirectory(): Promise<string | null> {
  const options = {
    title: 'Choose a directory to mount',
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'] as const,
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result =
    parent === undefined
      ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function registerIpc(engine: Engine): void {
  const handle = (channel: string, fn: Handler): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ApiError) {
          return { ok: false, error: { message, status: error.status } };
        }
        return { ok: false, error: { message } };
      }
    });
  };

  handle(IPC.modelsList, () => engine.listModels());
  handle(IPC.chatsCreate, (body: unknown) => engine.createChat(body));
  handle(IPC.chatsGet, (id: string) => engine.getState(id));
  handle(IPC.chatsList, () => engine.listChats());
  handle(IPC.chatsOpen, (id: string) => engine.openChat(id));
  handle(IPC.chatsSendMessage, (id: string, body: unknown) => engine.sendMessage(id, body));
  handle(IPC.chatsGeneration, (id: string) => engine.getGeneration(id));
  handle(IPC.chatsCancel, (id: string) => engine.cancel(id));
  handle(IPC.chatsDelete, (id: string) => engine.deleteChat(id));
  handle(IPC.settingsGet, () => loadSettings());
  handle(IPC.settingsSet, (settings: Settings) => saveSettings(settings));
  handle(IPC.dockerStatus, () => engine.dockerStatus());
  handle(IPC.dialogPickDirectory, () => pickDirectory());

  // Forward engine events (thinking/text/tool/...) to every renderer.
  engine.subscribe((chatId, event) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) {
        contents.send(IPC.chatsEvent, { chatId, event });
      }
    }
  });
}
