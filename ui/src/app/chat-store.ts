import { Injectable, computed, signal } from '@angular/core';
import type {
  ChatEvent,
  ChatState,
  ChatSummary,
  CreateChatRequest,
  DockerStatus,
  ModelInfo,
  SerializedMessage,
  Settings,
  ToolPermissionRequest,
  VolumeMount,
} from '../../../shared/contract';
import { bridge } from './lidecode-bridge';

export type BubbleKind = 'user' | 'assistant' | 'error';

export interface Bubble {
  kind: BubbleKind;
  text: string;
}

/** Transient message surfaced to the user (rendered as a snack bar). */
export type NoticeKind = 'info' | 'error';

export interface Notice {
  message: string;
  kind: NoticeKind;
}

/** Values collected by the "New chat" dialog. */
export interface CreateChatOptions {
  model: string;
  projectName: string;
  allowWeb: boolean;
  /** Offer the host-machine tools (`host_bash`, ...) to the model. Defaults to true. */
  hostTools: boolean;
  temperature?: number;
  systemPromptExt?: string;
  /** Host directory mounts, as `[hostPath, containerPath, mode?]` entries. */
  volumes?: VolumeMount[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Flatten a serialized message content into display text. */
function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
      )
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
    } else if (
      message.role === 'assistant' &&
      message.tool_calls &&
      message.tool_calls.length > 0
    ) {
      bubbles.push({
        kind: 'assistant',
        text:
          '[tool calls] ' +
          message.tool_calls
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
  readonly savedChats = signal<ChatSummary[]>([]);
  readonly settings = signal<Settings>({});
  readonly selectedModel = signal('');
  readonly projectName = signal('test-project');
  readonly chatId = signal<string | null>(null);
  /** Create-time configuration of the open chat, or null when no chat is open. */
  readonly currentSettings = signal<CreateChatOptions | null>(null);
  readonly bubbles = signal<Bubble[]>([]);
  readonly liveText = signal('');
  readonly liveThinking = signal('');
  readonly busy = signal(false);
  readonly status = signal('');
  readonly cost = signal(0);
  readonly docker = signal<DockerStatus | null>(null);
  readonly notice = signal<Notice | null>(null);

  /**
   * Host-tool calls waiting for the user's approval, oldest first. The model may
   * issue several tool calls at once, so more than one request can be
   * outstanding; the view answers the first one.
   */
  readonly permissionQueue = signal<ToolPermissionRequest[]>([]);

  /** The permission request currently awaiting an answer, if any. */
  readonly permissionRequest = computed<ToolPermissionRequest | null>(
    () => this.permissionQueue()[0] ?? null,
  );

  private unsubscribe?: () => void;
  private pollTimer?: ReturnType<typeof setTimeout>;

  /** Subscribe to engine events and load the initial data. */
  async init(): Promise<void> {
    this.unsubscribe ??= bridge().chats.onEvent(({ chatId, event }) =>
      this.handleEvent(chatId, event),
    );
    await this.loadSettings();
    void this.loadModels();
    void this.loadSavedChats();
    try {
      const docker = await bridge().docker.status();
      this.docker.set(docker);
      if (!docker.available) {
        this.notify(docker.message ?? 'Docker is not available.');
      }
    } catch {
      this.docker.set(null);
    }
  }

  /** Load the persisted settings (API keys and dialog defaults). */
  async loadSettings(): Promise<void> {
    try {
      this.settings.set(await bridge().settings.get());
    } catch (error: unknown) {
      this.notify('Failed to load settings: ' + errorMessage(error), 'error');
    }
  }

  /** Persist settings and refresh the local copy. */
  async saveSettings(settings: Settings): Promise<void> {
    try {
      this.settings.set(await bridge().settings.set(settings));
      this.notify('Settings saved.');
    } catch (error: unknown) {
      this.notify('Failed to save settings: ' + errorMessage(error), 'error');
    }
  }

  private notify(message: string, kind: NoticeKind = 'info'): void {
    this.notice.set({ message, kind });
  }

  /** Refresh the sidebar list of chats persisted on disk. */
  async loadSavedChats(): Promise<void> {
    try {
      this.savedChats.set(await bridge().chats.list());
    } catch (error: unknown) {
      this.status.set('Failed to load saved chats: ' + errorMessage(error));
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await bridge().models.list();
      this.models.set(models);
      if (this.selectedModel().length === 0) {
        const preferred = this.settings().default_model;
        const known = preferred !== undefined && models.some((model) => model.name === preferred);
        this.selectedModel.set(known ? preferred : (models[0]?.name ?? ''));
      }
      const project = this.settings().default_project_name;
      if (project !== undefined && project.length > 0 && this.projectName() === 'test-project') {
        this.projectName.set(project);
      }
    } catch (error: unknown) {
      this.status.set('Failed to load models: ' + errorMessage(error));
      this.notify('Failed to load models: ' + errorMessage(error), 'error');
    }
  }

  /** Rebuild the committed message list from a full chat state. */
  private renderState(state: ChatState): void {
    this.bubbles.set(toBubbles(state.messages));
    this.busy.set(!state.finished);
    this.cost.set(state.cost);
    this.status.set('id ' + state.id.slice(0, 8) + ' · ' + state.model + ' · cost ' + state.cost);
    this.currentSettings.set(this.settingsFromState(state));
  }

  /** Map the create-time configuration of a chat state into dialog options. */
  private settingsFromState(state: ChatState): CreateChatOptions {
    const settings: CreateChatOptions = {
      model: state.model,
      projectName: state.project_name,
      allowWeb: state.allow_web ?? true,
      hostTools: state.host_tools ?? true,
    };
    if (state.temperature !== undefined) {
      settings.temperature = state.temperature;
    }
    if (state.system_prompt_ext !== undefined) {
      settings.systemPromptExt = state.system_prompt_ext;
    }
    if (state.volumes !== undefined) {
      settings.volumes = state.volumes;
    }
    return settings;
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
        this.status.set('waiting for the model…');
        break;
      case 'thinking':
      case 'text': {
        // A cancelled turn may still deliver a few deltas while its stream is
        // torn down; the turn is over, so they must not re-open the bubble.
        if (!this.busy()) {
          break;
        }
        if (event.type === 'thinking') {
          this.liveThinking.update((value) => value + event.delta);
          this.status.set('thinking…');
        } else {
          this.liveText.update((value) => value + event.delta);
          this.status.set('writing…');
        }
        break;
      }
      case 'generation_finished':
        this.liveText.set('');
        this.liveThinking.set('');
        if (event.tool_calls.length > 0) {
          this.append({
            kind: 'assistant',
            text:
              '[tool calls] ' +
              event.tool_calls.map((call) => call.name + '(' + call.arguments + ')').join(', '),
          });
        }
        break;
      case 'tool_started':
        this.busy.set(true);
        this.status.set('running tool ' + event.name);
        break;
      case 'tool_finished':
        this.append({ kind: 'assistant', text: '[tool result] ' + event.name + ' finished' });
        // The model is asked for a follow-up now; do not keep showing the tool.
        this.status.set('waiting for the model…');
        break;
      case 'tool_permission_request':
        this.busy.set(true);
        this.status.set('waiting for approval: ' + event.name);
        this.append({
          kind: 'assistant',
          text: '[permission] ' + event.name + ' is waiting for your approval',
        });
        this.permissionQueue.update((queue) => [
          ...queue,
          { id: event.id, name: event.name, arguments: event.arguments },
        ]);
        break;
      case 'tool_permission_resolved':
        this.permissionQueue.update((queue) => queue.filter((entry) => entry.id !== event.id));
        break;
      case 'turn_finished':
        void this.finishTurn();
        break;
      case 'error':
        this.permissionQueue.set([]);
        this.append({ kind: 'error', text: 'Error: ' + event.message });
        break;
      case 'closed':
        this.permissionQueue.set([]);
        this.chatId.set(null);
        this.busy.set(false);
        this.status.set('chat closed');
        break;
    }
  }

  private async finishTurn(): Promise<void> {
    this.permissionQueue.set([]);
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
    void this.loadSavedChats();
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
      // The turn may have been cancelled or finished while this reply was in
      // flight; never resurrect streamed text for a turn that is no longer busy.
      if (this.busy() && generation.available) {
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

  /** Start a new chat (and its sandbox container) from the dialog's values. */
  async createChat(options: CreateChatOptions): Promise<boolean> {
    this.stopPolling();
    this.permissionQueue.set([]);
    this.liveText.set('');
    this.liveThinking.set('');
    this.bubbles.set([]);
    this.chatId.set(null);

    const request: CreateChatRequest = {
      model: options.model,
      project_name: options.projectName.length > 0 ? options.projectName : 'test-project',
      allow_web: options.allowWeb,
      host_tools: options.hostTools,
    };
    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }
    if (options.systemPromptExt !== undefined) {
      request.system_prompt_ext = options.systemPromptExt;
    }
    if (options.volumes !== undefined && options.volumes.length > 0) {
      request.volumes = options.volumes;
    }

    try {
      const state = await bridge().chats.create(request);
      this.chatId.set(state.id);
      this.selectedModel.set(state.model);
      this.projectName.set(state.project_name);
      this.renderState(state);
      this.append({
        kind: 'assistant',
        text: 'Chat created (' + state.model + '). Container is starting…',
      });
      this.notify('Chat created with ' + state.model + '.');
      void this.loadSavedChats();
      return true;
    } catch (error: unknown) {
      const message = 'Create chat failed: ' + errorMessage(error);
      this.append({ kind: 'error', text: message });
      this.notify(message, 'error');
      return false;
    }
  }

  /** Open a chat persisted on disk; its container starts lazily on next send. */
  async openChat(id: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.stopPolling();
    this.permissionQueue.set([]);
    this.liveText.set('');
    this.liveThinking.set('');
    try {
      const state = await bridge().chats.open(id);
      this.chatId.set(state.id);
      this.renderState(state);
    } catch (error: unknown) {
      const message = 'Open chat failed: ' + errorMessage(error);
      this.append({ kind: 'error', text: message });
      this.notify(message, 'error');
    }
  }

  async cancel(): Promise<void> {
    const id = this.chatId();
    if (!id) {
      return;
    }
    // Show the click immediately; `turn_finished` refreshes the status again.
    this.status.set('stopping…');
    try {
      await bridge().chats.cancel(id);
    } catch (error: unknown) {
      this.status.set(errorMessage(error));
      this.notify('Cancel failed: ' + errorMessage(error), 'error');
    }
  }

  /**
   * Answer the oldest pending host-tool permission request. Denying is safe:
   * the engine reports the denial back to the model and the turn continues.
   */
  async respondToPermission(approved: boolean): Promise<void> {
    const id = this.chatId();
    const request = this.permissionRequest();
    if (!id || request === null) {
      return;
    }
    // Drop it immediately so the buttons cannot be pressed twice.
    this.permissionQueue.update((queue) => queue.filter((entry) => entry.id !== request.id));
    try {
      await bridge().chats.toolPermission(id, request.id, approved);
    } catch (error: unknown) {
      // The usual cause is that the turn was cancelled first, which already
      // denies the request, so the failure is reported softly.
      this.notify('Permission response could not be delivered: ' + errorMessage(error), 'error');
    }
  }

  async deleteChat(): Promise<void> {
    const id = this.chatId();
    if (!id) {
      return;
    }
    this.stopPolling();
    this.chatId.set(null);
    this.currentSettings.set(null);
    this.permissionQueue.set([]);
    this.liveText.set('');
    this.liveThinking.set('');
    this.bubbles.set([]);
    this.status.set('deleted');
    this.busy.set(true);
    try {
      await bridge().chats.remove(id);
      this.notify('Chat deleted.');
    } catch (error: unknown) {
      this.status.set(errorMessage(error));
      this.notify('Delete failed: ' + errorMessage(error), 'error');
    }
    this.busy.set(false);
    void this.loadSavedChats();
  }

  async send(text: string): Promise<void> {
    const id = this.chatId();
    const message = text.trim();
    if (!id || message.length === 0) {
      return;
    }
    this.permissionQueue.set([]);
    this.append({ kind: 'user', text: message });
    this.busy.set(true);
    try {
      await bridge().chats.sendMessage(id, { message });
      this.startPolling();
    } catch (error: unknown) {
      const failure = 'Send failed: ' + errorMessage(error);
      this.append({ kind: 'error', text: failure });
      this.notify(failure, 'error');
      this.busy.set(false);
    }
  }
}
