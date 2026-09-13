import { Component, OnInit, effect, inject } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { Settings } from '../../../shared/contract';
import { ChatList } from './chat-list';
import { ChatView } from './chat-view';
import { ChatStore } from './chat-store';
import { ConfirmDialog, type ConfirmDialogData } from './confirm-dialog';
import { registerIcons } from './icons';
import { NewChatDialog, type NewChatDialogData, type NewChatDialogResult } from './new-chat-dialog';
import { SettingsDialog, type SettingsDialogData } from './settings-dialog';

/**
 * Application shell: toolbar, chat sidebar, conversation and the dialogs.
 *
 * All state lives in `ChatStore`; this component only wires inputs, dialogs and
 * the snack bar together.
 */
@Component({
  selector: 'app-root',
  imports: [
    ChatList,
    ChatView,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatSidenavModule,
    MatToolbarModule,
    MatTooltipModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly store = inject(ChatStore);

  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly iconRegistry = inject(MatIconRegistry);
  private readonly sanitizer = inject(DomSanitizer);

  constructor() {
    registerIcons(this.iconRegistry, this.sanitizer);

    // Surface transient store notices (errors, confirmations) as a snack bar.
    effect(() => {
      const notice = this.store.notice();
      if (notice === null) {
        return;
      }
      this.snackBar.open(notice.message, 'Dismiss', {
        duration: notice.kind === 'error' ? 8000 : 4000,
        panelClass: notice.kind === 'error' ? 'notice-error' : 'notice-info',
      });
    });
  }

  ngOnInit(): void {
    void this.store.init();
  }

  protected openChat(id: string): void {
    void this.store.openChat(id);
  }

  protected confirmDelete(): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
        data: {
          title: 'Delete chat?',
          message:
            'The chat and its persisted transcript are removed, and its sandbox container is stopped.',
          confirmLabel: 'Delete',
          destructive: true,
        },
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed === true) {
          void this.store.deleteChat();
        }
      });
  }

  protected openNewChat(): void {
    if (this.store.busy()) {
      return;
    }
    this.dialog
      .open<NewChatDialog, NewChatDialogData, NewChatDialogResult>(NewChatDialog, {
        width: '34rem',
        data: {
          models: this.store.models(),
          defaultModel: this.store.selectedModel(),
          defaultProjectName: this.store.projectName(),
          defaultAllowWeb: true,
          defaultHostTools: true,
        },
      })
      .afterClosed()
      .subscribe((options) => {
        if (options !== undefined) {
          void this.store.createChat(options);
        }
      });
  }

  protected openSettings(): void {
    this.dialog
      .open<SettingsDialog, SettingsDialogData, Settings>(SettingsDialog, {
        width: '34rem',
        data: { settings: this.store.settings(), models: this.store.models() },
      })
      .afterClosed()
      .subscribe((settings) => {
        if (settings !== undefined) {
          void this.store.saveSettings(settings);
        }
      });
  }
}
