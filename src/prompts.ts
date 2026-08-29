import {Model} from "./types";
import {Tool} from "./tool_definitions";


interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}


export function build_system_prompt(model: Model, project_name: string, tools: Tool[]): string {
  let prompt = "# Introduction\nYou are an expert coding assistant operating inside LideCode, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files. You are running inside a docker container. The project that you are working on is at `/home/agent/%%project_name%%`.\n"
  prompt = prompt.replace("%%project_name%%", project_name)
  prompt += "# Tool Calling\nTool Calling is very important to accomplish most tasks.\n"
  prompt += "## Examples\n"
  for (const tool of tools) {
    switch (tool.function.name) {
      case "bash":
        prompt += "### bash\n"
        prompt += format_tool_call({name: "bash", arguments: {command: "minecraft_source_extractor --version 26.2", timeout: 600, directory: "/home/agent/scripts"}}, model)
        break
      case "read_file":
        prompt += "### read_file\n"
        prompt += format_tool_call({name: "read_file", arguments: {path: "/home/agent/skills/angular/latex_renderer.md"}}, model)
        break
      case "write_to_file":
        prompt += "### write_to_file\n"
        prompt += format_tool_call({name: "write_to_file", arguments: {path: "/home/agent/maintenance.html", content: "<!DOCTYPE html>\n" +
              "<html lang=\"en\">\n" +
              "  <head>\n" +
              "    <meta charset=\"utf-8\">\n" +
              "    <title>This website is under maintenance</title>\n" +
              "  </head>\n" +
              "  <body>\n" +
              "    <h1>This website is under maintenance</h1>\n" +
              "    <p>Thank you for your visit, but this website is currently unavailable.</p>\n" +
              "  </body>\n" +
              "</html>", read: false}}, model)
        break
      case "replace_in_file":
        prompt += "### replace_in_file\n"
        prompt += format_tool_call({name: "replace_in_file", arguments: {path: "/home/agent/maintenance.html", search: "is currently unavailable.", replace: "will be unavailable until next monday."}}, model)
        break
      case "view_image":
        prompt += "### view_image\n"
        prompt += format_tool_call({name: "view_image", arguments: {path: "/home/agent/Downloads/image0001.png"}}, model)
        break
      case "websearch":
        prompt += "### websearch\n"
        prompt += format_tool_call({name: "websearch", arguments: {query: "typescript date-fns format UTC timezone", count: 5, freshness: "py"}}, model)
        break
    }
  }
  return prompt
}

function format_tool_call(tool_call: ToolCall, model: Model): string {
  let call = '';
  if (model._tech_name.includes("deepseek") && model._tech_name.includes("v4")) {
    call += "<｜DSML｜tool_calls>\n"
    call += "<｜DSML｜invoke name=\"" + tool_call.name + "\">\n"
    for (const key of Object.keys(tool_call.arguments)) {
      if (typeof tool_call.arguments[key] === 'string') {
        call += "<｜DSML｜parameter name=\"param\" string=\"true\">" + tool_call.arguments[key] + "</｜DSML｜parameter>\n"
      } else {
        call += "<｜DSML｜parameter name=\"param\" string=\"false\">" + tool_call.arguments[key] + "</｜DSML｜parameter>\n"
      }
    }
    call += "</｜DSML｜invoke>\n"
    call += "</｜DSML｜tool_calls>\n"
  } else {
    call += "<tool_call>\n"
    call += "<name>" + tool_call.name + "</name>\n"
    call += "<arguments>\n"
    for (const key of Object.keys(tool_call.arguments)) {
      call += "<" + key + ">" + tool_call.arguments[key] + "</" + key + ">\n"
    }
    call += "</arguments>\n"
    call += "</tool_call>\n"
  }
  return call
}
