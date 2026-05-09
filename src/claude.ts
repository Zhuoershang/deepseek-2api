import { Env, chooseAccount, updateAccountToken, loadConfig } from "./config";
import { createSession, getPowResponse, callCompletion, deleteSession, stopStream, loginDeepseek } from "./deepseek";
import { messagesPrepare } from "./messages";
import { detectAndParseToolCalls, buildClaudeToolSystemPrompt } from "./tools";
import {
  jsonResponse,
  sseResponse,
  errorResponse,
  estimateTokens,
  currentTimestamp,
  readSSEStream,
  Account,
  AppConfig,
} from "./utils";

interface ClaudeMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; content?: unknown }>;
}

interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  stream?: boolean;
  system?: string;
  tools?: Array<{
    name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
}

function getDeepseekModel(model: string, config: AppConfig): string {
  const mapping = config.claude_model_mapping || { fast: "deepseek-chat", slow: "deepseek-chat" };
  const m = model.toLowerCase();
  if (m.includes("opus") || m.includes("reasoner") || m.includes("slow")) {
    return mapping.slow;
  }
  return mapping.fast;
}

export async function handleClaudeModels(): Promise<Response> {
  const modelsList = [
    { id: "claude-sonnet-4-20250514", object: "model", created: 1715635200, owned_by: "anthropic" },
    { id: "claude-sonnet-4-20250514-fast", object: "model", created: 1715635200, owned_by: "anthropic" },
    { id: "claude-sonnet-4-20250514-slow", object: "model", created: 1715635200, owned_by: "anthropic" },
  ];
  return jsonResponse({ object: "list", data: modelsList });
}

export async function handleClaudeMessages(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized: missing Bearer token.", 401);
  }
  const callerKey = authHeader.replace("Bearer ", "").trim();

  const config = await loadConfig(env);

  const configKeys = config.keys || [];
  let useConfigToken = false;
  let deepseekToken = callerKey;
  let currentAccount: Account | null = null;
  const triedAccounts: string[] = [];

  if (configKeys.includes(callerKey)) {
    useConfigToken = true;
    const chosen = await chooseAccount(env);
    if (!chosen) {
      return errorResponse("No accounts configured or all accounts are busy.", 429);
    }
    currentAccount = chosen.account;
    if (!currentAccount.token?.trim()) {
      try {
        const newToken = await loginDeepseek(currentAccount);
        currentAccount.token = newToken;
        await updateAccountToken(env, currentAccount, newToken);
      } catch (e) {
        console.error("[claude_messages] Account login failed:", e);
        return errorResponse("Account login failed.", 500);
      }
    }
    deepseekToken = currentAccount.token!;
  }

  let reqData: ClaudeRequest;
  try {
    reqData = (await request.json()) as ClaudeRequest;
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const model = reqData.model;
  const messages = reqData.messages || [];
  if (!model || !messages.length) {
    return errorResponse("Request must include 'model' and 'messages'.", 400);
  }

  // Normalize messages
  const normalizedMessages: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    let content = "";
    if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "tool_result" && block.content !== undefined) {
          parts.push(String(block.content));
        }
      }
      content = parts.join("\n");
    } else {
      content = String(message.content);
    }
    normalizedMessages.push({ role: message.role, content });
  }

  // Handle system param
  if (reqData.system) {
    normalizedMessages.unshift({ role: "system", content: reqData.system });
  }

  const toolsRequested = reqData.tools || [];
  const hasTools = toolsRequested.length > 0;

  if (hasTools && !normalizedMessages.some((m) => m.role === "system")) {
    const toolPrompt = buildClaudeToolSystemPrompt(toolsRequested);
    normalizedMessages.unshift({ role: "system", content: toolPrompt });
  }

  const deepseekModel = getDeepseekModel(model, config);
  const thinkingEnabled = deepseekModel.includes("reasoner") || deepseekModel.includes("r1") || deepseekModel.includes("v4-pro-thinking");
  const searchEnabled = deepseekModel.includes("search");

  const finalPrompt = messagesPrepare(normalizedMessages);

  const sessionResult = await createSession(env, deepseekToken, useConfigToken, triedAccounts, currentAccount);
  if (!sessionResult) {
    return errorResponse("invalid token.", 401);
  }
  let { sessionId, token: sessionToken, account: sessionAccount } = sessionResult;
  currentAccount = sessionAccount;
  deepseekToken = sessionToken;

  const powResult = await getPowResponse(env, deepseekToken, useConfigToken, triedAccounts, currentAccount);
  if (!powResult) {
    return errorResponse("Failed to get PoW (invalid token or unknown error).", 401);
  }
  let { powResponse, token: powToken, account: powAccount } = powResult;
  currentAccount = powAccount;
  deepseekToken = powToken;

  const headers = {
    Host: "chat.deepseek.com",
    "User-Agent": "DeepSeek/2.0 Android/35",
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "Content-Type": "application/json",
    "x-client-platform": "android",
    "x-client-version": "2.0.4",
    "x-client-locale": "zh_CN",
    "accept-charset": "UTF-8",
    authorization: `Bearer ${deepseekToken}`,
    "x-ds-pow-response": powResponse,
  };

  const payload = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt: finalPrompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchEnabled,
  };

  const deepseekResp = await callCompletion(payload, headers, 3);
  if (!deepseekResp) {
    return errorResponse("Failed to get Claude response.", 500);
  }

  if (deepseekResp.status !== 200) {
    return jsonResponse({ error: { type: "api_error", message: "Failed to get response" } }, 500);
  }

  const createdTime = currentTimestamp();

  if (reqData.stream) {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const processStream = async () => {
      try {
        const messageId = `msg_${createdTime}_${Math.floor(Math.random() * 9000) + 1000}`;
        const inputTokens = normalizedMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        let outputTokens = 0;

        let fullResponseText = "";
        let fullReasoningText = "";

        const body = deepseekResp.body;
        if (body) {
          let ptype: "text" | "thinking" = "text";
          let fragType = "RESPONSE";
          for await (const dataStr of readSSEStream(body)) {
            if (dataStr === "[DONE]") break;
            try {
              const chunk = JSON.parse(dataStr) as Record<string, unknown>;
              if (chunk.p === "response/search_status") continue;
              // V4新格式：初始化 fragments chunk
              if (!chunk.p && typeof chunk.v === "object" && chunk.v !== null && !Array.isArray(chunk.v)) {
                const fragments = ((chunk.v as Record<string, unknown>).response as Record<string, unknown> | undefined)?.fragments;
                if (Array.isArray(fragments) && fragments.length > 0) {
                  for (const frag of fragments as Array<Record<string, unknown>>) {
                    if (typeof frag.content === "string") {
                      if (frag.type === "THINK") fullReasoningText += frag.content;
                      else fullResponseText += frag.content;
                    }
                  }
                  const last = fragments[fragments.length - 1] as Record<string, unknown>;
                  fragType = last.type === "THINK" ? "THINK" : "RESPONSE";
                }
                continue;
              }
              // V4新格式：新 fragment 追加
              if (chunk.p === "response/fragments" && Array.isArray(chunk.v)) {
                for (const frag of chunk.v as Array<Record<string, unknown>>) {
                  if (typeof frag.content === "string") {
                    if (frag.type === "THINK") fullReasoningText += frag.content;
                    else fullResponseText += frag.content;
                  }
                  fragType = frag.type === "THINK" ? "THINK" : "RESPONSE";
                }
                continue;
              }
              // V4新格式：content delta
              if (typeof chunk.v === "string" && (chunk.p === "response/fragments/-1/content" || !chunk.p)) {
                if (fragType === "THINK") fullReasoningText += chunk.v as string;
                else fullResponseText += chunk.v as string;
                continue;
              }
              // 旧格式（V3）
              if (chunk.p === "response/thinking_content") ptype = "thinking";
              else if (chunk.p === "response/content") ptype = "text";
              const vValue = chunk.v;
              if (typeof vValue === "string") {
                if (ptype === "thinking") fullReasoningText += vValue;
                else fullResponseText += vValue;
              } else if (Array.isArray(vValue)) {
                for (const item of vValue) {
                  if ((item as Record<string, unknown>).p === "status" && (item as Record<string, unknown>).v === "FINISHED") {
                    break;
                  }
                }
              }
            } catch {
              // ignore
            }
          }
        }

        // 1. message_start
        const messageStart = {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(messageStart)}\n\n`));

        // Detect tools
        let detectedTools: Array<{ name: string; input: Record<string, unknown> }> = [];
        let toolDetected = false;
        const cleanedResponse = fullResponseText.trim();

        // Method 1: Full JSON
        if (cleanedResponse.startsWith('{"tool_calls":') && cleanedResponse.endsWith("]}") && hasTools) {
          try {
            const toolData = JSON.parse(cleanedResponse);
            for (const toolCall of toolData.tool_calls || []) {
              const toolName = toolCall.name;
              const toolInput = toolCall.input || {};
              if (toolsRequested.some((t) => t.name === toolName)) {
                detectedTools.push({ name: toolName, input: toolInput });
                toolDetected = true;
              }
            }
          } catch {
            // ignore
          }
        }

        // Method 2: Regex
        if (!toolDetected && hasTools) {
          const pattern = /\{\s*["']tool_calls["']\s*:\s*\[(.*?)\]\s*\}/s;
          const matches = cleanedResponse.match(pattern);
          if (matches) {
            try {
              const toolData = JSON.parse(matches[0]);
              for (const toolCall of toolData.tool_calls || []) {
                const toolName = toolCall.name;
                const toolInput = toolCall.input || {};
                if (toolsRequested.some((t) => t.name === toolName)) {
                  detectedTools.push({ name: toolName, input: toolInput });
                  toolDetected = true;
                }
              }
            } catch {
              // ignore
            }
          }
        }

        let contentIndex = 0;
        let stopReason: string;

        if (detectedTools.length > 0) {
          stopReason = "tool_use";
          for (const toolInfo of detectedTools) {
            const toolUseId = `toolu_${createdTime}_${Math.floor(Math.random() * 9000) + 1000}_${contentIndex}`;
            const startEvent = {
              type: "content_block_start",
              index: contentIndex,
              content_block: { type: "tool_use", id: toolUseId, name: toolInfo.name, input: toolInfo.input },
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(startEvent)}\n\n`));
            const stopEvent = { type: "content_block_stop", index: contentIndex };
            await writer.write(encoder.encode(`data: ${JSON.stringify(stopEvent)}\n\n`));
            contentIndex++;
            outputTokens += estimateTokens(JSON.stringify(toolInfo.input));
          }
        } else {
          stopReason = "end_turn";
          if (fullResponseText) {
            const startEvent = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
            await writer.write(encoder.encode(`data: ${JSON.stringify(startEvent)}\n\n`));
            const deltaEvent = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fullResponseText } };
            await writer.write(encoder.encode(`data: ${JSON.stringify(deltaEvent)}\n\n`));
            const stopEvent = { type: "content_block_stop", index: 0 };
            await writer.write(encoder.encode(`data: ${JSON.stringify(stopEvent)}\n\n`));
            outputTokens += estimateTokens(fullResponseText);
          }
        }

        // message_delta and message_stop
        const messageDelta = {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`));
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`));
      } catch (e) {
        console.error("[claude_sse_stream] Error:", e);
        const errorEvent = { type: "error", error: { type: "api_error", message: `Stream processing error: ${String(e)}` } };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
        await writer.close();
        await deleteSession(deepseekToken, sessionId);
      }
    };

    processStream().catch(console.error);
    return sseResponse(readable);
  } else {
    // Non-streaming
    let finalContent = "";
    let finalReasoning = "";

    try {
      const body = deepseekResp.body;
      if (body) {
        let ptype: "text" | "thinking" = "text";
        let fragType = "RESPONSE";
        for await (const dataStr of readSSEStream(body)) {
          if (dataStr === "[DONE]") break;
          try {
            const chunk = JSON.parse(dataStr) as Record<string, unknown>;
            if (chunk.p === "response/search_status") continue;
            // V4新格式：初始化 fragments chunk
            if (!chunk.p && typeof chunk.v === "object" && chunk.v !== null && !Array.isArray(chunk.v)) {
              const fragments = ((chunk.v as Record<string, unknown>).response as Record<string, unknown> | undefined)?.fragments;
              if (Array.isArray(fragments) && fragments.length > 0) {
                for (const frag of fragments as Array<Record<string, unknown>>) {
                  if (typeof frag.content === "string") {
                    if (frag.type === "THINK") finalReasoning += frag.content;
                    else finalContent += frag.content;
                  }
                }
                const last = fragments[fragments.length - 1] as Record<string, unknown>;
                fragType = last.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：新 fragment 追加
            if (chunk.p === "response/fragments" && Array.isArray(chunk.v)) {
              for (const frag of chunk.v as Array<Record<string, unknown>>) {
                if (typeof frag.content === "string") {
                  if (frag.type === "THINK") finalReasoning += frag.content;
                  else finalContent += frag.content;
                }
                fragType = frag.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：content delta
            if (typeof chunk.v === "string" && (chunk.p === "response/fragments/-1/content" || !chunk.p)) {
              if (fragType === "THINK") finalReasoning += chunk.v as string;
              else finalContent += chunk.v as string;
              continue;
            }
            // 旧格式（V3）
            if (chunk.p === "response/thinking_content") ptype = "thinking";
            else if (chunk.p === "response/content") ptype = "text";
            const vValue = chunk.v;
            if (typeof vValue === "string") {
              if (ptype === "thinking") finalReasoning += vValue;
              else finalContent += vValue;
            } else if (Array.isArray(vValue)) {
              for (const item of vValue) {
                if ((item as Record<string, unknown>).p === "status" && (item as Record<string, unknown>).v === "FINISHED") {
                  break;
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (e) {
      console.error("[claude_messages] Non-stream error:", e);
    }

    // Detect tools
    let detectedTools: Array<{ name: string; input: Record<string, unknown> }> = [];
    let toolDetected = false;
    const cleanedContent = finalContent.trim();

    if (hasTools) {
      if (cleanedContent.startsWith('{"tool_calls":') && cleanedContent.endsWith("]}")) {
        try {
          const toolData = JSON.parse(cleanedContent);
          for (const toolCall of toolData.tool_calls || []) {
            const toolName = toolCall.name;
            const toolInput = toolCall.input || {};
            if (toolsRequested.some((t) => t.name === toolName)) {
              detectedTools.push({ name: toolName, input: toolInput });
              toolDetected = true;
            }
          }
        } catch {
          // ignore
        }
      }

      if (!toolDetected) {
        const pattern = /\{\s*["']tool_calls["']\s*:\s*\[(.*?)\]\s*\}/s;
        const matches = cleanedContent.match(pattern);
        if (matches) {
          try {
            const toolData = JSON.parse(matches[0]);
            for (const toolCall of toolData.tool_calls || []) {
              const toolName = toolCall.name;
              const toolInput = toolCall.input || {};
              if (toolsRequested.some((t) => t.name === toolName)) {
                detectedTools.push({ name: toolName, input: toolInput });
                toolDetected = true;
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }

    const claudeResponse: Record<string, unknown> = {
      id: `msg_${createdTime}_${Math.floor(Math.random() * 9000) + 1000}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: detectedTools.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: normalizedMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
        output_tokens: estimateTokens(finalContent) + estimateTokens(finalReasoning),
      },
    };

    if (finalReasoning) {
      (claudeResponse.content as Array<Record<string, unknown>>).push({
        type: "thinking",
        thinking: finalReasoning,
      });
    }

    if (detectedTools.length > 0) {
      for (let i = 0; i < detectedTools.length; i++) {
        const toolInfo = detectedTools[i];
        const toolUseId = `toolu_${createdTime}_${Math.floor(Math.random() * 9000) + 1000}_${i}`;
        (claudeResponse.content as Array<Record<string, unknown>>).push({
          type: "tool_use",
          id: toolUseId,
          name: toolInfo.name,
          input: toolInfo.input,
        });
      }
    } else {
      (claudeResponse.content as Array<Record<string, unknown>>).push({
        type: "text",
        text: finalContent || "抱歉，没有生成有效的响应内容。",
      });
    }

    await deleteSession(deepseekToken, sessionId);
    return jsonResponse(claudeResponse);
  }
}

export async function handleClaudeCountTokens(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized: missing Bearer token.", 401);
  }

  let reqData: Record<string, unknown>;
  try {
    reqData = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const messages = (reqData.messages || []) as Array<{ role?: string; content?: unknown }>;
  const system = (reqData.system || "") as string;

  if (!messages.length) {
    return errorResponse("Request must include 'messages'.", 400);
  }

  function estTokens(text: unknown): number {
    if (typeof text === "string") return estimateTokens(text);
    if (Array.isArray(text)) {
      return text.reduce((sum, item) => {
        if (typeof item === "object" && item !== null) {
          const dict = item as Record<string, unknown>;
          if (dict.type === "text") return sum + estimateTokens(String(dict.text || ""));
          if (dict.type === "tool_result") return sum + estimateTokens(String(dict.content || ""));
          return sum + estimateTokens(JSON.stringify(item));
        }
        return sum + estimateTokens(String(item));
      }, 0);
    }
    return estimateTokens(String(text));
  }

  let inputTokens = 0;
  if (system) inputTokens += estTokens(system);

  for (const message of messages) {
    inputTokens += 2; // role marker
    inputTokens += estTokens(message.content);
  }

  const tools = (reqData.tools || []) as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
  for (const tool of tools) {
    inputTokens += estimateTokens(tool.name || "");
    inputTokens += estimateTokens(tool.description || "");
    inputTokens += estimateTokens(JSON.stringify(tool.input_schema || {}));
  }

  return jsonResponse({ input_tokens: Math.max(1, inputTokens) });
}

export async function handleClaudeStopStream(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized: missing Bearer token.", 401);
  }
  const callerKey = authHeader.replace("Bearer ", "").trim();

  const config = await loadConfig(env);

  const configKeys = config.keys || [];
  let deepseekToken = callerKey;

  if (configKeys.includes(callerKey)) {
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
