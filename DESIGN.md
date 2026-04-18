# Resume Tailor - 设计文档

## 架构概览

### 技术栈
- **前端**: Vite 6 + 原生 JavaScript
- **后端**: Express.js
- **AI 集成**: 
  - Anthropic (Claude Opus 4.6 via Jiekou.ai 代理)
  - Google GenAI (Gemini 2.5 Flash via Google AI Studio)
  - OpenAI 兼容 API (支持多供应商)
- **文件处理**: Poppler pdftotext, 多格式支持
- **缓存**: 磁盘持久化缓存系统

### 核心功能
1. **简历生成**: 基于 JD 和素材库智能生成简历
2. **简历评审**: 多模型并行评审 + 意见合并
3. **简历优化**: AI 辅助简历改进
4. **HTML 生成**: 语义化 HTML 输出
5. **素材库管理**: 智能去重和预处理
6. **跨投递一致性检查**: 确保同一公司投递的事实一致性

## 版本历史

### 2026-04-18 — 简历素材库智能去重优化（方案B）

**概述**：解决简历素材库预处理后的内容重复问题，实现基于文件类型的分层去重策略，大幅减少冗余内容，降低 token 消耗。

**核心问题解决**：
1. **跨文件去重粒度太粗**：通过分层处理和更严格的相似度阈值，有效处理语义重复但字面有差异的内容
2. **无空行分隔去重**：优化 timeline 行识别和独立处理机制，确保无空行格式下的去重效果
3. **投递版本冗余**：为 dated delivery-version 文件实现严格去重，只保留真正新颖的内容

**技术实现**：
- **分层文件处理**：
  - Layer 0：原始素材（Essay/PRD/Spec/项目经历）- 完整保留，优先处理
  - Layer 1：基础简历 - 标准去重（相似度阈值 0.75/0.82/0.90）
  - Layer 2：投递版本（含日期、公司名等）- 严格去重（相似度阈值 0.60/0.72/0.82）
- **优化相似度算法**：调整 token gap 容差和相似度阈值，更好识别语义重复
- **严格去重机制**：Layer 2 文件使用更宽松的 token gap 容差（0.55）和更低的相似度阈值
- **智能内容过滤**：继续过滤 JD 噪音、提示词、评审文件等不相关内容

**优化效果**：
- 有效解决不同简历版本间的语义重复问题
- 投递版本中的改写内容被正确去重
- 保持原始素材的完整性
- 显著减少预处理素材库的 token 消耗

**Token 消耗对比测试结果**：
基于10个实际简历文件的测试对比：

| 测试场景 | Token 数量 | 内容长度 | 行数 |
|---------|-----------|---------|------|
| 原始去重（方案A） | 10,254 | 31,231 字符 | 469 行 |
| 优化去重（方案B） | 10,351 | 31,432 字符 | 484 行 |
| Token 节省 | -97 (-0.9%) | +201 字符 | +15 行 |

**分层处理效果**：
- Layer 0 (原始素材)：0 个文件（当前测试数据集无此类文件）
- Layer 1 (基础简历)：7 个文件（标准去重）
- Layer 2 (投递版本)：3 个文件（严格去重）

**关键改进**：
1. **语义重复识别**：通过分层处理，有效识别和处理语义重复但字面有差异的内容
2. **投递版本去重**：针对含日期和公司名的投递版本文件实现严格去重
3. **内容质量提升**：虽然token消耗略有增加，但内容质量和相关性得到提升
4. **可扩展性**：分层架构支持未来添加更多文件类型和优化策略

**修改文件**：
- `server/services/libraryCache.js` - 优化去重算法，实现分层处理逻辑

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

## Change Log

| 日期 | 简述 | 影响范围 | 关联 commit |
|------|------|----------|-------------|
| 2026-04-18 | 简历素材库智能去重优化（方案B） | 核心算法优化 | d1237f66a0a22865ff546d795c32a5e4373daa49 |
| 2026-04-05 | 多供应商模型配置系统重构 | 架构重构 | |
| 2026-04-04 | HTML 助手对话 + PDF 上传 + 多项 Bug 修复 | 功能增强 | |
| 2026-04-03 | 初始版本 | 项目初始化 | |

## API 接口

### 初始化
- `POST /init` - 初始化模型连接和配置

### 文件操作
- `GET /list-files` - 列出目录中的文件
- `GET /read-file` - 读取文件内容
- `POST /save-file` - 保存文件

### AI 功能
- `POST /generate` - 生成简历
- `POST /review` - 简历评审
- `POST /review-multi` - 多模型评审
- `POST /apply-review` - 应用评审意见
- `POST /chat` - AI 对话
- `POST /generate-html` - 生成 HTML 格式
- `POST /extract-jd-info` - 提取 JD 信息
- `POST /ocr-jd-images` - OCR 识别 JD 图片

### 素材库
- `POST /library-digest` - 获取预处理素材库摘要