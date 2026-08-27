import {Model} from "./types";
import {execSync} from "node:child_process";

export const IMAGE_NAME = 'lidecode_debian_13'
export const CONTAINER_PREFIX = 'lidecode'
export const INTERNAL_PORT = 50000
export const NETWORK_NAME = 'lidecode_net'
export const CONTAINER_IP_PREFIX = '172.30.0.'


export class Project {
  private _model: Model
  private _temperature: number | undefined
  private readonly _project_name: string
  private readonly _ip: string

  constructor(model: Model, temperature: number | undefined, project_name: string) {
    this._model = model
    this._temperature = temperature
    this._project_name = project_name
    this._ip= CONTAINER_IP_PREFIX + Math.floor(Math.random() * 255).toString()
  }

  ensure_image(): void {
    const stdout = execSync('docker images').toString();
    if (!stdout.includes(IMAGE_NAME)) {
      execSync('docker build -t ' + IMAGE_NAME + ' -f /opt/LideCode/docker/DOCKERFILE /opt/LideCode/docker')
    }
  }

  ensure_network(): void {
    const stdout = execSync('docker network ls').toString();
    if (!stdout.includes(NETWORK_NAME)) {
      execSync('docker network create --subnet=172.30.0.0/16 ' + NETWORK_NAME)
    }
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

}
