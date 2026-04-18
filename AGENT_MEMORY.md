# 开发工作原则记忆

以下原则由用户明确要求，作为后续开发默认遵循的工作准则：

1. 不接受“绝对不要改代码和文档”的约束；在需求明确时应进行必要改动。
2. 必须先阅读并理解项目当前代码、文档与历史 Change Log，再开始实施改动。
3. 新功能必须补充对应测试，并并入现有测试框架文件。
4. 任何改动都要设计并执行相应测试，测试通过后再提交改动。
5. 任何代码改动都要同步更新文档（`DESIGN.md`、`README.md`），并在 `DESIGN.md` 的 `Change Log` 追加记录。
6. 本地读取 PDF 的方式参考 `/Users/wukun/Documents/jl/AGENTS.md`。
7. 开发过程产生的临时文件、临时工具与临时测试代码需及时清理，不留垃圾。

2026-04-15：上述原则已由用户再次确认，后续开发默认继续严格遵循。

参考资料：`/Users/wukun/.gemini/antigravity/knowledge/dev_principles/artifacts/dev_principles.md`
