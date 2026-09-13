import { Component, ElementRef, effect, inject, output, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatStore } from './chat-store';
import { Composer } from './composer';
import { MessageBubble } from './message-bubble';

/** Conversation transcript plus the composer. */
@Component({
  selector: 'app-chat-view',
  imports: [Composer, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MessageBubble],
  templateUrl: './chat-view.html',
  styleUrl: './chat-view.css',
})
export class ChatView {
  protected readonly store = inject(ChatStore);

  /** Emitted when the user asks for a new chat; the shell owns the dialog. */
  readonly newChat = output<void>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Keep the transcript pinned to the bottom while text streams in.
    effect(() => {
      void this.store.bubbles();
      void this.store.liveText();
      void this.store.liveThinking();
      void this.store.permissionRequest();
      void this.store.chatId();
      setTimeout(() => this.scrollToBottom());
    });
  }

  protected send(text: string): void {
    void this.store.send(text);
  }

  protected approvePermission(): void {
    void this.store.respondToPermission(true);
  }

  protected denyPermission(): void {
    void this.store.respondToPermission(false);
  }

  private scrollToBottom(): void {
    const element = this.scroller()?.nativeElement;
    if (element !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
