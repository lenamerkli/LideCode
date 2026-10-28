/**
 * Provider transport codecs.
 *
 * A codec turns the internal message model into the exact JSON shape one
 * provider's API expects. This is deliberately separate from
 * `Message.toJSON()`, which is the *persistence* format: the two are not the
 * same shape and must not be conflated.
 *
 * That distinction is not academic. `toJSON()` emits the OpenAI wire format
 * (snake_case `image_url` / `tool_calls` / `tool_call_id`), which is what
 * saved chats on disk and the IPC contract in `shared/contract.ts` carry. The
 * OpenRouter SDK, however, validates `chatRequest.messages` against
 * `ChatMessages$outboundSchema` *before* sending, and that schema expects the
 * SDK's own camelCase spelling (`imageUrl` / `toolCalls` / `toolCallId`),
 * which it remaps to snake_case itself on the way out. Feeding wire format
 * into the SDK therefore fails validation on images and — because Zod is
 * non-strict — silently *drops* `tool_calls`, so the model would never see its
 * own tool calls.
 *
 * Adding a provider means adding a codec, not touching `types.ts`.
 */

import type {
  ChatAssistantMessage,
  ChatContentItems,
  ChatContentText,
  ChatMessages,
  ChatRequest,
  ChatToolMessage,
  ChatUserMessage,
} from "@openrouter/sdk/models";
import {
  AssistantMessage,
  type Content,
  type Conversation,
  ImageContent,
  type Message,
  SystemMessage,
  TextContent,
  ToolMessage,
  UserMessage,
} from "./types.js";
import type { Tool } from "./tool_definitions.js";

/**
 * Encodes conversations and tool definitions for one provider.
 *
 * `TMessages` and `TTools` are the provider's message and tool types.
 * Parameterizing them means a codec's output is checked against the provider's
 * real types, so a shape mismatch becomes a compile error instead of a runtime
 * validation dump.
 */
export interface ProviderCodec<TMessages, TTools = Tool[]> {
  /** Human-readable provider name, used in error messages. */
  readonly name: string;

  /** Encodes a whole conversation into the provider's `messages` array. */
  encodeMessages(conversation: Conversation): TMessages[];

  /**
   * Encodes tool definitions into the provider's `tools` array.
   *
   * Tool definitions are already in the OpenAI function-tool shape, which
   * every provider here accepts unchanged, so both codecs pass them through.
   * It is a method rather than an inline pass-through so a provider with a
   * different tool schema (Anthropic's `input_schema`, for example) can
   * override it without touching the callers.
   */
  encodeTools(tools: Tool[]): TTools;
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

/**
 * Codec for the OpenRouter SDK.
 *
 * Mirrors the SDK's expected camelCase input exactly. The return type is the
 * SDK's own `ChatMessages`, so `npm run typecheck` rejects any future drift
 * (for example emitting `image_url` here) at build time.
 */
export class OpenRouterCodec implements ProviderCodec<ChatMessages, ChatRequest["tools"]> {
  readonly name = "openrouter";

  encodeMessages(conversation: Conversation): ChatMessages[] {
    return conversation.messages.map((message) => this.encodeMessage(message));
  }

  encodeTools(tools: Tool[]): ChatRequest["tools"] {
    return tools;
  }

  private encodeMessage(message: Message): ChatMessages {
    if (message instanceof SystemMessage) {
      return {
        role: "system",
        content: encodeSystemContent(message.content),
      };
    }

    if (message instanceof UserMessage) {
      const encoded: ChatUserMessage = {
        role: "user",
        content: encodeUserContent(message.content),
      };
      if (message.name !== undefined) {
        encoded.name = message.name;
      }
      return encoded;
    }

    if (message instanceof AssistantMessage) {
      const encoded: ChatAssistantMessage = {
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        })),
      };
      if (message.reasoning !== null) {
        encoded.reasoning = message.reasoning;
      }
      if (message.refusal !== null) {
        encoded.refusal = message.refusal;
      }
      return encoded;
    }

    if (message instanceof ToolMessage) {
      const encoded: ChatToolMessage = {
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
      };
      return encoded;
    }

    throw new Error(`Cannot encode a message with unknown role "${String((message as Message).role)}"`);
  }
}

/**
 * System messages accept text parts only (`ChatSystemMessageContent` is
 * `string | ChatContentText[]`), so an image here is a programming error
 * rather than something to silently drop.
 */
function encodeSystemContent(content: Content): string | ChatContentText[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part instanceof ImageContent) {
      throw new Error("System messages cannot contain images");
    }
    return { type: "text", text: (part as TextContent).text };
  });
}

/** User messages accept any content part, including images. */
function encodeUserContent(content: Content): string | ChatContentItems[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): ChatContentItems => {
    if (part instanceof ImageContent) {
      // `imageUrl`, not `image_url`: the SDK remaps this to the wire format.
      return { type: "image_url", imageUrl: { url: part.dataUrl } };
    }
    return { type: "text", text: (part as TextContent).text };
  });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (llama.cpp, OpenAI)
// ---------------------------------------------------------------------------

/** One message in the OpenAI Chat Completions wire format. */
export interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIWireContentPart[] | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning?: string;
  refusal?: string;
}

/** One content part in the OpenAI Chat Completions wire format. */
export type OpenAIWireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Codec for any OpenAI Chat Completions-compatible endpoint (llama.cpp's
 * `/v1/chat/completions`, OpenAI itself).
 *
 * These endpoints do not validate requests, so this codec is the one place
 * that has to get the shape right by construction. It is deliberately the
 * inverse of `Message.toJSON()`'s persistence shape, which is why the two
 * cannot be shared: persistence uses `toolCallId`, the wire uses
 * `tool_call_id`.
 */
export class OpenAICompatibleCodec implements ProviderCodec<OpenAIWireMessage, Tool[]> {
  readonly name = "openai-compatible";

  encodeMessages(conversation: Conversation): OpenAIWireMessage[] {
    return conversation.messages.map((message) => this.encodeMessage(message));
  }

  encodeTools(tools: Tool[]): Tool[] {
    return tools;
  }

  private encodeMessage(message: Message): OpenAIWireMessage {
    if (message instanceof SystemMessage) {
      return { role: "system", content: this.encodeContent(message.content) };
    }

    if (message instanceof UserMessage) {
      const encoded: OpenAIWireMessage = {
        role: "user",
        content: this.encodeContent(message.content),
      };
      if (message.name !== undefined) {
        encoded.name = message.name;
      }
      return encoded;
    }

    if (message instanceof AssistantMessage) {
      const encoded: OpenAIWireMessage = {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        })),
      };
      if (message.reasoning !== null) {
        encoded.reasoning = message.reasoning;
      }
      if (message.refusal !== null) {
        encoded.refusal = message.refusal;
      }
      return encoded;
    }

    if (message instanceof ToolMessage) {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    throw new Error(`Cannot encode a message with unknown role "${String((message as Message).role)}"`);
  }

  private encodeContent(content: Content): string | OpenAIWireContentPart[] {
    if (typeof content === "string") {
      return content;
    }
    return content.map((part) => {
      if (part instanceof ImageContent) {
        return { type: "image_url", image_url: { url: part.dataUrl } };
      }
      return { type: "text", text: (part as TextContent).text };
    });
  }
}

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/**
 * Codec for Arena's OpenAI-compatible endpoint (`https://api.arena.ai/v1`).
 *
 * The wire shape is the same snake_case OpenAI format that
 * `OpenAICompatibleCodec` emits, but Arena's request schema is the *standard*
 * chat-completions message shape only. The non-standard `reasoning` and
 * `refusal` fields that the shared codec carries are stripped here, so a
 * strict upstream can never reject the request for unknown message fields
 * (and the model's own reasoning is not replayed back to it as non-standard
 * input either).
 */
export class ArenaCodec implements ProviderCodec<OpenAIWireMessage, Tool[]> {
  readonly name = "arena";
  private readonly inner = new OpenAICompatibleCodec();

  encodeMessages(conversation: Conversation): OpenAIWireMessage[] {
    return this.inner.encodeMessages(conversation).map((message) => {
      const encoded: OpenAIWireMessage = { ...message };
      delete encoded.reasoning;
      delete encoded.refusal;
      return encoded;
    });
  }

  encodeTools(tools: Tool[]): Tool[] {
    return this.inner.encodeTools(tools);
  }
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * A `tool` message is only meaningful as the answer to a specific tool call.
 *
 * This invariant is what the OpenRouter `tool_calls` bug violated: the field
 * was stripped, so the request still validated and still parsed, but every
 * `tool` message became an orphan. Cheap to check, and it catches the whole
 * family of serialization bugs rather than one instance of it.
 */
export function findOrphanToolMessages(messages: readonly Message[]): string[] {
  const answered = new Set<string>();
  const orphans: string[] = [];

  for (const message of messages) {
    if (message instanceof AssistantMessage) {
      for (const call of message.toolCalls) {
        answered.add(call.id);
      }
      continue;
    }
    if (message instanceof ToolMessage && !answered.has(message.toolCallId)) {
      orphans.push(message.toolCallId);
    }
  }

  return orphans;
}
