/**
 * Internal message types, modelled after the OpenAI Chat Completions API
 * schema (which OpenRouter normalizes to), so that messages can be sent to
 * the API with minimal transformation.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export enum Providers {
  OpenRouter = "openrouter",
  OpenAI = "openai",
  Anthropic = "anthropic",
  LLamaCPP = "llamacpp",
}


// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

export class TextContent {
  private _text: string;

  constructor(text: string) {
    this._text = text;
  }

  /** Rebuild a text part from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): TextContent {
    return new TextContent(typeof value["text"] === "string" ? value["text"] : "");
  }

  toString(): string {
    return `TextContent(text=${this.text})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      type: "text",
      text: this.text,
    };
  }

  get text(): string {
    return this._text;
  }

  set text(text: string) {
    this._text = text;
  }
}

export class ImageContent {
  private _content: Uint8Array;

  constructor(content: Uint8Array) {
    this._content = content;
  }

  /**
   * Rebuild an image part from its `toJSON()` representation, decoding the
   * `data:<mime>;base64,<payload>` URL back into raw bytes.
   */
  static fromJSON(value: Record<string, unknown>): ImageContent {
    const imageUrl = value["image_url"];
    let url = "";
    if (typeof imageUrl === "object" && imageUrl !== null && !Array.isArray(imageUrl)) {
      const candidate = (imageUrl as Record<string, unknown>)["url"];
      if (typeof candidate === "string") {
        url = candidate;
      }
    } else if (typeof imageUrl === "string") {
      url = imageUrl;
    }
    const comma = url.indexOf(",");
    const payload = comma === -1 ? url : url.slice(comma + 1);
    return new ImageContent(new Uint8Array(Buffer.from(payload, "base64")));
  }

  toString(): string {
    return `ImageContent(content=${this.content})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      type: "image_url",
      image_url: {
        url: `data:${this.getMime()};base64,${this.toBase64()}`,
      },
    };
  }

  private getMime(): string {
    const content = this.content;

    // PNG
    if (
      content.length >= 8 &&
      content[0] === 0x89 && content[1] === 0x50 &&
      content[2] === 0x4e && content[3] === 0x47
    ) {
      return "image/png";
    }

    // JPEG
    if (
      content.length >= 3 &&
      content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
    ) {
      return "image/jpeg";
    }

    // GIF
    if (
      content.length >= 6 &&
      content[0] === 0x47 && content[1] === 0x49 && content[2] === 0x46
    ) {
      return "image/gif";
    }

    // WebP: RIFF....WEBP
    if (
      content.length >= 12 &&
      content[0] === 0x52 && content[1] === 0x49 &&
      content[2] === 0x46 && content[3] === 0x46 &&
      content[8] === 0x57 && content[9] === 0x45 &&
      content[10] === 0x42 && content[11] === 0x50
    ) {
      return "image/webp";
    }

    return "image/png";
  }

  private toBase64(): string {
    return Buffer.from(this.content).toString("base64");
  }

  get content(): Uint8Array {
    return this._content;
  }

  set content(content: Uint8Array) {
    this._content = content;
  }
}

/** A single content part of a multimodal message. */
export type ContentPart = TextContent | ImageContent;

/**
 * Message content: either a plain string or a list of typed content parts
 * (same as the OpenAI `content` field).
 */
export type Content = string | ContentPart[];

/** Rebuild a single content part from its serialized form. */
function deserializeContentPart(value: unknown): ContentPart {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const part = value as Record<string, unknown>;
    if (part["type"] === "image_url") {
      return ImageContent.fromJSON(part);
    }
    if (part["type"] === "text") {
      return TextContent.fromJSON(part);
    }
  }
  // Unknown part shapes degrade to empty text rather than failing the load.
  return new TextContent("");
}

/** Rebuild `Content` (string or content parts) from its serialized form. */
export function deserializeContent(value: unknown): Content {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => deserializeContentPart(part));
  }
  return "";
}


// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export class ToolCall {
  private _id: string;
  private readonly _type: "function";
  private _function: ToolCallFunction;

  constructor(id: string, fn: ToolCallFunction) {
    this._id = id;
    this._type = "function";
    this._function = fn;
  }

  /** Rebuild a tool call from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): ToolCall {
    const serializedFn = value["function"];
    const fn = typeof serializedFn === "object" && serializedFn !== null && !Array.isArray(serializedFn)
      ? serializedFn as Record<string, unknown>
      : {};
    return new ToolCall(
      typeof value["id"] === "string" ? value["id"] : "",
      ToolCallFunction.fromJSON(fn),
    );
  }

  toString(): string {
    return `ToolCall(id=${this.id}, type=${this.type}, function=${this.function})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      type: this.type,
      function: this.function.toJSON(),
    };
  }

  get id(): string {
    return this._id;
  }

  set id(id: string) {
    this._id = id;
  }

  get type(): "function" {
    return this._type;
  }

  get function(): ToolCallFunction {
    return this._function;
  }

  set function(fn: ToolCallFunction) {
    this._function = fn;
  }
}

export class ToolCallFunction {
  private _name: string;
  /** Function arguments as a JSON string (as in the OpenAI API). */
  private _arguments: string;

  constructor(name: string, args: string) {
    this._name = name;
    this._arguments = args;
  }

  /** Rebuild a tool-call function from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): ToolCallFunction {
    return new ToolCallFunction(
      typeof value["name"] === "string" ? value["name"] : "",
      typeof value["arguments"] === "string" ? value["arguments"] : "",
    );
  }

  toString(): string {
    return `ToolCallFunction(name=${this.name}, arguments=${this.arguments})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      arguments: this.arguments,
    };
  }

  /** Parsed arguments object. */
  get parsedArguments(): Record<string, unknown> {
    try {
      return JSON.parse(this.arguments || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  get name(): string {
    return this._name;
  }

  set name(name: string) {
    this._name = name;
  }

  get arguments(): string {
    return this._arguments;
  }

  set arguments(args: string) {
    this._arguments = args;
  }
}


// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export class SystemMessage {
  readonly role: Role = "system";
  private _content: Content;

  constructor(content: Content) {
    this._content = content;
  }

  /** Rebuild a system message from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): SystemMessage {
    return new SystemMessage(deserializeContent(value["content"]));
  }

  toString(): string {
    return `SystemMessage(content=${this.content})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      role: "system",
      content: normalizeContent(this.content),
    };
  }

  get content(): Content {
    return this._content;
  }

  set content(content: Content) {
    this._content = content;
  }
}

export class UserMessage {
  readonly role: Role = "user";
  private _content: Content;
  private _name?: string | undefined;

  constructor(content: Content, name?: string | undefined) {
    this._content = content;
    this._name = name;
  }

  /** Rebuild a user message from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): UserMessage {
    return new UserMessage(
      deserializeContent(value["content"]),
      typeof value["name"] === "string" ? value["name"] : undefined,
    );
  }

  toString(): string {
    return `UserMessage(content=${this.content}, name=${this.name})`;
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      role: "user",
      content: normalizeContent(this.content),
    };
    if (this.name !== undefined) {
      json["name"] = this.name;
    }
    return json;
  }

  get content(): Content {
    return this._content;
  }

  set content(content: Content) {
    this._content = content;
  }

  get name(): string | undefined {
    return this._name;
  }

  set name(name: string | undefined) {
    this._name = name;
  }
}

export class AssistantMessage {
  readonly role: Role = "assistant";
  private _content: string | null;
  private _reasoning: string | null;
  private _toolCalls: ToolCall[];
  private _refusal: string | null;
  private _finishReason: string | null;

  constructor(
    content: string | null,
    toolCalls: ToolCall[] = [],
    reasoning: string | null = null,
    refusal: string | null = null,
    finishReason: string | null = null,
  ) {
    this._content = content;
    this._toolCalls = toolCalls;
    this._reasoning = reasoning;
    this._refusal = refusal;
    this._finishReason = finishReason;
  }

  /** Rebuild an assistant message from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): AssistantMessage {
    const rawToolCalls = value["tool_calls"];
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls
          .filter((call): call is Record<string, unknown> =>
            typeof call === "object" && call !== null && !Array.isArray(call))
          .map((call) => ToolCall.fromJSON(call))
      : [];
    return new AssistantMessage(
      typeof value["content"] === "string" ? value["content"] : null,
      toolCalls,
      typeof value["reasoning"] === "string" ? value["reasoning"] : null,
      typeof value["refusal"] === "string" ? value["refusal"] : null,
      typeof value["finish_reason"] === "string" ? value["finish_reason"] : null,
    );
  }

  toString(): string {
    return `AssistantMessage(content=${this.content}, tool_calls=${this.toolCalls}, reasoning=${this.reasoning})`;
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      role: "assistant",
      content: this.content,
      tool_calls: this.toolCalls.map((call) => call.toJSON()),
    };
    if (this.reasoning !== null) {
      json["reasoning"] = this.reasoning;
    }
    if (this.refusal !== null) {
      json["refusal"] = this.refusal;
    }
    return json;
  }

  get content(): string | null {
    return this._content;
  }

  set content(content: string | null) {
    this._content = content;
  }

  get reasoning(): string | null {
    return this._reasoning;
  }

  set reasoning(reasoning: string | null) {
    this._reasoning = reasoning;
  }

  get toolCalls(): ToolCall[] {
    return this._toolCalls;
  }

  set toolCalls(toolCalls: ToolCall[]) {
    this._toolCalls = toolCalls;
  }

  get refusal(): string | null {
    return this._refusal;
  }

  set refusal(refusal: string | null) {
    this._refusal = refusal;
  }

  get finishReason(): string | null {
    return this._finishReason;
  }

  set finishReason(finishReason: string | null) {
    this._finishReason = finishReason;
  }
}

export class ToolMessage {
  readonly role: Role = "tool";
  private _toolCallId: string;
  private _content: string;

  constructor(toolCallId: string, content: string) {
    this._toolCallId = toolCallId;
    this._content = content;
  }

  /**
   * Rebuild a tool message from its serialized form. Accepts both the current
   * `toolCallId` field and the legacy `tool_call_id` spelling.
   */
  static fromJSON(value: Record<string, unknown>): ToolMessage {
    const id = value["toolCallId"] ?? value["tool_call_id"];
    return new ToolMessage(
      typeof id === "string" ? id : "",
      typeof value["content"] === "string" ? value["content"] : "",
    );
  }

  toString(): string {
    return `ToolMessage(tool_call_id=${this.toolCallId}, content=${this.content})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      role: "tool",
      toolCallId: this.toolCallId,
      content: this.content,
    };
  }

  get toolCallId(): string {
    return this._toolCallId;
  }

  set toolCallId(toolCallId: string) {
    this._toolCallId = toolCallId;
  }

  get content(): string {
    return this._content;
  }

  set content(content: string) {
    this._content = content;
  }
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Rebuild a message from its serialized form, dispatching on `role`. Unknown
 * roles are surfaced as an error so a corrupted file cannot silently drop
 * messages from a restored conversation.
 */
export function deserializeMessage(value: unknown): Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Cannot deserialize a message that is not an object");
  }
  const message = value as Record<string, unknown>;
  switch (message["role"]) {
    case "system":
      return SystemMessage.fromJSON(message);
    case "user":
      return UserMessage.fromJSON(message);
    case "assistant":
      return AssistantMessage.fromJSON(message);
    case "tool":
      return ToolMessage.fromJSON(message);
    default:
      throw new Error(`Cannot deserialize a message with unknown role "${String(message["role"])}"`);
  }
}


// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export class Conversation {
  private _messages: Message[];

  constructor(messages: Message[]) {
    this._messages = messages;
  }

  /** Rebuild a conversation from its `toJSON()` representation. */
  static fromJSON(value: Record<string, unknown>): Conversation {
    const rawMessages = value["messages"];
    const messages = Array.isArray(rawMessages) ? rawMessages.map((message) => deserializeMessage(message)) : [];
    return new Conversation(messages);
  }

  toString(): string {
    return `Conversation(messages=${this.messages})`;
  }

  toJSON(): Record<string, unknown> {
    return {
      messages: this.messages.map((message) => message.toJSON()),
    };
  }

  push(message: Message): void {
    this._messages.push(message);
  }

  get messages(): Message[] {
    return this._messages;
  }

  set messages(messages: Message[]) {
    this._messages = messages;
  }
}


// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export class Model {
  readonly _name: string;
  readonly _tech_name: string;
  readonly _provider: Providers;
  readonly _supports_vision: boolean;
  readonly _supports_tool_calls: boolean;
  readonly _max_context: number;

  constructor(name: string, tech_name: string, provider: Providers, supports_vision: boolean, supports_tool_calls: boolean, max_context: number) {
    this._name = name;
    this._tech_name = tech_name;
    this._provider = provider;
    this._supports_vision = supports_vision;
    this._supports_tool_calls = supports_tool_calls;
    this._max_context = max_context;
  }

  get name(): string {
    return this._name;
  }

  get tech_name(): string {
    return this._tech_name;
  }

  get provider(): Providers {
    return this._provider;
  }

  get supports_vision(): boolean {
    return this._supports_vision;
  }

  get supports_tool_calls(): boolean {
    return this._supports_tool_calls;
  }

  get max_context(): number {
    return this._max_context;
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes `Content` (string or content parts) to the wire format: a plain
 * string stays a string, content parts are serialized via `toJSON()`.
 */
function normalizeContent(content: Content): string | Record<string, unknown>[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => part.toJSON());
}
