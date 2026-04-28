export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-requested-with",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

export function sseResponse(readable: ReadableStream<Uint8Array>): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

export function parseSSELine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("data:")) {
    return trimmed.slice(5).trim();
  }
  return null;
}

export async function* readSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = parseSSELine(line);
        if (data !== null) {
          yield data;
        }
      }
    }
    if (buffer.trim()) {
      const data = parseSSELine(buffer);
      if (data !== null) {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function getAccountIdentifier(account: Account): string {
  return (account.email || "").trim() || (account.mobile || "").trim();
}

export interface Account {
  email?: string;
  mobile?: string;
  password?: string;
  token?: string;
}

export interface AppConfig {
  keys: string[];
  accounts: Account[];
  claude_model_mapping?: {
    fast: string;
    slow: string;
  };
}
