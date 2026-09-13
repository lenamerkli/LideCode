export interface ExternalTool {
  definition: Tool;
  url: string;
  headers?: Record<string, string>;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  default?: unknown;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}

export const DEFAULT_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash shell command. Returns stdout, stderr and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command to execute"
          },
          timeout: {
            type: "integer",
            description: "The timeout for the command in seconds",
            default: 60
          },
          directory: {
            type: "string",
            description: "The working directory to execute the command in",
            default: "/home/agent"
          },
          venv: {
            type: "string",
            description: "The path to the python virtual environment to activate before executing the command"
          },
          max_chars: {
            type: "integer",
            description: "The maximum number of characters of output. It will cut off the entire tool response, not just stdout.",
            default: 100000
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. If both start_line and start_char are provided, the one further from the start will be used. If both end_line and end_char are provided, the one further from the end will be used.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read"
          },
          start_line: {
            type: "integer",
            description: "The line to start reading from, 1-indexed",
            default: 1
          },
          end_line: {
            type: "integer",
            description: "The line to end reading at",
            default: 1000
          },
          max_chars: {
            type: "integer",
            description: "The maximum number of characters to read",
            default: 1000000
          },
          start_char: {
            type: "integer",
            description: "The character to start reading from, 0-indexed",
            default: 0
          },
          end_char: {
            type: "integer",
            description: "The character to end reading at",
            default: 100000
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_to_file",
      description: "Write contents to a file. The file will be newly created or completely overwritten.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to create or overwrite"
          },
          content: {
            type: "string",
            description: "The content to write"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "This is the main method to edit files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to edit"
          },
          search: {
            type: "string",
            description: "The content to replace (must match exactly, no regex search)"
          },
          replace: {
            type: "string",
            description: "The content to write"
          },
          read: {
            type: "boolean",
            description: "Whether to read the file in its entirety after the replacement has taken place"
          }
        },
        required: ["path", "search", "replace"]
      }
    }
  }
];

export const WEBSEARCH_TOOL: Tool = {
  type: "function",
  function: {
    name: "websearch",
    description: "Search the web and return a list of web results with title, url, description and age.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query. Maximum 400 characters and 50 words."
        },
        count: {
          type: "integer",
          description: "The number of search results returned. Maximum 20. The actual number delivered may be less.",
          default: 10
        },
        offset: {
          type: "integer",
          description: "The zero based page offset to skip before returning results. Used together with count to paginate. Maximum 9.",
          default: 0
        },
        freshness: {
          type: "string",
          description: "Filter results by page age: 'pd' (24 hours or less), 'pw' (7 days or less), 'pm' (31 days or less), 'py' (365 days or less), or a custom range like 'YYYY-MM-DDtoYYYY-MM-DD'"
        },
        country: {
          type: "string",
          description: "The 2 character country code where the search results come from, e.g. 'US' or 'DE'",
          default: "US"
        },
        search_lang: {
          type: "string",
          description: "The language code for which the search results are provided, e.g. 'en' or 'de'",
          default: "en"
        }
      },
      required: ["query"]
    }
  }
}

export const VIEWIMAGE_TOOL: Tool = {
  type: "function",
  function: {
    name: "view_image",
    description: "View a png, jpeg or webp image.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the image to view"
        }
      },
      required: ["path"]
    }
  }
}

export const HOST_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "host_bash",
      description: "Execute a bash shell command on the host machine. Returns stdout, stderr and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command to execute"
          },
          timeout: {
            type: "integer",
            description: "The timeout for the command in seconds",
            default: 60
          },
          directory: {
            type: "string",
            description: "The working directory to execute the command in",
            default: "/"
          },
          venv: {
            type: "string",
            description: "The path to the python virtual environment to activate before executing the command"
          },
          max_chars: {
            type: "integer",
            description: "The maximum number of characters of output. It will cut off the entire tool response, not just stdout.",
            default: 100000
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_read_file",
      description: "Read the contents of a file that is located on the host machine. If both start_line and start_char are provided, the one further from the start will be used. If both end_line and end_char are provided, the one further from the end will be used.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read on the host machine"
          },
          start_line: {
            type: "integer",
            description: "The line to start reading from, 1-indexed",
            default: 1
          },
          end_line: {
            type: "integer",
            description: "The line to end reading at",
            default: 1000
          },
          max_chars: {
            type: "integer",
            description: "The maximum number of characters to read",
            default: 1000000
          },
          start_char: {
            type: "integer",
            description: "The character to start reading from, 0-indexed",
            default: 0
          },
          end_char: {
            type: "integer",
            description: "The character to end reading at",
            default: 100000
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_write_to_file",
      description: "Write contents to a file that is located on the host machine. The file will be newly created or completely overwritten.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to create or overwrite on the host machine"
          },
          content: {
            type: "string",
            description: "The content to write"
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_replace_in_file",
      description: "This is the main method to edit files that are located on the host machine.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to edit on the host machine"
          },
          search: {
            type: "string",
            description: "The content to replace (must match exactly, no regex search)"
          },
          replace: {
            type: "string",
            description: "The content to write"
          },
          read: {
            type: "boolean",
            description: "Whether to read the file in its entirety after the replacement has taken place"
          }
        },
        required: ["path", "search", "replace"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "copy_host_to_docker",
      description: "Copy a file or directory from the host machine to your docker container",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "The path to the file or directory on the host machine"
          },
          destination: {
            type: "string",
            description: "The path to copy the file or directory to inside the docker container"
          }
        },
        required: ["source", "destination"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "copy_docker_to_host",
      description: "Copy a file or directory from your docker container to the host machine",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "The path to the file or directory inside the docker container"
          },
          destination: {
            type: "string",
            description: "The path to copy the file or directory to on the host machine"
          }
        },
        required: ["source", "destination"]
      }
    }
  }
];

export const HOST_VIEWIMAGE_TOOL: Tool = {
  type: "function",
  function: {
    name: "host_view_image",
    description: "View a png, jpeg or webp image from the host machine.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the image to view on the host machine"
        }
      },
      required: ["path"]
    }
  }
}

/**
 * Names of every tool that reaches the host machine: the shell, filesystem and
 * image tools plus the `docker cp` bridges. Membership in this set is what
 * triggers the per-call user approval prompt in `Chat`.
 */
export const HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...HOST_TOOLS.map((tool) => tool.function.name),
  HOST_VIEWIMAGE_TOOL.function.name,
]);

