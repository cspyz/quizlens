# 贡献指南

先读 [README](README.md) 的「使用边界」和 [DISCLAIMER.md](DISCLAIMER.md)。这个项目的边界是设计出来的，不是免责套话——提交前请确认你的改动没有越过它。

## 一、环境

| 用途 | 需要 |
|---|---|
| 改插件本体 | 一个 Chrome 103+ / Edge 103+ 浏览器，无需任何依赖 |
| 跑 shim 单测 | Node.js 18+，**零依赖** |
| 跑浏览器 e2e | Node.js 18+，`playwright` + Chromium |
| 改题库构建脚本 | Python 3.8+，仅标准库 |

插件本体是**纯静态资源**，`extension/` 目录直接解压加载即可运行。根目录的 `package.json` 只用于测试，安装插件的人不需要 `npm install`。

## 二、跑测试

### 1. shim 单测（默认，推荐）

```bash
node tools/shim/run-all.js      # 或 npm test
```

纯 Node，不拉浏览器、不联网，在任何机器和 CI 上都应全绿。它用**未修改的** `extension/content.js` 源码 + 最小 DOM 桩，覆盖消息层、状态机、并发、超时、提示文案等逻辑。

单个用例：

```bash
node tools/shim/p0-batch6-test.js
```

### 2. 浏览器 e2e

```bash
npm i -D playwright
npx playwright install chromium
node tools/extension-test/run-all.js    # 或 npm run test:e2e
```

覆盖真实 DOM 结构与扩展生命周期（问卷星、学习通新版/旧版、同源 iframe、分页、题库匹配）。**对环境敏感**：在没有图形界面的容器里可能因 `spawn EPERM` 起不来浏览器，属于预期现象，不作为代码回归的证据。CI 只跑 shim。

## 三、工程约定

这些约定来自实际踩过的坑，不是风格偏好：

- **不动已实测的核心逻辑**：`findNextPageButton`（绝不点提交）、`extractAnswerLetters`（解析里的字母不当答案）、`remapAnswer`（选项乱序重定位）、空题干硬闸门。这些有测试背书，改动前先看对应用例。
- **每一处"写页面"后面必须有一次"读回来"**：写 `checked` / `value` 之后回读校验，读不回来就如实计入未答，不许假定成功。
- **改动必须能被用户看见**：只写进 `console.log` 的修复等于没修——要么进面板日志，要么进弹窗提示。
- **不谎报**：半题、超时、拒答、限流都必须如实显示，不许为了"好看"统一报成功。
- **文案不自相矛盾**：提示要落在用户当前所处的模式上。用户已经在「题库 + AI 兜底」时，不要再叫他"改用题库 + AI 兜底"。
- **注释解释"为什么"**：仓库里大量注释记录的是"当初为什么不能这么写"，改动时保留这些信息，不要顺手删。
- **行尾统一 LF**：由 `.gitattributes` 强制；只有 `.bat` / `.cmd` 保留 CRLF（批处理解析器对 LF 敏感）。如果你看到"整个文件都改了"，先检查编辑器有没有按 CRLF 保存。

## 四、什么不能提交

以下路径已在 `.gitignore` 中，**不要用 `git add -f` 绕过**：

| 路径 | 原因 |
|---|---|
| `extension/bank/`、`quiz-app/bank/` | 题库数据许可按来源分别适用，不适用 MIT，见 [题库来源与许可](docs/题库来源与许可.md) |
| `tools/bank-src/` | 作者本地维护的题库源，上游来源未记录，不能随代码分发 |
| `tools/ceval-import/raw/` | 55 个原始 parquet 缓存，可由脚本重新下载 |
| `.ext-test-profiles/`、`.tmp-cdp-profile*/` | 浏览器 profile，含 Cookies 等可复用凭据 |
| `.env`、`*.pem`、`*.key` | 凭据 |

另外**不要在 Issue / PR / 测试夹具里贴真实 API Key**。截图里出现 Key 的，请先打码。

## 五、不接受哪些 PR

以下方向的改动会被直接关闭，与技术水平无关：

- 自动点击「提交 / 交卷」，或任何形式的自动提交；
- 绕过验证码、伪造身份、冒充他人；
- 隐藏作答痕迹、篡改平台判分逻辑、删除操作记录；
- 增加作者侧服务端、埋点、遥测、远程配置下发；
- 把 API Key 或页面内容发往用户未填写的地址。

## 六、提交与 PR

1. 一个 PR 只做一件事，附带「改之前是什么现象、改之后是什么现象」。
2. 涉及行为的改动，请补一条 shim 用例（`tools/shim/*-test.js`），并在 PR 里贴 `node tools/shim/run-all.js` 的汇总行。
3. 涉及适配某个新站点的，请说明页面结构（DOM 特征）与验证方式；不要提交真实试卷内容。
4. 提交信息用中文或英文均可，格式建议 `类型: 简述`，例如 `fix: 学习通新版多选清勾`、`docs: 补题库许可说明`。

## 七、Issue

提 Bug 请附：浏览器与版本、插件版本（`extension/manifest.json` 的 `version`）、页面地址（或同类站点的公开页）、复现步骤、弹窗日志与面板日志截图（**Key 先打码**）。

题库相关的问题请注明是哪种模式（题库匹配 / 题库 + AI 兜底 / 仅 AI），否则无法判断是题库未命中还是匹配逻辑有误。
