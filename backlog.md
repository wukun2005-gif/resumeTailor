# Resume Tailor — Feature Backlog

> 创建时间: 2026-04-28 | 状态: 待实施
> 原则：Feature 越小越好，易于迭代，每个 feature 可独立完成和测试。

---

## A. 引导与首次体验（Onboarding）

### [✅] A5. 「保存并连接」按钮状态反馈

**问题**: 用户点击"保存并连接"后，不知道操作是否在进行中或已成功/失败。
**改动范围**:
- `src/main.js`: 点击时将按钮文案改为"连接中..."并 disable；成功/失败后恢复文案 + 显示对应状态文字
- `src/style.css`: 未改动，复用已有 `.btn-primary:disabled` 样式
**验证方式**:
1. 仿真模式下点保存 → 按钮应显示"连接中..."约 0.5~1 秒后恢复为"保存并连接"
2. 故意留空 API Key 点保存 → 按钮恢复并显示错误信息

**实现状态**: ✅ 已完成 — commit d00d2bb
- `saveSettings()` 进入异步阶段前禁用按钮并改文案为"连接中..."
- `finally` 块中恢复按钮文案和可用状态
- `Promise.all` 最少 500ms 展示加载态，确保快速操作下用户可见反馈
- 复用 Gemini model save handler 的 disabled/finally 模式

---

## B. 操作确认与防误操作

### [✅] B4. 生成/Review/HTML 导出中禁止重复操作

**问题**: 流式生成过程中用户可能重复点击按钮，导致多次并发调用浪费 token 或覆盖结果。
**改动范围**:
- `src/main.js`: 全局变量 `isStreaming` 已存在但需检查所有入口是否完整使用：
  - `doGenerate()` 入口
  - `doReview()` / `doReviewMulti()` 入口
  - `doGenerateHtml()` 入口
  - 对话发送按钮（genChat / reviewChat / htmlChat）
- 在流式期间：
  - 禁用所有操作按钮（生成、重新生成、开始 Review、采纳更新、生成 HTML 等）
  - 顶部状态区显示蓝色提示条："AI 正在处理，请稍候..."
  - 流结束后恢复所有按钮
**验证方式**:
1. 仿真模式点击生成 → 所有面板按钮应为 disabled → 生成完成后恢复
2. 生成中点击其他面板的 Review/HTML 按钮均无响应

**实现状态**: ✅ 已完成
- 新增 `lockAllButtons()` 和 `unlockAllButtons()` 集中管理函数
- 流式期间禁用所有主操作按钮、对话发送按钮、素材库操作按钮
- 复用 `sessionTotalInfo` 显示蓝色提示"AI 正在处理，请稍候..."
- 所有流式操作在 `finally` 块统一调用 `unlockAllButtons()` 恢复状态

---

## C. 进度与状态反馈

> **注意**: C4（OCR 处理进度条）已在代码中实现（`main.js:1308`），无需再做。

### [✅] C1. 素材库加载状态提示

**问题**: 用户点击"加载素材库"后无任何视觉反馈，不知道系统是否在处理。
**改动范围**:
- `src/main.js`: `loadLibrary()` 函数内：
  - 调用前：设置 `els.exportDigestStatus.textContent = '正在读取素材库...'`
  - 成功后：调用 `api.getLibraryDigest()` 计算去重段数，显示 `'已加载 N 个文件，去重后 M 段'`
  - 失败后：红色错误提示
- `src/style.css`: 未改动，复用已有 `.status-text` / `.status-text.success` / `.status-text.error`
**验证方式**:
1. 点击加载 → 应显示"正在读取素材库..."
2. 加载完成 → 显示"已加载 N 个文件，去重后 M 段"（绿色）

**实现状态**: ✅ 已完成
- 加载前设置 `exportDigestStatus` 为"正在读取素材库..."
- 成功后调用 `api.getLibraryDigest(dir, [])` 获取去重数据，统计总段落数
- 失败后显示红色错误提示
- `silent` 模式不显示状态提示
- E2E 测试 142/142 全部通过

### [ ] C2. 生成进度分阶段提示

**问题**: 流式生成过程较长（尤其大模型），用户只看到文本在滚动，不知道当前处于哪个阶段。
**改动范围**:
- `src/main.js`: `doGenerate()` 内，在 SSE streamRequest 的 onChunk 回调前设置阶段提示：
  - 开始："'正在向 AI 发送请求...'"
  - 收到首 chunk："'AI 正在生成简历...'"
  - 流结束（自动保存阶段）："'正在自动保存到素材库...'"
  - 完成：清除提示
  提示位置可用 `els.resumeStatusAndToken` 区域或新增一个独立的状态行
**验证方式**:
1. 仿真模式点击生成 → 观察阶段文字变化

### [ ] C3. 多模型 Review 并行进度指示（概要）

**问题**: 多模型并行 Review 时用户看到的是泛泛的"正在并行调用多个评审模型..."（如有），无法知道每个模型的状态。此条为**概要级进度条**（详细进度见 F15）。
**改动范围**:
- `src/main.js`: `doReviewMulti()` 函数：
  - 进入函数时：显示 `'正在启动并行评审（共 N 个模型）...'`
  - 每个模型完成后更新计数：`'已完成 K/N 个模型评审，正在进行合并...'`
  - 合并完成后清除
**验证方式**:
1. 配置 2+ Reviewer，仿真模式点击 Review → 观察进度文字

### [ ] C5. AI 响应等待超时提示

**问题**: 网络波动或模型慢时，SSE 长时间无输出，用户以为卡死了。
**改动范围**:
- `src/api.js`: `streamRequest()` 函数内：
  - 记录 `lastChunkTime = Date.now()`
  - 每次 chunk 更新 `lastChunkTime`
  - reader 循环内检查：若距离上次 chunk 超过 15 秒且非首 chunk，触发 `onChunk(null, fullText)` 并附带超时标志
  - 或更简单方案：前端 main.js 中对 streamRequest 包装一层 setTimeout 监控
- `src/main.js`: 接收到超时信号后在当前操作的 status 区域显示黄色提示
**验证方式**:
1. 可通过断点调试模拟延迟，或临时设一个较短的超时阈值（如 5 秒）观察效果

---

## F. 错误处理与降级提示

### [ ] F1. SSE 断连重试提示

**问题**: 网络中断或服务器异常导致 SSE 流断开时，错误被静默捕获或仅 console 报错，用户不知道发生了什么。
**改动范围**:
- `src/main.js`: 将所有 `streamRequest()` / `api.streamRequest()` 的 catch 块统一处理：
  - 显示明确的 UI 反馈（编辑区上方或 status 区）：红色错误消息
  - 若是网络错误：显示「连接中断」+ 「重试」按钮（复用上一次请求参数）
  - 若是 API 错误：显示服务端返回的错误信息
- 涉及的调用点：`doGenerate()`, `doReview()/doReviewMulti()`, `doApplyReview()`, `doGenerateHtml()`, 各 chat send handler, `preprocessLibrary`
**验证方式**:
1. 仿真模式下关闭后端服务再点击生成 → 应显示明确错误 + 重试选项

### [ ] F15. 多模型评审逐模型进度条

**问题**: `doReviewMulti()` 并行调用多个 Reviewer 时，用户只能看到一个笼统的"正在并行评审"，无法感知每个模型的独立进展。
**改动范围**:
- `src/main.js`: `doReviewMulti()` 函数重构（核心逻辑）：
  - 当前逻辑是按顺序或并发调用各模型，需改为带独立回调的方式
  - 每个模型的 SSE streamRequest 完成时回调更新该模型状态
  - 在 `els.reviewStatusAndToken` 或 Review 面板 header 处显示类似：
    ```
    评审员 A (Claude)：完成 ✓    评审员 B (Gemini)：进行中...    评审员 C (GPT)：排队中...
    ```
  - 所有模型完成后进入合并阶段，显示"正在合并评审意见..."
- 后端 `/api/review-multi` 可能需要调整为返回中间状态（或保持现有逻辑不变，仅在前端做进度追踪）
**验证方式**:
1. 配置 3 个 Reviewer，仿真模式点击 Review → 观察每个模型独立状态变化

---

## G. 智能提示与推荐

### [ ] G4. 未配置 Reviewer 时提醒

**问题**: 用户未在设置中勾选任何 Reviewer 时，"开始 Review"按钮虽然可以点击（或 disable），但没有告诉用户原因。
**改动范围**:
- `src/main.js`:
  - 初始化时或在 `populateAgentDropdowns()` 后，检查 Reviewer checkbox group 是否全空
  - 为空时：在 Review 面板的"开始 Review"按钮下方显示灰色提示文字：「未配置评审模型，请先在「设置」中勾选至少一个 Reviewer」
  - 配置后提示消失
- `index.html`: 可在 `reviewBtn` 下方预留一个 `<span>` 用于显示此提示
**验证方式**:
1. 打开设置，取消勾选所有 Reviewer → Review 面板下方应出现提示
2. 勾选一个 Reviewer → 提示消失

---

## I. 微交互与可访问性

### [ ] I2. Textarea 自动增高

**问题**: 固定高度的 textarea 在内容超出时需手动滚动，短内容时又浪费空间。
**改动范围**:
- `src/main.js` 或 `src/style.css`:
  - 方案 A（纯 CSS）：`field-sizing: content`（现代浏览器支持，最简单）
  - 方案 B（JS）：给关键 textarea 绑定 input 事件，动态调整 height = scrollHeight
  - 需要处理的 textarea：
    - `resumeOutput`（简历编辑区）
    - `reviewOutput`（Review 编辑区）
    - `genNotesOutput`（AI 备注）
    - `jdInput`（JD 输入框）
    - `genInstructions`, `reviewInstructions`, `htmlInstructions`, `preprocessInstructions`（指令区）
    - 各聊天输入框（`chatInput`, `genChatInput`, `htmlChatInput`, `preprocessChatInput`）
  - 设最小高度（当前值）和最大高度（如 600px，超出出滚动条）
**验证方式**:
1. JD 输入框粘贴长文本 → 高度自动增长
2. 清空输入框 → 高度收缩回默认
3. 内容极长时 → 到达上限不再增长，出滚动条

### [ ] I3. 折叠区 `<details>` 展开状态记忆

**问题**: 每次刷新页面或重新打开应用，所有 `<details>` 都回到折叠状态，用户需要反复展开常用的指令区。
**改动范围**:
- `src/main.js`:
  - 定义一组需要记忆的 details element ID：`['genInstructionsDetails', 'reviewInstructionsDetails', 'htmlFormatDetails', 'preprocessInstructionsDetails']`（或通过 class 标记 `.remember-state`）
  - 页面初始化时（DOMContentLoaded），从 localStorage 读取 `collapsedStates` JSON，逐一恢复 open/close
  - 每个 details 元素绑定 toggle 事件，变化时写入 localStorage
  - localStorage key 示例：`resumeTailor_collapsedStates = { genInstructions: true, reviewInstructions: false, ... }`
- `index.html`: 给相关 `<details>` 元素添加 ID 或 class
**验证方式**:
1. 展开"生成指令"区 → 刷新页面 → 该区域仍为展开状态
2. 折叠"HTML 格式指令"区 → 刷新页面 → 仍为折叠状态

---

## 实施顺序建议

| 批次 | Feature | 理由 |
|------|---------|------|
| **Batch 1** | A5, G4 | 最小改动（纯 UI 状态控制），快速交付 |
| **Batch 2** | B4, C1, C3, C5 | 进度反馈类，共享同一套状态展示机制 |
| **Batch 3** | I2, I3 | CSS/JS 微交互，不影响业务逻辑 |
| **Batch 4** | F1, F15 | 错误处理和复杂进度追踪，需要更多测试 |
| **Batch 5** | C2 | 需要拆分生成流程的阶段钩子 |

> 每个 Batch 内的 feature 可并行开发（不同文件/不同区域），互不依赖。
