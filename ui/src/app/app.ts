import { Component, OnInit, inject, signal } from '@angular/core';
import { ChatStore } from './chat-store';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  protected readonly store = inject(ChatStore);
  protected readonly draft = signal('');

  ngOnInit(): void {
    void this.store.init();
  }

  protected onModelChange(event: Event): void {
    this.store.selectedModel.set((event.target as HTMLSelectElement).value);
  }

  protected onProjectInput(event: Event): void {
    this.store.projectName.set((event.target as HTMLInputElement).value);
  }

  /** Open a chat persisted on disk (its container starts on the next send). */
  protected openChat(id: string): void {
    void this.store.openChat(id);
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submitDraft();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      this.submitDraft();
    }
  }

  private submitDraft(): void {
    const text = this.draft();
    this.draft.set('');
    void this.store.send(text);
  }
}
