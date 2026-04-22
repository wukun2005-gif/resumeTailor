
# 简历定制助手 — 设计文档

> 本文档供后续开发者阅读，以便理解项目全貌后继续开发。每次改动须在末尾 Change Log 追加记录。

👈 **[返回项目主页 (README.md)](./README.md)**

---

## 1. 项目概述

**简历定制助手** 是一个本地 GUI Web 应用，用于根据 JD（Job Description）和简历素材库，利用多个 AI 模型自动生成、评审、修改定制简历和求职信，并最终转换为 HTML 供用户手动打印为 PDF。
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
│   ├── main.js               # 前端主逻辑 (~1100 行)
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
│   │   ├── fileReader.js     # 文件读取 (txt/html/pdf/docx/md)
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
| `reviewInstructions` | 评审简历的 prompt 指令 | 否 |
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
- 用户可通过独立"评审指令"输入框自定义评审要求，prompt 中以"评审指令（用户自定义要求）"段落注入

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

- **本地识别优先或 AI 直接识别**：用户可选择“直接用 AI 识别”；若未勾选，图片先在浏览器端做本地 OCR（不消耗 Token），质量不佳时再提供 AI 补救按钮。
- **文本仍是唯一真源**：无论是本地还是 AI 识别，结果最终都被追加/替换到 `jdInput` 中，后续流程仅消费 JD 文本。
- **AI 角色复用**：AI 识别（包括直接识别和补救识别）均调用 `Format Converter` 角色分配的模型（通常是 Gemini）。

前端流程：

1. 用户选择多张 JD 图片。
2. 系统检查“直接用 AI 识别”勾选状态：
   - **若勾选**：直接将图片发送至后端 `/api/ocr-jd-images`，调用 `Format Converter` 进行识别。
   - **若未勾选**：
     - 前端按上传顺序逐张预处理（缩放、灰度/二值化）。
     - 使用浏览器端 Tesseract.js 提取文本。
     - 将文本追加到 `jdInput`。
     - 执行本地质量检查（长度、关键词命中、异常字符）。
     - 质量差时展示“用 AI 改进识别”按钮。
3. 识别结果追加到 `jdInput`。

AI 兜底与补救：
- 路由：`POST /api/ocr-jd-images`
- 输入：图片数组（base64）
- 输出：整理后的 JD 纯文本
- 状态：仅在初始勾选 AI 或后续补救时调用，主流程不重复发送图片。

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

| 日期 | 简述 | 影响范围 | 关联 commit |
|------|------|----------|-------------|
| 2026-04-22 | 添加PDF查看功能：HTML生成PDF后可在浏览器内直接打开查看 | UI/用户体验增强 | cce8fa09eef22b37c542c4596c1ef58dfc3c8e3a |
| 2026-04-21 | 新增"评审指令"输入区，支持自定义评审要求 | UI/功能增强 | - |
| 2026-04-20 | JD 图片上传增加"直接用 AI 识别"选项 | UI/功能增强 | [Antigravity] |
| 2026-04-18 | 简历素材库智能去重优化（方案B）：分层去重策略，显著减少 token 消耗 | 核心算法优化 | 0219b420 |
| 2026-04-15 | 素材库 digest 修复：缓存版本更新、JD 过滤漏洞修复 | 数据处理修复 | - |
| 2026-04-15 | 原始项目文档全文纳入：Essay/PRD/Spec/项目经历完整保留 | 数据处理增强 | - |
| 2026-04-15 | 素材库 digest：过滤提示词/说明文档 + 结构化分块去重 | 数据处理优化 | - |
| 2026-04-15 | 素材库 digest：JD 噪音过滤 + 近似段落去重 | 数据处理优化 | - |
| 2026-04-14 | Gemini 模型查询改为优先使用当前输入 Key | 用户体验修复 | - |
| 2026-04-11 | OpenRouter Anthropic Prompt Caching 支持 | Token 成本优化 | - |
| 2026-04-11 | 导出预处理文本素材库功能 | 功能增强 | - |
| 2026-04-09 | Orchestrator 透明化 + 原生 PDF 打印 + 多项回归修复 | 架构优化 | - |
| 2026-04-09 | 工作区自动清空 + Orchestrator 内部化 + JD OCR 纯文本化 | 交互设计优化 | - |
| 2026-04-08 | 图片 JD 输入 + 本地 OCR + Format Converter 兜底 | 功能增强 | - |
| 2026-04-08 | Dev Reload 草稿恢复 | 开发体验优化 | - |
| 2026-04-08 | 单主 E2E 合并 + 空连接兜底修复 + 模型查询状态优化 | 测试/交互优化 | - |
| 2026-04-08 | 测试策略收缩为按改动范围回归 | 测试流程优化 | - |
| 2026-04-08 | Gemini 免费文本模型过滤 + 内部退避重试 | 稳定性增强 | - |
| 2026-04-07 | PII 脱敏保护（V1.x）| 安全增强 | - |
| 2026-04-07 | Token 消费审计 + 优化（第三轮）| 成本优化 | - |
| 2026-04-07 | Output Token 优化回归修复 + E2E 测试 | 性能优化 | - |
| 2026-04-06 | Output Token 优化：差分模式、精简 prompt、Body-only HTML | 成本优化 | - |
| 2026-04-06 | Token 全面优化：素材库缓存、本地 JD 解析、Prompt Caching | 成本优化 | - |
| 2026-04-06 | PDF 文本提取改用 Poppler pdftotext | 依赖优化 | - |
| 2026-04-05 | 跨投递一致性检查 | 功能增强 | - |
| 2026-04-05 | 多供应商模型配置系统重构 | 架构重构 | - |
| 2026-04-04 | HTML 助手对话 + PDF 上传 + 多项 Bug 修复 | 功能增强 | - |
| 2026-04-03 | 初始版本发布 | 初始版本 | - |

> 详细变更内容可通过 `git log` 或 GitHub commit history 查看。

