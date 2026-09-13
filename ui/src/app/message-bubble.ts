import { Component, input } from '@angular/core';
import type { Bubble } from './chat-store';

/** A single committed conversation message. */
@Component({
  selector: 'app-message-bubble',
  imports: [],
  templateUrl: './message-bubble.html',
  styleUrl: './message-bubble.css',
})
export class MessageBubble {
  readonly bubble = input.required<Bubble>();
}
