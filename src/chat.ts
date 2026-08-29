import {
  AssistantMessage,
  Conversation,
  ImageContent,
  Model,
  TextContent,
  ToolCall, ToolMessage,
  UserMessage
} from "./types";
import {execSync} from "node:child_process";
import {DEFAULT_TOOLS, Tool, VIEWIMAGE_TOOL, WEBSEARCH_TOOL} from "./tool_definitions";
import {build_system_prompt} from "./prompts";
import {LLM, get_llm, GenerationHandle} from "./llm";
import {join} from "node:path";
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {getRequestWithHeaders, getRequest, postRequest} from "./util";

export const IMAGE_NAME = 'lidecode_debian_13'
export const CONTAINER_PREFIX = 'lidecode_'
export const INTERNAL_PORT = 50000
export const NETWORK_NAME = 'lidecode_net'
export const CONTAINER_IP_PREFIX = '172.30.0.'
const TOKEN_DIR = "/opt/LideCode";
const TOKEN_FILE = join(TOKEN_DIR, "access_token");


export function getOrCreateAccessToken(): string {
  mkdirSync(TOKEN_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  }
  const token = `sk-${randomBytes(32).toString("hex")}`;
  writeFileSync(TOKEN_FILE, token, { encoding: "utf8", mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return token;
}


export class Chat {
  private _model: Model
  private _llm: LLM
  private _temperature: number | undefined
  private readonly _project_name: string
  private readonly _ip: string
  private _conversation: Conversation
  private readonly _tools: Tool[]
  private readonly _container_name: string
  private _generation_handle: GenerationHandle | undefined
  private _generation_cancelled: boolean = false
  private _generation_error: string | undefined
  private _waiting_for_tool_response: number = 0
  private _cost: number = 0
  private _tool_runners: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    'bash': this.execute_bash.bind(this),
    'read_file': this.execute_read_file.bind(this),
    'write_to_file': this.execute_write_to_file.bind(this),
    'replace_in_file': this.execute_replace_in_file.bind(this),
    'view_image': this.execute_view_image.bind(this),
    'websearch': this.execute_websearch.bind(this)
  }

  constructor(model: Model, temperature: number | undefined, project_name: string) {
    this._model = model
    this._llm = get_llm(model, temperature)
    this._temperature = temperature
    this._project_name = project_name
    this._ip= CONTAINER_IP_PREFIX + Math.floor(Math.random() * 255).toString()
    this._container_name = CONTAINER_PREFIX + this._ip.split('.').pop()
    this._tools = DEFAULT_TOOLS
    if (process.env.BRAVE_SEARCH_API_KEY) {
      this._tools.push(WEBSEARCH_TOOL)
    }
    if (model.supports_vision) {
      this._tools.push(VIEWIMAGE_TOOL)
    }
    this._conversation = new Conversation([new AssistantMessage(build_system_prompt(model, project_name, this._tools))])
  }

  ensure_docker_image(): void {
    const stdout = execSync('docker images').toString();
    if (!stdout.includes(IMAGE_NAME)) {
      execSync('docker build -t ' + IMAGE_NAME + ' -f /opt/LideCode/docker/DOCKERFILE /opt/LideCode/docker')
    }
  }

  ensure_docker_network(): void {
    const stdout = execSync('docker network ls').toString();
    if (!stdout.includes(NETWORK_NAME)) {
      execSync('docker network create --subnet=172.30.0.0/16 ' + NETWORK_NAME)
    }
  }

  stop_docker(): void {
    const stout = execSync('docker ps -q --filter name=' + this._container_name).toString();
    if (stout) {
      execSync('docker stop ' + this._container_name)
      execSync('docker rm ' + this._container_name)
    }
  }

  start_docker(additional_volumes: [string, string][] | undefined, env: Record<string, string> | undefined) {
    this.stop_docker()
    this.ensure_docker_image()
    this.ensure_docker_network()
    let command = 'docker run -d --name ' + this._container_name + ' --network ' + NETWORK_NAME + ' --ip ' + this._ip + ' -e ACCESS_TOKEN=' + getOrCreateAccessToken() + ' '
    if (additional_volumes) {
      command += additional_volumes.map(([host, container]) => '-v ' + host + ':' + container + ' ').join('')
    }
    if (env) {
      command += Object.entries(env).map(([key, value]) => '-e ' + key + '=' + value + ' ').join('')
    }
    command += IMAGE_NAME
    execSync(command)
  }

  async check_health(): Promise<boolean> {
    let returns = false
    try{
      const response = await getRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/')
      returns = JSON.parse(response).status === 'ok'
    } catch (e) {}
    return returns
  }

  send_user_message(message: string): void {
    this._conversation.messages.push(new UserMessage([new TextContent(message)]))
  }

  generate(): void {
    if (this._generation_handle) {
      throw new Error("Generation already in progress")
    }
    if (this._waiting_for_tool_response > 0) {
      throw new Error("Cannot start generation while waiting for tool response")
    }
    const handle = this._llm.generate(this._conversation, this._tools)
    this._generation_handle = handle
    this._generation_cancelled = false
    this._generation_error = undefined
    handle.done.then((generation_result) => {
      this._generation_handle = undefined
      this._conversation.messages.push(generation_result.message)
      this._cost += generation_result.cost ?? 0
      for (const tool_call of generation_result.message.toolCalls) {
        this._waiting_for_tool_response++
        this.call_tool(tool_call).then(() => {
          this._waiting_for_tool_response--
          if (this._waiting_for_tool_response == 0 && !this._generation_cancelled) {
            this.generate()
          }
        })
      }
    }).catch((error: unknown) => {
      this._generation_handle = undefined
      if (!this._generation_cancelled) {
        this._generation_error = error instanceof Error ? error.message : String(error)
      }
    })
  }

  cancel_generation(): void {
    if (this._generation_handle) {
      const handle = this._generation_handle
      this._generation_handle = undefined
      handle.cancel()
      // The `done` promise rejects on cancellation; attach a catch so the
      // rejection is handled and the generation callback chain is stopped.
      handle.done.catch(() => {})
      // Suppress the automatic follow-up generation once pending tool calls finish.
      this._generation_cancelled = true
    }
  }

  async call_tool(tool_call: ToolCall): Promise<void> {
    const tool_name = tool_call.function.name
    const args: Record<string, unknown> = JSON.parse(tool_call.function.arguments)
    const runner = this._tool_runners[tool_name]
    const result = runner ? await runner(args) : 'Error: `' + tool_name + '` is not a valid tool.'
    this._conversation.messages.push(new ToolMessage(tool_call.id, result))
  }

  async execute_bash(args: Record<string, unknown>): Promise<string> {
    if (!args.command) {
      return 'The parameter "command" is required'
    }
    if (typeof args.command != "string") {
      return 'The parameter "command" must be a string'
    }
    const command: string = args.command
    if (args.timeout && typeof args.timeout != "number") {
      return 'The parameter "timeout" must be a number'
    }
    const timeout: number = typeof args.timeout === "number" ? args.timeout : 60
    if (args.directory && typeof args.directory != "string") {
      return 'The parameter "directory" must be a string'
    }
    const directory: string = typeof args.directory === "string" ? args.directory : '/home/agent'
    if (args.venv && typeof args.venv != "string") {
      return 'The parameter "venv" must be a string'
    }
    const venv: string = typeof args.venv === "string" ? args.venv : ''
    if (args.max_chars && typeof args.max_chars != "number") {
      return 'The parameter "max_chars" must be a number'
    }
    const max_chars: number = typeof args.max_chars === "number" ? args.max_chars : 1000000
    const raw_response = await postRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/bash', {command: command, timeout: timeout, directory: directory, venv: venv, max_chars: max_chars})
    const response = JSON.parse(raw_response)
    if (response.error) {
      return response.error
    }
    const stdout = response.stdout
    const stderr = response.stderr
    const returncode = response.returncode
    const output = '<returncode>' + returncode + '</returncode>\n<stderr>' + stderr + '</stderr>\n<stdout>' + stdout + '</stdout>'
    if (output.length > max_chars) {
      return output.slice(0, max_chars) + '<truncated>'
    }
    return output
  }

  async execute_read_file(args: Record<string, unknown>): Promise<string> {
    if (!args.path) {
      return 'The parameter "path" is required'
    }
    if (typeof args.path != "string") {
      return 'The parameter "path" must be a string'
    }
    const path: string = args.path
    if (args.start_line && typeof args.start_line != "number") {
      return 'The parameter "start_line" must be a number'
    }
    const start_line: number = typeof args.start_line === "number" ? args.start_line : 1
    if (args.end_line && typeof args.end_line != "number") {
      return 'The parameter "end_line" must be a number'
    }
    const end_line: number = typeof args.end_line === "number" ? args.end_line : 1000
    if (args.start_char && typeof args.start_char != "number") {
      return 'The parameter "start_char" must be a number'
    }
    const start_char: number = typeof args.start_char === "number" ? args.start_char : 0
    if (args.end_char && typeof args.end_char != "number") {
      return 'The parameter "end_char" must be a number'
    }
    const end_char: number = typeof args.end_char === "number" ? args.end_char : 100000
    if (args.max_chars && typeof args.max_chars != "number") {
      return 'The parameter "max_chars" must be a number'
    }
    const max_chars: number = typeof args.max_chars === "number" ? args.max_chars : 1000000
    const raw_response = await postRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/read_file', {path: path, start_line: start_line, end_line: end_line, start_char: start_char, end_char: end_char, max_chars: max_chars})
    const response = JSON.parse(raw_response)
    if (response.error) {
      return response.error
    }
    return '<path>' + path + '</path>\n<first_char>' + response.first_char + '</first_char>\n<last_char>' + response.last_char + '</last_char>\n<first_line>' + response.first_line + '</first_line>\n<last_line>' + response.last_line + '</last_line>\n<content>' + response.content + '</content>'
  }

  async execute_write_to_file(args: Record<string, unknown>): Promise<string> {
    if (!args.path) {
      return 'The parameter "path" is required'
    }
    if (typeof args.path != "string") {
      return 'The parameter "path" must be a string'
    }
    const path: string = args.path
    if (args.content === undefined || args.content === null) {
      return 'The parameter "content" is required'
    }
    if (typeof args.content != "string") {
      return 'The parameter "content" must be a string'
    }
    const content: string = args.content
    const raw_response = await postRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/write_to_file', {path: path, content: content})
    const response = JSON.parse(raw_response)
    if (response.error) {
      return response.error
    }
    return 'Wrote ' + response.characters + ' characters to ' + path
  }

  async execute_replace_in_file(args: Record<string, unknown>): Promise<string> {
    if (!args.path) {
      return 'The parameter "path" is required'
    }
    if (typeof args.path != "string") {
      return 'The parameter "path" must be a string'
    }
    const path: string = args.path
    if (!args.search) {
      return 'The parameter "search" is required'
    }
    if (typeof args.search != "string") {
      return 'The parameter "search" must be a string'
    }
    const search: string = args.search
    if (args.replace === undefined || args.replace === null) {
      return 'The parameter "replace" is required'
    }
    if (typeof args.replace != "string") {
      return 'The parameter "replace" must be a string'
    }
    const replace: string = args.replace
    if (args.read && typeof args.read != "boolean") {
      return 'The parameter "read" must be a boolean'
    }
    const read: boolean = typeof args.read === "boolean" ? args.read : false
    const raw_response = await postRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/replace_in_file', {path: path, search: search, replace: replace, read: read})
    const response = JSON.parse(raw_response)
    if (response.error) {
      return response.error
    }
    let output = '<note>Made ' + response.replacements + ' replacement(s) in <path>' + path + '</path></note>\n'
    if (response.occurrences) {
      output += '<ocurrences>\n'
    }
    for (const occurrence of response.occurrences) {
      output += '<occurrence>\n'
      output += '<old_start_character>' + occurrence.old_start + '</old_start_character>\n'
      output += '<old_end_character>' + occurrence.old_end + '</old_end_character>\n'
      output += '<new_start_character>' + occurrence.new_start + '</new_start_character>\n'
      output += '<new_end_character>' + occurrence.new_end + '</new_end_character>\n'
      output += '</occurrence>\n'
    }
    if (response.ocurrences) {
      output += '</ocurrences>\n'
    }
    if (read) {
      output += '<content>' + response.content + '</content>\n'
    }
    return output
  }

  async execute_view_image(args: Record<string, unknown>): Promise<string> {
    if (!args.path) {
      return 'The parameter "path" is required'
    }
    if (typeof args.path != "string") {
      return 'The parameter "path" must be a string'
    }
    const path: string = args.path
    const raw_response = await postRequest('http://' + this._ip + ':' + INTERNAL_PORT + '/view_image', {path: path})
    const response = JSON.parse(raw_response)
    if (response.error) {
      return response.error
    }
    this._conversation.push(new UserMessage([new TextContent('Result from the "view_image" tool call.'), new ImageContent(Uint8Array.from(response.data_url.split(',').pop() || ''))]))
    return "See the user message."
  }

  async execute_websearch(args: Record<string, unknown>): Promise<string> {
    if (!process.env.BRAVE_SEARCH_API_KEY) {
      return 'Web search is not available: no BRAVE_SEARCH_API_KEY is configured.'
    }
    if (!args.query) {
      return 'The parameter "query" is required'
    }
    if (typeof args.query != "string") {
      return 'The parameter "query" must be a string'
    }
    const query: string = args.query
    if (query.length > 400) {
      return 'The parameter "query" must not exceed 400 characters'
    }
    if (query.split(/\s+/).filter(Boolean).length > 50) {
      return 'The parameter "query" must not exceed 50 words'
    }
    if (args.count && typeof args.count != "number") {
      return 'The parameter "count" must be a number'
    }
    const count: number = Math.min(Math.max(Math.floor(typeof args.count === "number" ? args.count : 10), 1), 20)
    if (args.offset && typeof args.offset != "number") {
      return 'The parameter "offset" must be a number'
    }
    const offset: number = Math.min(Math.max(Math.floor(typeof args.offset === "number" ? args.offset : 0), 0), 9)
    if (args.freshness && typeof args.freshness != "string") {
      return 'The parameter "freshness" must be a string'
    }
    const freshness: string | undefined = typeof args.freshness === "string" ? args.freshness : undefined
    if (freshness !== undefined && !/^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/.test(freshness)) {
      return 'The parameter "freshness" must be one of pd, pw, pm, py or a range like YYYY-MM-DDtoYYYY-MM-DD'
    }
    if (args.country && typeof args.country != "string") {
      return 'The parameter "country" must be a string'
    }
    const country: string = typeof args.country === "string" ? args.country : 'US'
    if (args.search_lang && typeof args.search_lang != "string") {
      return 'The parameter "search_lang" must be a string'
    }
    const search_lang: string = typeof args.search_lang === "string" ? args.search_lang : 'en'
    const params = new URLSearchParams({
      q: query,
      count: String(count),
      offset: String(offset),
      country: country,
      search_lang: search_lang,
      spellcheck: 'false',
      text_decorations: 'false',
      units: 'metric',
      result_filter: 'web',
      extra_snippets: 'true'
    })
    if (freshness !== undefined) {
      params.set('freshness', freshness)
    }
    let response: Record<string, unknown>
    try {
      const raw_response = await getRequestWithHeaders('https://api.search.brave.com/res/v1/web/search?' + params.toString(), {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
      })
      response = JSON.parse(raw_response)
    } catch (error: unknown) {
      return 'Web search request failed: ' + (error instanceof Error ? error.message : String(error))
    }
    const web = response.web as {results?: Record<string, unknown>[]} | undefined
    const results = web?.results
    if (!results || results.length === 0) {
      return 'No web results found for the query: ' + query
    }
    let output = '<query>' + query + '</query>\n'
    for (const result of results) {
      output += '<result>\n'
      output += '<title>' + (result.title ?? '') + '</title>\n'
      output += '<url>' + (result.url ?? '') + '</url>\n'
      if (result.description) {
        output += '<description>' + result.description + '</description>\n'
      }
      if (result.page_age) {
        output += '<page_age>' + result.page_age + '</page_age>\n'
      }
      const extra_snippets = result.extra_snippets as string[] | undefined
      if (extra_snippets && extra_snippets.length > 0) {
        output += '<extra_snippets>\n'
        for (const snippet of extra_snippets) {
          output += '<snippet>' + snippet + '</snippet>\n'
        }
        output += '</extra_snippets>\n'
      }
      output += '</result>\n'
    }
    return output
  }

  get model(): Model {
    return this._model
  }

  set model(model: Model) {
    if (this._model.supports_tool_calls != model.supports_tool_calls) {
      throw new Error("Support for tool calls cannot be changed after initialization")
    }
    if (this._model.supports_vision && !model.supports_vision) {
      throw new Error("Support for vision cannot be disabled after initialization")
    }
    if (!this._model.supports_vision && model.supports_vision) {
      this._tools.push(VIEWIMAGE_TOOL)
    }
    this._model = model
  }

  get temperature(): number | undefined {
    return this._temperature
  }

  set temperature(temperature: number | undefined) {
    this._temperature = temperature
  }

  get project_name(): string {
    return this._project_name
  }

  /** Whether a generation or tool execution is currently in progress. */
  get busy(): boolean {
    return this._generation_handle !== undefined || this._waiting_for_tool_response > 0
  }

  /** Current generation handle, or undefined if no generation is active. */
  get generation_handle(): GenerationHandle | undefined {
    return this._generation_handle
  }

  /** Error message of the last failed generation, if any. */
  get error(): string | undefined {
    return this._generation_error
  }

  /** Total cost in credits accumulated by this chat. */
  get cost(): number {
    return this._cost
  }

  /** The full conversation, including the system prompt. */
  get conversation(): Conversation {
    return this._conversation
  }

}
