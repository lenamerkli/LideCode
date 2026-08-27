import {AssistantMessage, Conversation, Model, Providers, ToolCall, ToolCallFunction,} from "./types";
import {OpenRouter} from "@openrouter/sdk";

/**
 * Handle returned by `LLM.generate`.
 *
 * Gives access to the current state of the streamed tokens while the
 * generation is running (`text`, `thinking`, `isDone`), and to the final
 * results via the `done` promise (assembled `AssistantMessage` plus the
 * cost in credits reported by OpenRouter in the final stream chunk).
 */
export interface GenerationHandle {
  /** Current state of the streamed (visible) tokens. Grows while running. */
  readonly text: string;
  /** Current state of the streamed reasoning/thinking tokens, if any. */
  readonly thinking: string;
  /** Whether the stream has finished (successfully or with an error). */
  readonly isDone: boolean;

  /** Resolves when the stream finishes; rejects on pre-stream or mid-stream errors. */
  readonly done: Promise<GenerationResult>;
}

export interface GenerationResult {
  /** Fully assembled assistant message (content, tool calls, reasoning, ...). */
  readonly message: AssistantMessage;
  /** Cost in credits, from `usage.cost` of the final stream chunk. Undefined if not reported. */
  readonly cost: number | undefined;
  /** Raw usage stats from the final stream chunk, if present. */
  readonly usage: UsageStats | undefined;
}

export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number | null;
}

/** Minimal structural types for the OpenRouter streaming chunks we consume. */
interface StreamToolCall {
  index: number;
  id?: string;
  function?: {name?: string; arguments?: string};
}

interface StreamChoice {
  delta: {content?: string | null; reasoning?: string | null; refusal?: string | null; toolCalls?: StreamToolCall[]};
  finishReason: string | null;
}

interface StreamChunk {
  choices: StreamChunkChoice[];
  usage?: UsageStats | null;
  error?: {message?: string} | null;
}

type StreamChunkChoice = StreamChoice;

export function get_llm_class(model: Model): typeof LLM {
  if (model.provider == Providers.OpenRouter) {
    return OpenRouterLLM;
  }
  throw new Error(`Unknown provider: ${model.provider}`);
}

export abstract class LLM {
  readonly model: Model;
  readonly temperature: number | undefined;
  protected constructor(model: Model, temperature: number | undefined) {
    this.model = model;
    this.temperature = temperature;
  };
  abstract generate(conversation: Conversation, tools?: any): GenerationHandle;
}

export class OpenRouterLLM extends LLM {
  constructor(model: Model, temperature: number | undefined) {
    super(model, temperature);
  }

  generate(conversation: Conversation, tools?: any): GenerationHandle {
    const client = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      httpReferer: 'https://github.com/lenamerkli/LideCode',
      appTitle: 'LideCode',
      appCategories: 'cli-agent,programming-app'
    });

    // --- Live state exposed through the handle -----------------------------
    let text = "";
    let thinking = "";
    let refusal: string | null = null;
    let finished = false;

    // Tool-call fragments, accumulated per tool-call index.
    const toolCallFragments = new Map<number, {id?: string | undefined; name: string; args: string}>();

    const done = (async (): Promise<GenerationResult> => {
      const chatRequest: Record<string, unknown> = {
        model: this.model.tech_name,
        // Message `toJSON()` already produces the OpenAI wire format.
        messages: conversation.messages.map((message) => message.toJSON()),
        stream: true,
      };
      if (this.temperature !== undefined) {
        chatRequest["temperature"] = this.temperature;
      }
      if (tools !== undefined) {
        chatRequest["tools"] = tools;
      }

      const response = await client.chat.send({chatRequest} as never);

      // With `stream: true` the SDK returns an EventStream of chunks.
      const stream = response as unknown as AsyncIterable<StreamChunk>;

      let usage: UsageStats | undefined;
      let finishReason: string | null = null;

      try {
        for await (const chunk of stream) {
          // Mid-stream error: reject with the provider error message.
          if (chunk.error) {
            throw new Error(
              `OpenRouter stream error: ${chunk.error.message ?? "unknown error"}`
            );
          }

          // Final chunk before [DONE]: usage stats (incl. cost), empty choices.
          if (chunk.usage) {
            usage = chunk.usage;
          }

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (choice?.finishReason != null) {
            finishReason = choice.finishReason;
          }
          if (delta) {
            if (typeof delta.reasoning === "string") {
              thinking += delta.reasoning;
            }
            if (typeof delta.content === "string") {
              text += delta.content;
            }
            if (typeof delta.refusal === "string") {
              refusal = (refusal ?? "") + delta.refusal;
            }
            for (const call of delta.toolCalls ?? []) {
              const existing = toolCallFragments.get(call.index) ?? {id: undefined, name: "", args: ""};
              if (call.id !== undefined) {
                existing.id = call.id;
              }
              if (call.function?.name !== undefined) {
                existing.name += call.function.name;
              }
              if (call.function?.arguments !== undefined) {
                existing.args += call.function.arguments;
              }
              toolCallFragments.set(call.index, existing);
            }
          }
        }
      } finally {
        finished = true;
      }

      // Assemble tool calls in stream order.
      const toolCalls: ToolCall[] = [];
      for (const fragment of [...toolCallFragments.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, fragment]) => fragment)) {
        toolCalls.push(
          new ToolCall(fragment.id ?? "", new ToolCallFunction(fragment.name, fragment.args))
        );
      }

      const message = new AssistantMessage(
        text.length > 0 ? text : null,
        toolCalls,
        thinking.length > 0 ? thinking : null,
        refusal,
        finishReason,
      );

      return {
        message,
        cost: usage?.cost ?? undefined,
        usage,
      };
    })();

    // Mark finished even if the stream loop rejects.
    done.catch(() => { finished = true; });

    return {
      get text() { return text; },
      get thinking() { return thinking; },
      get isDone() { return finished; },
      done,
    };
  }
}
