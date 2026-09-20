/**
 * Console logging for completed LLM requests.
 *
 * Every generation is logged once, when the stream finishes, with the three
 * things the model produced — its thinking, its visible content and its tool
 * calls — plus the usage/cost reported in the final stream chunk. Failed and
 * cancelled generations are logged as well, so a turn never disappears from
 * the console silently.
 *
 * The formatting is kept in a pure function (`format_generation_log`) so it can
 * be exercised without a provider, and the `console` calls are wrapped so that
 * logging can never disturb a running generation.
 */

/** Marker prefix every generation log line starts with. */
const HEADER = '[LLM]';

/**
 * Structural shape of the usage stats reported in the final stream chunk.
 * Declared here (instead of importing `UsageStats`) to keep this module free of
 * dependencies, in particular of a cycle with the provider implementation.
 */
export interface LoggedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number | null;
}

/** One completed generation, as assembled by the provider implementation. */
export interface GenerationLogEntry {
  /** Provider model id, e.g. `anthropic/claude-opus-5`. */
  model: string;
  /** Why the stream stopped, or `null` when the provider never said. */
  finish_reason: string | null;
  /** Streamed reasoning/thinking tokens, if the model produced any. */
  thinking: string | null;
  /** Visible assistant text, if any. */
  content: string | null;
  /** Refusal text, when the provider returned one instead of content. */
  refusal: string | null;
  /** Tool calls the model requested, in stream order. */
  tool_calls: { name: string; arguments: string }[];
  /** Usage stats from the final stream chunk, if it reported any. */
  usage: LoggedUsage | undefined;
  /** Cost in credits, if the provider reported one. */
  cost: number | undefined;
}

/** Indent every line of a block, so multi-line payloads stay readable. */
function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => prefix + line).join('\n');
}

/** A labelled, indented block such as `  thinking:\n    ...`. */
function section(label: string, body: string): string {
  return '  ' + label + ':\n' + indent(body, '    ');
}

/** One tool call as `- name(arguments)`, tolerating nameless/argument-less calls. */
function toolCallLine(call: { name: string; arguments: string }): string {
  const name = call.name.length > 0 ? call.name : '(unnamed)';
  const args = call.arguments.length > 0 ? '(' + call.arguments + ')' : '';
  return '- ' + name + args;
}

/**
 * Render one completed generation as a multi-line, greppable log entry:
 *
 * ```
 * [LLM] anthropic/claude-opus-5 · finish=tool_calls · tokens=120/45/165 · cost=0.0123
 *   thinking:
 *     Let me check.
 *   content:
 *     Running it.
 *   tool_calls:
 *     - bash({"command":"ls"})
 * ```
 *
 * Empty sections are omitted entirely, so a tool-only turn stays short.
 */
export function format_generation_log(entry: GenerationLogEntry): string {
  let header = HEADER + ' ' + entry.model + ' · finish=' + (entry.finish_reason ?? 'none');
  if (entry.usage !== undefined) {
    header += ' · tokens=' + entry.usage.prompt_tokens + '/'
      + entry.usage.completion_tokens + '/' + entry.usage.total_tokens;
  }
  if (entry.cost !== undefined) {
    header += ' · cost=' + entry.cost;
  }

  const blocks = [header];
  if (entry.thinking) {
    blocks.push(section('thinking', entry.thinking));
  }
  if (entry.content) {
    blocks.push(section('content', entry.content));
  }
  if (entry.refusal) {
    blocks.push(section('refusal', entry.refusal));
  }
  if (entry.tool_calls.length > 0) {
    blocks.push(section('tool_calls', entry.tool_calls.map(toolCallLine).join('\n')));
  }
  return blocks.join('\n');
}

/** Whether an error came from aborting the request rather than a failure. */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Log one completed generation. Swallows logging errors so a broken `console`
 * can never reject the generation's `done` promise.
 */
export function log_generation(entry: GenerationLogEntry): void {
  try {
    console.log(format_generation_log(entry));
  } catch {
    // Logging is observational; never let it affect the generation.
  }
}

/** Log a failed or cancelled generation as a single header line. */
export function log_generation_error(model: string, error: unknown): void {
  try {
    const message = isAbort(error)
      ? 'cancelled'
      : error instanceof Error ? error.message : String(error);
    console.error(HEADER + ' ' + model + ' · error: ' + message);
  } catch {
    // Logging is observational; never let it affect the generation.
  }
}