/**
 * On-disk persistence for chats.
 *
 * One JSON document per chat lives in `<dataDir>/chats/<id>.json`, so listing
 * never has to parse every conversation and a single corrupted file cannot
 * take down the whole store. Writes go through a temp file plus `rename`,
 * which keeps a partially written file from ever being observed.
 *
 * The module is deliberately transport-agnostic (no Electron imports) so it
 * can be exercised headlessly by the smoke test via `configurePaths`.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPaths } from './config.js';
import type { ChatSummary, SavedChat, SerializedMessage } from '../shared/contract.js';

/** Current on-disk schema version. Files with another version are ignored. */
export const SAVED_CHAT_VERSION = 1;

const CHATS_DIR_NAME = 'chats';
/** Chat ids are UUIDs, but the guard also blocks path traversal via `id`. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const TITLE_MAX_LENGTH = 60;

/** Directory holding the per-chat JSON files. */
function chatsDir(): string {
  return join(getPaths().dataDir, CHATS_DIR_NAME);
}

/** Absolute path of a chat file, or `null` when the id is not safe to use. */
function chatFile(id: string): string | null {
  return SAFE_ID.test(id) ? join(chatsDir(), id + '.json') : null;
}

/** Extract the display text of a serialized message content. */
function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        && typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return content === undefined || content === null ? '' : String(content);
}

/**
 * Derive a human-readable title from the conversation: the first user message,
 * collapsed to one line and truncated. Falls back to "Untitled chat".
 */
export function deriveTitle(messages: SerializedMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = contentToText(message.content).replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH - 1) + '…' : text;
    }
  }
  return 'Untitled chat';
}

/** Structural validation of a parsed document; rejects unknown versions. */
function isSavedChat(value: unknown): value is SavedChat {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return doc['version'] === SAVED_CHAT_VERSION
    && typeof doc['id'] === 'string'
    && typeof doc['model'] === 'string'
    && typeof doc['project_name'] === 'string'
    && Array.isArray(doc['messages'])
    && Array.isArray(doc['external_tools']);
}

function toSummary(doc: SavedChat): ChatSummary {
  return {
    id: doc.id,
    title: doc.title,
    project_name: doc.project_name,
    model: doc.model,
    cost: typeof doc.cost === 'number' ? doc.cost : 0,
    message_count: doc.messages.length,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

/** Persist a chat document atomically. */
export async function saveSavedChat(doc: SavedChat): Promise<void> {
  const file = chatFile(doc.id);
  if (file === null) {
    throw new Error(`Refusing to save a chat with an unsafe id "${doc.id}"`);
  }
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await writeFile(temp, JSON.stringify(doc, null, 2), 'utf8');
  await rename(temp, file);
}

/** Load a single chat document, or `null` when it is missing or invalid. */
export async function loadSavedChat(id: string): Promise<SavedChat | null> {
  const file = chatFile(id);
  if (file === null) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSavedChat(parsed) ? parsed : null;
  } catch (error: unknown) {
    console.warn(`Ignoring unreadable saved chat "${id}": ` + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}

/** List every saved chat, newest first. Unreadable files are skipped. */
export async function listSavedChats(): Promise<ChatSummary[]> {
  let names: string[];
  try {
    names = await readdir(chatsDir());
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const summaries: ChatSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const doc = await loadSavedChat(name.slice(0, -'.json'.length));
    if (doc !== null) {
      summaries.push(toSummary(doc));
    }
  }
  summaries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return summaries;
}

/** Delete a saved chat. Missing files are ignored. */
export async function deleteSavedChat(id: string): Promise<void> {
  const file = chatFile(id);
  if (file === null) {
    return;
  }
  try {
    await unlink(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
