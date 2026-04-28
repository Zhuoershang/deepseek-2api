interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export function detectAndParseToolCalls(content: string): { toolCalls: ToolCall[] | null; remainingContent: string } {
  let toolCalls: ToolCall[] | null = null;
  let remainingContent = content;

  // 模式1: {"tool_calls": [...]}
  const pattern1 = /\{\s*"tool_calls"\s*:\s*\[/s;
  const match1 = content.match(pattern1);
  if (match1) {
    try {
      // 尝试找到完整的JSON对象
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = match1.index!;
      for (let i = match1.index!; i < content.length; i++) {
        const ch = content[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"' && !inString) {
          inString = true;
        } else if (ch === '"' && inString) {
          inString = false;
        } else if (!inString) {
          if (ch === "{" || ch === "[") depth++;
          else if (ch === "}" || ch === "]") depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      const jsonStr = content.slice(match1.index!, endIdx);
      const parsed = JSON.parse(jsonStr);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        toolCalls = validateToolCalls(parsed.tool_calls);
        if (toolCalls) {
          remainingContent = (content.slice(0, match1.index!) + content.slice(endIdx)).trim();
        }
      }
    } catch {
      // ignore
    }
  }

  return { toolCalls, remainingContent };
}

function validateToolCalls(calls: unknown[]): ToolCall[] | null {
  const validCalls: ToolCall[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (typeof call !== "object" || call === null) continue;
    const c = call as Record<string, unknown>;
    const callId = (c.id as string) || `call_${String(i + 1).padStart(3, "0")}`;
    const callType = (c.type as string) || "function";
    const func = c.function;
    if (typeof func === "object" && func !== null) {
      const f = func as Record<string, unknown>;
      const name = f.name as string;
      if (!name) continue;
      let args = f.arguments || "{}";
      if (typeof args === "object") {
        args = JSON.stringify(args);
      }
      validCalls.push({
        id: callId,
        type: callType,
        function: {
          name,
          arguments: String(args),
        },
      });
    }
  }
  return validCalls.length > 0 ? validCalls : null;
}

export function buildToolSystemPrompt(tools: Array<{
  type?: string;
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
}>): string {
  const toolSchemas: string[] = [];
  for (const tool of tools) {
    const func = tool.function;
    if (!func) continue;
    const toolName = func.name || "unknown";
    const toolDesc = func.description || "No description available";
    const params = func.parameters || {};
    let toolInfo = `Tool: ${toolName}\nDescription: ${toolDesc}`;
    const properties = (params as Record<string, unknown>).properties as Record<string, { type?: string; description?: string }> | undefined;
    if (properties) {
      const props: string[] = [];
      const required = ((params as Record<string, unknown>).required as string[]) || [];
      for (const [propName, propInfo] of Object.entries(properties)) {
        const propType = propInfo.type || "string";
        const propDesc = propInfo.description || "";
        const isReq = required.includes(propName) ? " (required)" : "";
        props.push(`  - ${propName}: ${propType}${isReq} - ${propDesc}`);
      }
      if (props.length) {
        toolInfo += `\nParameters:\n${props.join("\n")}`;
      }
    }
    toolSchemas.push(toolInfo);
  }

  return `You have access to the following tools:

${toolSchemas.join("\n\n")}

When you need to use a tool, respond with a JSON object in this exact format:
{"tool_calls": [{"id": "call_xxx", "type": "function", "function": {"name": "tool_name", "arguments": "{\\"param\\": \\"value\\"}"}}]}

You can call multiple tools in one response by adding more objects to the tool_calls array.
IMPORTANT: The "arguments" field must be a JSON string, not a JSON object.

Example:
{"tool_calls": [{"id": "call_001", "type": "function", "function": {"name": "get_weather", "arguments": "{\\"location\\": \\"Beijing\\"}"}}]}

After calling tools, you will receive the results and can continue the conversation.`;
}

export function buildClaudeToolSystemPrompt(tools: Array<{
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}>): string {
  const toolSchemas: string[] = [];
  for (const tool of tools) {
    const toolName = tool.name || "unknown";
    const toolDesc = tool.description || "No description available";
    const schema = tool.input_schema || {};
    let toolInfo = `Tool: ${toolName}\nDescription: ${toolDesc}`;
    const properties = schema.properties as Record<string, { type?: string }> | undefined;
    if (properties) {
      const props: string[] = [];
      const required = (schema.required as string[]) || [];
      for (const [propName, propInfo] of Object.entries(properties)) {
        const propType = propInfo.type || "string";
        const isReq = required.includes(propName) ? " (required)" : "";
        props.push(`  - ${propName}: ${propType}${isReq}`);
      }
      if (props.length) {
        toolInfo += `\nParameters:\n${props.join("\n")}`;
      }
    }
    toolSchemas.push(toolInfo);
  }

  return `You are Claude, a helpful AI assistant. You have access to these tools:

${toolSchemas.join("\n\n")}

When you need to use tools, you can call multiple tools in a single response. Use this format:

{"tool_calls": [
  {"name": "tool1", "input": {"param": "value"}},
  {"name": "tool2", "input": {"param": "value"}}
]}

IMPORTANT: You can call multiple tools in ONE response. If you need to:
1. Create a directory - include that in tool_calls
2. Write a file - include that in the SAME tool_calls array
3. Run a command - include that in the SAME tool_calls array

Example of multiple tool calls in one response:
{"tool_calls": [
  {"name": "str_replace_editor", "input": {"command": "create", "path": "pp1/hello.py", "file_text": "print('Hello, World!')"}},
  {"name": "Bash", "input": {"command": "python pp1/hello.py"}}
]}

Examples:
- For TodoWrite: {"name": "TodoWrite", "input": {"todos": [{"content": "task", "status": "pending", "activeForm": "doing task"}]}}
- For str_replace_editor: {"name": "str_replace_editor", "input": {"command": "create", "path": "file.py", "file_text": "code"}}}
- For Bash: {"name": "Bash", "input": {"command": "cd /path && python file.py"}}}

Remember: Output ONLY the JSON, no other text. The response must start with { and end with ]}}`;
}
