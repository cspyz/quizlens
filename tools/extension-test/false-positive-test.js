/**
 * 复杂页面误判测试：页面里塞满各种"长得像选项但不是选项"的列表，
 * 验证插件只填真题目、不碰其他 li。
 *
 * 页面包含 6 段：
 *   ① nav 导航菜单（ul>li）
 *   ② header 里的列表
 *   ③ 英文术语表：Authentication… / Brute force… / Cross-site…（旧规则会误判成 A/B/C 选项）
 *   ④ 分点说明：A./B./C. 三阶段方案（结构与选择题完全一致，题干不像问句）
 *   ⑤ 真选择题：4 个 A./B./C./D. 选项
 *   ⑥ 选项中间夹了一行普通提示文字的题（应整体放弃，不能乱点）
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8088;

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>复杂页面</title></head><body>

<nav>
  <ul>
    <li onclick="window.__clicks.push('NAV-1')">首页</li>
    <li onclick="window.__clicks.push('NAV-2')">产品介绍</li>
    <li onclick="window.__clicks.push('NAV-3')">关于我们</li>
    <li onclick="window.__clicks.push('NAV-4')">联系方式</li>
  </ul>
</nav>

<header>
  <ul>
    <li onclick="window.__clicks.push('HDR-1')">登录</li>
    <li onclick="window.__clicks.push('HDR-2')">注册</li>
    <li onclick="window.__clicks.push('HDR-3')">帮助中心</li>
  </ul>
</header>

<div class="glossary">
  <h3>常见安全术语</h3>
  <ul>
    <li onclick="window.__clicks.push('GLO-A')">Authentication mechanisms and identity verification</li>
    <li onclick="window.__clicks.push('GLO-B')">Brute force attack prevention strategies</li>
    <li onclick="window.__clicks.push('GLO-C')">Cross-site scripting mitigation techniques</li>
  </ul>
</div>

<div class="doc">
  <p>本方案分为三个阶段，具体如下：</p>
  <ul>
    <li onclick="window.__clicks.push('DOC-A')">A. 需求调研与分析阶段，产出调研报告</li>
    <li onclick="window.__clicks.push('DOC-B')">B. 方案设计与评审阶段，产出设计文档</li>
    <li onclick="window.__clicks.push('DOC-C')">C. 开发实施与验收阶段，产出验收报告</li>
  </ul>
</div>

<div class="quiz">
  <div class="stem">3. 下列哪种语言主要用于描述网页样式？</div>
  <ul>
    <li onclick="window.__clicks.push('Q1-A')">A. JavaScript，一种用于网页交互的脚本语言</li>
    <li onclick="window.__clicks.push('Q1-B')">B. CSS，层叠样式表，专门描述网页外观样式</li>
    <li onclick="window.__clicks.push('Q1-C')">C. Python，一种通用高级编程语言</li>
    <li onclick="window.__clicks.push('Q1-D')">D. SQL，用于关系型数据库查询的语言</li>
  </ul>
</div>

<div class="quiz2">
  <div class="stem">4. 以下哪个是 HTTP 状态码 404 的含义？</div>
  <ul>
    <li onclick="window.__clicks.push('Q2-A')">A. 服务器内部错误，通常表示程序发生崩溃</li>
    <li onclick="window.__clicks.push('Q2-HINT')">提示：请仔细阅读题干后再作答本题</li>
    <li onclick="window.__clicks.push('Q2-C')">C. 未找到请求的资源，服务器无法定位</li>
  </ul>
</div>

</body></html>`;

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": PAGE } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/", { aiAnswer: "B", waitFor: null });

  await H.startAndWait(page, { mode: "ai", intervalMs: 50, aiKey: "x", fillHosts: "*" });

  const log = await H.readLog(page);
  const clicks = await page.evaluate(() => window.__clicks);
  const recognized = Number((log.match(/页面识别到 (\d+) 道题/) || [])[1]);
  const all = clicks.join(",");

  console.log("--- 运行日志 ---\n" + log + "\n");
  console.log("实际发生的点击:", JSON.stringify(clicks));

  const R = H.Reporter();
  R.t("识别出 2 道（真选择题 + 分点说明），第 6 段整体放弃", recognized === 2, recognized);
  R.t("全程只发生 1 次点击", clicks.length === 1, clicks);
  R.t("导航菜单没被点", !/NAV-/.test(all), clicks);
  R.t("header 列表没被点", !/HDR-/.test(all), clicks);
  R.t("英文术语表没被误判成选项（旧规则会）", !/GLO-/.test(all), clicks);
  R.t("分点说明没被自动点（低置信跳过）", !/DOC-/.test(all), clicks);
  R.t("真选择题被正确点选（B）", clicks.includes("Q1-B"), clicks);
  R.t("夹了提示文字的题没被乱点", !/Q2-/.test(all), clicks);
  R.t("低置信跳过有记录", /低置信跳过 1/.test(log), (log.match(/低置信跳过 \d+/) || [])[0]);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
