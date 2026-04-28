import { Env, loadConfig } from "./config";
import { stopStream } from "./deepseek";
import { handleModels, handleChatCompletions } from "./openai";
import {
  handleClaudeModels,
  handleClaudeMessages,
  handleClaudeCountTokens,
  handleClaudeStopStream,
} from "./claude";
import { corsHeaders, jsonResponse, errorResponse, AppConfig } from "./utils";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>服务已启动</title></head><body><p>deepseek-to-api 已启动！</p></body></html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
          }
        );
      }

      if (pathname === "/v1/models" && request.method === "GET") {
        return await handleModels();
      }

      if (pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletions(request, env);
      }

      if (pathname === "/v1/chat/stop_stream" && request.method === "POST") {
        return await handleOpenAIStopStream(request, env);
      }

      if (pathname === "/anthropic/v1/models" && request.method === "GET") {
        return await handleClaudeModels();
      }

      if (pathname === "/anthropic/v1/messages" && request.method === "POST") {
        return await handleClaudeMessages(request, env);
      }

      if (pathname === "/anthropic/v1/messages/count_tokens" && request.method === "POST") {
        return await handleClaudeCountTokens(request, env);
      }

      if (pathname === "/anthropic/v1/messages/stop_stream" && request.method === "POST") {
        return await handleClaudeStopStream(request, env);
      }

      return errorResponse("Not Found", 404);
    } catch (e) {
      console.error("[fetch] Unexpected error:", e);
      return errorResponse("Internal Server Error", 500);
    }
  },
};

async function handleOpenAIStopStream(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized: missing Bearer token.", 401);
  }
  const callerKey = authHeader.replace("Bearer ", "").trim();

  const config = await loadConfig(env);

  const configKeys = config.keys || [];
  let deepseekToken = callerKey;

  if (configKeys.includes(callerKey)) {
    const { chooseAccount } = await import("./config");
    const chosen = await chooseAccount(env);
    if (!chosen) {
      return errorResponse("No accounts configured.", 429);
    }
    deepseekToken = chosen.account.token || "";
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const chatSessionId = body.chat_session_id as string;
  const messageId = body.message_id as number | undefined;

  if (!chatSessionId) {
    return errorResponse("Missing chat_session_id parameter.", 400);
  }

  try {
    const resp = await stopStream(deepseekToken, chatSessionId, messageId);
    if (resp.status === 200) {
      return jsonResponse({ success: true, message: "已停止流式响应" });
    }
    return jsonResponse({ success: false, message: `停止失败: ${resp.status}` }, resp.status);
  } catch (e) {
    return errorResponse(`停止流式响应失败: ${String(e)}`, 500);
  }
}
