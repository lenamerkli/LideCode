import { Component, inject, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore } from './chat-store';

/** Sidebar listing the chats persisted on disk. */
@Component({
  selector: 'app-chat-list',
  imports: [MatButtonModule, MatDividerModule, MatIconModule, MatListModule, MatTooltipModule],
  templateUrl: './chat-list.html',
  styleUrl: './chat-list.css',
})
export class ChatList {
  protected readonly store = inject(ChatStore);

  /** Emitted with the id of the chat the user picked. */
  readonly open = output<string>();

  /** Emitted when the user asks for a new chat; the shell owns the dialog. */
  readonly newChat = output<void>();
}
