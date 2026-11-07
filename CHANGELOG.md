# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与 `extension/manifest.json` 的 `version` 保持一致。

> 说明：1.7.8 之前为内部迭代版本，未维护变更记录，因此不在此处补写历史条目——避免凭记忆倒填出不准确的日志。

## [1.7.8] - 2026-11-08

首个公开版本。

### 变更（开源整理）

- **项目更名为 QuizLens**。仓库名、插件显示名（`manifest.json` 的 `name` / `default_title`）、面板标题、控制台日志前缀、内置文档、题库包文件名（`quizlens-bank-v1.zip` / `quizlens-bank-ceval-v1.zip`）全部同步。
  - 原因：原名 `AutoAnswer` 在英文语境里直接指向「自动答题器」，与本项目「只填答案、不交卷、正式考试勿用」的定位冲突；且该词在 GitHub 上同类项目极多，没有辨识度。
  - **保留项**：`AutoAnswerSubmit` 这个标识符未改名——它是 1.7.x 已移除的提交守卫 API，测试专门断言它「不再存在」，改名会让该断言失去意义。
- **题库许可核实完成**：A 组 11 条上游的 LICENSE 已逐条查证，结果写入 [题库来源与许可](docs/题库来源与许可.md) 第二节新增的「可否再分发」列。结论：113,878 题中约 **25%** 有清晰的再分发授权（28,600 题），GPL 与 CC BY-NC 各需独立成包，35,200 题无授权不可发布。因此完整题库包仍不随首发发布。

### 新增（开源整理）

- 源代码以 **MIT** 协议开源，见 [LICENSE](LICENSE)。题库数据不适用 MIT，按来源分别适用许可，**不随仓库分发**，见 [题库来源与许可](docs/题库来源与许可.md)。
- 新增 [CONTRIBUTING.md](CONTRIBUTING.md)：环境、测试入口、工程约定、不可提交的数据、不接受的 PR 方向。
- 新增 [SECURITY.md](SECURITY.md)：支持版本、私密报告渠道、属于与不属于安全问题的判定。
- 新增本文件。
- 新增 `.gitattributes`：统一行尾为 LF，`.bat` 例外保留 CRLF。此前没有该文件，Windows 下 Git 默认会把 LF 转成 CRLF，跨平台贡献者会看到"整文件改动"的假 diff。
- 新增 `.github/`：Bug / 功能请求 Issue 表单、PR 模板、CI。
- 新增 `tools/shim/run-all.js`：**零依赖**测试统一入口（纯 Node，不拉浏览器、不联网），`npm test` 指向它。
- 新增 `package.json`：仅供测试使用；插件本体是纯静态资源，安装时不需要 `npm install`。

### 修复（开源整理）

- **署名统一**：`LICENSE` 的版权人由 `linxuan` 改为 `cspyz`，与提交身份、GitHub 账号保持一致。原先两者不一致，贡献者无法确认版权主体。
- **`tools/shim/p0-batch6-test.js` 判据过粗**：原先对 `content.js` 全文做正则检查"是否还叫用户改用题库 + AI 兜底"，把解释该问题**已修复**的注释也判为违规，导致该用例长期红着（27/28）。现改为剔除注释后再断言，28/28 通过。代码行为本身无需改动。
- **README 与事实不符**：原文写冒烟测试"作者内部维护，未包含在本仓库中"，实际 `tools/extension-test/`（29 个 e2e 用例）与 `tools/shim/`（19 个单测）均已在仓库内。已改写并给出运行命令。
- **`tools/bank-src/` 描述失实**：`docs/题库来源与许可.md` 与 `tools/build_bank.py` 称其为"本仓库自带"，但该目录并不存在于仓库。已改为"作者本地维护、不随仓库分发"，并注明 `build_bank.py` 检测到缺失时会打印提示并跳过（代码本就容错，只是文档没写对）。
- **`.gitignore`**：新增 `tools/bank-src/`，防止来源未记录的题库源被误提交；修正"测试夹具已移出仓库"的失实注释——测试夹具与 shim 单测仍在仓库内，被排除的只是截图、日志与浏览器 profile。

### 已知问题

见 README 的[「已知问题」](README.md#已知问题)一节，当前版本共 7 条未修复项，其中第 1 条（`web_accessible_resources` 对任意页面可读）影响面最大。
