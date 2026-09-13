/**
 * Host-side tool implementations.
 *
 * These run in the Electron main process against the user's own machine,
 * outside the Docker sandbox. They deliberately mirror the algorithms of the
 * container-side Flask app (`src/docker/app.py`) so the agent sees identical
 * output shapes, and every execution is gated behind an explicit per-call user
 * approval (see `Chat._request_tool_permission`).
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Upper bound for captured command output, matching `chat.ts`'s `run()`. */
const MAX_BUFFER = 100 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT, bad cwd, ...). */
  failure: string | undefined;
}

/** Base64 image payload returned by `hostViewImage`. */
export interface HostImageData {
  mime: string;
  base64: string;
}

// ---------------------------------------------------------------------------
// Argument validation
//
// Messages mirror the container-side runners in `chat.ts`, so the agent sees
// the same wording for a given mistake whichever filesystem it targets.
// ---------------------------------------------------------------------------

function checkString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    return 'The parameter "' + name + '" is required';
  }
  return typeof value === 'string' ? undefined : 'The parameter "' + name + '" must be a string';
}

function checkNonEmptyString(args: Record<string, unknown>, name: string): string | undefined {
  if (!args[name]) {
    return 'The parameter "' + name + '" is required';
  }
  return typeof args[name] === 'string' ? undefined : 'The parameter "' + name + '" must be a string';
}

function checkOptionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return value === undefined || typeof value === 'string'
    ? undefined
    : 'The parameter "' + name + '" must be a string';
}

function checkOptionalNumber(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return value === undefined || typeof value === 'number'
    ? undefined
    : 'The parameter "' + name + '" must be a number';
}

function checkOptionalBoolean(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return value === undefined || typeof value === 'boolean'
    ? undefined
    : 'The parameter "' + name + '" must be a boolean';
}

/** First validation error of the checks, or undefined when every argument is fine. */
function firstError(...checks: (string | undefined)[]): string | undefined {
  return checks.find((message) => message !== undefined);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function exitCode(error: Error): number {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'number' ? candidate : 1;
}

/**
 * Run a command without a shell and resolve even on a non-zero exit code, so
 * callers can report stdout/stderr/returncode the way the container does.
 */
function runCapture(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult> {
  const execOptions: { maxBuffer: number; cwd?: string; timeout?: number } = { maxBuffer: MAX_BUFFER };
  if (options?.cwd !== undefined) {
    execOptions.cwd = options.cwd;
  }
  if (options?.timeout !== undefined) {
    execOptions.timeout = options.timeout;
  }
  return new Promise<ExecResult>((resolve) => {
    execFile(command, args, execOptions, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: 0, timedOut: false, failure: undefined });
        return;
      }
      const code = (error as { code?: unknown }).code;
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: exitCode(error),
        timedOut: (error as { killed?: unknown }).killed === true,
        failure: typeof code === 'string' ? error.message : undefined,
      });
    });
  });
}

function truncate(output: string, maxChars: number): string {
  return output.length > maxChars ? output.slice(0, maxChars) + '<truncated>' : output;
}

/**
 * `host_bash`: run a command on the host through bash, mirroring the container
 * response shape (`<returncode>`/`<stderr>`/`<stdout>`).
 */
export async function hostBash(args: Record<string, unknown>): Promise<string> {
  const invalid = firstError(
    checkNonEmptyString(args, 'command'),
    checkOptionalNumber(args, 'timeout'),
    checkOptionalString(args, 'directory'),
    checkOptionalString(args, 'venv'),
    checkOptionalNumber(args, 'max_chars'),
  );
  if (invalid !== undefined) {
    return invalid;
  }
  const command = args['command'] as string;
  const timeout = typeof args['timeout'] === 'number' ? args['timeout'] : 60;
  const directory = typeof args['directory'] === 'string' ? args['directory'] : '/';
  const venv = typeof args['venv'] === 'string' ? args['venv'] : '';
  const maxChars = typeof args['max_chars'] === 'number' ? args['max_chars'] : 100000;
  const script = venv.length > 0 ? 'source ' + venv + '/bin/activate && ' + command : command;
  const result = await runCapture('bash', ['-lc', script], { cwd: directory, timeout: timeout * 1000 });
  if (result.timedOut) {
    return 'Error: the command timed out after ' + timeout + ' second(s).';
  }
  if (result.failure !== undefined) {
    return 'Error: ' + result.failure;
  }
  const output = '<returncode>' + result.code + '</returncode>\n<stderr>' + result.stderr
    + '</stderr>\n<stdout>' + result.stdout + '</stdout>';
  return truncate(output, maxChars);
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

type FileReadResult = { ok: true; content: string } | { ok: false; error: string };

/** Read a host file as UTF-8 text, mirroring the container's not-found/not-a-file errors. */
async function readHostTextFile(path: string): Promise<FileReadResult> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return { ok: false, error: 'Not a file: ' + path };
    }
    return { ok: true, content: await readFile(path, 'utf8') };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'File not found: ' + path };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Split text into lines, keeping the terminators. Mirrors Python's
 * `str.splitlines(keepends=True)`, including its treatment of `\r\n` as a
 * single terminator, so the line offsets match the container's.
 */
function splitLinesKeepEnds(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const pattern = /\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/g;
  const lines: string[] = [];
  let start = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const end = match.index + (match[0] ?? '').length;
    lines.push(text.slice(start, end));
    start = end;
    match = pattern.exec(text);
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * `host_read_file`: the same offset math as the container endpoint. The
 * further of `start_line`/`start_char` wins for the start, and the further of
 * `end_line`/`end_char` wins for the end.
 */
export async function hostReadFile(args: Record<string, unknown>): Promise<string> {
  const invalid = firstError(
    checkNonEmptyString(args, 'path'),
    checkOptionalNumber(args, 'start_line'),
    checkOptionalNumber(args, 'end_line'),
    checkOptionalNumber(args, 'start_char'),
    checkOptionalNumber(args, 'end_char'),
    checkOptionalNumber(args, 'max_chars'),
  );
  if (invalid !== undefined) {
    return invalid;
  }
  const path = args['path'] as string;
  const startLine = typeof args['start_line'] === 'number' ? args['start_line'] : 1;
  const endLine = typeof args['end_line'] === 'number' ? args['end_line'] : 1000;
  const startChar = typeof args['start_char'] === 'number' ? args['start_char'] : 0;
  const endChar = typeof args['end_char'] === 'number' ? args['end_char'] : 100000;
  const maxChars = typeof args['max_chars'] === 'number' ? args['max_chars'] : 1000000;
  const file = await readHostTextFile(path);
  if (!file.ok) {
    return file.error;
  }
  const lines = splitLinesKeepEnds(file.content);
  const lineStartOffset = lines.slice(0, Math.max(startLine - 1, 0))
    .reduce((total, line) => total + line.length, 0);
  const offset = Math.max(lineStartOffset, Math.max(startChar, 0));
  const lineEndOffset = lines.slice(0, endLine).reduce((total, line) => total + line.length, 0);
  const charEndOffset = offset + Math.max(endChar, 0);
  const endOffset = Math.max(lineEndOffset, charEndOffset);
  let text = file.content.slice(offset, endOffset);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return '<path>' + path + '</path>\n<first_char>' + offset + '</first_char>\n<last_char>'
    + (endOffset - 1) + '</last_char>\n<first_line>null</first_line>\n<last_line>null</last_line>\n<content>'
    + text + '</content>';
}

/** `host_write_to_file`: create parent directories and overwrite the file. */
export async function hostWriteToFile(args: Record<string, unknown>): Promise<string> {
  const invalid = firstError(checkNonEmptyString(args, 'path'), checkString(args, 'content'));
  if (invalid !== undefined) {
    return invalid;
  }
  const path = args['path'] as string;
  const content = args['content'] as string;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return 'Wrote ' + [...content].length + ' characters to ' + path;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * `host_replace_in_file`: literal (non-regex) replacement of every occurrence,
 * reporting the same occurrence/offset structure as the container endpoint.
 */
export async function hostReplaceInFile(args: Record<string, unknown>): Promise<string> {
  const invalid = firstError(
    checkNonEmptyString(args, 'path'),
    checkNonEmptyString(args, 'search'),
    checkString(args, 'replace'),
    checkOptionalBoolean(args, 'read'),
  );
  if (invalid !== undefined) {
    return invalid;
  }
  const path = args['path'] as string;
  const search = args['search'] as string;
  const replace = args['replace'] as string;
  const read = args['read'] === true;
  const file = await readHostTextFile(path);
  if (!file.ok) {
    return file.error;
  }
  const current = file.content;
  const searchLength = search.length;
  const replaceLength = replace.length;
  const delta = replaceLength - searchLength;
  const occurrences: { old_start: number; old_end: number; new_start: number; new_end: number }[] = [];
  let searchFrom = 0;
  let matchCount = 0;
  for (;;) {
    const originalIndex = current.indexOf(search, searchFrom);
    if (originalIndex === -1) {
      break;
    }
    const newIndex = originalIndex + matchCount * delta;
    occurrences.push({
      old_start: originalIndex,
      old_end: originalIndex + searchLength - 1,
      new_start: newIndex,
      new_end: newIndex + replaceLength - 1,
    });
    searchFrom = originalIndex + searchLength;
    matchCount++;
  }
  if (occurrences.length === 0) {
    return 'Search text not found in file';
  }
  const newContent = current.split(search).join(replace);
  try {
    await writeFile(path, newContent, 'utf8');
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  let output = '<note>Made ' + occurrences.length + ' replacement(s) in <path>' + path + '</path></note>\n';
  output += '<occurrences>\n';
  for (const occurrence of occurrences) {
    output += '<occurrence>\n';
    output += '<old_start_character>' + occurrence.old_start + '</old_start_character>\n';
    output += '<old_end_character>' + occurrence.old_end + '</old_end_character>\n';
    output += '<new_start_character>' + occurrence.new_start + '</new_start_character>\n';
    output += '<new_end_character>' + occurrence.new_end + '</new_end_character>\n';
    output += '</occurrence>\n';
  }
  output += '</occurrences>\n';
  if (read) {
    output += '<content>' + newContent + '</content>\n';
  }
  return output;
}

// ---------------------------------------------------------------------------
// Copies between the host and the sandbox container
// ---------------------------------------------------------------------------

async function dockerCopy(source: string, destination: string): Promise<string> {
  const result = await runCapture('docker', ['cp', source, destination]);
  if (result.timedOut) {
    return 'Error: docker cp timed out.';
  }
  if (result.failure !== undefined) {
    return 'Error: ' + result.failure;
  }
  if (result.code !== 0) {
    const details = result.stderr.trim();
    return 'Error: docker cp failed' + (details.length > 0 ? ': ' + details : ' (exit code ' + result.code + ')');
  }
  return 'Copied ' + source + ' to ' + destination;
}

/** `copy_host_to_docker`: `docker cp <source> <container>:<destination>`. */
export async function copyHostToDocker(args: Record<string, unknown>, containerName: string): Promise<string> {
  const invalid = firstError(checkNonEmptyString(args, 'source'), checkNonEmptyString(args, 'destination'));
  if (invalid !== undefined) {
    return invalid;
  }
  return dockerCopy(args['source'] as string, containerName + ':' + (args['destination'] as string));
}

/** `copy_docker_to_host`: `docker cp <container>:<source> <destination>`. */
export async function copyDockerToHost(args: Record<string, unknown>, containerName: string): Promise<string> {
  const invalid = firstError(checkNonEmptyString(args, 'source'), checkNonEmptyString(args, 'destination'));
  if (invalid !== undefined) {
    return invalid;
  }
  return dockerCopy(containerName + ':' + (args['source'] as string), args['destination'] as string);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Guess the image mime from its extension, defaulting to PNG like `app.py`. */
function imageMime(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg';
  }
  if (extension === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * `host_view_image`: read a host image and return its base64 payload, or an
 * error string when the path cannot be read.
 */
export async function hostViewImage(args: Record<string, unknown>): Promise<string | HostImageData> {
  const invalid = checkNonEmptyString(args, 'path');
  if (invalid !== undefined) {
    return invalid;
  }
  const path = args['path'] as string;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return 'Not a file: ' + path;
    }
    const bytes = await readFile(path);
    return { mime: imageMime(path), base64: bytes.toString('base64') };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'File not found: ' + path;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
