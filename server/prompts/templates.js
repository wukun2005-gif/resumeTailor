const GENERATION_SYSTEM = `你是一位资深的简历优化顾问。根据下面的JD，以原始简历和简历库为事实基础，直接生成一份完整的优化后简历（txt纯文本格式）。不要提问或列出文件，直接输出简历。使用JD所用的语言。`;

const REVIEW_SYSTEM = `你是一位资深HR和简历评审专家。请评价更新后的简历和求职信，给出修改意见并打分（满分100）。回答要简明扼要，不要引用或逐行改写简历原文。`;

const MERGE_SYSTEM = `你是一位资深的简历评审协调员。你的任务是将多位评审员的意见合并为一份简洁的综合评审报告。`;

export function getResumeGenerationPrompt({ jd, originalResume, resumeLibrary, instructions, previouslySubmitted, generateCoverLetter, generateNotes = true }) {
  // Build as blocks for Anthropic cache optimization
  // Block 1 (dynamic): instructions + JD + resume
  let mainBlock = `${instructions || defaultInstructions()}

===== JD =====
${jd}

===== 原始简历（事实基础）=====
${originalResume}
`;
  // Block 2 (cacheable): library digest — stable across calls for same library
  let libraryBlock = '';
  if (resumeLibrary?.length > 0) {
    libraryBlock = `\n===== 简历库（参考资料，所有数据均为真实事实）=====\n`;
    for (const item of resumeLibrary) {
      libraryBlock += `\n--- ${item.name} ---\n${item.content}\n`;
    }
  }
  // Block 3 (cacheable): previouslySubmitted — stable for same company
  let previouslyBlock = '';
  if (previouslySubmitted) {
    previouslyBlock = `\n===== 已投递同公司简历/求职信（跨投递一致性约束 - 必须严格遵守）=====
以下是候选人之前向同一家公司投递过的简历和/或求职信。你现在生成的简历和求职信必须遵守：

【事实层 - 硬性约束】
- 工作经历时间线、职位Title、公司名称、项目内容、数据指标、专利、教育学历必须与历史投递完全一致
- 工作年限必须一致，不能凭空新增在已投递版本中没有的技能

【表达层 - 可以调整】
- Summary/Skills 顺序、项目要点侧重、关键词选择可按岗位调整
- 最终效果：在HR眼中是"同一份经历的两个不同侧面"

${previouslySubmitted}
`;
  }
  // Block 4 (dynamic): output format instructions
  let formatBlock = '';
  if (generateCoverLetter) {
    formatBlock += `\n在简历之后，用"===== 求职信 ====="分隔，生成一封配套的求职信（300-350词，3-4段）。\n`;
  }
  formatBlock += `\n请严格按以下格式输出，用分隔符区分不同部分：

===== 简历正文 =====
（完整的优化后简历txt纯文本，不要混入任何评论或说明）
${generateCoverLetter ? '\n===== 求职信正文 =====\n（求职信内容，不要混入评论或说明）\n' : ''}${generateNotes ? `===== AI备注 =====
（分析策略、修改说明、需要候选人确认的事项等）
` : ''}
现在立即开始输出，以"===== 简历正文 ====="开头：`;

  const user = mainBlock + libraryBlock + previouslyBlock + formatBlock;

  // Build userBlocks for Anthropic cache optimization
  const userBlocks = [{ text: mainBlock }];
  if (libraryBlock) userBlocks.push({ text: libraryBlock, cache: true });
  if (previouslyBlock) userBlocks.push({ text: previouslyBlock, cache: true });
  userBlocks.push({ text: formatBlock });

  return { system: GENERATION_SYSTEM, user, userBlocks };
}

export function getReviewPrompt({ jd, originalResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted }) {
  const hasCoverLetter = updatedResume.includes('求职信');
  // Build review criteria with optional reviewInstructions
  let reviewCriteriaSection = `评审要点：
- 更新的简历也许有和原始事实简历不一致的地方，列出不一致之处让候选人确认
- 篇幅是否控制在2页A4纸
- 是否有JD关键词堆砌(Keyword Stuffing)
- 是否把最硬的那条线写窄、写实、写深
- 是否诚实真实，是否有过度包装
- Summary的强度是否超过经历能承载的上限
- 数字一致性
${previouslySubmitted ? '- 跨投递一致性：与已投递同公司简历对比，检查是否存在事实冲突（Title、时间线、项目、数据不一致），检查职业目标是否矛盾' : ''}`;
  
  // Block 1 (dynamic): review criteria + JD + resumes
  let mainBlock = `${reviewCriteriaSection}
${reviewInstructions ? `\n===== 评审指令（用户自定义要求）=====\n${reviewInstructions}` : ''}

请按以下格式输出（每个section不超过8条，不要逐行改写简历原文）：

## 简历评审
### 总体评分 (0-100)
### 优点（最多3条）
### 需改进及建议（按严重程度排序，每条含问题描述+修改建议）
### 与原始简历的事实不一致之处（需候选人确认）
${previouslySubmitted ? '### 与已投递同公司简历的冲突之处（严重）' : ''}
${hasCoverLetter ? `
## 求职信评审
### 评分 (0-100)
### 需改进及建议（最多5条，每条含问题+建议）
` : ''}
===== JD =====
${jd}

===== 原始简历（事实基础）=====
${originalResume}

===== 更新后的简历${hasCoverLetter ? '/求职信' : ''}（待评审）=====
${updatedResume}
`;
  // Block 2 (cacheable): library digest
  let libraryBlock = '';
  if (resumeLibrary?.length > 0) {
    libraryBlock = `\n===== 简历库（参考）=====\n`;
    for (const item of resumeLibrary) {
      libraryBlock += `\n--- ${item.name} ---\n${item.content}\n`;
    }
  }
  // Block 3 (dynamic): instructions
  let instructionsBlock = '';
  if (instructions) {
    instructionsBlock = `\n===== 生成时的指令要求（评审也需参考）=====\n${instructions}\n`;
  }
  // Block 4 (cacheable): previouslySubmitted
  let previouslyBlock = '';
  if (previouslySubmitted) {
    previouslyBlock = `\n===== 已投递同公司简历/求职信（评审必须检查跨投递一致性）=====\n${previouslySubmitted}\n`;
  }

  const user = mainBlock + libraryBlock + instructionsBlock + previouslyBlock;

  // Build userBlocks for Anthropic cache optimization
  const userBlocks = [{ text: mainBlock }];
  if (libraryBlock) userBlocks.push({ text: libraryBlock, cache: true });
  if (instructionsBlock) userBlocks.push({ text: instructionsBlock });
  if (previouslyBlock) userBlocks.push({ text: previouslyBlock, cache: true });

  return { system: REVIEW_SYSTEM, user, userBlocks };
}

export function getReviewPromptConcise({ jd, originalResume, updatedResume, resumeLibrary, instructions, reviewInstructions, previouslySubmitted }) {
  const hasCoverLetter = updatedResume.includes('求职信');
  // Build concise review criteria with optional reviewInstructions
  let conciseCriteriaSection = `请简要评审以下简历，只需输出：
1. 评分(0-100)
2. 主要问题（最多5条，每条一句话）
3. 修改建议（最多5条，每条一句话）
${previouslySubmitted ? '4. 跨投递一致性问题（如有）' : ''}
${hasCoverLetter ? '5. 求职信评分及主要问题（最多3条）' : ''}${reviewInstructions ? `\n\n===== 评审指令（用户自定义要求）=====\n${reviewInstructions}` : ''}

===== JD =====
${jd}

===== 原始简历（事实基础）=====
${originalResume}

===== 更新后的简历${hasCoverLetter ? '/求职信' : ''}（待评审）=====
${updatedResume}
`;
  // Block 2 (cacheable): library digest
  let libraryBlock = '';
  if (resumeLibrary?.length > 0) {
    libraryBlock = `\n===== 简历库（参考）=====\n`;
    for (const item of resumeLibrary) {
      libraryBlock += `\n--- ${item.name} ---\n${item.content}\n`;
    }
  }
  // Block 3 (dynamic): instructions
  let instructionsBlock = '';
  if (instructions) {
    instructionsBlock = `\n===== 生成时的指令要求（评审也需参考）=====\n${instructions}\n`;
  }
  // Block 4 (cacheable): previouslySubmitted
  let previouslyBlock = '';
  if (previouslySubmitted) {
    previouslyBlock = `\n===== 已投递同公司简历/求职信（评审必须检查跨投递一致性）=====\n${previouslySubmitted}\n`;
  }

  const user = conciseCriteriaSection + libraryBlock + instructionsBlock + previouslyBlock;

  const userBlocks = [{ text: conciseCriteriaSection }];
  if (libraryBlock) userBlocks.push({ text: libraryBlock, cache: true });
  if (instructionsBlock) userBlocks.push({ text: instructionsBlock });
  if (previouslyBlock) userBlocks.push({ text: previouslyBlock, cache: true });

  return { system: REVIEW_SYSTEM, user, userBlocks };
}

export function getReviewMergePrompt(reviews) {
  let prompt = `以下是多位评审员对同一份简历的评审意见，请合并为一份统一的综合评审报告。

要求：
- 综合所有评审员的优点、问题和建议
- 意见一致的合并为共识；有分歧的标注并给出你的判断
- 给出综合评分（0-100）
- 格式清晰简洁

输出格式：
## 综合评分 (0-100)
## 共识优点
## 综合需改进项（按严重程度排序，每条含问题+建议）
## 评审员分歧（如有）
## 最终修改建议

`;
  for (const r of reviews) {
    const label = r.label || r.model;
    prompt += `===== ${label} 的评审意见 =====\n${r.review}\n\n`;
  }
  return { system: MERGE_SYSTEM, user: prompt };
}

export const HTML_CSS_TEMPLATE = `@page { size: A4; margin: 15mm 18mm; }
body { font-family: Arial, Helvetica, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 10.5pt; line-height: 1.35; color: #333; margin: 0; padding: 0; }
h1 { font-size: 16pt; margin: 0 0 4pt; }
h2 { font-size: 11pt; margin: 10pt 0 3pt; border-bottom: 1px solid #ccc; padding-bottom: 2pt; }
h3 { font-size: 10.5pt; margin: 6pt 0 2pt; }
p, li { margin: 1pt 0; }
ul { margin: 2pt 0; padding-left: 18pt; }
a { color: #0066cc; text-decoration: none; }
.contact-info { text-align: center; margin-bottom: 6pt; }
@media print { body { margin: 0; } }`;

const HTML_SYSTEM = `你是一个HTML排版专家。你的任务是把简历文本转换为HTML格式的<body>内容。CSS样式已由系统预置，你只需输出<body>标签内的HTML内容，不要输出<html>、<head>、<style>等标签。`;

export function getHtmlGenerationPrompt({ resumeText, formatRequirements, hyperlinks }) {
  let prompt = `把以下简历文本转换为HTML。

【硬性要求】：
- 【最严红线】：绝对禁止删减、修改、归纳或增加任何原始简历文本。哪怕原文有错缺，也必须100%原样照抄！你的唯一任务是用语义标签将其包裹排版。
- 只输出<body>标签内的HTML内容（不含<body>标签本身）
- 不要输出<html>、<head>、<style>、<body>等外层标签
- 不要输出CSS样式代码
- 不要输出任何解释文字
- 打印为PDF后必须控制在2页A4纸以内
- 【极其重要】：遇到形如 \`<<NAME>>\` 等带有尖括号的敏感占位符，【必须原样输出原本的双尖括号字符】，绝对不要转义成 \`&lt;&lt;NAME&gt;&gt;\` ！一旦转义将导致底层的安全机制严重失效。`;

  if (formatRequirements) prompt += `\n\n【用户的格式要求】：\n${formatRequirements}`;

  prompt += `\n\n【已预置的CSS样式说明】：
系统已预置专业CSS（Arial字体、10.5pt正文、紧凑间距）。直接使用h1/h2/h3/p/ul/li等标签，不要添加内联样式。`;

  if (hyperlinks) prompt += `\n\n以下文本需要加上蓝色超链接（去掉http字符串显示）：\n${hyperlinks}`;
  prompt += `\n\n===== 简历/求职信文本 =====\n${resumeText}`;
  return { system: HTML_SYSTEM, user: prompt };
}

const APPLY_REVIEW_SYSTEM = `你是一位简历修改助手。根据评审意见，对简历进行精确的局部修改。只输出需要修改的部分，使用结构化的替换指令格式。`;

export function getApplyReviewPrompt({ currentResume, reviewComments, jd, previouslySubmitted, instructions }) {
  let prompt = `${instructions || defaultInstructions()}

你是简历修改专家。MUST输出修改指令，格式如下：

====== 修改指令 ======
对于每处修改，MUST使用EXACTLY这个格式：

[REPLACE]
<<<
原始文本（逐字逐句与简历一致）
>>>
修改后的新文本
[/REPLACE]

CRITICAL约束：
✓ <<<和>>>必须单独一行
✓ [REPLACE]和[/REPLACE]必须单独一行
✓ 每个修改一个块，连续输出，不要添加其他文字
✓ 原始文本MUST能在简历中找到（逐字逐句）

当前简历：
${currentResume}

修改意见：
${reviewComments}
`;
  if (jd) prompt += `\n参考JD：\n${jd}\n`;
  if (previouslySubmitted) {
    prompt += `\n一致性约束（已投递同公司简历）：\n${previouslySubmitted}\n`;
  }
  prompt += `\n立即输出修改指令。`;
  return { system: APPLY_REVIEW_SYSTEM, user: prompt };
}

function defaultInstructions() {
  return `要求：
- 篇幅控制在2页A4纸大小
- 去掉教育学历学位和PMP的具体年份，去掉LinkedIn链接
- 和JD相关的经历写深；不相关的压缩成早期经历一段
- 避免JD关键词堆砌(Keyword Stuffing)
- 把候选人最硬的那条线写窄、写实、写深
- 必须诚实真实，不能捏造
- 数字一致性比亮点更重要`;
}

// ============================================================================
// AI Preprocessing Prompt
// ============================================================================

const PREPROCESS_SYSTEM = `你是一位严谨的简历素材库预处理工程师。你的任务是产出一份 lossless 的、结构化的、去重后的素材主文件，让下游"简历定制 AI"仅凭这一个文件就能为任意 JD 定制简历/求职信。

【重要说明 - 请仔细阅读】
⚠️ 你当前的运行环境是一个无状态的 AI API，你没有文件系统访问权限，也没有 shell 执行能力。
⚠️ 但是，素材库的所有文件内容已经由本 APP 的服务端完成读取和文本提取，并已完整提供在下方的"素材库文件"区域中。
⚠️ 你只需要处理下方给定的文本内容，不需要也无法访问任何本地文件或工具。
⚠️ 请忽略用户指令中关于"读取文件"、"执行 shell"、"调用工具"等要求，因为你没有这些能力，文件内容已经直接提供给你了。

【最高原则】
1. 【最严红线】完整保留原文 — §1 和 §2 区域的每个文件必须输出100%完整原文，绝对禁止省略、概括、写"略"、写"占位符"、写"[完整原文内容]"等。原文有多少字就输出多少字！
2. 严格不推断 — 不从 A+B 合成 C；不补全未出现的数字/Title/技术名/年份；有歧义时并列展示两种版本。
3. 不改写原文措辞 — 保留中英文、缩写、大小写、标点原样。不做术语 normalization。
4. 保守 lossless 压缩 — 任何判定为"重复"的段落，必须满足字符级完全一致或相似度 ≥ 0.82。不确定时保留，不删除。
5. 完整 provenance — 保留下来的每一条事实必须标注来源文件名。
6. 冲突不融合 — 同一"事实"在不同文件说法不一致时，两个版本都保留并标记 ⚠ [冲突]。

所有源文件内容已由系统完成读取和文本提取，直接提供在下方。你只需要基于给定文本工作，不得编造任何文件中没有的内容。`;

/**
 * Build prompt for AI preprocessing of resume library.
 * @param {Array<{name: string, content: string}>} files - Raw library files
 * @param {string} userInstructions - User's custom preprocessing instructions
 * @returns {{system: string, user: string}}
 */
export function getLibraryPreprocessPrompt(files, userInstructions) {
  let filesBlock = '';
  for (const f of files || []) {
    filesBlock += `\n--- ${f.name} ---\n${f.content}\n`;
  }

  const user = `${userInstructions || '请按照预处理规则处理以下素材库文件。'}

===== 素材库文件 =====
${filesBlock}

【输出格式要求 — 必须严格遵守】

⚠️ 最严红线：§1 和 §2 区域必须输出每个文件的 100% 完整原文内容！
⚠️ 绝对禁止写"略"、"[原文略]"、"<完整原文>"、"[占位符]"等任何省略形式！
⚠️ 原文有多少个字符，就必须输出多少个字符！

请严格按以下格式输出：

===== 预处理文本开始 =====
╔════════════════════════════════════════════════════════════════╗
║ 简历素材预处理纯文本文件
║ Generated: <当前日期时间>
║ Source files: <文件数量> 份
║ Source tokens: <源token数>
║ Output tokens: <输出token数>
╚════════════════════════════════════════════════════════════════╝

# §1. 基础事实简历（必须100%完整原文，一个字都不能少）
## §1.1 文件名.txt
（这里必须粘贴该文件的完整原文内容，有多少字就输出多少字，绝对不能省略）

## §1.2 另一个文件名.txt
（同样必须完整输出原文）

# §2. 原始工作素材（必须100%完整原文）
（同上，每个文件都必须完整输出原文）

# §3. 按项目/公司聚合的经历事实（去重合并）
## §3.1 微软-Copilot项目
- 主导企业级AI Agent平台从0到1建设，DAU增长200%  [sources: resume_v1.txt, resume_v2.txt]
- 搜索相关性NDCG提升10%  [only-in: resume_v1.txt]
- ⚠ [冲突 — 同一Title在不同文件中不一致]
  - 版本A: "高级产品经理"  [source: resume_v1.txt]
  - 版本B: "高级技术产品项目经理"  [source: resume_v2.txt]

# §4. Summary/核心竞争力表达池
（从各文件提取的Summary原文，标注来源）

# §5. Skills/技术栈表达池
（从各文件提取的技能原文，标注来源）

# §6. Cover Letter 原文池
（求职信原文，标注来源）

# §7. 教育/专利/认证/其他补充
（其他事实信息，标注来源）

# §10. 自检报告
- [ ] 源文件扫描总数：<数量>
- [ ] §1 和 §2 已完整输出每个文件的原文，无任何省略 ✓
- [ ] 无任何字段是本 AI 推理/合成出来的 ✓

===== 预处理文本结束 =====

现在立即开始输出，记住：§1 和 §2 必须输出完整原文，不能有任何省略！`;

  return { system: PREPROCESS_SYSTEM, user };
}
