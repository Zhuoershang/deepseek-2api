import { Env, chooseAccount, updateAccountToken, loadConfig } from "./config";
import { createSession, getPowResponse, callCompletion, deleteSession, loginDeepseek } from "./deepseek";
import { messagesPrepare } from "./messages";
import { detectAndParseToolCalls, buildToolSystemPrompt } from "./tools";
import {
  jsonResponse,
  sseResponse,
  errorResponse,
  estimateTokens,
  currentTimestamp,
  readSSEStream,
  getAccountIdentifier,
  Account,
  AppConfig,
} from "./utils";

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: Array<{
    type?: string;
    function?: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
}

function getModelFlags(model: string): { thinking: boolean; search: boolean } {
  const m = model.toLowerCase();
  if (m === "deepseek-v3" || m === "deepseek-chat" || m === "deepseek-v4-flash" || m === "deepseek-v4-pro") return { thinking: false, search: false };
  if (m === "deepseek-r1" || m === "deepseek-reasoner" || m === "deepseek-v4-pro-thinking") return { thinking: true, search: false };
  if (m === "deepseek-v3-search" || m === "deepseek-chat-search" || m === "deepseek-v4-flash-search" || m === "deepseek-v4-pro-search") return { thinking: false, search: true };
  if (m === "deepseek-r1-search" || m === "deepseek-reasoner-search" || m === "deepseek-v4-pro-thinking-search") return { thinking: true, search: true };
  throw new Error(`Model '${model}' is not available.`);
}

export async function handleModels(): Promise<Response> {
  const modelsList = [
    { id: "deepseek-v4-pro", object: "model", created: 1745452800, owned_by: "deepseek", permission: [] },
    { id: "deepseek-v4-flash", object: "model", created: 1745452800, owned_by: "deepseek", permission: [] },
    { id: "deepseek-v4-pro-thinking", object: "model", created: 1745452800, owned_by: "deepseek", permission: [] },
    { id: "deepseek-v4-pro-search", object: "model", created: 1745452800, owned_by: "deepseek", permission: [] },
    { id: "deepseek-v4-flash-search", object: "model", created: 1745452800, owned_by: "deepseek", permission: [] },
    { id: "deepseek-chat", object: "model", created: 1677610602, owned_by: "deepseek", permission: [] },
    { id: "deepseek-reasoner", object: "model", created: 1677610602, owned_by: "deepseek", permission: [] },
    { id: "deepseek-chat-search", object: "model", created: 1677610602, owned_by: "deepseek", permission: [] },
    { id: "deepseek-reasoner-search", object: "model", created: 1677610602, owned_by: "deepseek", permission: [] },
  ];
  return jsonResponse({ object: "list", data: modelsList });
}

export async function handleChatCompletions(
  request: Request,
  env: Env
): Promise<Response> {
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
    console.log("[chat_completions] Account chosen:", getAccountIdentifier(currentAccount), "token:", currentAccount.token || "(empty)");
    if (!currentAccount.token?.trim()) {
      try {
        console.log("[chat_completions] Logging in...");
        const newToken = await loginDeepseek(currentAccount);
        console.log("[chat_completions] Login success, token length:", newToken.length);
        currentAccount.token = newToken;
        await updateAccountToken(env, currentAccount, newToken);
      } catch (e) {
        console.error("[chat_completions] Account login failed:", e);
        return errorResponse("Account login failed.", 500);
      }
    }
    deepseekToken = currentAccount.token!;
    console.log("[chat_completions] Using token (first 20 chars):", deepseekToken.slice(0, 20));
  }

  let reqData: ChatCompletionRequest;
  try {
    reqData = (await request.json()) as ChatCompletionRequest;
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const model = reqData.model;
  const messages = reqData.messages || [];
  if (!model || !messages.length) {
    return errorResponse("Request must include 'model' and 'messages'.", 400);
  }

  let thinkingEnabled: boolean;
  let searchEnabled: boolean;
  try {
    const flags = getModelFlags(model);
    thinkingEnabled = flags.thinking;
    searchEnabled = flags.search;
  } catch (e: unknown) {
    return errorResponse((e as Error).message, 503);
  }

  const toolsRequested = reqData.tools || [];
  const hasTools = toolsRequested.length > 0;

  let mutableMessages = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  if (hasTools) {
    const toolPrompt = buildToolSystemPrompt(toolsRequested);
    let systemFound = false;
    for (const msg of mutableMessages) {
      if (msg.role === "system") {
        msg.content = (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)) + "\n\n" + toolPrompt;
        systemFound = true;
        break;
      }
    }
    if (!systemFound) {
      mutableMessages.unshift({ role: "system", content: toolPrompt });
    }
  }

  const finalPrompt = messagesPrepare(mutableMessages);

  const sessionResult = await createSession(env, deepseekToken, useConfigToken, triedAccounts, currentAccount);
  if (!sessionResult) {
    return errorResponse("invalid token.", 401);
  }
  const { sessionId, token: sessionToken, account: sessionAccount } = sessionResult;
  currentAccount = sessionAccount;
  deepseekToken = sessionToken;

  const powResult = await getPowResponse(env, deepseekToken, useConfigToken, triedAccounts, currentAccount);
  if (!powResult) {
    return errorResponse("Failed to get PoW (invalid token or unknown error).", 401);
  }
  const { powResponse, token: powToken, account: powAccount } = powResult;
  currentAccount = powAccount;
  deepseekToken = powToken;

  const headers = { ...getAuthHeaders(deepseekToken), "x-ds-pow-response": powResponse };
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
    return errorResponse("Failed to get completion.", 500);
  }

  const createdTime = currentTimestamp();
  const completionId = sessionId;

  if (reqData.stream) {
    if (deepseekResp.status !== 200) {
      const body = await deepseekResp.text();
      return jsonResponse(JSON.parse(body || "{}"), deepseekResp.status);
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const processStream = async () => {
      let finalText = "";
      let finalThinking = "";
      let firstChunkSent = false;
      let ptype: "text" | "thinking" = "text";
      let fragType = "RESPONSE"; // V4格式：追踪当前活跃 fragment 类型

      const emitDelta = async (content: string, isThinking: boolean) => {
        if (isThinking) finalThinking += content;
        else finalText += content;
        if (hasTools) return; // 工具模式：全程缓冲，流结束后统一发送
        const deltaObj: Record<string, string> = {};
        if (!firstChunkSent) { deltaObj.role = "assistant"; firstChunkSent = true; }
        if (isThinking && thinkingEnabled) deltaObj.reasoning_content = content;
        else if (!isThinking) deltaObj.content = content;
        if (Object.keys(deltaObj).length > 0) {
          const outChunk = { id: completionId, object: "chat.completion.chunk", created: createdTime, model, choices: [{ delta: deltaObj, index: 0 }] };
          await writer.write(encoder.encode(`data: ${JSON.stringify(outChunk)}\n\n`));
        }
      };

      try {
        const body = deepseekResp.body;
        if (!body) return;

        for await (const dataStr of readSSEStream(body)) {
          if (dataStr === "[DONE]") break;
          try {
            const chunk = JSON.parse(dataStr) as Record<string, unknown>;
            if (chunk.p === "response/status" && chunk.v === "FINISHED") {
              break;
            }
            if (chunk.p === "response/search_status") continue;
            // V4新格式：初始化 fragments chunk
            if (!chunk.p && typeof chunk.v === "object" && chunk.v !== null && !Array.isArray(chunk.v)) {
              const fragments = ((chunk.v as Record<string, unknown>).response as Record<string, unknown> | undefined)?.fragments;
              if (Array.isArray(fragments) && fragments.length > 0) {
                for (const frag of fragments as Array<Record<string, unknown>>) {
                  if (typeof frag.content !== "string") continue;
                  await emitDelta(frag.content, frag.type === "THINK");
                }
                const last = fragments[fragments.length - 1] as Record<string, unknown>;
                fragType = last.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：新 fragment 追加（切换类型）
            if (chunk.p === "response/fragments" && Array.isArray(chunk.v)) {
              for (const frag of chunk.v as Array<Record<string, unknown>>) {
                if (typeof frag.content === "string") await emitDelta(frag.content, frag.type === "THINK");
                fragType = frag.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：content delta
            if (typeof chunk.v === "string" && (chunk.p === "response/fragments/-1/content" || !chunk.p)) {
              const s = chunk.v as string;
              if (searchEnabled && s.startsWith("[citation:")) continue;
              await emitDelta(s, fragType === "THINK");
              continue;
            }
            // 旧格式（V3）
            if (chunk.p === "response/thinking_content") ptype = "thinking";
            else if (chunk.p === "response/content") ptype = "text";
            const vValue = chunk.v;
            if (typeof vValue === "string") {
              const content = vValue;
              if (searchEnabled && content.startsWith("[citation:")) continue;
              await emitDelta(content, ptype === "thinking");
            } else if (Array.isArray(vValue)) {
              for (const item of vValue) {
                if ((item as Record<string, unknown>).p === "status" && (item as Record<string, unknown>).v === "FINISHED") {
                  break;
                }
              }
            }
          } catch {
            // ignore parse errors
          }
        }

        // Detect tool calls
        let toolCallsDetected = null;
        let finalTextContent = finalText;
        if (hasTools) {
          const result = detectAndParseToolCalls(finalText);
          toolCallsDetected = result.toolCalls;
          finalTextContent = result.remainingContent;

          if (toolCallsDetected) {
            // 标准流式工具调用格式：role chunk → tool_calls chunk
            await writer.write(encoder.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: createdTime, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
            for (let i = 0; i < toolCallsDetected.length; i++) {
              const tc = { index: i, ...toolCallsDetected[i] };
              await writer.write(encoder.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: createdTime, model, choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] })}\n\n`));
            }
          } else if (finalTextContent) {
            // 有工具定义但模型直接回答：发完整内容块
            await writer.write(encoder.encode(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: createdTime, model, choices: [{ index: 0, delta: { role: "assistant", content: finalTextContent }, finish_reason: null }] })}\n\n`));
          }
        }

        const promptTokens = estimateTokens(finalPrompt);
        const thinkingTokens = estimateTokens(finalThinking);
        const completionTokens = estimateTokens(finalTextContent);
        const finishReason = toolCallsDetected ? "tool_calls" : "stop";

        const finishChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTime,
          model,
          choices: [{ delta: {}, index: 0, finish_reason: finishReason }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: thinkingTokens + completionTokens,
            total_tokens: promptTokens + thinkingTokens + completionTokens,
            completion_tokens_details: { reasoning_tokens: thinkingTokens },
          },
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        console.error("[sse_stream] Error:", e);
      } finally {
        await writer.close();
        await deleteSession(deepseekToken, sessionId);
      }
    };

    // Start processing without awaiting to allow immediate response
    processStream().catch(console.error);

    return sseResponse(readable);
  } else {
    // Non-streaming
    let thinkList: string[] = [];
    let textList: string[] = [];
    let finished = false;

    try {
      const body = deepseekResp.body;
      if (body) {
        let ptype: "text" | "thinking" = "text";
        let fragType = "RESPONSE"; // V4格式：追踪当前活跃 fragment 类型（THINK/RESPONSE）
        for await (const dataStr of readSSEStream(body)) {
          if (dataStr === "[DONE]") break;
          try {
            const chunk = JSON.parse(dataStr) as Record<string, unknown>;
            if (chunk.p === "response/status" && chunk.v === "FINISHED") {
              finished = true;
              break;
            }
            if (chunk.p === "response/search_status") continue;
            // V4新格式：初始化 fragments chunk（无 p 字段，v.response.fragments 存在）
            if (!chunk.p && typeof chunk.v === "object" && chunk.v !== null && !Array.isArray(chunk.v)) {
              const fragments = ((chunk.v as Record<string, unknown>).response as Record<string, unknown> | undefined)?.fragments;
              if (Array.isArray(fragments) && fragments.length > 0) {
                for (const frag of fragments as Array<Record<string, unknown>>) {
                  if (typeof frag.content === "string") {
                    if (frag.type === "THINK") thinkList.push(frag.content);
                    else textList.push(frag.content);
                  }
                }
                const last = fragments[fragments.length - 1] as Record<string, unknown>;
                fragType = last.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：新 fragment 追加（p="response/fragments"，v 是数组）
            if (chunk.p === "response/fragments" && Array.isArray(chunk.v)) {
              for (const frag of chunk.v as Array<Record<string, unknown>>) {
                if (typeof frag.content === "string") {
                  if (frag.type === "THINK") thinkList.push(frag.content);
                  else textList.push(frag.content);
                }
                fragType = frag.type === "THINK" ? "THINK" : "RESPONSE";
              }
              continue;
            }
            // V4新格式：content delta（p="response/fragments/-1/content" 或无 p）
            if (typeof chunk.v === "string" && (chunk.p === "response/fragments/-1/content" || !chunk.p)) {
              const s = chunk.v as string;
              if (searchEnabled && s.startsWith("[citation:")) continue;
              if (fragType === "THINK") thinkList.push(s);
              else textList.push(s);
              continue;
            }
            // 旧格式（V3 兼容）
            if (chunk.p === "response/thinking_content") ptype = "thinking";
            else if (chunk.p === "response/content") ptype = "text";
            const vValue = chunk.v;
            if (typeof vValue === "string") {
              if (searchEnabled && vValue.startsWith("[citation:")) continue;
              if (ptype === "thinking") thinkList.push(vValue);
              else textList.push(vValue);
            } else if (Array.isArray(vValue)) {
              for (const item of vValue) {
                if ((item as Record<string, unknown>).p === "status" && (item as Record<string, unknown>).v === "FINISHED") {
                  finished = true;
                  break;
                }
              }
              if (finished) break;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (e) {
      console.error("[chat_completions] Non-stream error:", e);
    }

    const finalContent = textList.join("");
    const finalReasoning = thinkList.join("");

    let toolCallsDetected = null;
    let displayContent = finalContent;
    if (hasTools) {
      const result = detectAndParseToolCalls(finalContent);
      toolCallsDetected = result.toolCalls;
      displayContent = result.remainingContent;
    }

    const promptTokens = estimateTokens(finalPrompt);
    const reasoningTokens = estimateTokens(finalReasoning);
    const completionTokens = estimateTokens(displayContent);
    const finishReason = toolCallsDetected ? "tool_calls" : "stop";

    const messageObj: Record<string, unknown> = {
      role: "assistant",
      content: displayContent,
      reasoning_content: finalReasoning,
    };
    if (toolCallsDetected) {
      messageObj.tool_calls = toolCallsDetected;
    }

    const result = {
      id: completionId,
      object: "chat.completion",
      created: createdTime,
      model,
      choices: [
        {
          index: 0,
          message: messageObj,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: reasoningTokens + completionTokens,
        total_tokens: promptTokens + reasoningTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
    };

    await deleteSession(deepseekToken, sessionId);
    return jsonResponse(result);
  }
}

function getAuthHeaders(token: string): Record<string, string> {
  return {
    Host: "chat.deepseek.com",
    "User-Agent": "DeepSeek/2.0 Android/35",
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "Content-Type": "application/json",
    "x-client-platform": "android",
    "x-client-version": "2.0.0",
    "x-client-locale": "zh_CN",
    "accept-charset": "UTF-8",
    authorization: `Bearer ${token}`,
  };
}
