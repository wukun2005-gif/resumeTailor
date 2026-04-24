# AI 预处理素材库功能 - 开发检查清单

## 后端实现检查清单

### 阶段 1: AI 预处理缓存机制 (server/services/libraryCache.js)
- [x] AI 缓存支持 - 通过 mode 字段区分 local/ai (第 702 行: cached.mode !== 'ai')
- [x] AI 缓存命中条件 - 文件未变 + prompt 未变 + model 未变 + piiEnabled (第 666-677 行 buildAiCacheKey)
- [x] getAiPreprocessedLibrary() 函数 (第 689-717 行)
- [x] saveAiDigestCache() 函数 (第 730-753 行)
- [x] readRawLibraryFiles() 函数 (第 764-790 行) - 读取原始素材，不做本地去重
- [x] loadDigestCache() 的 mode 校验 (第 702 行)

### 阶段 2: AI 预处理模板 (server/prompts/templates.js)
- [x] getLibraryPreprocessPrompt() 函数 (第 320-388 行)
- [x] 分隔符协议 - ===== 预处理文本开始/结束 ===== (第 339, 383 行)
- [x] 系统指令：无文件系统工具，基于给定材料工作 (第 298-302 行 PREPROCESS_SYSTEM)
- [x] 最高原则：完整保留原文、不推断、不改写、lossless压缩、provenance标注 (第 304-311 行)
- [x] 输出格式：§1-§10 结构化章节 (第 348-382 行)

### 阶段 3: AI 预处理 API 路由 (server/routes/api.js)
- [x] GET /default-preprocess-prompt 路由
- [x] POST /preprocess-library 路由
- [x] AI 缓存命中检测 (getAiPreprocessedLibrary)
- [x] AI 调用逻辑 (callModel)
- [x] 结果解析（分隔符协议 ===== 预处理文本开始/结束 =====）
- [x] 失败回退本地预处理 (fallbackUsed: true)
- [x] 写回 digest.json (saveAiDigestCache)
- [x] sourceTokens / digestTokens 统计

## 前端实现检查清单

### 阶段 4: 状态和 UI (index.html + src/main.js)
- [x] useAiPreprocess 状态（默认 false）
- [x] preprocessInstructions 状态
- [x] preprocessorModel 状态
- [x] Settings 中 Preprocessor Agent 下拉选择器 (cfgAgentPreprocessor)
- [x] 素材库区 "使用 AI 预处理" 复选框
- [x] 预处理指令 <details> 区域 (preprocessInstructionsSection)
- [x] "和预处理助手对话" 对话区域 (preprocessChatSection)
- [x] preprocessChatHistory / preprocessChatInput 状态
- [x] 预处理对话 bubble 类型：user / ai / system
- [x] 系统消息样式（灰色提示）

### 阶段 5: 前后端 API 连接 (src/api.js + src/main.js)
- [x] getDefaultPreprocessPrompt() API 函数
- [x] preprocessLibrary() API 函数（SSE 流式）
- [x] exportDigest() 分支逻辑：useAiPreprocess?.checked 判断
- [x] exportDigestWithAi() 函数
- [x] ensureDefaultPreprocessInstructions() 函数 - 已实现，自动加载默认 prompt
- [x] 预处理对话消息发送逻辑 (preprocessChatMessages)
- [x] Token 统计显示在系统消息中 (sourceTokens/digestTokens)

## PII 脱敏功能检查清单

### 后端 PII 服务 (server/services/piiSanitizer.js)
- [x] sanitize() 函数 - 真实 PII → 占位符
- [x] restore() 函数 - 占位符 → 真实 PII
- [x] 支持的 PII 类型：EMAIL, PHONE, NAME, NAME_ZH
- [x] 长度降序替换（避免邮箱包含姓名的问题）
- [x] SSE 流式缓冲恢复 - createStreamRestorer()

### PII 路由集成 (server/routes/api.js)
- [x] /init 路由集成 PII - setPiiConfig()
- [x] /generate 路由集成 PII
- [x] /review 路由集成 PII
- [x] /chat 路由集成 PII
- [x] /review-multi 路由集成 PII
- [x] /apply-review 路由集成 PII
- [x] /generate-html 路由集成 PII
- [x] /preprocess-library 路由集成 PII

### 前端 PII 配置 (index.html + src/main.js)
- [x] Settings 中 PII 配置区域
- [x] buildPiiConfig() 函数
- [x] piiConfig 传递给 initAPI

## 测试验证检查清单

### test-e2e.mjs 覆盖
- [x] /library-digest 本地预处理测试 (多个测试用例)
- [x] /generate 功能测试
- [x] /review 功能测试
- [x] /review-multi 功能测试
- [x] /generate-html 功能测试
- [x] /preprocess-library AI 预处理测试 - testPreprocessLibrary() 函数
- [x] AI 缓存命中/失效测试 - testPreprocessLibrary() 测试 2-4
- [x] /default-preprocess-prompt 测试 - testDefaultPreprocessPrompt() 函数
- [x] testAiPreprocessLibrary() - 完整 AI 预处理流程测试
- [x] testAiPreprocessCache() - AI 缓存命中测试
- [x] testAiPreprocessFallback() - AI 预处理回退本地测试
- [x] testAiPreprocessRealApi() - 真实 AI API 预处理测试
- [x] PII 相关测试：
  - [x] pii /init ready
  - [x] pii /generate no placeholders leaked (checkPiiRestored)
  - [x] pii /generate real PII restored
  - [x] pii /review no placeholders leaked
  - [x] pii /chat generator no placeholders leaked
  - [x] pii /generate-html PII restored

## 文档更新检查清单

### README.md
- [x] Agent 角色说明（Preprocessor）
- [x] 场景 6：使用 AI 预处理素材库
- [x] AI 预处理的优势说明
- [x] 失败回退说明

### DESIGN.md
- [x] Agent 角色表更新（Preprocessor）
- [x] API 路由表更新（/default-preprocess-prompt, /preprocess-library）
- [x] AI 预处理素材库功能章节（7.7）
- [x] 分隔符协议说明
- [x] 失败回退说明
- [x] Change Log 追加（2026-04-23）

---

## 总结

### 已完成功能
1. ✅ AI 预处理缓存机制 - 完整实现
2. ✅ AI 预处理模板 - 完整实现
3. ✅ AI 预处理 API 路由 - 完整实现
4. ✅ 前端状态和 UI - 完整实现
5. ✅ 前后端 API 连接 - 完整实现
6. ✅ PII 脱敏功能 - 完整实现
7. ✅ 文档更新 - 完整实现

### 待补充项
1. ✅ `ensureDefaultPreprocessInstructions()` 函数 - 已实现
   - 在用户勾选"使用 AI 预处理"且预处理指令区为空时自动加载默认 prompt
   - 调用 `api.getDefaultPreprocessPrompt()` 获取默认 prompt
   - 默认 prompt 来自硬编码路径 `/Users/wukun/Documents/jl/预处理-prompt.md`
   
2. ✅ `/preprocess-library` 端到端测试 - 已添加
   - `testPreprocessLibrary()` - AI 预处理基础测试（首次调用、缓存命中、文件变更失效、prompt 变更失效）
   - `testDefaultPreprocessPrompt()` - 默认 prompt 读取测试
   - `testAiPreprocessLibrary()` - 完整 AI 预处理流程测试
   - `testAiPreprocessCache()` - AI 缓存命中测试
   - `testAiPreprocessFallback()` - AI 预处理回退本地测试
   - `testAiPreprocessRealApi()` - 真实 AI API 预处理测试（验证 AI 不抱怨文件系统）

### 所有功能已完成 ✅
