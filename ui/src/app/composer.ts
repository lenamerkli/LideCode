import { Component, input, output, signal } from '@angular/core';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

/** Message composer: autosizing textarea plus a send button. */
@Component({
  selector: 'app-composer',
  imports: [
    CdkTextareaAutosize,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
  templateUrl: './composer.html',
  styleUrl: './composer.css',
})
export class Composer {
  /** True while a generation is running or when no chat is open. */
  readonly disabled = input(false);

  /** Emitted with the trimmed message text. */
  readonly send = output<string>();

  protected readonly draft = signal('');

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
    }
  }

  protected canSend(): boolean {
    return !this.disabled() && this.draft().trim().length > 0;
  }

  private submit(): void {
    const text = this.draft().trim();
    if (!this.canSend() || text.length === 0) {
      return;
    }
    this.draft.set('');
    this.send.emit(text);
  }
}
