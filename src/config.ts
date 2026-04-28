import { AppConfig, Account, getAccountIdentifier } from "./utils";

export async function loadConfig(env: Env): Promise<AppConfig> {
  try {
    const kvData = await env.DEEPSEEK_CONFIG.get("config");
    if (kvData) {
      return JSON.parse(kvData) as AppConfig;
    }
  } catch (e) {
    console.warn("[loadConfig] KV read failed:", e);
  }
  try {
    const envConfig = env.CONFIG_JSON || '{"keys":[],"accounts":[]}';
    return JSON.parse(envConfig) as AppConfig;
  } catch (e) {
    console.warn("[loadConfig] ENV config parse failed:", e);
    return { keys: [], accounts: [] };
  }
}

export async function saveConfig(env: Env, cfg: AppConfig): Promise<void> {
  try {
    await env.DEEPSEEK_CONFIG.put("config", JSON.stringify(cfg));
  } catch (e) {
    console.error("[saveConfig] KV write failed:", e);
  }
}

export async function chooseAccount(
  env: Env,
  excludeIds: string[] = []
): Promise<{ account: Account; config: AppConfig } | null> {
  const config = await loadConfig(env);
  const accounts = config.accounts || [];
  const available = accounts.filter((acc) => {
    const id = getAccountIdentifier(acc);
    return id && !excludeIds.includes(id);
  });
  if (available.length === 0) {
    console.warn("[chooseAccount] No available accounts");
    return null;
  }
  // 随机选择一个
  const idx = Math.floor(Math.random() * available.length);
  const account = available[idx];
  console.info(`[chooseAccount] Selected account: ${getAccountIdentifier(account)}`);
  return { account, config };
}

export async function updateAccountToken(
  env: Env,
  account: Account,
  token: string
): Promise<void> {
  const config = await loadConfig(env);
  const targetId = getAccountIdentifier(account);
  for (const acc of config.accounts) {
    if (getAccountIdentifier(acc) === targetId) {
      acc.token = token;
      break;
    }
  }
  await saveConfig(env, config);
}

export interface Env {
  CONFIG_JSON: string;
  DEEPSEEK_CONFIG: KVNamespace;
}
