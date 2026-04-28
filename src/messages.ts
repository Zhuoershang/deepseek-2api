interface ToolCallFunction {
  name: string;
  arguments: string;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: ToolCallFunction;
}

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function extractText(content: Message["content"]): string {
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("\n");
  }
  return String(content);
}

export function messagesPrepare(messages: Message[]): string {
  if (messages.length === 0) return "";

  const processed = messages.map((m) => ({
    role: m.role || "",
    text: extractText(m.content),
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
  }));

  const hasHistory = processed.some((m) => m.role === "assistant" || m.role === "tool");

  if (!hasHistory) {
    // 单轮：拼合 system + user，用 special token 格式
    const merged = [processed[0]];
    for (const msg of processed.slice(1)) {
      if (msg.role === merged[merged.length - 1].role) {
        merged[merged.length - 1].text += "\n\n" + msg.text;
      } else {
        merged.push(msg);
      }
    }
    const parts: string[] = [];
    for (let idx = 0; idx < merged.length; idx++) {
      const { role, text } = merged[idx];
      if (role === "assistant") {
        parts.push(`<｜Assistant｜>${text}<｜end▁of▁sentence｜>`);
      } else {
        parts.push(idx > 0 ? `<｜User｜>${text}` : text);
      }
    }
    return parts.join("");
  }

  // 多轮：纯文本 User/Assistant/Tool 格式，system 提前作前缀
  const systemParts = processed.filter((m) => m.role === "system").map((m) => m.text);
  const turns = processed.filter((m) => m.role !== "system");

  const parts: string[] = [];
  if (systemParts.length > 0) {
    parts.push(systemParts.join("\n\n"));
    parts.push("");
  }
  for (const m of turns) {
    if (m.role === "tool") {
      const id = m.tool_call_id ? ` (${m.tool_call_id})` : "";
      parts.push(`Tool result${id}: ${m.text}`);
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        parts.push(`Assistant: ${JSON.stringify({ tool_calls: m.tool_calls })}`);
      } else {
        parts.push(`Assistant: ${m.text}`);
      }
    } else {
      parts.push(`User: ${m.text}`);
    }
  }
  return parts.join("\n");
}
