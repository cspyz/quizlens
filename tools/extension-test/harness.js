/**
 * 测试公共台架。
 * 之前 9 个测试各自复制了一遍「HTTP 服务 + chrome API stub + 注入 content.js + 等作答完成 + 断言汇总」
 * （实测 47 行逐字重复、平均出现 6.4 次）。抽到这里，以后改一处全部生效。
 *
 * 用法：
 *   const H = require("./harness");
 *   const { chromium } = H.ensurePlaywright();
 *   const site = await H.serve({ port: 8085, staticDir: path.join(__dirname, "..", "..", "quiz-app") });
 *   const page = await H.newPage(browser, site.url + "/");
 *   await H.startAndWait(page, { mode: "ai", intervalMs: 50, fillHosts: "*" });
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

// 扩展源码目录：测试一律直连它，不在测试目录留副本（留副本会漂移，白调试过一轮）
const EXT = path.join(__dirname, "..", "..", "extension");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// playwright 作为普通依赖解析：可装在项目下，也可用 NODE_PATH 指向全局安装位置
function ensurePlaywright() {
  const extra = process.env.PLAYWRIGHT_NODE_PATH;
  if (extra && !process.env.NODE_PATH) {
    process.env.NODE_PATH = extra;
    require("module").Module._initPaths();
  }
  try {
    return require("playwright");
  } catch (e) {
    throw new Error(
      "未找到 playwright。请先安装：\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      "若已装在别处，可用 PLAYWRIGHT_NODE_PATH 指向其 node_modules。\n" +
      "原始错误：" + e.message
    );
  }
}

/**
 * 起静态服务。
 * @param port     端口（各测试用不同端口，避免互相干扰）
 * @param staticDir 静态根目录
 * @param defaultFile "/" 对应的文件
 * @param routes   额外/覆盖路由：{ "/bank/index.json": 对象或字符串 }
 * @param contentJsUrl 是否把 /content.js 指到扩展目录（默认是）
 */
async function serve({ port, staticDir = __dirname, defaultFile = "index.html", routes = {}, contentJsUrl = true }) {
  const server = http.createServer((req, res) => {
    // ⚠ 必须 decodeURIComponent：req.url 是**URL 编码**过的，
    // 而题库文件名是中文（10_中医.json / 11_中文理解.json / 12_体育·乒乓球.json …）。
    // 不解码就会拿 "%E4%B8%AD%E5%8C%BB" 去拼路径 → 必然 404 → 整个题库加载失败
    // → 面板日志停在「正在加载题库并建索引…」→ 完不成作答 → 依赖"跑完一轮"的
    // 断言全部连环失败（实测 fuzzy / regression / run 三个套件就是这么红的）。
    //
    // 这个坑只在题库使用中文文件名后才暴露：早期题库是英文名（05_cmmlu.json 等），
    // 编码前后恰好一致，所以一直没被发现。解码对英文名无影响，是纯增量修复。
    let url = req.url.split("?")[0];
    try { url = decodeURIComponent(url); } catch (_) { /* 畸形编码就按原样处理 */ }
    if (Object.prototype.hasOwnProperty.call(routes, url)) {
      const body = routes[url];
      res.writeHead(200, { "Content-Type": MIME[path.extname(url)] || "text/html" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
      return;
    }
    const file = (contentJsUrl && url === "/content.js")
      ? path.join(EXT, "content.js")
      : path.join(staticDir, url === "/" ? defaultFile : url);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(port, r));
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

/**
 * 日志容器选择器。
 *
 * 历史包袱：日志区早期的写法是 `<div id="aa-log">`，后来重构把「运行日志」并进了
 * 题卡面板，容器改成 `class="aa-runlog"`，**id 被去掉了**。但测试与台架仍按
 * `#aa-log` 查询 —— 于是查询永远落空：
 *   · waitForFinish() 拿不到日志 → 永远等不到「完成：题库命中 N」→ 等满 37.5 秒超时；
 *   · 期间所有断言连环失败，看起来像"产品坏了"，其实只是选择器过期。
 *
 * 这里同时认两种写法（新写法优先），这样测试不必关心产品内部用的是 id 还是 class。
 * 页面上下文里执行，所以用普通函数字符串而不是外部变量。
 */
const LOG_SELECTOR = "#aa-log, .aa-runlog, [data-aa-log]";

/**
 * 打开页面并注入 chrome stub + content.js。
 * page.errors 收集 pageerror，page 结束前断言它为空 —— 这是发现"调用了不存在的函数"的唯一手段。
 * @param storage 让 chrome.storage.local.get 返回指定配置（测「读配置」分支时用）
 */
async function newPage(browser, url, { aiAnswer = "A", inject = true, waitFor = ".question", storage = {} } = {}) {
  // 默认打开运行日志面板。
  //
  // 为什么：产品的日志面板受 popup 的「答题时显示面板」开关控制，**默认关** ——
  // 关掉时 content.js 全程不创建面板 DOM（`if (!logPanelEnabled) return;`），
  // 日志只写进浏览器控制台。而测试既要读日志（readLog 查 .aa-runlog），
  // 又要断言"面板存在"，所以必须显式打开。
  //
  // 以前各测试自己传 storage 时都没带 showLog，于是读到的日志恒为空、
  // 面板断言恒为 false —— 看起来像产品坏了，实际是测试没把开关打开。
  // 这里给个默认值；测试想验证"关面板"的行为时显式传 showLog:false 覆盖即可。
  const st = Object.assign({ showLog: true }, storage);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.errors = errors;

  await page.goto(url);
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});

  if (inject) {
    await page.evaluate(({ a, st, logSel }) => {
      window.__clicks = [];
      window.__listenerCount = 0;
      // 日志容器选择器注入页面：后续断言都用 window.__aaLogSel 查，
      // 不再各自硬编码 #aa-log（产品换成 class 之后就全废了，见 LOG_SELECTOR 注释）。
      window.__aaLogSel = logSel;
      window.chrome = {
        runtime: {
          onMessage: { addListener: fn => { window.__listenerCount++; window.__aaListener = fn; } },
          getManifest: () => ({ version: "test" }),
          sendMessage: async msg => (msg.type === "AI_CHAT" ? { ok: true, text: a } : { ok: false, error: "stub" })
        },
        storage: { local: { get: async () => st, set: async () => {} } },
      };
    }, { a: aiAnswer, st, logSel: LOG_SELECTOR });
    await page.addScriptTag({ path: path.join(EXT, "content.js") });
    await page.waitForFunction(() => typeof window.__aaListener === "function");
  }
  return page;
}

/**
 * 等到作答结束。
 * 关键：用 Node 侧纯 sleep 轮询，不要用 waitForFunction/waitForTimeout ——
 * headless 下 Playwright 的等待类调用会冻结页面 JS，页面里的定时逻辑会停摆，表现为"卡死"。
 * 完成判定必须锚定到结果行（不能只匹配"完成："，题库日志里的"构建完成："也含这两个字）。
 */
async function waitForFinish(page, { tries = 15, step = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(step);
    const done = await page.evaluate(() => {
      const sel = window.__aaLogSel || "#aa-log, .aa-runlog";
      const log = document.querySelector(sel);
      return !!log && /完成：题库命中\s*\d+/.test(log.textContent);
    });
    if (done) return true;
  }
  return false;
}

// 发 START 并等结束。
//
// ⚠ showLog 必须在这里补默认值（不能只靠 newPage 的 storage 默认）：
// run() 判定要不要建日志面板用的是**这条 START 消息里的 settings** ——
//   content.js:  logPanelEnabled = !!(settings && settings.showLog);
// 而不是 storage。测试要读日志、要等"完成：题库命中 N"，面板就必须存在，
// 所以默认打开；想验证"关面板"行为的用例显式传 showLog:false 覆盖即可。
async function startAndWait(page, settings, opts) {
  const s = Object.assign({ showLog: true }, settings || {});
  await page.evaluate(s2 => window.__aaListener({ type: "START", settings: s2 }), s);
  return waitForFinish(page, opts);
}

const readLog = page => page.evaluate(() => {
  const sel = window.__aaLogSel || "#aa-log, .aa-runlog";
  const el = document.querySelector(sel);
  return el ? (el.innerText || el.textContent || "") : "";
});

// 读扩展内置题库清单（bank/index.json）。
// 用途：断言里的"类别数 / 题量"不要再写死 —— 题库从 9 类扩到 41 类时，
// 硬编码的 9/9 和 55000 会立刻变红，而那是题库长大、不是代码坏了。
function readBundledIndex() {
  const p = path.join(EXT, "bank", "index.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return []; }
}
function readBundledIndexCount() {
  return readBundledIndex().length;
}
function readBundledIndexTotal() {
  return readBundledIndex().reduce((s, it) => s + (Number(it && it.count) || 0), 0);
}

// 断言汇总：统一输出格式与退出码
function Reporter() {
  const results = [];
  return {
    t(name, cond, got) { results.push({ name, ok: !!cond, got }); },
    finish() {
      console.log("----- 断言 -----");
      for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}  got=${JSON.stringify(x.got)}`);
      const all = results.every(x => x.ok);
      console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} =====`);
      process.exitCode = all ? 0 : 1;
      return all;
    },
  };
}

// 统一的启动包裹：异常统一打 TEST_CRASH，别让测试静默挂掉
function run(main) {
  main().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
}

module.exports = { EXT, MIME, sleep, ensurePlaywright, serve, newPage, startAndWait, waitForFinish, readLog, Reporter, run,
  readBundledIndex, readBundledIndexCount, readBundledIndexTotal };
