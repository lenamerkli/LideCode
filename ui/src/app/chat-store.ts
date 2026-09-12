import { Injectable, signal } from '@angular/core';
import type {
  ChatEvent,
  ChatState,
  DockerStatus,
  ModelInfo,
  SerializedMessage,
} from '../../../shared/contract';
import { bridge } from './lidecode-bridge';

export type BubbleKind = 'user' | 'assistant' | 'error';

export interface Bubble {
  kind: BubbleKind;
  text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Flatten a serialized message content into display text. */
function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text: string } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return content === undefined || content === null ? '' : String(content);
}

/** Reproduce the message rendering of the previous web interface. */
function toBubbles(messages: SerializedMessage[]): Bubble[] {
  const bubbles: Bubble[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    const text = contentToText(message.content);
    if (message.role === 'tool') {
      bubbles.push({ kind: 'assistant', text: '[tool result] ' + text });
    } else if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      bubbles.push({
        kind: 'assistant',
        text: '[tool calls] ' + message.tool_calls
          .map((call) => call.function.name + '(' + call.function.arguments + ')')
          .join(', '),
      });
    } else {
      bubbles.push({ kind: message.role === 'user' ? 'user' : 'assistant', text });
    }
  }
  return bubbles;
}

/**
 * Single source of truth for the chat view. Mirrors the event handling of the
 * previous `public/index.html`, but driven by signals instead of DOM mutation.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  readonly models = signal<ModelInfo[]>([]);
  readonly selectedModel = signal('');
  readonly projectName = signal('test-project');
  readonly chatId = signal<string | null>(null);
  readonly bubbles = signal<Bubble[]>([]);
  readonly liveText = signal('');
  readonly liveThinking = signal('');
  readonly busy = signal(false);
  readonly status = signal('');
  readonly cost = signal(0);
  readonly docker = signal<DockerStatus | null>(null);

  private unsubscribe?: () => void;
  private pollTimer?: ReturnType<typeof setTimeout>;

  /** Subscribe to engine events and load the initial data. */
  async init(): Promise<void> {
    this.unsubscribe ??= bridge().chats.onEvent(({ chatId, event }) => this.handleEvent(chatId, event));
    void this.loadModels();
    try {
      this.docker.set(await bridge().docker.status());
    } catch {
      this.docker.set(null);
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await bridge().models.list();
      this.models.set(models);
      if (models.length > 0 && this.selectedModel().length === 0) {
        this.selectedModel.set(models[0]!.name);
      }
    } catch (error: unknown) {
      this.status.set('Failed to load models: ' + errorMessage(error));
    }
  }

  /** Rebuild the committed message list from a full chat state. */
  private renderState(state: ChatState): void {
    this.bubbles.set(toBubbles(state.messages));
    this.busy.set(!state.finished);
    this.cost.set(state.cost);
    this.status.set('id ' + state.id.slice(0, 8) + ' · ' + state.model + ' · cost ' + state.cost);
  }

  private append(bubble: Bubble): void {
    this.bubbles.update((bubbles) => [...bubbles, bubble]);
  }

  private handleEvent(chatId: string, event: ChatEvent): void {
    if (chatId !== this.chatId()) {
      return;
    }
    switch (event.type) {
      case 'generation_started':
        this.liveText.set('');
        this.liveThinking.set('');
        this.busy.set(true);
        break;
      case 'thinking':
        this.liveThinking.update((text) => text + event.delta);
        break;
      case 'text':
        this.liveText.update((text) => text + event.delta);
        break;
      case 'generation_finished':
        this.liveText.set('');
        this.liveThinking.set('');
        if (event.tool_calls.length > 0) {
          this.append({
            kind: 'assistant',
            text: '[tool calls] ' + event.tool_calls.map((call) => call.name + '(' + call.arguments + ')').join(', '),
          });
        }
        break;
      case 'tool_started':
        this.busy.set(true);
        this.status.set('running tool ' + event.name);
        break;
      case 'tool_finished':
        this.append({ kind: 'assistant', text: '[tool result] ' + event.name + ' finished' });
        break;
      case 'turn_finished':
        void this.finishTurn();
        break;
      case 'error':
        this.append({ kind: 'error', text: 'Error: ' + event.message });
        break;
      case 'closed':
        this.chatId.set(null);
        this.busy.set(false);
        this.status.set('chat closed');
        break;
    }
  }

  private async finishTurn(): Promise<void> {
    this.liveText.set('');
    this.liveThinking.set('');
    const id = this.chatId();
    if (id) {
      try {
        this.renderState(await bridge().chats.get(id));
      } catch (error: unknown) {
        this.status.set(errorMessage(error));
      }
    }
    this.busy.set(false);
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) {
      return;
    }
    this.pollTimer = setTimeout(() => void this.poll(), 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Safety net for the renderer: keeps the streamed text in sync even if an
   * event is missed (for example when the window is reloaded mid-generation)
   * and refreshes the committed messages once the turn finishes.
   */
  private async poll(): Promise<void> {
    this.pollTimer = undefined;
    const id = this.chatId();
    if (!id || !this.busy()) {
      return;
    }
    try {
      const generation = await bridge().chats.generation(id);
      if (generation.available) {
        const text = generation.text ?? '';
        const thinking = generation.thinking ?? '';
        if (text.length >= this.liveText().length) {
          this.liveText.set(text);
        }
        if (thinking.length >= this.liveThinking().length) {
          this.liveThinking.set(thinking);
        }
      }
      const state = await bridge().chats.get(id);
      if (state.finished) {
        this.liveText.set('');
        this.liveThinking.set('');
        this.renderState(state);
        this.busy.set(false);
        return;
      }
    } catch (error: unknown) {
      this.status.set('Poll failed: ' + errorMessage(error));
    }
    if (this.busy()) {
      this.startPolling();
    }
  }

  async createChat(): Promise<void> {
    this.stopPolling();
    this.liveText.set('');
    this.liveThinking.set('');
    this.bubbles.set([]);
    this.chatId.set(null);
    try {
      const state = await bridge().chats.create({
        model: this.selectedModel(),
        project_name: this.projectName() || 'test-project',
      });
      this.chatId.set(state.id);
      this.renderState(state);
      this.append({ kind: 'assistant', text: 'Chat created (' + state.model + '). Container is starting…' });
    } catch (error: unknown) {
      this.append({ kind: 'error', text: 'Create chat failed: ' + errorMessage(error) });
    }
  }

  async cancel(): Promise<void> {
    const id = this.chatId();
    if (!id) {
      return;
    }
    try {
      await bridge().chats.cancel(id);
    } catch (error: unknown) {
      this.status.set(errorMessage(error));
    }
  }

  async deleteChat(): Promise<void> {
    const id = this.chatId();
    if (!id) {
      return;
    }
    this.stopPolling();
    this.chatId.set(null);
    this.liveText.set('');
    this.liveThinking.set('');
    this.bubbles.set([]);
    this.status.set('deleted');
    this.busy.set(true);
    try {
      await bridge().chats.remove(id);
    } catch (error: unknown) {
      this.status.set(errorMessage(error));
    }
    this.busy.set(false);
  }

  async send(text: string): Promise<void> {
    const id = this.chatId();
    const message = text.trim();
    if (!id || message.length === 0) {
      return;
    }
    this.append({ kind: 'user', text: message });
    this.busy.set(true);
    try {
      await bridge().chats.sendMessage(id, { message });
      this.startPolling();
    } catch (error: unknown) {
      this.append({ kind: 'error', text: 'Send failed: ' + errorMessage(error) });
      this.busy.set(false);
    }
  }
}
