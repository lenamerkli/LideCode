import {Model, Providers} from "./types.js";

export const MODELS = [
  new Model("DeepSeek V4 Pro", "deepseek/deepseek-v4-pro-0813", Providers.OpenRouter, false, true, 1000000),
  new Model("DeepSeek V4 Flash", "deepseek/deepseek-v4-flash-0731", Providers.OpenRouter, false, true, 1000000),
  new Model("Gemini 3.7 Flash", "google/gemini-3.7-flash", Providers.OpenRouter, true, true, 1000000),
  new Model("GLM 5.3", "z-ai/glm-5.3", Providers.OpenRouter, false, true, 1000000),
  new Model("Qwen 3.8 Max", "qwen/qwen3.8-max", Providers.OpenRouter, true, true, 1000000),
  new Model("Kimi K3", "moonshotai/kimi-k3", Providers.OpenRouter, true, true, 1000000),
  new Model("GLM 5.2 (Free)", "z-ai/glm-5.2:free", Providers.OpenRouter, false, true, 256000),
]
