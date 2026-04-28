import { chooseAccount, updateAccountToken, Env } from "./config";
import { computePowAnswer } from "./pow";
import { Account, getAccountIdentifier } from "./utils";

const DEEPSEEK_HOST = "chat.deepseek.com";
const DEEPSEEK_LOGIN_URL = `https://${DEEPSEEK_HOST}/api/v0/users/login`;
const DEEPSEEK_CREATE_SESSION_URL = `https://${DEEPSEEK_HOST}/api/v0/chat_session/create`;
const DEEPSEEK_CREATE_POW_URL = `https://${DEEPSEEK_HOST}/api/v0/chat/create_pow_challenge`;
const DEEPSEEK_COMPLETION_URL = `https://${DEEPSEEK_HOST}/api/v0/chat/completion`;
const DEEPSEEK_STOP_STREAM_URL = `https://${DEEPSEEK_HOST}/api/v0/chat/stop_stream`;
const DEEPSEEK_DELETE_SESSION_URL = `https://${DEEPSEEK_HOST}/api/v0/chat_session/delete`;

const BASE_HEADERS: Record<string, string> = {
  Host: "chat.deepseek.com",
  "User-Agent": "DeepSeek/2.0 Android/35",
  Accept: "application/json",
  "Accept-Encoding": "gzip",
  "Content-Type": "application/json",
  "x-client-platform": "android",
  "x-client-version": "2.0.0",
  "x-client-locale": "zh_CN",
  "accept-charset": "UTF-8",
};

function getAuthHeaders(token: string): Record<string, string> {
  return { ...BASE_HEADERS, authorization: `Bearer ${token}` };
}

export async function loginDeepseek(account: Account): Promise<string> {
  const email = (account.email || "").trim();
  const mobile = (account.mobile || "").trim();
  const password = (account.password || "").trim();
  if (!password || (!email && !mobile)) {
    throw new Error("Account missing required login info");
  }

  let payload: Record<string, unknown>;
  if (email) {
    payload = {
      email,
      password,
      device_id: "deepseek_to_api",
      os: "android",
    };
  } else {
    payload = {
      mobile,
      area_code: null,
      password,
      device_id: "deepseek_to_api",
      os: "android",
    };
  }

  const resp = await fetch(DEEPSEEK_LOGIN_URL, {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Login request failed: ${resp.status}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  console.log("[loginDeepseek] Response:", JSON.stringify(data));
  const bizData = (data.data as Record<string, unknown>)?.biz_data as Record<string, unknown>;
  const user = bizData?.user as Record<string, unknown>;
  const newToken = user?.token as string | undefined;
  if (!newToken) {
    throw new Error(`Login response missing token. Response: ${JSON.stringify(data)}`);
  }
  return newToken;
}

export async function createSession(
  env: Env,
  token: string,
  useConfigToken: boolean,
  triedAccounts: string[],
  currentAccount: Account | null
): Promise<{ sessionId: string; token: string; account: Account | null } | null> {
  let attempts = 0;
  const maxAttempts = 3;
  let currentToken = token;
  let currentAcc = currentAccount;

  while (attempts < maxAttempts) {
    const headers = getAuthHeaders(currentToken);
    try {
      const resp = await fetch(DEEPSEEK_CREATE_SESSION_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ character_id: null }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (resp.status === 200 && data.code === 0) {
        const bizData = (data.data as Record<string, unknown>)?.biz_data as Record<string, unknown>;
        const chatSession = bizData?.chat_session as Record<string, unknown>;
        const sessionId = chatSession?.id as string;
        if (sessionId) {
          return { sessionId, token: currentToken, account: currentAcc };
        }
      }
      console.warn(`[createSession] Failed, code=${data.code}, msg=${data.msg}`);
    } catch (e) {
      console.error(`[createSession] Request error:`, e);
    }

    if (useConfigToken) {
      const currentId = currentAcc ? getAccountIdentifier(currentAcc) : "";
      if (currentId && !triedAccounts.includes(currentId)) {
        triedAccounts.push(currentId);
      }
      const chosen = await chooseAccount(env, triedAccounts);
      if (!chosen) break;
      currentAcc = chosen.account;
      try {
        currentToken = await loginDeepseek(currentAcc);
        await updateAccountToken(env, currentAcc, currentToken);
      } catch (e) {
        console.error(`[createSession] Account login failed:`, e);
        attempts++;
        continue;
      }
    } else {
      attempts++;
    }
  }
  return null;
}

export async function getPowResponse(
  env: Env,
  token: string,
  useConfigToken: boolean,
  triedAccounts: string[],
  currentAccount: Account | null
): Promise<{ powResponse: string; token: string; account: Account | null } | null> {
  let attempts = 0;
  const maxAttempts = 3;
  let currentToken = token;
  let currentAcc = currentAccount;

  while (attempts < maxAttempts) {
    const headers = getAuthHeaders(currentToken);
    try {
      const resp = await fetch(DEEPSEEK_CREATE_POW_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (resp.status === 200 && data.code === 0) {
        const challenge = ((data.data as Record<string, unknown>)?.biz_data as Record<string, unknown>)?.challenge as Record<string, unknown>;
        if (challenge) {
          const difficulty = (challenge.difficulty as number) || 144000;
          const expireAt = (challenge.expire_at as number) || 1680000000;
          try {
            const answer = computePowAnswer(
              challenge.algorithm as string,
              challenge.challenge as string,
              challenge.salt as string,
              difficulty,
              expireAt,
              challenge.signature as string,
              challenge.target_path as string
            );
            if (answer === null) {
              console.warn("[getPowResponse] PoW answer computation failed");
              attempts++;
              continue;
            }
            const powDict = {
              algorithm: challenge.algorithm,
              challenge: challenge.challenge,
              salt: challenge.salt,
              answer,
              signature: challenge.signature,
              target_path: challenge.target_path,
            };
            const powStr = JSON.stringify(powDict, null, 0);
            const encoded = btoa(powStr).replace(/=/g, "");
            return { powResponse: encoded, token: currentToken, account: currentAcc };
          } catch (e) {
            console.error(`[getPowResponse] PoW computation error:`, e);
            attempts++;
            continue;
          }
        }
      }
      console.warn(`[getPowResponse] Failed, code=${data.code}, msg=${data.msg}`);
    } catch (e) {
      console.error(`[getPowResponse] Request error:`, e);
    }

    if (useConfigToken) {
      const currentId = currentAcc ? getAccountIdentifier(currentAcc) : "";
      if (currentId && !triedAccounts.includes(currentId)) {
        triedAccounts.push(currentId);
      }
      const chosen = await chooseAccount(env, triedAccounts);
      if (!chosen) break;
      currentAcc = chosen.account;
      try {
        currentToken = await loginDeepseek(currentAcc);
        await updateAccountToken(env, currentAcc, currentToken);
      } catch (e) {
        console.error(`[getPowResponse] Account login failed:`, e);
        attempts++;
        continue;
      }
    } else {
      attempts++;
    }
  }
  return null;
}

export async function callCompletion(
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  maxAttempts = 3
): Promise<Response | null> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const resp = await fetch(DEEPSEEK_COMPLETION_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (resp.status === 200) {
        return resp;
      }
      console.warn(`[callCompletion] Failed, status: ${resp.status}`);
    } catch (e) {
      console.warn(`[callCompletion] Request error:`, e);
    }
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;
  }
  return null;
}

export async function deleteSession(token: string, sessionId: string): Promise<void> {
  try {
    const headers = getAuthHeaders(token);
    const resp = await fetch(DEEPSEEK_DELETE_SESSION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_session_id: sessionId }),
    });
    if (resp.status === 200) {
      console.info(`[deleteSession] Deleted session ${sessionId}`);
    } else {
      console.warn(`[deleteSession] Failed: ${resp.status}`);
    }
  } catch (e) {
    console.warn(`[deleteSession] Error:`, e);
  }
}

export async function stopStream(token: string, sessionId: string, messageId?: number): Promise<Response> {
  const headers = getAuthHeaders(token);
  const payload: Record<string, unknown> = { chat_session_id: sessionId };
  if (messageId !== undefined) {
    payload.message_id = messageId;
  }
  return fetch(DEEPSEEK_STOP_STREAM_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}
