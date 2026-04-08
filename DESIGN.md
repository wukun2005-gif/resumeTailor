# 简历定制助手 — 设计文档

> 本文档供后续开发者阅读，以便理解项目全貌后继续开发。每次改动须在末尾 Change Log 追加记录。

👈 **[返回项目主页 (README.md)](./README.md)**

---

## 1. 项目概述

**简历定制助手** 是一个本地 GUI Web 应用，用于根据 JD（Job Description）和简历素材库，利用多个 AI 模型自动生成、评审、修改定制简历和求职信，并最终转换为 HTML 供用户手动打印为 PDF。

### 核心价值
- 用户无需在多个 AI 聊天窗口之间来回复制粘贴
- 一站式完成：生成 → 评审 → 修改 → HTML导出
- 支持多 AI 供应商（Jiekou.ai、OpenRouter.ai、Google AI Studio）和多种模型（OpenAI、Google、Anthropic）

### 运行环境
- macOS (Darwin 21.6.0)，MacBook Pro 2015，i7 2.2GHz 四核，16GB 内存
- **关键约束**：应用不能使机器卡死，`--max-old-space-size=512` 限制 Node.js 内存

---

## 2. 技术架构

```
┌──────────────────────────────────┐
│  浏览器 (localhost:5173)         │
│  Vanilla JS SPA + CSS           │
│  index.html / src/main.js       │
│  src/api.js / src/state.js      │
└──────────┬───────────────────────┘
           │ Vite Dev Proxy /api → :3001
┌──────────▼───────────────────────┐
│  Express.js Server (:3001)       │
│  server/index.js                 │
│  server/routes/api.js            │
│  server/services/anthropic.js    │
│  server/services/gemini.js       │
│  server/services/openai-compat.js│
│  server/services/fileReader.js   │
│  server/prompts/templates.js     │
└──────────────────────────────────┘
```

### 技术栈
| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vanilla JS + CSS | 无框架，单页应用 |
| 构建 | Vite 6 | 开发代理 + 生产构建 |
| 后端 | Express.js (Node.js ES Modules) | API 路由 + AI 调用 |
| AI SDK | `@anthropic-ai/sdk`, `@google/genai`, raw `fetch` | 三种调用方式 |
| 文件解析 | `mammoth`, Poppler `pdftotext` | DOCX/PDF 读取 |
| 数据持久化 | localStorage + AES-GCM 加密 | 凭证加密存储 |
| 实时通信 | Server-Sent Events (SSE) | AI 流式输出 |

### 启动方式
```bash
cd /Users/wukun/Documents/tmp/resumeTailor/vscCCOpus
npm run dev
# 浏览器打开 http://localhost:5173
```

停止：在终端按 Ctrl+C（可能需要多按几次或 `kill %1`）

生产模式：
```bash
npm run build
npm start
# 浏览器打开 http://localhost:3001
```

---

## 3. 文件结构

```
vscCCOpus/
├── package.json              # 依赖和脚本
├── vite.config.js            # Vite 配置，代理 /api → :3001
├── index.html                # SPA 入口，包含设置弹窗和所有 UI
├── src/
│   ├── main.js               # 前端主逻辑 (~850 行)
│   ├── api.js                # SSE 流式请求、文件操作封装
│   ├── state.js              # localStorage 状态管理 + AES-GCM 加密
│   └── style.css             # 所有样式
├── server/
│   ├── index.js              # Express 入口，CORS、JSON 限制 50MB
│   ├── routes/
│   │   └── api.js            # 所有 API 路由
│   ├── services/
│   │   ├── anthropic.js      # Anthropic Claude SDK 调用
│   │   ├── gemini.js         # Google GenAI SDK 调用
│   │   ├── openai-compat.js  # OpenAI 兼容 API (raw fetch)
│   │   └── fileReader.js     # 文件读取 (txt/html/pdf/docx/md)
│   │   └── libraryCache.js   # 素材库 digest 缓存系统
│   └── prompts/
│       └── templates.js      # 所有 LLM Prompt 模板
└── DESIGN.md                 # 本文档
```

---

## 4. 多模型连接系统

### 4.1 两级配置架构

**第一级：模型连接配置** — 配置供应商 + API 凭证 + 模型 ID

7 个可选连接：

| Connection ID | 供应商 | 模型族 | SDK 路由 | 默认 URL |
|---|---|---|---|---|
| `jiekou-openai` | Jiekou.ai | OpenAI | OpenAI-compat | `https://api.jiekou.ai/v1` |
| `jiekou-google` | Jiekou.ai | Google | OpenAI-compat | `https://api.jiekou.ai/v1` |
| `jiekou-anthropic` | Jiekou.ai | Anthropic | Anthropic SDK | `https://api.jiekou.ai/anthropic` |
| `openrouter-openai` | OpenRouter.ai | OpenAI | OpenAI-compat | `https://openrouter.ai/api/v1` |
| `openrouter-google` | OpenRouter.ai | Google | OpenAI-compat | `https://openrouter.ai/api/v1` |
| `openrouter-anthropic` | OpenRouter.ai | Anthropic | OpenAI-compat | `https://openrouter.ai/api/v1` |
| `google-studio-google` | Google AI Studio | Google | Google GenAI SDK | （无，直连） |

**第二级：Agent 角色分配** — 将已配置的连接分配给 Agent

| Agent | 作用 | 选择方式 | 默认 |
|---|---|---|---|
| Orchestrator | 对话/协调/JD解析 | 单选下拉 | `jiekou-anthropic` |
| Generator | 简历/求职信生成 | 单选下拉 | `jiekou-anthropic` |
| Reviewer | 简历评审 | 多选复选框 | `google-studio-google` |
| HTML Converter | txt→HTML 转换 | 单选下拉 | `google-studio-google` |

### 4.2 SDK 路由逻辑 (`getSdkType()`)

```
connectionId === 'google-studio-google'  → Google GenAI SDK (gemini.js)
connectionId === 'jiekou-anthropic'      → Anthropic SDK (anthropic.js)
其他所有                                  → OpenAI-compatible (openai-compat.js)
```

关键设计决策：
- `jiekou-anthropic` 走 Anthropic 原生 SDK，因为 Jiekou.ai 的 Anthropic 代理端点(`/anthropic`)与 Anthropic 官方 API 兼容
- `jiekou-openai`、`jiekou-google` 走 OpenAI-compatible，因为 Jiekou.ai 的 `/v1` 端点是 OpenAI 兼容格式
- OpenRouter 全部走 OpenAI-compatible
- Google AI Studio 走原生 Google GenAI SDK（需 VPN）

### 4.3 向后兼容

旧的 `model` 值自动映射：
- `'opus'` → `'jiekou-anthropic'`
- `'gemini'` → `'google-studio-google'`

旧的凭证也会自动迁移到新的 `connKey_*` 格式。

---

## 5. API 路由

所有路由前缀 `/api`：

| 方法 | 路径 | 说明 | 流式 |
|---|---|---|---|
| POST | `/init` | 初始化模型连接 | No |
| GET | `/list-files` | 列出素材库文件 | No |
| GET | `/read-file` | 读取单个文件 | No |
| POST | `/save-file` | 保存文件 | No |
| POST | `/library-digest` | 素材库段落去重 digest | No |
| POST | `/generate` | 生成简历/求职信 | SSE |
| POST | `/review` | 单模型评审 | SSE |
| POST | `/review-multi` | 多模型并行评审 + 合并 | SSE |
| POST | `/chat` | AI 对话（通用） | SSE |
| POST | `/apply-review` | 根据评审意见 diff 修改简历 | SSE |
| POST | `/generate-html` | 生成 HTML | SSE |
| POST | `/extract-jd-info` | 从 JD 提取公司/部门/职位 | No |

### `/init` 请求格式（新格式）
```json
{
  "modelConnections": [
    { "id": "jiekou-anthropic", "url": "https://api.jiekou.ai/anthropic", "key": "sk_v-...", "model": "claude-opus-4-6", "label": "Jiekou Anthropic" },
    { "id": "google-studio-google", "url": "", "key": "AIza...", "model": "gemini-2.5-flash", "label": "Google AI Studio" }
  ],
  "allowedPaths": ["/Users/wukun/Documents/tmp/resumeTailor/vscCCOpus", "/Users/wukun/Documents/jl"]
}
```

### SSE 数据格式
```
data: {"type":"chunk","text":"..."}
data: {"type":"error","message":"..."}
data: {"type":"done"}
```

### 路径安全
服务端维护 `allowedDirs` 白名单，所有文件操作路径必须在白名单目录下。

---

## 6. 前端状态管理

### 6.1 `state.js` — localStorage + AES-GCM 加密

- 非敏感数据：`state.get(key)` / `state.set(key, value)` — 明文存 localStorage
- 敏感数据（API Key）：`state.getCredential(key)` / `state.setCredential(key, value)` — AES-GCM 加密
- 加密密钥通过 PBKDF2 从浏览器指纹派生（`navigator.userAgent + screen.width + ...`）
- 凭证 key 命名：`connKey_{connectionId}`（如 `connKey_jiekou-anthropic`）
- 非凭证配置 key：`connUrl_{connectionId}`、`connModel_{connectionId}`

### 6.2 持久化的设置项
| Key | 说明 | 加密 |
|---|---|---|
| `connKey_*` | 每个连接的 API Key | 是 |
| `connUrl_*` | 每个连接的 URL | 否 |
| `connModel_*` | 每个连接的 Model ID | 否 |
| `orchestratorModel` | Orchestrator Agent 对应的 connection ID | 否 |
| `generatorModel` | Generator Agent 对应的 connection ID | 否 |
| `reviewerModels` | Reviewer Agent 的 connection ID 数组 | 否 |
| `htmlModel` | HTML Converter 的 connection ID | 否 |
| `libraryPath` | 简历素材库绝对路径 | 否 |
| `genInstructions` | 生成简历的 prompt 指令 | 否 |
| `htmlInstructions` | HTML 转换的 prompt 指令 | 否 |
| `baseResume` | 上次选择的基础简历文件名 | 否 |
| `mockMode` | 仿真模式开关 | 否 |

---

## 7. Prompt 模板

### 7.1 `getResumeGenerationPrompt`
- 输入：JD、原始简历、简历库、指令、是否生成求职信
- 输出格式强制要求三段式：`===== 简历正文 =====` / `===== 求职信正文 =====`（可选）/ `===== AI备注 =====`
- 前端 `parseGeneratedOutput()` 解析分隔符，将正文与备注分开显示

### 7.2 `getReviewPrompt`
- 动态检测 `updatedResume` 是否包含「求职信」，有则追加求职信评审格式要求
- 评审要点：事实一致性、篇幅、关键词堆砌、深度、诚实度、数字一致性

### 7.3 `getReviewMergePrompt`
- 用于多 Reviewer 场景：多个模型并行评审后，由 Orchestrator 模型合并评审意见
- 使用实际的 connection label 标识各评审员

### 7.4 `getHtmlGenerationPrompt`
- 硬性要求：2 页 A4 以内、CSS @page 规则、紧凑排版
- 用户的格式要求放在 prompt 最前面以获得最大权重
- 输出纯 HTML 代码，不要解释文字

### 7.5 跨投递一致性检查 (Cross-Submission Consistency)

当用户为某公司某岗位生成简历时，系统自动检测素材库中是否存在之前向**同一公司**投递过的简历/求职信，如果存在，则将这些历史投递内容作为上下文传递给 AI，并注入详细的一致性约束规则。

#### 前端检测逻辑

`findSameCompanyFiles(companyName)` 在 `src/main.js` 中实现：

1. 解析素材库文件列表的文件名，格式为 `name - type - {company} - {dept} - {title} - {date}.txt`
2. 提取第 3 个 `-` 分隔段（即公司名），与当前 JD 的公司名进行**大小写不敏感**匹配
3. 排除当前选中的基础简历（即 `baseResumeSelect.value`），避免与 `originalResume` 重复（该文件已作为"原始简历"单独传入 prompt）
4. 匹配到的文件内容拼接为 `previouslySubmitted` 字符串

> **关于排除逻辑的两种典型场景**：
>
> - **场景 A — 基础简历是通用主简历**（如 `base-resume.txt`，文件名不含公司名）：排除逻辑**不会触发**，因为通用简历的文件名不会匹配公司检索条件。所有同公司历史投递均完整进入 `previouslySubmitted`。AI 同时参考 `originalResume`（原始事实基础）和 `previouslySubmitted`（历史投递一致性约束）生成新简历。这是最常见的使用方式——用户基于同一份通用主简历，为同公司不同岗位生成多份定制简历，每份定制简历已经与通用主简历不同（面向不同 JD 裁剪过），AI 需要看到所有历史投递来保持一致。
> - **场景 B — 基础简历本身就是某份已投递的同公司简历**（如 `wukun - resume - Amazon - AGS - PM - 2026-04-01.txt`）：该文件被排除，因为它已作为 `originalResume` 出现在 prompt 中，再放入 `previouslySubmitted` 会造成内容重复。其余同公司投递正常进入 `previouslySubmitted`。AI 仍能看到所有信息，不会遗漏。

#### UI 提示

匹配成功时，输出区显示黄色警告栏（`#sameCompanyHint`）：

```
⚠️ 检测到已向 {company} 投递过 {N} 份简历/求职信，将自动进行跨投递一致性约束
```

样式类 `.same-company-hint`：黄色背景 + 琥珀色边框，定义在 `src/style.css`。

#### API 传递

`previouslySubmitted` 字段通过前端 `doGenerate()`、`doReview()`、`doApplyReview()` 发送到以下后端路由：

| 路由 | 用途 |
|------|------|
| `POST /api/generate` | 生成时注入一致性约束 |
| `POST /api/review` | 评审时增加跨投递一致性检查维度 |
| `POST /api/review-multi` | 多模型评审时同上 |

#### 生成 Prompt 注入规则

当 `previouslySubmitted` 非空时，`getResumeGenerationPrompt` 注入以下分层约束：

- **事实层硬性约束**：时间线、Title、公司名、项目名、数据指标、专利/论文、教育背景必须与历史投递**完全一致**；不能凭空新增之前未出现过的技能
- **表达层可调整**：Summary/Skills 排列顺序、项目要点的侧重角度、关键词选择可根据目标岗位灵活调整
- **最终效果**：在 HR 眼中看起来是「同一份经历的两个不同侧面」，而非前后矛盾的两份简历

#### 评审 Prompt 扩展

当 `previouslySubmitted` 非空时，`getReviewPrompt` 增加：

- 评审维度追加「跨投递一致性检查」：核查事实层是否与历史投递矛盾
- 评审输出格式追加专门的「跨投递一致性」评审小节

---

## 8. UI 布局

```
┌─────────────────────────────────────────────┐
│  Header: [简历定制助手]  [仿真模式] [设置]    │
├─────────────────────────────────────────────┤
│  输入区                                      │
│  ├ JD 输入框                                 │
│  ├ 素材库路径 + 浏览/加载按钮                   │
│  ├ 基础简历下拉选择                             │
│  ├ 手动输入简历（按需显示）                      │
│  ├ [折叠] 生成指令                             │
│  ├ [折叠] HTML 格式指令                        │
│  └ [同时生成求职信] [生成简历]                   │
├─────────────────────────────────────────────┤
│  输出区（始终可见）                             │
│  ┌──────────────────┬──────────────────┐     │
│  │ 简历/求职信 面板   │ Review 面板       │     │
│  │ [保存] [重新生成]  │ [开始Review]      │     │
│  │                  │ [采纳并更新简历]    │     │
│  │ 简历编辑区        │ Review 结果编辑区  │     │
│  │ AI备注(折叠)      │                  │     │
│  │ 生成助手对话框     │ Review 对话框     │     │
│  └──────────────────┴──────────────────┘     │
│  ┌──────────────────────────────────────┐    │
│  │  [生成HTML并下载]                      │    │
│  │  HTML 助手对话框 + PDF 上传            │    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

### 设置弹窗
- 宽度 820px (`.modal-wide`)
- **模型连接配置**：3 个可折叠的供应商区块，每块一个表格（模型类型 / URL / Key / Model ID）
- **Agent 模型分配**：4 个选择器，从已配置连接中动态生成选项
- 动态更新：用户在连接表中填入 API Key 后，Agent 分配区的下拉选项即时刷新

---

## 9. 文件命名与保存

### 命名规则
`wukun - {type} - {company} - {department} - {title} - {YYYY-MM-DD}.{ext}`

- `type`：`resume`
- 公司/部门/职位由 Orchestrator 从 JD 中提取（`/extract-jd-info`）
- 中文 JD 对应中文文件名，英文 JD 对应英文文件名
- 如果提取不到公司名，仅在手动保存时询问用户

### 自动保存
- 生成简历后自动保存 `.txt` 到素材库目录
- HTML 只触发浏览器下载，不自动保存到素材库

### PDF 文件名
- HTML `<title>` 标签注入为 `wukun - resume - company - dept - title - date`
- 浏览器打印 PDF 时自动使用 `<title>` 作为文件名

---

## 10. 仿真模式 (Mock Mode)

勾选「仿真模式」后，所有 AI 调用返回预设文本，不消耗 API Token。

Mock 数据包含：
- `resume`：模拟简历正文
- `coverLetter`：模拟求职信（仅当勾选「同时生成求职信」）
- `notes`：模拟 AI 备注
- `review` / `reviewCoverLetter`：模拟评审（根据是否有求职信动态拼接）
- `reviewMerge` / `reviewMergeCoverLetter`：多模型合并评审
- `chat`：模拟聊天回复
- `html`：模拟 HTML 输出
- `extractJdInfo`：模拟 JD 解析结果

---

## 11. 安全设计

| 威胁 | 对策 |
|---|---|
| API Key 泄露 | AES-GCM 加密存储在 localStorage |
| 路径遍历攻击 | 服务端 `allowedDirs` 白名单校验 |
| CORS 攻击 | 仅允许 localhost 源 |
| 简历内容截获 | 纯本地应用，不经过第三方（API 代理除外） |
| XSS | 无用户生成的 HTML 直接注入 DOM |

---

## 12. 多模态支持

### 支持的场景
- HTML 助手对话中上传 PDF/图片，让 AI 查看排版问题（base64 多模态方式）

### PDF 文本提取（简历素材库）

简历素材库中的 PDF 文件使用 Poppler `pdftotext -raw` 命令行工具提取文本，而非 npm 包。优势：
- 系统依赖：需预装 Poppler（`brew install poppler`），当前版本 v26.02.0
- 对中文 PDF 支持更好
- `-raw` 输出紧凑纯文本，节省 token（相比 `-layout` 减少空格填充）
- 减少 npm 依赖，输出纯文本直接注入 prompt

实现位于 `server/services/fileReader.js` 的 `readPdf()` 函数，使用 `execFile`（非 `exec`）避免 shell 注入。

### 多模态内部格式（HTML 助手上传路径）
```json
{ "type": "file", "mimeType": "application/pdf", "data": "base64..." }
```

### 各 SDK 的转换
| SDK | PDF | 图片 |
|---|---|---|
| Anthropic | `{ type: "document", source: { type: "base64", ... } }` | `{ type: "image", source: { type: "base64", ... } }` |
| Google GenAI | `{ inlineData: { mimeType, data } }` | 同左 |
| OpenAI-compat | `[Attached file: ...]`（文本占位） | `{ type: "image_url", image_url: { url: "data:..." } }` |

---

## 13. 已知限制

- `.pages` 文件不支持自动解析，提示用户手动粘贴
- Google AI Studio 需要 VPN（中国大陆网络限制）
- `gemini-2.5-pro`/`gemini-3.1-pro-preview` 免费额度为 0，默认使用 `gemini-3.1-flash-lite-preview`（30 RPM, 2000 RPD）
- OpenAI-compat 的 PDF 多模态支持有限（转为文本占位符）
- 加密基于浏览器指纹，更换浏览器会丢失已保存凭证
- 应用数据存在 localStorage，清除浏览器数据会丢失所有配置

---

## 14. 开发指南

### 添加新的模型供应商
1. 如果是 OpenAI 兼容 API：无需改后端，只需在 `index.html` 添加表格行 + `main.js` 的 `MODEL_CONNECTIONS` 添加条目
2. 如果是非兼容 API：在 `server/services/` 添加新 caller + `api.js` 中 `getSdkType()` 添加路由

### 添加新的 Agent 角色
1. `index.html` 设置弹窗添加下拉/复选框
2. `main.js` 的 `populateAgentDropdowns()` 中注册新选择器
3. `main.js` 中对应功能函数读取 `state.get('newAgentModel')`
4. `saveSettings()` 和 `restoreAgentAssignments()` 中处理新角色

### 修改 Prompt 模板
编辑 `server/prompts/templates.js`，无需改动前后端代码。

---

## 15. 用户原始需求摘要

- 一站式完成简历生成 → 评审 → 修改 → HTML 导出
- 支持 Opus 4.6（付费 Jiekou.ai 代理）和 Gemini（免费 Google AI Studio / 付费代理）
- 多 Agent 协作：Orchestrator / Generator / Reviewer / HTML Converter
- 简历素材库路径直接读取，不要求用户上传文件
- 生成的文件自动保存到素材库，AI 根据 JD 自动命名
- HTML 导出后用户自行在浏览器打印 PDF
- Mock 模式先测试流程再消耗 Token
- UI 朴素简洁，中文界面
- 隐私安全第一：凭证加密、CORS 限制、路径校验
- 不能让机器卡死（内存限制 512MB）
- 输出区始终可见，用户可随时跳步操作
- 生成简历正文与 AI 备注分离显示
- 每个功能区都有与 AI 的对话框
- Review 时简历和求职信分别评审
- 为每个 Agent 配置不同的 model，支持 Jiekou.ai / OpenRouter.ai / Google AI Studio 三个供应商

---

## Change Log

### 2026-04-08 — PII 脱敏保护（V1.x）

**概述**：在 AI API 调用链路中增加 PII（个人身份信息）脱敏/恢复拦截层。所有用户 PII（姓名、邮箱、电话、社交媒体链接等）在发送给 AI API 前自动替换为占位符（`<<NAME>>`、`<<EMAIL>>` 等），AI 返回结果中的占位符自动恢复为真实 PII。PII 映射表仅存在于服务端内存，绝不离开本地。

**架构设计**：
- 拦截点：Express 路由层，在 prompt 模板构建前 sanitize，在 SSE 流式返回中 restore
- 占位符格式：`<<TYPE>>`（双尖括号），与 diff 格式 `<<<`/`>>>` 不冲突
- 替换策略：按 real 值长度降序（长的先替换），避免短子串嵌入长字符串导致双重替换
- 流式恢复：缓冲机制处理跨 chunk 占位符分割，检测未闭合 `<<` 并等待后续 chunk
- PII 存储：前端用 AES-256-GCM 加密存储在 localStorage（`pii_` 前缀）

**覆盖路由**：`/generate`、`/review`、`/review-multi`、`/apply-review`、`/chat`、`/generate-html`、`/extract-jd-info`（共 7 条）

**改动文件**：

| 文件 | 操作 |
|------|------|
| `server/services/piiSanitizer.js` | 新建 — 8 个导出函数（setPiiConfig/getPiiEntries/sanitize/restore/sanitizeRequestBody/sanitizeLibrary/sanitizeMessages/createStreamRestorer） |
| `server/routes/api.js` | 修改 — import piiSanitizer + `/init` 接收 piiConfig + 7 条路由加 sanitize/restore |
| `index.html` | 修改 — 设置弹窗加 PII 配置 fieldset（启用开关 + 9 个 PII 输入字段） |
| `src/main.js` | 修改 — PII DOM 引用 + buildPiiConfig() + save/restore + initAPI 传递 piiConfig |
| `src/state.js` | 修改 — isCredentialKey() 扩展 `pii_` 前缀识别 |

### 2026-04-07 — Token 消费地毯式审计 + 优化（第三轮）

**概述**：按"上下文精简/减少冗余调用/缓存复用/避免重复读取"四方向对全部 7+条 AI 路由逐一审计。在保留用户要求的完整 context（library、JD、instructions、AI 备注）前提下，实施剩余可优化项。

**优化项**：

| 优化项 | 说明 | 节省 |
|--------|------|------|
| HTML chat seed 精简 | seed assistant 改用 AI body 输出（去除 CSS 模板 + DOCTYPE 等外层包装），用户从不看 HTML 源码 | ~400tok/轮 |
| HTML prompt CSS 描述精简 | 从详细列举字体/字号/行距改为一句话概述 | ~80tok |
| Anthropic user message cache | `callAnthropic()` 支持 `userBlocks` 参数，对 library digest 和 previouslySubmitted 加 `cache_control: { type: "ephemeral" }` | 第 2 次+调用大块内容 90% cache 折扣 |
| Diff 解析鲁棒性 | `parseDiffOutput()` 增加 lenient fallback regex（容忍可选换行/空格）；`applyDiffs()` 增加 whitespace-normalized 行级模糊匹配 | 减少 fallback 全量重生成频率 |

**改动文件**：
- `src/main.js` — htmlChatMessages seed 改用 bodyContent; parseDiffOutput 增加 lenient regex; applyDiffs 增加 whitespace-normalized 匹配
- `server/prompts/templates.js` — HTML CSS 描述精简; getResumeGenerationPrompt/getReviewPrompt/getReviewPromptConcise 返回 `userBlocks` 数组（标记可缓存块）
- `server/services/anthropic.js` — callAnthropic 支持 `opts.userBlocks`，自动转为 Anthropic content blocks + cache_control
- `server/routes/api.js` — generate/review/review-multi 路由传递 userBlocks 到 caller

**审计结论**：
- `/extract-jd-info`、`/generate`、`/review`、`/review-multi`、`/apply-review`、`/chat(review/gen)`：input/output 均已达合理下限
- Output token：全路由在上轮优化中已达下限（标准流程 ~12300→~5900, 省 52%），无额外空间
- 主要剩余收益来源：Anthropic prompt caching 和 diff 模式可靠性提升

### 2026-04-07 — Output Token 优化回归修复 + E2E 测试

**概述**：修复 output token 优化引入的多个回归 bug，完成全路由端到端 API 测试（16/16 通过）。

**Bug Fixes**：

| Bug | 原因 | 修复 |
|-----|------|------|
| 生成的简历/求职信被截断 | maxTokens 设为 4096 不够 | generate → 8192, review → 6144 |
| OpenAI-compat system prompt 不生效 | `opts.system` 在 `opts.messages` 存在时被跳过 | 改为检查 `messages[0]?.role !== 'system'` |
| genChatSection 不显示 | 被条件性隐藏 | 改为始终可见（与 review chat 一致） |
| Chat AI 更新的简历/review 不同步到主编辑区 | 仅显示在对话区 | 新增 `looksLikeResume()` / `looksLikeReview()` 启发式检测，自动同步 |
| Gemini 1.5 Flash 返回 404 | 模型已废弃 | 默认模型改为 `gemini-3.1-flash-lite-preview` |
| test-e2e.mjs 泄露 API Key 到 GitHub | 硬编码 key | 改为 `process.env.GEMINI_KEY` 环境变量 |

**最终 maxTokens 配置表**：
| 路由 | maxTokens |
|------|-----------|
| generate | 8192 |
| review | 6144 |
| reviewer (multi) | 3072 |
| merge (multi) | 4096 |
| apply-review | 4096 |
| chat (review) | 4096 |
| chat (generator) | 4096 |
| chat (html) | 8192 |
| generate-html | 8192 |
| extract-jd-info | 256 |

**E2E 测试结果**（gemini-3.1-flash-lite-preview，16/16 通过）：
- Mock 模式 7 路由全部通过
- Real API 9 项全部通过：extract-jd-info、generate（含/不含求职信+备注）、review、apply-review（diff 格式正确）、chat（review/generator 类型）、generate-html（body-only 输出正确）

**改动文件**：
- `server/routes/api.js` — maxTokens 调整
- `server/services/openai-compat.js` — system message 条件修复
- `server/services/gemini.js` — 默认模型改为 `gemini-3.1-flash-lite-preview`
- `src/main.js` — 新增 `looksLikeResume()` / `looksLikeReview()` 启发式同步
- `index.html` — genChatSection 移除 `display:none`
- `test-e2e.mjs` — 移除硬编码 API Key

### 2026-04-06 — Output Token 优化

**概述**：在 input token 优化（节省 75-87%）基础上，对 output token 进行系统性优化。Output token 单价是 input 的 3-5 倍，标准全流程 output 从 ~12300 降至 ~5900 tokens（~52%）。

**核心优化项**：

| 优化项 | 说明 | Output 节省 |
|--------|------|------------|
| maxTokens 收紧 | generate 8K, review 6K, reviewer 3K, merge 4K, apply-review 4K, chat 4K/4K/8K, html 8K | 防护性 |
| Review prompt 精简 | 合并"需要修改的问题"和"具体修改建议"为一节，限制每节条目数（≤8条），REVIEW_SYSTEM 加"不要逐行改写" | ~40% |
| 多模型 review 精简 | 个别 reviewer 用精简 prompt（`getReviewPromptConcise`：仅评分+问题+建议），不显示个别结果只显示合并 | ~54% |
| Merge prompt 拆分 | `getReviewMergePrompt` 返回 `{system, user}`，新增 `MERGE_SYSTEM`，启用 Anthropic prompt caching | 启用 cache |
| HTML CSS 模板 | 预置 `HTML_CSS_TEMPLATE` 常量，AI 只输出 `<body>` 内 HTML，前端组装完整文档 | ~30% |
| Chat 分型 system prompt | `/chat` 路由根据 `chatType`（review/generator/html）设不同 system prompt 和 maxTokens（4K/4K/8K） | ~33% |
| Apply-review diff 模式 | 新增 `/api/apply-review` 路由，AI 输出 `[REPLACE]<<<old>>>new[/REPLACE]` 格式修改指令，前端解析应用 diff，失败自动 fallback 全量重生成 | ~79% |
| generateNotes 参数 | apply-review 时关闭 AI 备注输出（`generateNotes: false`） | ~200-400 tokens |

**新增函数/路由**：
- `server/prompts/templates.js` — `MERGE_SYSTEM`、`HTML_SYSTEM`、`APPLY_REVIEW_SYSTEM` 常量；`HTML_CSS_TEMPLATE` CSS 模板；`getReviewPromptConcise()` 精简评审 prompt；`getApplyReviewPrompt()` diff 模式 prompt；`getHtmlGenerationPrompt` 改为返回 `{system, user}`；`getReviewMergePrompt` 改为返回 `{system, user}`；`getResumeGenerationPrompt` 新增 `generateNotes` 参数
- `server/routes/api.js` — 新增 `POST /api/apply-review` 路由；`/chat` 路由增加 `chatType` 分型 system prompt
- `src/main.js` — 新增 `HTML_CSS_TEMPLATE` 前端常量；新增 `parseDiffOutput()` diff 解析；新增 `applyDiffs()` diff 应用；`doGenerateHtml()` 改为前端组装完整 HTML 文档；`doApplyReview()` 改为 diff 模式 + fallback；三个 chat 函数增加 `chatType` 参数

**改动文件**：
- `server/services/openai-compat.js` — 修复 `opts.system` 在 `opts.messages` 存在时也能生效（之前只在非 messages 模式下生效）

**优化效果**：
| 场景 | 优化前 output | 优化后 | 节省 |
|------|-------------|--------|------|
| apply-review | ~2400 | ~500（diff 模式） | 79% |
| review 单模型 | ~2500 | ~1500 | 40% |
| review-multi (3 reviewers) | ~9500 | ~4400 | 54% |
| generate-html | ~5000 | ~3500 | 30% |
| 5 轮 review chat | ~1500 | ~1000 | 33% |
| 标准全流程 | ~12300 | ~5900 | 52% |

### 2026-04-06 — Token 全面优化

**概述**：对全部 9 个 AI 调用点进行系统性 token 消费优化，预计标准流程节省 75-87% input tokens。

**核心策略**：不变的 context 预处理一次、持久化缓存、后续直接复用；能本地处理的不用 AI。

**新增文件**：
- `server/services/libraryCache.js` — 素材库 digest 缓存系统：段落级 MD5 hash 去重 + 磁盘持久化缓存（`<libraryDir>/.resume-tailor-cache/digest.json`）

**改动文件**：
- `server/services/fileReader.js` — 新增 `.md` 文件支持；PDF 从 `-layout` 改为 `-raw`（紧凑输出，减少空格 token）；修复 HTML numeric entity 解码（`&#8211;` → `–`）
- `server/services/anthropic.js` — 支持 `opts.system` 参数 + `cache_control: { type: "ephemeral" }`（Anthropic prompt caching）；支持 `opts.maxTokens` 动态设置
- `server/services/gemini.js` — 支持 `opts.system`（systemInstruction）；支持 `opts.jsonMode`（responseMimeType）；支持 `opts.maxTokens`
- `server/services/openai-compat.js` — 支持 `opts.system`（system role prepend）；支持 `opts.jsonMode`（response_format）
- `server/prompts/templates.js` — `getResumeGenerationPrompt` 和 `getReviewPrompt` 改为返回 `{ system, user }` 对象（分离系统指令用于 prompt caching）；精简重复指令
- `server/routes/api.js` — 新增 `/api/library-digest` 路由；保存文件时增量更新 digest 缓存；各路由设置合理 maxTokens（review=8192, chat=8192, extract-jd-info=256）；extract-jd-info 启用 JSON mode
- `src/api.js` — 新增 `getLibraryDigest()` 接口
- `src/main.js` — 新增 `truncateHistory()` 滑动窗口（保留 seed 2 条 + 最近 5 轮）；新增 `cleanBase64InHistory()` 清理历史消息中的 base64；新增 `tryLocalJdParse()` + `detectLanguage()` 本地 JD 解析（成功则不调 AI）；新增 `baseResumeCache` 客户端基础简历缓存；`doGenerate()`/`doReview()`/`doApplyReview()` 改用 digest API；mock 模式跳过数据准备；保存后增量更新缓存（不再整体清除）

**优化效果**：
| 场景 | 优化前 (input tokens) | 优化后 | 节省 |
|------|----------------------|--------|------|
| 标准流程 (generate → review → apply) | ~60K-190K | ~10K-25K | 75-87% |
| 多模型 review (2 reviewers) + merge | ~44K-132K | ~14K-30K | 68-77% |
| 10 轮 chat（含 PDF 上传） | ~100K+ | ~20K | ~80% |
| Mock 模式 | 仍做数据准备 | 0 | 100% |

### 2026-04-06 — PDF 文本提取改用 Poppler pdftotext

**概述**：简历素材库的 PDF 文本提取从 `pdf-parse` npm 包改为 Poppler `pdftotext -layout` 命令行工具，减少依赖、节省 token、改善中文 PDF 支持。

**修改文件**：
- `server/services/fileReader.js` — `readPdf()` 从 `pdf-parse` 改为 `execFile('pdftotext', ['-layout', filePath, '-'])`
- `package.json` — 移除 `pdf-parse` 依赖

**不影响的路径**：HTML 助手 PDF 上传仍使用 base64 多模态方式（需 AI 视觉审查排版）。

### 2026-04-05 — 跨投递一致性检查 (Cross-Submission Consistency)

**概述**：新增跨投递一致性检查功能。当向某公司生成简历时，系统自动检测素材库中是否有之前向同一公司投递过的简历/求职信，自动传递给 AI 并注入详细的一致性约束规则，确保同一公司的多份投递不会出现事实矛盾。

**新增功能**：
- 前端 `findSameCompanyFiles()` 函数：解析素材库文件名，提取公司名段并进行大小写不敏感匹配
- 前端 `buildPreviouslySubmitted()` 函数：拼接匹配文件的内容
- 前端 `showSameCompanyHint()` / `hideSameCompanyHint()` 函数：黄色警告栏 UI 提示
- `previouslySubmitted` 参数贯穿 `/api/generate`、`/api/review`、`/api/review-multi` 三个路由
- 生成 prompt 注入事实层硬性约束 + 表达层可调整规则
- 评审 prompt 追加跨投递一致性检查维度和输出格式

**修改文件**：
- `src/main.js` — 新增 `findSameCompanyFiles()`、`buildPreviouslySubmitted()`、`showSameCompanyHint()`、`hideSameCompanyHint()`；`doGenerate()`、`doReview()`、`doApplyReview()` 增加 `previouslySubmitted` 检测与传递逻辑
- `server/prompts/templates.js` — `getResumeGenerationPrompt` 增加 `previouslySubmitted` 非空时的分层一致性约束注入；`getReviewPrompt` 新增 `previouslySubmitted` 参数，追加跨投递一致性评审维度和输出小节
- `server/routes/api.js` — `/review` 和 `/review-multi` 路由解构并传递 `previouslySubmitted` 到 `getReviewPrompt()`
- `index.html` — 输出区 textarea 和状态栏之间新增 `<div id="sameCompanyHint">`
- `src/style.css` — 新增 `.same-company-hint` 样式（黄色背景、琥珀色边框）

### 2026-04-05 — 多供应商模型配置系统重构

**概述**：将原来的硬编码双模型系统（`opus` / `gemini`）重构为支持 7 个连接 × 4 个 Agent 角色的灵活配置系统。

**新增文件**：
- `server/services/openai-compat.js` — OpenAI 兼容 API 流式调用器，使用 raw `fetch`，支持多命名连接、SSE 解析、多模态内容转换

**修改文件**：
- `server/routes/api.js` — `/init` 接受 `modelConnections` 数组格式；`getModelCaller()` 基于 connection ID 路由到不同 SDK；`getConnectionLabel()` 从注册表获取显示名；向后兼容旧的 `opus`/`gemini` 值
- `server/prompts/templates.js` — Review 合并 prompt 使用动态 `r.label` 替代硬编码模型名
- `index.html` — 设置弹窗重写为两级配置：3 个供应商折叠区块（Jiekou.ai / OpenRouter.ai / Google AI Studio）的连接表格 + Agent 角色动态下拉/复选框
- `src/style.css` — 新增 `.modal-wide`（820px）、`.model-config-table`、`.provider-section` 样式
- `src/main.js` — 新增 `MODEL_CONNECTIONS` 定义、`getConnInput()`、`getConfiguredConnections()`、`populateAgentDropdowns()`、`buildModelConnections()`；`restoreState()` 支持 `connKey_*` 格式加密凭证和旧格式自动迁移；`saveSettings()` 构建连接数组发送服务端；所有 `state.get('xxxModel')` 的默认值更新为新的 connection ID
- `src/state.js` — `isCredentialKey()` 增加 `connKey_*` 前缀匹配

### 2026-04-04 — HTML 助手对话 + PDF 上传 + 多项 Bug 修复

**修复**：
- HTML 格式指令未被 AI 遵守 → prompt 中将用户格式要求前置以增加权重
- 输出/Review/HTML 区域隐藏需要先生成 → 改为始终可见
- 聊天输入框太小 → `rows="4"` + CSS `min-height: 80px` + JS 自动伸缩
- 「采纳并更新」丢弃用户编辑 → `doApplyReview()` 使用 `currentResume` 而非 `baseResumeContent`
- PDF 打印文件名错误 → HTML `<title>` 注入正确文件名
- Mock 模式缺少求职信 → 添加 `coverLetter`、`notes` 到 Mock 数据，路由按 `generateCoverLetter` 条件拼接
- Review 未分别评审求职信 → prompt 动态检测并追加求职信评审格式

**新增**：
- HTML 助手对话框 + PDF/图片上传功能
- Anthropic 和 Gemini 多模态内容转换
- 聊天消息「思考中...」 loading 指示器

### 2026-04-03 — 初始版本

- Express.js + Vite 6 应用框架搭建
- Anthropic SDK（Claude Opus 4.6 via Jiekou.ai 代理）集成
- Google GenAI SDK（Gemini 2.5 Flash via Google AI Studio）集成
- SSE 流式输出
- 简历生成、评审、多模型并行评审+合并、AI 对话、HTML 生成
- 文件读取（txt/html/pdf/docx）
- AES-GCM 加密凭证存储
- 仿真测试模式
- 自动保存生成的简历到素材库
- JD 自动解析命名
