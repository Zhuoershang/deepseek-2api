# DeepSeek2API for Cloudflare Workers

> 基于 Cloudflare Workers 构建的高性能 DeepSeek API 网关，完整兼容 OpenAI 与 Anthropic Claude 协议，支持流式输出、工具调用、推理模式与联网搜索。

---

## 目录

- [项目概述](#项目概述)
- [功能特性](#功能特性)
- [技术架构](#技术架构)
- [前置要求](#前置要求)
- [快速部署](#快速部署)
- [配置详解](#配置详解)
- [API 使用指南](#api-使用指南)
- [模型映射对照表](#模型映射对照表)
- [常见问题排查](#常见问题排查)

---

## 项目概述

本项目将 DeepSeek 官方聊天服务转换为标准 OpenAI / Claude 兼容 API，使你能够在任何支持 OpenAI SDK 或 Claude SDK 的客户端中无缝使用 DeepSeek 的 deepseek-chat 与 deepseek-reasoner 模型。

核心能力包括：

- **多账号自动轮换**：基于 Cloudflare KV 持久化存储账号 Token，单账号失效时自动切换
- **PoW 工作量证明**：集成 WebAssembly 模块，自动完成 DeepSeek 反爬验证
- **流式与非流式输出**：完整支持 SSE 流式传输，延迟低至毫秒级
- **工具调用（Function Calling）**：自动检测并解析模型输出的 tool_calls JSON
- **推理链展示**：deepseek-reasoner 的 thinking 过程通过 reasoning_content 字段透出
- **零服务器运维**：依托 Cloudflare Edge Network，全球 300+ 节点就近响应

---

## 功能特性

| 特性 | 状态 | 说明 |
|------|------|------|
| OpenAI 兼容 API | 已支持 | `/v1/models`、`/v1/chat/completions` |
| Claude 兼容 API | 已支持 | `/anthropic/v1/models`、`/anthropic/v1/messages` |
| 流式输出 (SSE) | 已支持 | 逐字返回，首包延迟 < 500ms |
| 非流式输出 | 已支持 | 一次性返回完整响应 |
| 工具调用 | 已支持 | 自动注入 system prompt 并解析 JSON 工具调用 |
| 推理模式 | 已支持 | `deepseek-reasoner` 模型启用 thinking |
| 联网搜索 | 已支持 | `*-search` 后缀模型启用 search |
| 多账号轮询 | 已支持 | KV 存储，自动登录与 Token 刷新 |
| Bearer Token 直通 | 已支持 | 用户可自带 DeepSeek Token 直接访问 |

---

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端层                              │
│  OpenAI SDK / Claude SDK / ChatGPT-Next-Web / LobeChat ...  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Cloudflare Worker (TypeScript)          │    │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌────────┐ │    │
│  │  │  Index  │──│  OpenAI  │──│  Claude │──│ Config │ │    │
│  │  │ 路由分发 │  │  路由层   │  │  路由层  │  │ KV管理 │ │    │
│  │  └─────────┘  └────┬─────┘  └────┬────┘  └────────┘ │    │
│  │                    │             │                   │    │
│  │              ┌─────┴─────────────┴─────┐             │    │
│  │              │      DeepSeek Core       │             │    │
│  │              │  登录 · 会话 · PoW · 补全 │             │    │
│  │              └─────────────────────────┘             │    │
│  │                         │                           │    │
│  │              ┌──────────┴──────────┐                │    │
│  │              │  WASM PoW Solver    │                │    │
│  │              │  sha3_wasm_bg.wasm  │                │    │
│  │              └─────────────────────┘                │    │
│  └─────────────────────────────────────────────────────┘    │
│                         │                                   │
│              ┌──────────┴──────────┐                        │
│              │  DEEPSEEK_CONFIG KV │                        │
│              │  账号 · Token · 配置  │                        │
│              └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     DeepSeek 官方服务                        │
│              chat.deepseek.com (HTTPS API)                  │
└─────────────────────────────────────────────────────────────┘
```

### 核心模块说明

| 文件 | 职责 |
|------|------|
| `src/index.ts` | Worker 入口，路由分发，CORS 中间件 |
| `src/openai.ts` | OpenAI 协议路由：`/v1/models`、`/v1/chat/completions` |
| `src/claude.ts` | Claude 协议路由：`/anthropic/v1/*` |
| `src/deepseek.ts` | DeepSeek 核心 API：登录、创建会话、PoW、调用补全、删除会话 |
| `src/pow.ts` | WebAssembly PoW 计算模块封装 |
| `src/messages.ts` | 消息预处理：content 标准化、连续消息合并、角色标签注入 |
| `src/tools.ts` | 工具调用检测与 system prompt 构建 |
| `src/config.ts` | Cloudflare KV 读写，账号选择与 Token 更新 |
| `src/utils.ts` | Token 估算、SSE 流解析、通用工具函数 |
| `assets/sha3_wasm_bg.wasm` | PoW 哈希计算 WASM 二进制 |

---

## 前置要求

- [Node.js](https://nodejs.org/) >= 18.0.0
- [npm](https://www.npmjs.com/) >= 9.0.0
- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费套餐即可）
- 一个可用的 DeepSeek 账号（手机号 + 密码）

---

## 快速部署

### 第一步：克隆或解压项目

```bash
cd deepseek2api-workers
```

### 第二步：安装依赖

```bash
npm install
```

### 第三步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器将弹出授权页面，点击 **Allow** 授予 Wrangler 访问权限。

### 第四步：创建 KV 命名空间

账号 Token 与配置需要持久化存储，必须先创建 KV Namespace：

```bash
npx wrangler kv:namespace create DEEPSEEK_CONFIG
```

命令将输出类似以下内容：

```
🌀 Creating namespace with title "deepseek2api-DEEPSEEK_CONFIG"
✨ Success!
Add the following to your configuration file:
{
  "kv_namespaces": [
    {
      "binding": "DEEPSEEK_CONFIG",
      "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  ]
}
```

**复制输出的 `id`**，粘贴到 `wrangler.jsonc` 中替换 `your-kv-namespace-id`：

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "DEEPSEEK_CONFIG",
      "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  ]
}
```

### 第五步：配置账号（二选一）

#### 方式 A：通过 KV 写入配置（推荐，支持运行时动态更新）

```bash
npx wrangler kv:key put --namespace-id=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx config '
{
  "keys": ["sk-your-api-key"],
  "accounts": [
    {
      "mobile": "13800138000",
      "password": "your-password",
      "token": ""
    }
  ],
  "openai_model_mapping": {
    "fast": "deepseek-chat",
    "slow": "deepseek-reasoner"
  },
  "claude_model_mapping": {
    "fast": "deepseek-chat",
    "slow": "deepseek-reasoner"
  }
}
'
```

> **字段说明**
> - `keys`：自定义 API Key 列表，客户端请求时 `Authorization: Bearer sk-your-api-key` 必须匹配其中一项
> - `accounts`：DeepSeek 登录账号数组，支持多账号自动轮询；`token` 留空，Worker 将在首次请求时自动登录获取
> - `openai_model_mapping` / `claude_model_mapping`：模型别名映射（可选）

#### 方式 B：通过环境变量注入（适合单账号快速体验）

编辑 `wrangler.jsonc`，将 `vars.CONFIG_JSON` 替换为你的配置：

```jsonc
{
  "vars": {
    "CONFIG_JSON": "{\"keys\":[\"sk-your-api-key\"],\"accounts\":[{\"mobile\":\"13800138000\",\"password\":\"your-password\",\"token\":\"\"}]}"
  }
}
```

> 注意：环境变量方式在重新部署时才会生效，且不支持运行时动态更新 Token。

### 第六步：部署上线

```bash
npx wrangler deploy
```

部署成功后，终端将输出你的 Worker 地址：

```
✨ Successfully deployed
  https://deepseek2api.xxx.workers.dev
```

### 第七步：验证服务

**测试模型列表：**

```bash
curl https://deepseek2api.xxx.workers.dev/v1/models \
  -H "Authorization: Bearer sk-your-api-key"
```

**测试对话补全（非流式）：**

```bash
curl -X POST https://deepseek2api.xxx.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**测试流式输出：**

```bash
curl -X POST https://deepseek2api.xxx.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "讲一个笑话"}],
    "stream": true
  }'
```

---

## 配置详解

### 配置文件结构（JSON）

```json
{
  "keys": [
    "sk-your-api-key-1",
    "sk-your-api-key-2"
  ],
  "accounts": [
    {
      "mobile": "13800138000",
      "password": "your-password",
      "token": ""
    },
    {
      "mobile": "13900139000",
      "password": "another-password",
      "token": ""
    }
  ],
  "openai_model_mapping": {
    "fast": "deepseek-chat",
    "slow": "deepseek-reasoner"
  },
  "claude_model_mapping": {
    "fast": "deepseek-chat",
    "slow": "deepseek-reasoner"
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keys` | `string[]` | 是 | 自定义 API Key 白名单。请求头 `Authorization: Bearer <key>` 必须匹配其中一项 |
| `accounts` | `object[]` | 是 | DeepSeek 账号数组。Worker 将自动登录获取 Token 并进行轮询 |
| `accounts[].mobile` | `string` | 是 | DeepSeek 注册手机号 |
| `accounts[].password` | `string` | 是 | DeepSeek 登录密码 |
| `accounts[].token` | `string` | 否 | 登录后的 Bearer Token，留空由 Worker 自动填充 |
| `openai_model_mapping` | `object` | 否 | OpenAI 协议模型别名映射 |
| `claude_model_mapping` | `object` | 否 | Claude 协议模型别名映射 |

### 两种认证模式

#### 模式一：配置模式（Config Mode）

客户端使用你在 `keys` 中定义的 API Key 访问，Worker 自动从 `accounts` 中选取账号登录并代理请求。

适用场景：多用户共享、需要账号轮询、不想让终端用户知道 DeepSeek 原始 Token。

#### 模式二：直通模式（Direct Mode）

客户端直接携带有效的 DeepSeek Bearer Token 访问，跳过 `keys` 校验。

适用场景：个人使用、Token 由其他渠道获取、无需账号密码配置。

> 直通模式判定条件：请求头中的 Bearer Token 长度大于 30 且不是 `eyJ` 开头（JWT 特征）时，视为 DeepSeek 原始 Token 直接透传。

---

## API 使用指南

### OpenAI 兼容接口

#### 获取模型列表

```bash
GET /v1/models
```

#### 对话补全

```bash
POST /v1/chat/completions
```

**请求体示例（基础对话）：**

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "你是一个乐于助人的助手。"},
    {"role": "user", "content": "请介绍 Cloudflare Workers。"}
  ]
}
```

**请求体示例（工具调用）：**

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "user", "content": "北京今天天气如何？"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市的天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "城市名称"}
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

**请求体示例（推理模式）：**

```json
{
  "model": "deepseek-reasoner",
  "messages": [
    {"role": "user", "content": "解方程 2x + 5 = 13"}
  ]
}
```

**请求体示例（联网搜索）：**

```json
{
  "model": "deepseek-chat-search",
  "messages": [
    {"role": "user", "content": "2025年最新的 AI 发展趋势"}
  ]
}
```

**请求体示例（流式输出）：**

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "user", "content": "写一首关于春天的诗"}
  ],
  "stream": true
}
```

#### Python SDK 示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://deepseek2api.xxx.workers.dev/v1",
    api_key="sk-your-api-key"
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[
        {"role": "user", "content": "你好"}
    ],
    stream=False
)

print(response.choices[0].message.content)
```

#### Python SDK 流式示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://deepseek2api.xxx.workers.dev/v1",
    api_key="sk-your-api-key"
)

stream = client.chat.completions.create(
    model="deepseek-chat",
    messages=[
        {"role": "user", "content": "讲一个科幻故事"}
    ],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Claude 兼容接口

#### 获取模型列表

```bash
GET /anthropic/v1/models
```

#### Messages 对话

```bash
POST /anthropic/v1/messages
```

**请求体示例：**

```json
{
  "model": "claude-3-haiku",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "max_tokens": 1024
}
```

> Claude 接口内部会将请求转发至 DeepSeek 模型，并通过 `claude_model_mapping` 进行模型名映射。

---

## 模型映射对照表

### OpenAI 协议模型名

| 请求模型名 | 实际调用模型 | 特性 |
|-----------|-------------|------|
| `deepseek-chat` | deepseek-chat | 默认对话，响应快速 |
| `deepseek-v3` | deepseek-chat | 同 deepseek-chat 别名 |
| `deepseek-reasoner` | deepseek-reasoner | 启用推理链（thinking） |
| `deepseek-r1` | deepseek-reasoner | 同 deepseek-reasoner 别名 |
| `*-search` | deepseek-chat | 启用联网搜索（任意带 `-search` 后缀的模型名） |

### Claude 协议模型名

| 请求模型名 | 默认映射（可通过配置覆盖） |
|-----------|------------------------|
| `claude-3-haiku` | `deepseek-chat` |
| `claude-3-sonnet` | `deepseek-chat` |
| `claude-3-opus` | `deepseek-reasoner` |

> 自定义映射：在配置文件中修改 `claude_model_mapping` 即可调整对应关系。

---

## 常见问题排查

### 部署后返回 `invalid token.`

**原因一：KV 中未写入配置**

```bash
npx wrangler kv:key put --namespace-id=<your-id> config '{"keys":["sk-your-key"],"accounts":[{...}]}'
```

**原因二：API Key 不匹配**

确认请求头中的 `Authorization: Bearer <key>` 与配置中 `keys` 数组完全一致（区分大小写）。

**原因三：DeepSeek 账号登录失败**

检查账号密码是否正确，或账号是否被风控。可在 Worker Logs 中查看详细错误信息：

```bash
npx wrangler tail
```

### 部署后返回 `CLIENT_VERSION_TOO_LOW`

DeepSeek 官方更新了 App 版本要求。本项目已内置最新版本号 `x-client-version: 2.0.0`，如未来再次出现此错误：

1. 查看当前 Worker 日志确认错误码
2. 修改 `src/deepseek.ts`、`src/openai.ts`、`src/claude.ts` 中的 `x-client-version` 为最新版本
3. 重新执行 `npx wrangler deploy`

### 流式输出没有内容

检查客户端是否正确解析 SSE 格式。标准 SSE 格式如下：

```
data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

确保客户端按 `\n\n` 分割事件，并忽略 `event:` 前缀（本实现省略了 `event:` 前缀）。

### PoW 计算失败

PoW 依赖 WebAssembly 模块 `assets/sha3_wasm_bg.wasm`，该文件必须存在且未被损坏。如部署后 PoW 接口返回错误：

1. 确认 `assets/sha3_wasm_bg.wasm` 文件大小不为 0
2. 确认 `wrangler.jsonc` 中 `compatibility_flags` 包含 `nodejs_compat`

### 如何更新账号密码

直接更新 KV 中的配置即可，无需重新部署：

```bash
npx wrangler kv:key put --namespace-id=<your-id> config '<新的 JSON 配置>'
```

更新后立即生效，下一个请求将使用新配置。

### 本地开发调试

```bash
npm run dev
```

Worker 将在本地启动，默认监听 `http://localhost:8787`。本地开发时不使用 KV，配置直接读取 `wrangler.jsonc` 中的 `vars.CONFIG_JSON`。

---

## 许可证

本项目基于原 [DeepSeek2API](https://github.com/iidamie/deepseek2api) Python 项目重构，遵循原项目许可证协议。

---

## 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/) — 无服务器边缘计算平台
- [DeepSeek](https://deepseek.com/) — 强大的国产大语言模型
- [LINUX DO](https://linux.do) - 互联网上唯一的净土