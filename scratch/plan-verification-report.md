# AI 预处理素材库功能 - Plan.txt 逐项自检报告

## 一、范围与结论

### 1.1 影响面收敛 ✅
- [x] AI 预处理仅影响"素材库导出链路 + 独立 AI 预处理缓存"
- [x] 未改动 generate/review 的现有预处理逻辑
- [x] 现有本地预处理入口保持不变：`exportDigest()` 可走本地 `/api/library-digest`

### 1.2 缓存隔离 ✅
- [x] `digest.json` 沿用现有路径 `<library>/.resume-tailor-cache/digest.json`
- [x] 缓存内容带 `mode` 元数据：`mode: 'ai'`
- [x] Local route 只命中 `mode=local`（或无 mode），AI route 只命中 `mode=ai`
- [x] 已验证：`cached.mode !== 'ai'` 检查（libraryCache.js 第 702 行）

### 1.3 AI 缓存命中条件 ✅
- [x] 素材文件未变化
- [x] 预处理 prompt 未变化（通过 `instructionsHash`）
- [x] Preprocessor model 未变化
- [x] piiEnabled 状态未变化
- [x] Schema version 未变化

---

## 二、目标行为

### 2.1 用户未勾选"使用 AI 预处理" ✅
- [x] 行为与现在完全一致
- [x] `exportDigest()` 根据 `useAiPreprocess?.checked` 判断分支（第 1266-1269 行）

### 2.2 用户勾选后 UI 显示 ✅
- [x] 素材库区显示独立的预处理指令 `<details>`（`preprocessInstructionsSection`，第 254 行）
- [x] 显示独立的"和预处理助手对话（确认/追问）"区域（`preprocessChatSection`，第 268 行）
- [x] 位置在素材库操作区下面

### 2.3 点击"导出预处理文本素材库" ✅
- [x] AI cache 有效时：直接复用 `digest.json` 并下载 txt
- [x] AI cache 无效时：读取原始素材文本给 AI 预处理
- [x] 完成后立即写回 `digest.json`
- [x] 下载 `素材库预处理文本-<日期>.txt`

### 2.4 预处理对话区系统消息 ✅
- [x] 显示 `sourceTokens` 和 `digestTokens`
- [x] 显示缓存命中状态（`fromCache`）
- [x] 显示回退状态（`fallbackUsed`）

### 2.5 AI 失败回退本地预处理 ✅
- [x] 自动回退本地预处理（server/routes/api.js 第 779-800 行）
- [x] 返回 `fallbackUsed: true`
- [x] 系统消息明确提示"已回退到本地预处理"

### 2.6 对话区输入框 ✅
- [x] 初始为空
- [x] 用户后续发送消息时，围绕同一份素材上下文对话

---

## 三、详细设计：前端

### 3.1 index.html 元素 ✅

| 元素 ID | 用途 | 行号 | 状态 |
|---------|------|------|------|
| `cfgAgentPreprocessor` | Preprocessor Agent 下拉框 | 150 | ✅ |
| `useAiPreprocess` | AI 预处理复选框 | 244 | ✅ |
| `preprocessInstructionsSection` | 预处理指令区域 | 254 | ✅ |
| `preprocessInstructions` | 预处理指令输入 | 264 | ✅ |
| `preprocessLoadFile` | 加载指令文件 | 259 | ✅ |
| `preprocessSaveFile` | 保存指令文件 | 261 | ✅ |
| `preprocessFileStatus` | 文件状态显示 | 262 | ✅ |
| `preprocessChatSection` | 预处理对话区域 | 268 | ✅ |
| `preprocessChatHistory` | 对话历史 | 270 | ✅ |
| `preprocessChatInput` | 对话输入 | 272 | ✅ |
| `preprocessChatSendBtn` | 发送按钮 | 273 | ✅ |

### 3.2 src/main.js 状态和逻辑 ✅

| 检查项 | 状态 | 行号 |
|--------|------|------|
| `preprocessUseAi` state key | ✅ | 721, 840 |
| `preprocessInstructions` state key | ✅ | 722, 866, 879 |
| `preprocessorModel` state key | ✅ | 417, 1010 |
| `getPreprocessorModelId()` | ✅ | 500-506 |
| `requireConfiguredConnection(..., 'Preprocessor')` | ✅ | 在 exportDigestWithAi() 中使用 |
| `exportDigest()` 分支逻辑 | ✅ | 1261-1320 |
| `exportDigestWithAi()` | ✅ | 839-921 |
| `ensureDefaultPreprocessInstructions()` | ✅ | 726-736 |
| 三种 bubble 类型 (user/ai/system) | ✅ | `appendPreprocessChatBubble()` |
| `handleLoadFile/handleSaveFile` for preprocess | ✅ | type='preprocess' 支持 |

### 3.3 src/style.css ✅
- [x] `.chat-msg.system` 样式存在

---

## 四、详细设计：后端

### 4.1 src/api.js ✅

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `getDefaultPreprocessPrompt()` | ✅ | 第 126-131 行 |
| `preprocessLibrary()` SSE 流式 | ✅ | 第 145-203 行 |
| 结构化字段 `fromCache` | ✅ | 返回对象包含 |
| 结构化字段 `fallbackUsed` | ✅ | 返回对象包含 |
| 结构化字段 `sourceTokens` | ✅ | 返回对象包含 |
| 结构化字段 `digestTokens` | ✅ | 返回对象包含 |

### 4.2 server/routes/api.js ✅

| 检查项 | 状态 | 行号 |
|--------|------|------|
| `GET /default-preprocess-prompt` | ✅ | 562-583 |
| `POST /preprocess-library` | ✅ | 627-810 |
| AI 缓存命中检测 | ✅ | 642-664 |
| AI 调用逻辑 | ✅ | 使用 `callModel()` |
| 分隔符协议解析 | ✅ | `===== 预处理文本开始/结束 =====` |
| 失败回退本地预处理 | ✅ | 779-800 |
| 写回 `digest.json` | ✅ | `saveAiDigestCache()` |
| `sourceTokens/digestTokens` 统计 | ✅ | 返回对象包含 |

### 4.3 server/prompts/templates.js ✅

| 检查项 | 状态 | 行号 |
|--------|------|------|
| `getLibraryPreprocessPrompt()` | ✅ | 320-388 |
| 系统指令：无文件系统工具 | ✅ | 296-312 |
| 分隔符协议 | ✅ | 339, 383 |

### 4.4 server/services/libraryCache.js ✅

| 检查项 | 状态 | 行号 |
|--------|------|------|
| `buildAiCacheKey()` | ✅ | 666-677 |
| `getAiPreprocessedLibrary()` | ✅ | 689-717 |
| `saveAiDigestCache()` | ✅ | 730-753 |
| `readRawLibraryFiles()` | ✅ | 764-790 |
| `loadDigestCache()` mode 校验 | ✅ | 701-709 |

---

## 五、PII 计划

### 5.1 PII 设计原则 ✅

| 检查项 | 状态 | 说明 |
|--------|------|------|
| AI 预处理接入 PII 脱敏体系 | ✅ | 复用 `piiSanitizer.js` |
| 脱敏只作用于发给 AI 的输入 | ✅ | `sanitizeLibrary()`, `sanitizeMessages()` |
| 流式返回时恢复占位符 | ✅ | `createStreamRestorer()` |
| 最终写入 digest.json 恢复真实内容 | ✅ | `restore()` 后再写入 |
| 不新增 PII 配置界面 | ✅ | 复用现有设置 |
| 缓存只记录 piiEnabled 布尔值 | ✅ | 不记录具体 PII 值 |

### 5.2 POST /preprocess-library PII 集成 ✅

| 检查项 | 状态 | 行号 |
|--------|------|------|
| 获取 PII 配置 `getPiiEntries()` | ✅ | 637-649 |
| 对源文件脱敏 `sanitizeLibrary()` | ✅ | 695-705 |
| 对 instructions 脱敏 | ✅ | `sanitizeRequestBody()` |
| 对聊天消息脱敏 `sanitizeMessages()` | ✅ | 719-721 |
| 流式恢复 `createStreamRestorer()` | ✅ | 恢复后发送给用户 |
| 最终输出恢复后再写入 | ✅ | `restore()` 后写 digest.json |

### 5.3 缓存 PII 元数据 ✅
- [x] AI cache 包含 `piiEnabled` 元数据
- [x] `piiEnabled` 变化时 cache miss

---

## 六、测试计划

### 6.1 test-e2e.mjs 覆盖 ✅

| 测试项 | 状态 | 函数名 |
|--------|------|--------|
| `/preprocess-library` 首次 AI 生成成功 | ✅ | `testPreprocessLibrary()` |
| 二次同文件同 prompt/model 命中 AI cache | ✅ | `testPreprocessLibrary()` 测试 2 |
| 修改文件后 cache 失效 | ✅ | `testPreprocessLibrary()` 测试 3 |
| 修改 prompt 后 AI cache 失效 | ✅ | `testPreprocessLibrary()` 测试 4 |
| 历史 `素材库预处理文本-*.txt` 被忽略 | ✅ | `testAiPreprocessLibrary()` |
| AI 解析失败时 `fallbackUsed=true` | ✅ | `testAiPreprocessFallback()` |
| 现有 `/library-digest` 全部测试保留 | ✅ | - |
| `sourceTokens`/`digestTokens` 都是数字 | ✅ | `testPreprocessLibrary()` |
| 成功路径 `digestTokens > 0` | ✅ | - |
| 本地 fallback `digestTokens <= sourceTokens` | ✅ | - |
| PII 预处理端到端测试 | ✅ | `testAiPreprocessPii()` |
| piiEnabled 变化时 cache miss | ✅ | `testAiPreprocessPiiCacheMiss()` |

---

## 七、文档更新

### 7.1 README.md ✅
- [x] Agent 角色说明（Preprocessor）
- [x] 场景 6：使用 AI 预处理素材库
- [x] AI 预处理的优势说明
- [x] 失败回退说明
- [x] 安全/隐私章节：AI 预处理复用 PII 脱敏机制

### 7.2 DESIGN.md ✅
- [x] Agent 角色表更新（Preprocessor）
- [x] API 路由表更新（`/default-preprocess-prompt`, `/preprocess-library`）
- [x] AI 预处理素材库功能章节（7.7）
- [x] 分隔符协议说明
- [x] 失败回退说明
- [x] Change Log 追加（2026-04-23）

### 7.3 AI 预处理仅影响导出链路说明 ✅
- [x] README 和 DESIGN 都写清楚：AI 预处理仅影响导出链路，不改变 generate/review 的现有 local digest 路径

---

## 八、风险与交接提醒

### 8.1 AI 流式回复解析 ✅
- [x] 使用分隔符协议 `===== 预处理文本开始/结束 =====`
- [x] 比 JSON 更稳

### 8.2 缓存语义隔离 ✅
- [x] Local 和 AI cache 通过 `mode` 隔离
- [x] 已验证不会互相污染

### 8.3 硬编码 prompt 文件读取 ✅
- [x] 使用单独 route `/default-preprocess-prompt`
- [x] 未扩大 `allowedPaths` 范围

---

## 九、总体评估

### 9.1 完成度

| 模块 | 完成度 | 说明 |
|------|--------|------|
| 范围与结论 | 100% | 完全符合 |
| 目标行为 | 100% | 完全符合 |
| 前端设计 | 100% | 完全符合 |
| 后端设计 | 100% | 完全符合 |
| PII 计划 | 100% | 完全符合 |
| 测试计划 | 100% | PII 测试已补充完成 |
| 文档更新 | 100% | 完全符合 |
| 风险控制 | 100% | 完全符合 |

### 9.2 待补充项

无。所有功能已实现，所有测试用例已补充。

### 9.3 结论

AI 预处理素材库功能开发 **全部完成**，与 `/Users/wukun/Documents/tmp/plan.txt` 的要求 **完全一致**。

---

*报告生成时间：2026-04-24*