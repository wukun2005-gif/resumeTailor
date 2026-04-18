
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
cd resumeTailor
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
| Generator | 简历/求职信生成 | 单选下拉 | `jiekou-anthropic` |
| Reviewer | 简历评审 | 多选复选框 | `google-studio-google` |
| Format Converter | HTML 转换；在本地 OCR 质量差时作为 JD 图片 OCR 的 AI 兜底 | 单选下拉 | `google-studio-google` |

补充说明：
- `Orchestrator` 作为可配置角色在“设置”中可见；用于 JD 解析及评审合并协调
- JD 解析的 AI 兜底默认复用 `Generator`
- `review-multi` 的合并与 Review 对话默认复用首个 `Reviewer`；若没有 Reviewer，则回退到 `Generator`

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
| POST | `/list-models` | 列出 Google AI Studio 可用于本应用的免费 Gemini 文本模型 | No |
| GET | `/list-files` | 列出素材库文件 | No |
| GET | `/read-file` | 读取单个文件 | No |
| POST | `/save-file` | 保存文件 | No |
| POST | `/library-digest` | 素材库清洗+去重 digest（排除 prompt/review artifact；完整纳入 PRD/Spec/Essay/项目经历等原始材料后去重） | No |
| POST | `/generate` | 生成简历/求职信 | SSE |
| POST | `/review` | 单模型评审 | SSE |
| POST | `/review-multi` | 多模型并行评审 + 合并 | SSE |
| POST | `/chat` | AI 对话（通用） | SSE |
| POST | `/apply-review` | 根据评审意见 diff 修改简历 | SSE |
| POST | `/generate-html` | 生成 HTML | SSE |
| POST | `/extract-jd-info` | 从 JD 提取公司/部门/职位 | No |
| POST | `/ocr-jd-images` | JD 图片 OCR 的 AI 兜底（仅用户主动触发） | No |

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

### `/list-models` 过滤策略

`POST /api/list-models` 当前仅服务于 `google-studio-google`，并且是一个**面向本应用场景的精简列表**，不是 Google 全量模型浏览器。返回结果满足以下约束：

- 仅返回适合简历/求职信生成场景的 **Gemini 文本模型**
- 仅返回免费可用模型，不显示 `pro`、deep research、robotics、computer use 等付费或专用模型
- 不显示图片/音频/TTS/embedding 等非文本模型
- 不显示 `latest`、`-001` 这类别名噪音，尽量保留用户真正需要手选的模型 ID

当前真实接口回归下，典型返回为 `gemini-2.5-flash`、`gemini-2.5-flash-lite`、`gemini-2.0-flash`、`gemini-2.0-flash-lite`、`gemini-3-flash-preview`、`gemini-3.1-flash-lite-preview`。

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
| `generatorModel` | Generator Agent 对应的 connection ID | 否 |
| `reviewerModels` | Reviewer Agent 的 connection ID 数组 | 否 |
| `htmlModel` | Format Converter 的 connection ID | 否 |
| `libraryPath` | 简历素材库绝对路径 | 否 |
| `genInstructions` | 生成简历的 prompt 指令 | 否 |
| `htmlInstructions` | HTML 转换的 prompt 指令 | 否 |
| `mockMode` | 仿真模式开关 | 否 |

### 6.3 工作区内容默认不持久化

当前版本进入应用时会自动清空工作区，不恢复上一次的 JD、生成结果、Review、聊天记录和 OCR 中间结果。保留的只有“设置层”信息，例如 API 连接、Agent 分配、素材库路径、指令和 PII 配置。

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
- 用于多 Reviewer 场景：多个模型并行评审后，由内部编排层默认复用首个 Reviewer 模型合并评审意见
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

### 7.6 JD 图片输入与 OCR 策略

新增能力：JD 不再只支持用户粘贴的纯文本，也支持上传 `1..N` 张职位截图图片（常见为社交媒体平台导出的 `JPG` / `PNG` / `WebP`）。

设计原则：

- **默认本地 OCR**：图片先在浏览器端做预处理和 OCR，不消耗 AI token
- **文本仍是唯一真源**：OCR 结果被追加写入 `jdInput`，后续 `/extract-jd-info`、`/generate`、`/review`、`/apply-review` 等全部继续只消费 JD 文本
- **AI 仅做兜底**：当本地 OCR 质量差，且用户主动点击“用 AI 改进识别”时，才调用 `Format Converter` 执行一次性 AI OCR 兜底

前端流程：

1. 用户选择多张 JD 图片
2. 前端按上传顺序逐张预处理（缩放、灰度/二值化）
3. 使用浏览器端 OCR 提取文本
4. 将净化后的 JD 纯文本**追加**到 `jdInput`
5. 本地质量检查：
   - 文本长度
   - JD 关键词命中（职责 / 要求 / 任职等）
   - 异常字符比例
6. 质量差时显示提示；若已配置 `Format Converter`，展示“用 AI 改进识别”按钮

AI 兜底：

- 路由：`POST /api/ocr-jd-images`
- Agent：复用 `Format Converter`
- 输入：图片数组
- 输出：整理后的 JD 纯文本
- 只在用户主动触发时调用一次；生成、评审等主流程不会重复发送这些图片

JD 输入框中只保留最终的 JD 纯文本，不写入批次号、图片文件名或其他技术分隔符，因此不会额外污染 prompt，也不会为这些辅助标记消耗 token。

---

## 8. UI 布局

```
┌─────────────────────────────────────────────┐
│  Header: [简历定制助手]  [仿真模式] [设置]    │
├─────────────────────────────────────────────┤
│  输入区                                      │
│  ├ JD 输入框 + JD图片上传 / OCR状态           │
│  ├ 素材库路径 + 浏览/加载/导出预处理文本按钮    │
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
- **Agent 模型分配**：3 个选择器（Generator / Reviewer / Format Converter），从已配置连接中动态生成选项
- 动态更新：用户在连接表中填入 API Key 后，Agent 分配区的下拉选项即时刷新

---

## 9. 文件命名与保存

### 命名规则
`wukun - {type} - {company} - {department} - {title} - {YYYY-MM-DD}.{ext}`

- `type`：`resume`
- 公司/部门/职位由内部 JD 解析流程从文本 JD 中提取（先本地规则，再由 `Generator` 做 AI 兜底）；若 JD 最初来自图片，也会先在前端 OCR 成文本
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
- `jdOcr`：模拟 JD 图片 OCR 兜底结果

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
- Gemini 不同模型的免费配额差异较大；模型列表只显示“免费且适合文本生成”的 Gemini 模型，默认优先使用 `gemini-2.5-flash`
- OpenAI-compat 的 PDF 多模态支持有限（转为文本占位符）
- 加密基于浏览器指纹，更换浏览器会丢失已保存凭证
- 应用数据存在 localStorage，清除浏览器数据会丢失所有配置

---

## 14. 开发指南

### 回归测试要求

不再要求“每次改动都跑一次全量统一 E2E”。这条规则已经被证伪：对免费 Gemini 配额敏感、耗时长、限流波动大，会让测试体系本身变成负担。

今后的规则是：**按改动范围做最小充分回归，由 feature owner 自行设计并说明测试路径。**

基本原则：

- 目标是防止主功能出现明显 regression，不追求每次全覆盖
- 只回归和本次改动直接相关的路径；与改动无关的路径不要求覆盖
- 涉及真实 AI API 的测试要尽量少，只保留必要路径，避免重复和无价值消耗免费额度
- 除了必须打真实 AI API 的路径，其余尽量用本地集成测试、mock 或人工冒烟完成

推荐分层：

1. 本地集成测试
   - 默认优先
   - 不调用真实 AI
   - 适合前端状态、素材库、文件读写、`.pages` fallback、工作区清空、模型查询 UI 等
2. 定向真实 AI 测试
   - 仅在改动直接影响 AI 调用链时执行
   - 一次只测本次改动影响的那一两条 AI 路径
   - 例如只改 `/generate`，就只测生成，不要求顺带测 review/html/chat
3. 人工冒烟
   - 最后人工过 1 到 2 条关键流程
   - 用于兜住“代码没报错但体验坏了”的问题

哪些改动必须跑真实 AI：

- prompt 修改
- `server/routes/api.js` 中 AI 路由的请求体、返回体、fallback、retry、SSE 逻辑
- `server/services/gemini.js`
- PII 脱敏/恢复链路
- 前端到后端的 AI 请求结构变化
- 模型发现、模型过滤、连接选择逻辑

哪些改动尽量不要跑真实 AI：

- 纯 UI 文案或样式
- 展开/收起、按钮状态、提示文案
- 工作区清空
- 文件读取、素材库元数据、`.pages` 手动粘贴 fallback
- 其他纯本地逻辑

当前建议：

- `npm run build` 仍然是所有源码修改后的基础检查
- `test-e2e.mjs` 保留为一个可复用的综合回归脚本，但不再要求每次都全量执行
- 若需要真实 AI 回归，建议使用独立端口启动一份测试后端，并仅执行与改动相关的最小路径
- `npm run dev` 使用 Vite 热更新；只要工作区内的前端源码被修改，浏览器就可能整页 reload。当前版本不做工作草稿自动恢复，开发时请避免把正式操作放在会触发热更新的会话里

### 14.1 HTML 打印链路最小冒烟清单

当改动 `doGenerateHtml()` 或导出相关 UI 时，至少做一次人工冒烟：

1. 点击“生成排版并保存为PDF”，确认浏览器弹出系统打印对话框
2. 观察导出后状态文案应进入成功状态，不应卡在 loading
3. 取消打印后继续操作页面，按钮应恢复可点击，不应锁死
4. 若导出报错，应显示失败状态，不应吞错或无提示

### 添加新的模型供应商
1. 如果是 OpenAI 兼容 API：无需改后端，只需在 `index.html` 添加表格行 + `main.js` 的 `MODEL_CONNECTIONS` 添加条目
2. 如果是非兼容 API：在 `server/services/` 添加新 caller + `api.js` 中 `getSdkType()` 添加路由

### 添加新的 Agent 角色
1. `index.html` 设置弹窗添加下拉/复选框
2. `main.js` 的 `populateAgentDropdowns()` 中注册新选择器
3. `main.js` 中对应功能函数通过“已配置连接解析”辅助函数读取模型，避免把空字符串 connection id 直接发到后端
4. `saveSettings()` 和 `restoreAgentAssignments()` 中处理新角色

### 修改 Prompt 模板
编辑 `server/prompts/templates.js`，无需改动前后端代码。

---

## 15. 用户原始需求摘要

- 一站式完成简历生成 → 评审 → 修改 → HTML 导出
- 支持 Opus 4.6（付费 Jiekou.ai 代理）和 Gemini（免费 Google AI Studio / 付费代理）
- 多 Agent 协作：Generator / Reviewer / Format Converter + 内部编排逻辑
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

### 2026-04-15 -- 素材库 digest：修复回归遗漏文件与 JD 提取漏洞（by Antigravity）

**概述**：修复此前由于 `CACHE_SCHEMA_VERSION` 未更新导致的旧缓存持续生效问题；重新明确对各类项目文档（Agent、Model、Finance、规格书等）的无条件纳入策略（不再强行受制于 careerScore）；并且修复了此前对纯中文 JD 正则匹配评分太低（只有 1 分）从而漏网的漏洞。
另外修复了一个由放宽 PRD 提取策略引起的漏洞：包含有 PRD 关键词的 Prompt 文件（如“简历arena提示词.txt”）在之前的逻辑中能够绕过文件黑名单检查，目前已将文件黑名单前置为顶级铁律，且增强了 `jdScore >= 2` 的一票否决权，确保含有较高职涯关键词的纯英文 JD 不再渗透进用户结果库。

**实现**：
- `server/services/libraryCache.js`：将 `CACHE_SCHEMA_VERSION` 更新为 `digest-v5`，强制系统再次基于新规则全面洗牌去重。
- `extractRelevantParagraphs`：将 `NEGATIVE_FILE_NAME_PATTERNS` 验证移动到所有文本和内容正则扫描之前的首行进行拦截。
- `shouldKeepFile`：将 `jdScore >= 2` 变为独立的一票否决条件，废弃掉高 `careerScore` 的豁免保护，阻断含丰富经验关键词英语职位描述绕过过滤的漏洞。
- 扩展 `FULL_PRESERVE_FILE_NAME_PATTERNS`：显式加入 `agent`、`model`、`finance`、`规格书`。
- 修改 `shouldPreserveFullFile`：放宽 PRD 的正文判定条件，如果包含 PRD 等文件类型且毫不含 JD 时强制提取。
- 修复 `getJdSignalScore`：分离 "岗位职责" 与 "任职要求"，使得中文 JD 累加打分正常达到 2 分以上遭到过滤。
- `test-e2e.mjs`：对针对 prompt 文件规避库检测的特殊案例追加了附带 "PRD" 字眼的注入测试以防御未来的再回归。

### 2026-04-15 -- 素材库 digest：原始项目文档全文纳入（by Codex）

**概述**：修正上一版规则过于激进的问题。用户明确要求 `Essay`、`PRD`、`Spec/Specification`、`项目经历` 等原始工作经历材料必须全文纳入 digest，一个字都不能丢；这些材料进入 digest 后允许和其他素材去重，但不再因为文件名、JD-like 词汇或规格文档结构被过滤掉。

**实现**：
- `server/services/libraryCache.js`：新增 `FULL_PRESERVE_FILE_NAME_PATTERNS`、`FULL_PRESERVE_CONTENT_PATTERNS`、`shouldPreserveFullFile()`、`splitPreservedBlocks()`、`splitStoredDigestContent()`。
- 对命中 `Essay` / `PRD` / `Spec` / `项目经历` 的文件，以及内容中明显属于 `Specification` / `PRD` 的工作文档，改为“全文保留分块”路径：保留原始文本，不再做 JD / prompt 段落裁剪，只参与全局去重。
- 继续排除明显的 artifact 文件：`prompt`/`提示词`/`arena`/`review`/`score`/`AGENTS.md`/`README*`/`DESIGN*`/旧导出 `素材库预处理文本-*.txt`。
- `appendToDigestCache()` 改用 `splitStoredDigestContent()` 读取已缓存内容，保证增量更新与“全文保留”策略一致。
- `CACHE_SCHEMA_VERSION` 升级到 `digest-v3`，触发旧 cache 自动失效重建。
- `test-e2e.mjs`：`testFileRoutesAndDigest()` 新增 `Written Essay.txt`、`OmniDataFlow PRD.md`、`ExcelAgent Specification.md`、`项目经历.txt` 样本；断言这些文件会被全文纳入，同时 `job-description.txt` 与 `简历arena提示词.txt` 仍会被排除。

**验证**：
- `node --check server/services/libraryCache.js`
- `node --check test-e2e.mjs`
- 本地合成样本 direct call：`项目经历.txt` / `Written Essay.txt` / `OmniDataFlow PRD.md` / `ExcelAgent Specification.md` 均进入 digest，且保留原文；`简历arena提示词.txt` 与纯 `job-description.txt` 仍被排除
- 对真实素材库 `/Users/wukun/Documents/jl` dry-run：`fileCount=88`，并确认 `Written Essay.txt`、`Resume Tailor APP - PRD.md`、`项目经历.txt`、`ExcelAgent_Kun_FinanceModel.pdf`、`OmniDataFlow PRD.pdf` 均已纳入 digest
- `npm run build`

**文档**：`README.md` 产品边界与术语；本表 `/library-digest` 说明。

### 2026-04-15 -- 素材库 digest：过滤提示词/说明文档 + 结构化分块去重（by Codex）

**概述**：继续压缩导出素材库中的无关内容。除了原有 JD 噪音过滤外，这次进一步排除提示词/打分稿/说明文档等非经历文件，并把 PDF/无空行履历按 heading、bullet、timeline 拆成更小块后再去重，减少像 Apple PMO prompt/JD 混入和同一事实跨版本反复出现的问题。

**实现**：
- `server/services/libraryCache.js`：新增 `shouldKeepFile()`、`splitParagraphs()`、`classifyLine()`、`getCareerSignalScore()`、`getPromptSignalScore()`、`getJdSignalScore()`，把清洗提升为“文件级筛除 + 结构化分块 + 段落级保留/去重”三层策略。
- 文件名和内容双重过滤：默认排除 `prompt`/`提示词`/`review`/`score`/`AGENTS`/`PRD`/`essay` 等明显非素材文件；对整文件做 career-signal / prompt-signal / JD-signal 打分，避免整份提示词或说明文档进入 digest。
- 去重与缓存：`fingerprintParagraph()` 改为 token 指纹，短块走精确比较，长块走更宽松的近似重复阈值；`CACHE_SCHEMA_VERSION` 写入 cache key，确保旧规则生成的 digest 会自动失效重建。
- `test-e2e.mjs`：`testFileRoutesAndDigest()` 新增 prompt artifact 样本和“无空行但有 bullet”的履历样本；断言导出 digest 不含 `简历arena提示词.txt`、不含 Apple PMO prompt/JD 文本，并继续验证共享经历与近似重复事实只保留一份。

**验证**：
- `node --check server/services/libraryCache.js`
- `node --check test-e2e.mjs`
- `npm run build`
- `node -e "import { getLibraryDigest } from './server/services/libraryCache.js'; ..."`：对真实素材库 `/Users/wukun/Documents/jl` dry-run，结果 `fileCount=78`，且 `hasPromptFile=false`、`hasAgents=false`、`hasPrd=false`、`hasApplePmoPrompt=false`
- `TEST_BASE=http://localhost:3002/api node test-e2e.mjs`：完整 Lean E2E 已执行；所有 `/library-digest` 相关断言通过，但脚本后续仍因外部 Gemini API 繁忙和 `/extract-jd-info` 实时调用失败而未全绿

**文档**：`README.md` 产品边界与术语；本表 `/library-digest` 说明。

### 2026-04-15 -- 素材库 digest：JD 噪音过滤 + 近似段落去重（by Codex）

**概述**：在段落 MD5 去重基础上，过滤明显 JD/招聘无关段落，并合并高度相似的经历段落，降低导出与生成流程中的冗余 token。

**实现**：
- `server/services/libraryCache.js`：`isLikelyIrrelevantParagraph()`、`fingerprintParagraph()`、`similarity()`；`getLibraryDigest` 与 `appendToDigestCache` 共用同一套清洗逻辑。
- `isExportedDigestArtifactFileName()`：默认排除文件名匹配 `素材库预处理文本-*.txt`（与应用导出的预处理文本下载名一致），避免「导出结果再被读入 digest」的递归噪音；`appendToDigestCache` 对同名保存也不写入缓存。
- `test-e2e.mjs`：`testFileRoutesAndDigest` 增加 JD 样本与近似重复英文段落断言；断言导出 digest 不含上述 artifact 文件名。

**验证**：
- `node --check server/services/libraryCache.js`
- `node --check test-e2e.mjs`
- `npm run build`

**文档**：`README.md` 产品边界与术语；本表 `/library-digest` 说明。

### 2026-04-14 -- Gemini 模型查询改为优先使用当前输入 Key（by Codex）

**概述**：修复“设置页查询 Gemini 模型时误报 API key 无效”的易错交互。根因是查询接口只使用后端已初始化的旧 key（依赖先点“保存设置”），与用户当前输入框的新 key 脱节。

**实现**：
- `src/main.js`：`fetchGeminiModels()` 查询前读取 `google-studio-google` 当前输入框 key；为空时直接提示；查询时传给前端 API 层。
- `src/api.js`：`listModels(connectionId, apiKey)` 新增 `apiKey` 参数并透传给后端。
- `server/routes/api.js`：`POST /api/list-models` 支持 `apiKey` 覆盖，优先使用请求体中的 key；若未提供再回退到连接注册表中的 key。

**验证**：
- 直接调用 Gemini 官方 `models` 接口验证 `.env` 中 key 有效（返回 200 + models 列表）。
- 本地复现旧行为：后端初始化为无效 key 时会报 “API key not valid”。
- 修复后验证：同样初始化无效 key，但在 `/api/list-models` 传入有效 `apiKey` 可成功返回模型列表。

**文档**：
- `README.md` 快速参考增加“查询 Gemini 模型失败排查”说明。

### 2026-04-11 -- OpenRouter Anthropic Prompt Caching Support (by Copilot GPT-4.1)

**Overview**: Enable prompt caching for Anthropic models via OpenRouter, reducing token usage by up to 90%.

**Implementation**:
- `server/services/openai-compat.js` detects Anthropic models (connectionId/model) and passes system/user messages as content blocks with `cache_control: { type: 'ephemeral' }`.
- No changes to API routes or prompt templates required; only the OpenAI-compat layer is updated.

**Testing**:
- `node --check server/services/openai-compat.js`
- `npm run build`
- Manual: Configure OpenRouter Anthropic, run generate/review, verify cache hits in OpenRouter dashboard.

**Impact**:
- Dramatically reduces prompt token cost for Anthropic via OpenRouter.
- No user-facing UI changes; optimization is internal.

### 2026-04-11 -- Export Preprocessed Text Library (by Antigravity)

**Overview**: Expose the internal library preprocessing (paragraph dedup) functionality to users. A new button allows exporting a human-readable `.txt` file of the deduplicated library for use with other AI tools.

**Implementation**:

- Reuses existing `POST /api/library-digest` route (no backend changes needed)
- Frontend `exportDigest()`: calls API with no exclusions, formats digest as human-readable text with metadata header + file separators, triggers browser Blob download
- Export filename: `Export-YYYY-MM-DD.txt`
- Button enabled after library load, disabled otherwise

**Changed files**:

- `index.html` -- new `#exportDigestBtn` and `#exportDigestStatus` in library path row
- `src/main.js` -- DOM refs, event binding, `exportDigest()`, enable button in `loadLibrary()`
- `test-e2e.mjs` -- full-export digest test in `testFileRoutesAndDigest()`
- `DESIGN.md` -- UI layout + Change Log
- `README.md` -- product boundary table

**Testing**:

- `node --check` all source files: passed
- `npm run build`: passed

### 2026-04-09 -- Orchestrator + Native Print + Regression Fixes (by Antigravity)

**概述**：
- **Orchestrator 透明化**：取消模型选项黑盒化，向用户显式提供性价比排序机制，优先推荐免费 Gemini 以节约成本。
- **原生 PDF 打印**：注入隐藏 `iframe` 并执行 `window.print()`，直接唤起系统原生的 PDF 打印弹窗。

**回归修复专项 (Regression Fixes)**：
- **内容保真红线**：禁绝 AI 在 HTML 排版中改写原文，确保 100% 还原。
- **文件名动态劫持**：通过临时修改 `document.title`，强制引导打印对话框使用规范文件名。
- **PII HTML 转义兼容**：自动还原被转义为 `&lt;&lt;NAME&gt;&gt;` 的占位符。
- **UI 语义修正**：更正按钮文本为“生成排版并保存为PDF”。

**修改文件**：
- `index.html` — `#cfgAgentOrchestrator` 解除隐藏；修正生成按钮文案。
- `src/main.js` — 升级 `doGenerateHtml` 增加 `document.title` 劫持；调整状态恢复逻辑。
- `server/services/piiSanitizer.js` / `server/prompts/templates.js` / `server/routes/api.js` 等深度重构。

### 2026-04-09 — 工作区自动清空 + Orchestrator 内部化 + JD OCR 纯文本化

**概述**：收紧前一版的交互设计，去掉过度工程化的状态恢复和显式 Orchestrator 配置。进入应用时工作区自动清空；设置里只保留 3 个可配置 Agent；JD 图片 OCR 结果只把最终纯文本写入 JD 输入框，不再插入任何批次/文件名分隔符。

**实现要点**：

- `src/main.js`
  - `restoreDraftState()` 改为启动即清空工作区，不再恢复旧草稿
  - `persistDraftState()` 退化为空实现，工作内容不再跨启动保存
  - JD 解析默认复用 `Generator`；`review-multi` 合并和 Review 对话默认复用首个 `Reviewer`
  - JD 图片上传后的本地 OCR 和 AI OCR 兜底结果，都只向 `jdInput` 追加/替换净化后的纯文本
- `index.html`：设置中隐藏 `Orchestrator` 下拉，仅保留 `Generator / Reviewer / Format Converter`
- `README.md` / `DESIGN.md`：同步更新产品结构、状态策略和当前职责边界

**测试**：

- `node --check src/main.js`
- `node --check server/routes/api.js`
- `node --check test-e2e.mjs`
- `npm run build`

### 2026-04-08 — 图片 JD 输入 + 本地 OCR + Format Converter 兜底

**概述**：新增图片型 JD 输入能力。用户除了粘贴文本 JD，还可以上传 1..N 张社交媒体平台导出的职位截图或普通 `JPG/PNG/WebP` 图片。系统默认先在浏览器端做图片预处理和本地 OCR，把结果追加写入 JD 输入框；只有当本地 OCR 质量差且用户主动触发时，才调用 `Format Converter` 做一次性 AI OCR 兜底，从而尽量把图片 JD 的 token 消耗压到最低。

**实现要点**：

- `index.html`：JD 区新增“上传 JD 图片”、“用 AI 改进识别”、OCR 状态和质量提示
- `src/main.js`：
  - 接入浏览器端 `tesseract.js` 本地 OCR
  - 图片预处理（缩放、灰度/二值化）
  - 多图按顺序识别并**追加**到现有 JD 文本后面
  - 新增 OCR 质量检测，决定是否展示 AI OCR 兜底入口
  - `Format Converter` 角色文案改名，不再局限于“HTML Converter”
- `server/routes/api.js`：新增 `POST /api/ocr-jd-images`，复用 `Format Converter` 模型做一次性 AI OCR 兜底；mock 模式同步支持
- `test-e2e.mjs`：新增 `/ocr-jd-images` mock 回归

**测试**：

- `node --check server/routes/api.js`：通过
- `node --check src/main.js`：通过
- `node --check test-e2e.mjs`：通过
- `npm run build`：通过
- `curl http://localhost:3003/api/ocr-jd-images`（mock 路由）验证：通过

**改动文件**：

- `index.html`
- `src/style.css`
- `src/api.js`
- `src/main.js`
- `server/routes/api.js`
- `test-e2e.mjs`
- `README.md`
- `DESIGN.md`

### 2026-04-08 — Dev Reload 草稿恢复

**概述**：修复开发模式下前端源码热更新触发整页 reload 后，JD、生成结果和 Review 结果全部丢失的问题。根因不是服务端崩溃，而是 `npm run dev` 下 Vite 监听到 `src/main.js` 变更后主动刷新页面；原先应用没有保存工作中的草稿。

**实现要点**：

- `src/main.js` 增加本地 `draftState`，自动保存 JD、手动简历、是否生成求职信、简历输出、Review 输出、AI 备注和状态文本
- 在用户输入、流式 chunk 更新、保存完成，以及 `beforeunload` / `visibilitychange` 时落盘草稿
- 页面初始化时自动恢复草稿；若检测到之前已有工作内容，会显示“已恢复本地草稿（页面曾刷新）”
- 这只能恢复已经落盘的内容；若页面在流式请求中途 reload，请求本身仍会被浏览器中断，需要手动重新发起

**真实回归结果**：

- `npm run build`：通过
- `TEST_BASE=http://localhost:3003/api node test-e2e.mjs`：40/40 通过

**改动文件**：

- `src/main.js` — 工作草稿自动保存与恢复
- `DESIGN.md` — dev reload 说明与 changelog 更新

### 2026-04-08 — 单主 E2E 合并 + 空连接兜底修复 + 模型查询状态优化

**概述**：将原先分离的主流程 E2E 与 PII E2E 合并为单一主套件，后续所有新功能的端到端回归都必须并入 `test-e2e.mjs`。同时修复空 connection id 导致的生成失败，补上 `/extract-jd-info` 的本地兜底解析，并把“查询模型”的前端交互状态改成最简洁的朴素提示。

**实现要点**：

- `test-e2e.mjs` 合并普通流程、`/review-multi`、PII 脱敏/恢复链路到一个主脚本；删除 `test-pii-e2e.mjs`
- 回归规范更新为“每次源码修改只跑一次主 E2E”，并明确新功能测试必须追加到 `test-e2e.mjs`
- `src/main.js` 为模型查询增加 `查询中...` / `查询完毕` / `查询失败` 状态；默认展开免费 Google AI Studio，默认收起 `jiekou.ai`
- `src/main.js` 改为基于“已配置连接解析”读取 Agent 模型，避免把空字符串模型 id 发给后端；未配置对应模型时会禁用相关按钮
- `server/routes/api.js` 在仅存在一个已初始化连接时自动回退到该连接；`/extract-jd-info` 增加本地规则兜底，避免 AI JSON 偶发失败直接变成空结果
- `server/services/gemini.js` 不再单纯按 `pro` 名称排除模型，而是按“免费且适合文本生成的 Gemini 模型”过滤；保留对 image/audio/video/computer-use 等非本应用场景模型的过滤

**真实回归结果**：

- `npm run build`：通过
- `TEST_BASE=http://localhost:3003/api node test-e2e.mjs`：40/40 通过
- 测试使用 `.env` 中真实免费 `GEMINI_KEY`，主 E2E 默认模型为 `gemini-3.1-flash-lite-preview`

**改动文件**：

- `index.html` — 默认展开/收起顺序调整；模型查询状态占位
- `src/style.css` — 模型查询状态文本布局
- `src/main.js` — 模型查询状态；Agent 连接解析；空连接防御；按钮可用性修正
- `server/routes/api.js` — connection id 归一化与单连接回退；`/extract-jd-info` 本地兜底
- `server/services/gemini.js` — Gemini 免费文本模型过滤规则放宽到不限于 flash/lite
- `test-e2e.mjs` — 合并主流程 + `review-multi` + PII 主回归
- `DESIGN.md` — 单主 E2E 规则与 changelog 更新

### 2026-04-08 — 测试策略收缩为按改动范围回归

**概述**：复盘“大一统全量 E2E”策略后，确认它不适合本项目当前阶段。真实免费 Gemini 配额有限，且限流和网络波动会显著放大全量统一回归的耗时与不稳定性。后续不再要求“每次改动都跑一次全量统一 E2E”，改为由 feature owner 按改动范围设计最小充分回归。

**结论**：

- 不再要求每次源码改动都全量执行 `test-e2e.mjs`
- 后继测试目标从“全覆盖”调整为“避免主要功能出现明显 regression”
- 所有涉及真实 AI API 的测试路径都要仔细审查，避免重复、冗余和无必要的免费额度消耗
- 除必须真实调用 AI 的路径外，其余尽量改为本地集成测试、mock 或人工冒烟

**新规则**：

- feature owner 负责为本次改动说明“测了哪些路径，为什么这些已经足够”
- 仅回归与改动直接相关的路径
- 与改动无关的路径不要求顺带覆盖
- 涉及 prompt、AI 路由、PII、SSE、模型发现/选择时，才执行定向真实 AI 回归

**改动文件**：

- `DESIGN.md` — 删除“每次源码修改都全量主 E2E”的旧规则，改为按改动范围做最小充分回归

### 2026-04-08 — Gemini 免费文本模型过滤 + 内部退避重试 + 真实回归补强

**概述**：收紧 Google AI Studio 的模型发现逻辑，只显示适合本应用场景的免费 Gemini 文本模型；同时在 `callGemini()` 内部加入 429/503 的指数退避重试，降低真实接口回归时的瞬时高负载失败率。补强两套真实 E2E 脚本，修复 fatal 假阳性，并将 `/list-models` 纳入回归覆盖。

**实现要点**：

- `listGeminiModels()` 改为基于实时 models API 做场景化过滤：仅保留免费 Gemini 文本模型
- 过滤掉 `pro`、deep research、robotics、computer use、image/audio/TTS/embedding，以及 `latest` / `-001` 别名噪音
- `callGemini()` 在真正拿到流式 response 前，对 429/503/高负载错误做指数退避重试；一旦开始流式返回就不再重试，避免重复 chunk
- `test-e2e.mjs` 新增 `/list-models` 断言，并修复 fatal 不计失败的问题
- `test-e2e.mjs` / `test-pii-e2e.mjs` 支持 `TEST_BASE`，可指向独立测试后端实例；并对 429/503/高负载/瞬时网络错误做有限重试

**真实回归结果**：

- `npm run build`：通过
- `TEST_BASE=http://localhost:3003/api node test-e2e.mjs`：22/22 通过
- `TEST_BASE=http://localhost:3003/api node test-pii-e2e.mjs`：15/15 通过

**改动文件**：

- `server/services/gemini.js` — 免费 Gemini 文本模型过滤；429/503 指数退避重试
- `src/main.js` — 模型列表空态提示；避免重复绑定选择事件
- `test-e2e.mjs` — `/list-models` 真实接口断言；fatal 失败计数；`TEST_BASE`；重试增强
- `test-pii-e2e.mjs` — fatal 失败计数；`TEST_BASE`；重试增强

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
### 2026-04-09 — Orchestrator 透明化与极客级原生打印接入

**概述**：
- 取消了 Orchestrator 模型选项的黑盒化，向用户显式提供性价比排序机制，最高优先推荐免费 Gemini 以节约成本。
- 实现真正的纯正 PDF 触达：在调用 AI 完成深度的 HTML 语义结构转换后，系统不再提供繁琐的 `.html` 下载附件模式，而是通过注入隐藏 `iframe` 并执行 `window.print()`，直接在浏览器端调起系统原生的 PDF 打印弹窗。彻底解决 PDF 不可选字、无法过 ATS 的痛点问题。

**修改文件**：
- `index.html` — `#cfgAgentOrchestrator` 解除隐藏限制。
- `src/main.js` — 修改了 `populateAgentDropdowns()` 和 `applyResolvedAgentSelections()`；升级 `doGenerateHtml` 逻辑，移除冗余的 HTML 文件下载拦截，添加原生 `window.print()` 挂载与触发闭环。
- `test-e2e.mjs` — 针对 `/generate-html` 开发并强化了具备 `<h2>` 等语义化断言的 TDD 严苛测试防护。

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
