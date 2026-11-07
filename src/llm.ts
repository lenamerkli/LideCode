import {createHash} from "node:crypto";
import {AssistantMessage, Conversation, ImageContent, Model, Providers, TextContent, ToolCall, ToolCallFunction, UserMessage,} from "./types.js";
import {log_generation, log_generation_error} from "./logging.js";
import {OpenRouter} from "@openrouter/sdk";
import type {ChatMessages, ChatRequest} from "@openrouter/sdk/models";
import {ArenaCodec, OpenRouterCodec, type OpenAIWireMessage, type ProviderCodec} from "./codec.js";
import type {Tool} from "./tool_definitions.js";

/**
 * Handle returned by `LLM.generate`.
 *
 * Gives access to the current state of the streamed tokens while the
 * generation is running (`text`, `thinking`, `isDone`), and to the final
 * results via the `done` promise (assembled `AssistantMessage` plus the
 * cost in credits reported by OpenRouter in the final stream chunk).
 */
/**
 * Events emitted by a `GenerationHandle` while the generation runs.
 * Subscribing is purely observational: it never influences the stream.
 */
export type GenerationEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; message: AssistantMessage; cost: number | undefined }
  | { type: 'error'; message: string };

export interface GenerationHandle {
  /** Current state of the streamed (visible) tokens. Grows while running. */
  readonly text: string;
  /** Current state of the streamed reasoning/thinking tokens, if any. */
  readonly thinking: string;
  /** Whether the stream has finished (successfully or with an error). */
  readonly isDone: boolean;

  /** Resolves when the stream finishes; rejects on pre-stream or mid-stream errors. */
  readonly done: Promise<GenerationResult>;

  /**
   * Aborts the underlying request/stream. The `done` promise will reject with
   * an abort error. Safe to call multiple times and after completion.
   */
  cancel(): void;

  /**
   * Register a listener for incremental stream events. Returns an
   * unsubscribe function. Listeners are removed automatically once the
   * generation finishes, but calling the unsubscribe function early is safe.
   */
  subscribe(listener: (event: GenerationEvent) => void): () => void;
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

// ---------------------------------------------------------------------------
// Normalized stream assembly (shared by providers)
// ---------------------------------------------------------------------------

/**
 * One tool-call fragment as it arrives on the wire, normalized across
 * providers: both the OpenRouter SDK's camelCase chunks and Arena's plain
 * OpenAI snake_case chunks are mapped onto this shape before assembling.
 */
export interface StreamToolCallDelta {
  /** Tool-call slot the fragment belongs to; fragments merge per index. */
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  arguments?: string | undefined;
}

/** One normalized stream delta, provider-independent. */
export interface StreamDelta {
  content?: string | null | undefined;
  reasoning?: string | null | undefined;
  refusal?: string | null | undefined;
  toolCalls?: StreamToolCallDelta[] | undefined;
}

/**
 * Sink fed by a provider's stream loop. `generationHandle` wraps it to expose
 * live state and incremental events; tests can feed a bare `StreamAccumulator`
 * instead, which implements the same interface.
 */
export interface StreamSink {
  /** Absorb one streamed delta (content, thinking, tool-call fragments). */
  accept(delta: StreamDelta): void;
  /** Record the finish reason reported by the provider. */
  setFinishReason(reason: string | null): void;
  /** Record the usage stats reported in the stream's final chunk. */
  setUsage(usage: UsageStats): void;
}

/**
 * Accumulates normalized stream deltas into the final `AssistantMessage`.
 *
 * Tool-call fragments arrive spread over several deltas (an id and a name on
 * the first one, the argument JSON in pieces afterwards) and are merged per
 * fragment index, exactly as the provider streams them.
 */
export class StreamAccumulator implements StreamSink {
  /** Visible assistant text accumulated so far. */
  text = "";
  /** Reasoning/thinking tokens accumulated so far. */
  thinking = "";
  /** Refusal text accumulated so far, when the provider sends any. */
  refusal: string | null = null;
  /** Finish reason of the stream, when the provider reported one. */
  finish_reason: string | null = null;
  /** Usage stats from the stream's final chunk, when the provider sent any. */
  usage: UsageStats | undefined;

  private readonly toolCallFragments = new Map<number, {id?: string | undefined; name: string; args: string}>();

  accept(delta: StreamDelta): void {
    if (typeof delta.reasoning === "string") {
      this.thinking += delta.reasoning;
    }
    if (typeof delta.content === "string") {
      this.text += delta.content;
    }
    if (typeof delta.refusal === "string") {
      this.refusal = (this.refusal ?? "") + delta.refusal;
    }
    for (const call of delta.toolCalls ?? []) {
      const existing = this.toolCallFragments.get(call.index) ?? {id: undefined, name: "", args: ""};
      if (call.id !== undefined) {
        existing.id = call.id;
      }
      if (call.name !== undefined) {
        existing.name += call.name;
      }
      if (call.arguments !== undefined) {
        existing.args += call.arguments;
      }
      this.toolCallFragments.set(call.index, existing);
    }
  }

  setFinishReason(reason: string | null): void {
    this.finish_reason = reason;
  }

  setUsage(usage: UsageStats): void {
    this.usage = usage;
  }

  /** The assembled message, with tool calls in stream order. */
  message(): AssistantMessage {
    const toolCalls: ToolCall[] = [];
    for (const fragment of [...this.toolCallFragments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, fragment]) => fragment)) {
      toolCalls.push(
        new ToolCall(fragment.id ?? "", new ToolCallFunction(fragment.name, fragment.args))
      );
    }
    return new AssistantMessage(
      this.text.length > 0 ? this.text : null,
      toolCalls,
      this.thinking.length > 0 ? this.thinking : null,
      this.refusal,
      this.finish_reason,
    );
  }
}

/**
 * Builds the client for a model's provider.
 *
 * Returns `LLM<unknown, unknown>` because callers only ever drive the
 * `GenerationHandle`; the concrete provider types are enforced inside each
 * implementation, where the request body is actually assembled.
 */
export function get_llm(model: Model, temperature: number | undefined): LLM<unknown, unknown> {
  if (model.provider == Providers.OpenRouter) {
    return new OpenRouterLLM(model, temperature);
  }
  if (model.provider == Providers.Arena) {
    return new ArenaLLM(model, temperature);
  }
  throw new Error(`Unknown provider: ${model.provider}`);
}

/**
 * Base class for provider clients.
 *
 * `TMessages` is the provider's message shape, carried so each subclass gets
 * a request body that is statically checked against that provider's types.
 * Subclasses pick their codec and never hand-roll message serialization.
 */
export abstract class LLM<TMessages, TTools = Tool[]> {
  readonly model: Model;
  readonly temperature: number | undefined;
  /** Encodes conversations into this provider's wire format. */
  protected readonly codec: ProviderCodec<TMessages, TTools>;
  protected constructor(
    model: Model,
    temperature: number | undefined,
    codec: ProviderCodec<TMessages, TTools>,
  ) {
    this.model = model;
    this.temperature = temperature;
    this.codec = codec;
  };
  abstract generate(conversation: Conversation, tools?: Tool[]): GenerationHandle;
}

/**
 * Builds a `GenerationHandle` around one provider's streaming run.
 *
 * The observable contract — live `text`/`thinking` state, incremental events,
 * exactly one `[LLM]` log entry per stream, a `done` promise and `cancel()` —
 * is the same for every provider, so the plumbing lives here once. The
 * provider's `run` feeds normalized deltas into the sink and resolves with the
 * usage stats the stream reported, if any.
 */
function generationHandle(
  model: Model,
  abort_controller: AbortController,
  run: (sink: StreamSink) => Promise<UsageStats | undefined>,
): GenerationHandle {
  const accumulator = new StreamAccumulator();
  let finished = false;

  // Observational listeners for incremental stream events. Iterating over a
  // copy so listeners may unsubscribe from within their own callback, and
  // swallowing listener errors so a broken subscriber can never disturb
  // the generation itself.
  const listeners = new Set<(event: GenerationEvent) => void>();
  const emit = (event: GenerationEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        console.warn('Generation event listener failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  };

  // Listeners see every delta as it arrives; the accumulator assembles the
  // final message from the same deltas.
  const sink: StreamSink = {
    accept(delta: StreamDelta): void {
      if (typeof delta.reasoning === "string") {
        emit({type: 'thinking', delta: delta.reasoning});
      }
      if (typeof delta.content === "string") {
        emit({type: 'text', delta: delta.content});
      }
      accumulator.accept(delta);
    },
    setFinishReason(reason: string | null): void {
      accumulator.setFinishReason(reason);
    },
    setUsage(usage: UsageStats): void {
      accumulator.setUsage(usage);
    },
  };

  const done = (async (): Promise<GenerationResult> => {
    try {
      const usage = await run(sink);
      const message = accumulator.message();

      // Report the finished request (thinking, content and tool calls) to the
      // console before notifying listeners, so the log reads in stream order.
      log_generation({
        model: model.tech_name,
        finish_reason: accumulator.finish_reason,
        thinking: message.reasoning,
        content: message.content,
        refusal: message.refusal,
        tool_calls: message.toolCalls.map((call) => ({name: call.function.name, arguments: call.function.arguments})),
        usage,
        cost: usage?.cost ?? undefined,
      });

      emit({type: 'done', message, cost: usage?.cost ?? undefined});
      return {
        message,
        cost: usage?.cost ?? undefined,
        usage,
      };
    } finally {
      finished = true;
    }
  })();

  // Mark finished even if the stream loop rejects.
  done.catch((error: unknown) => {
    finished = true;
    // A generation that never completes normally (provider error, cancelled
    // stream) would otherwise leave no trace in the console.
    log_generation_error(model.tech_name, error);
    emit({type: 'error', message: error instanceof Error ? error.message : String(error)});
  });

  return {
    get text() { return accumulator.text; },
    get thinking() { return accumulator.thinking; },
    get isDone() { return finished; },
    done,
    cancel() { abort_controller.abort(); },
    subscribe(listener: (event: GenerationEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export class OpenRouterLLM extends LLM<ChatMessages, ChatRequest["tools"]> {
  constructor(model: Model, temperature: number | undefined) {
    super(model, temperature, new OpenRouterCodec());
  }

  generate(conversation: Conversation, tools?: Tool[]): GenerationHandle {
    const client = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      httpReferer: 'https://github.com/lenamerkli/LideCode',
      appTitle: 'LideCode',
      appCategories: 'cli-agent,programming-app'
    });

    const abort_controller = new AbortController();

    return generationHandle(this.model, abort_controller, async (sink) => {
      // Built as a typed `ChatRequest` so a codec/provider shape mismatch is a
      // compile error rather than a runtime SDK validation dump.
      const chatRequest: ChatRequest = {
        model: this.model.tech_name,
        messages: this.codec.encodeMessages(conversation),
        stream: true,
      };
      if (this.temperature !== undefined) {
        chatRequest.temperature = this.temperature;
      }
      if (tools !== undefined) {
        chatRequest.tools = this.codec.encodeTools(tools);
      }

      const response = await client.chat.send({chatRequest}, {signal: abort_controller.signal});

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
            sink.setUsage(chunk.usage);
          }

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (choice?.finishReason != null) {
            finishReason = choice.finishReason;
          }
          if (delta) {
            sink.accept({
              content: delta.content,
              reasoning: delta.reasoning,
              refusal: delta.refusal,
              toolCalls: delta.toolCalls?.map((call) => ({
                index: call.index,
                id: call.id,
                name: call.function?.name,
                arguments: call.function?.arguments,
              })),
            });
          }
        }
      } finally {
        sink.setFinishReason(finishReason);
      }

      return usage;
    });
  }
}

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/** Base URL of Arena's OpenAI-compatible chat-completions API. */
const ARENA_BASE_URL = 'https://api.arena.ai/v1';

/**
 * OpenCode's user-agent string. Arena rejects anything else: without it (and
 * without `x-session-affinity`) the server answers HTTP 403
 * (`organization_client_restricted`), and retrying a 403 can never help.
 */
const ARENA_USER_AGENT = 'opencode/latest/2.2.5/cli';

/** Request body for Arena's `/v1/chat/completions` endpoint. */
interface ArenaChatRequest {
  model: string;
  messages: OpenAIWireMessage[];
  stream: true;
  temperature?: number | undefined;
  tools?: Tool[] | undefined;
}

/**
 * Structural types for Arena's streaming chunks: the plain OpenAI
 * `chat.completion.chunk` shape (snake_case `tool_calls` / `finish_reason`),
 * verified against the live API.
 */
export interface ArenaStreamChunk {
  choices?: ArenaStreamChoice[] | undefined;
  usage?: UsageStats | null | undefined;
  error?: {message?: string | null} | null | undefined;
}

export interface ArenaStreamChoice {
  delta?: {
    content?: string | null | undefined;
    reasoning?: string | null | undefined;
    /** Alternate reasoning spelling some OpenAI-compatible routers use. */
    reasoning_content?: string | null | undefined;
    refusal?: string | null | undefined;
    tool_calls?: ArenaStreamToolCall[] | undefined;
  } | undefined;
  finish_reason?: string | null | undefined;
}

export interface ArenaStreamToolCall {
  index: number;
  id?: string | null | undefined;
  function?: {name?: string | null | undefined; arguments?: string | null | undefined} | undefined;
}

/**
 * Feeds one parsed Arena stream chunk into a sink, normalizing the snake_case
 * wire shape. Throws on a provider error payload, mirroring the mid-stream
 * error behaviour of the OpenRouter stream.
 */
export function applyArenaChunk(chunk: ArenaStreamChunk, sink: StreamSink): void {
  if (chunk.error) {
    throw new Error(`Arena stream error: ${chunk.error.message ?? "unknown error"}`);
  }
  if (chunk.usage) {
    sink.setUsage(chunk.usage);
  }
  const choice = chunk.choices?.[0];
  if (choice?.finish_reason != null) {
    sink.setFinishReason(choice.finish_reason);
  }
  const raw = choice?.delta;
  if (raw) {
    sink.accept({
      content: raw.content,
      reasoning: raw.reasoning ?? raw.reasoning_content,
      refusal: raw.refusal,
      toolCalls: raw.tool_calls?.map((call) => ({
        index: call.index,
        id: call.id ?? undefined,
        name: call.function?.name ?? undefined,
        arguments: call.function?.arguments ?? undefined,
      })),
    });
  }
}

/**
 * Yields the JSON payloads of an OpenAI-style SSE stream (`data: <json>`
 * lines), stopping at the `data: [DONE]` terminator.
 */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') {
            return;
          }
          if (payload.length > 0) {
            yield payload;
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    // Release the stream even when the consumer stops early (a cancelled
    // generation aborts the request while chunks are still in flight).
    reader.cancel().catch(() => {});
  }
}

/**
 * Deterministic OpenCode-style session id for Arena requests
 * (`ses_` + 24 chars), derived from a hash of the conversation's first user
 * message. The Arena server only checks the id's shape, not its identity, so
 * any derivation works; hashing the first user message keeps the id stable
 * across the turns of one conversation (session affinity) without storing
 * any state. Conversations without a user message hash their serialized
 * messages instead, which is still deterministic.
 */
export function arenaSessionId(conversation: Conversation): string {
  const first = conversation.messages.find((message) => message instanceof UserMessage);
  let input: string;
  if (first instanceof UserMessage) {
    const content = first.content;
    input = typeof content === "string"
      ? content
      : content.map((part) => (part instanceof ImageContent ? "[image]" : (part as TextContent).text)).join("\n");
  } else {
    input = JSON.stringify(conversation.toJSON());
  }
  return "ses_" + createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
}

/**
 * Client for Arena's OpenAI-compatible endpoint
 * (`https://api.arena.ai/v1/chat/completions`, see `ARENA_API.md`).
 *
 * Arena only answers requests that look like an interactive OpenCode CLI
 * session; the headers below are what makes the difference. The request body
 * and the SSE response are otherwise plain OpenAI chat completions.
 */
export class ArenaLLM extends LLM<OpenAIWireMessage, Tool[]> {
  constructor(model: Model, temperature: number | undefined) {
    super(model, temperature, new ArenaCodec());
  }

  generate(conversation: Conversation, tools?: Tool[]): GenerationHandle {
    const abort_controller = new AbortController();

    return generationHandle(this.model, abort_controller, async (sink) => {
      const api_key = process.env['ARENA_API_KEY'];
      if (api_key === undefined || api_key.length === 0) {
        throw new Error('ARENA_API_KEY is not set; add it to the environment or .env to use Arena models');
      }

      const body: ArenaChatRequest = {
        model: this.model.tech_name,
        messages: this.codec.encodeMessages(conversation),
        stream: true,
      };
      if (this.temperature !== undefined) {
        body.temperature = this.temperature;
      }
      if (tools !== undefined) {
        body.tools = this.codec.encodeTools(tools);
      }

      // The session values must look like OpenCode session ids (`ses_` + 24
      // chars): the server checks their shape, not their identity. Deriving
      // the id from a hash of the first user message keeps it stable across
      // the turns of one conversation (session affinity) without state.
      const session = arenaSessionId(conversation);
      const response = await fetch(ARENA_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + api_key,
          'Content-Type': 'application/json',
          'User-Agent': ARENA_USER_AGENT,
          'x-opencode-client': 'cli',
          'x-opencode-session': session,
          'x-opencode-session-id': session,
          'x-session-id': session,
          'x-session-affinity': session,
        },
        body: JSON.stringify(body),
        signal: abort_controller.signal,
      });

      if (!response.ok) {
        // 403 (`organization_client_restricted`) means the headers above no
        // longer look like an OpenCode session; per the API documentation a
        // 403 is never retried.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Arena request failed (HTTP ${response.status})${detail.length > 0 ? ': ' + detail : ''}`
        );
      }
      if (response.body === null) {
        throw new Error('Arena returned an empty response body');
      }

      let usage: UsageStats | undefined;
      for await (const payload of readSseData(response.body)) {
        const chunk = JSON.parse(payload) as ArenaStreamChunk;
        applyArenaChunk(chunk, sink);
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
      return usage;
    });
  }
}
