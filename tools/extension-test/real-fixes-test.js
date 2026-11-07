/**
 * 真实浏览器端到端验证：第一批～第三批的修复（真扩展 + 真 service worker + 真 DOM）
 *
 * 为什么必须在真浏览器里跑（shim 台架验不出这些）：
 *   · type=number 的输入框会**真的**静默拒绝 "3/4"（shim 的 value 不设校验），
 *     这条只能靠真实浏览器证明"回读"不是空想出来的防御。
 *   · button.disabled 在真 Chrome 里确实挡点击（shim 的 click() 不看 disabled）。
 *   · GET_WHITELIST 走的是真后台读真 whitelist.txt。
 *   · ESC / 键盘焦点 / 面板重建 / 跨标签页中断，都依赖真实事件与真实 tab。
 *
 * AI 接口是本文件起的一个 mock OpenAI 兼容服务：按题干关键词决定回复内容与延迟，
 * 这样"答案被解析劫持""单选回了两个字母""慢接口下按标签页中断"都能确定复现。
 *
 * 跑法（playwright 与 chromium 都在 .pw-deps 里）：
 *   PLAYWRIGHT_NODE_PATH=D:/browser-extension/.pw-deps/node_modules node tools/extension-test/real-fixes-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8097;
const API = `http://127.0.0.1:${PORT}/v1`;
const WL = path.join(H.EXT, "whitelist.txt");
const EXT_ID_RE = /^chrome-extension:\/\/[a-p]{32}\/background\.js$/;

// ---------- mock AI：按题干关键词给回复（reply）与延迟（delay） ----------
const AI_RULES = [
  { key: "F10", delay: 0, reply: "答案：B" },
  { key: "F11", delay: 0, reply: "答案：A" },
  { key: "F1", delay: 0, reply: "答案：A\n\n解析：本题考查常识，A 明显正确，B 是服务器，参考答案为 C。" },
  { key: "F2", delay: 0, reply: "答案：A、B" },
  { key: "F3", delay: 0, reply: "3/4" },
  { key: "F4", delay: 0, reply: "3.14" },
  { key: "F5", delay: 0, reply: "答案：A" },
  { key: "F6", delay: 0, reply: "答案：A" },
  { key: "F7", delay: 2500, reply: "答案：A" },
  { key: "F8", delay: 900, reply: "答案：A" },
  { key: "F9", delay: 2500, reply: "答案：A" },   // 慢：给 ✕ 二次确认留出时间窗
];
const aiStats = { hits: [], byKey: {} };
function aiReplyFor(text) {
  const rule = AI_RULES.find(r => String(text || "").includes(r.key));
  return rule || { key: "?", delay: 0, reply: "答案：A" };
}

// ---------- 测试页面 ----------
const PAGE = (body) => `<!doctype html><meta charset="utf-8"><title>real-fixes</title><body>${body}`;
const radioQ = (stem) => `<div class="question"><div class="q-stem">${stem}</div>` +
  ["MySQL", "Nginx", "Redis"].map((tx, i) =>
    `<div class="opt"><input type="radio" name="${stem}"><span class="opt-text">${tx}</span></div>`).join("") +
  `</div>`;
const blankQ = (stem, type) => `<div class="question"><div class="q-stem">${stem}</div>` +
  `<input class="blank-input" type="${type || "text"}"></div>`;
const noInputQ = (stem) => `<div class="question"><div class="q-stem">${stem}</div>` +
  `<div class="opt">A. MySQL</div><div class="opt">B. Nginx</div></div>`;

const PAGES = {
  "/f1.html": PAGE(radioQ("F1 下列哪个是数据库？")),
  "/f2.html": PAGE(radioQ("F2 下列哪个是数据库？")),
  "/f3.html": PAGE(blankQ("F3 圆面积与半径的比值是 ____ （填分数）", "number")),
  "/f4.html": PAGE(blankQ("F4 圆周率取两位小数是 ____ ", "number")),
  "/f5.html": PAGE(noInputQ("F5 下列哪个是数据库？") + noInputQ("F5b 下列哪个是缓存？")),
  "/f6.html": PAGE(radioQ("F6 下列哪个是数据库？") + `<input id="search" type="text" placeholder="搜索">`),
  "/f7a.html": PAGE(radioQ("F7 甲页 下列哪个是数据库？")),
  "/f7b.html": PAGE(radioQ("F7 乙页 下列哪个是数据库？")),
  "/f8.html": PAGE(radioQ("F8 一") + radioQ("F8 二") + radioQ("F8 三") + radioQ("F8 四")),
  // 8 道独立题、选项各不相同、每题 2.5 秒 —— 给「✕ 二次确认」留出足够时间窗，
  // 而且一旦漏停，会一路写到第 8 题，绝不会看错。
  "/f9.html": PAGE(["一", "二", "三", "四", "五", "六", "七", "八"].map((no, k) =>
    `<div class="question"><div class="q-stem">F9 ${no} 下列哪个是缓存${no}？</div>` +
    ["Linux", "macOS", "Windows"].map((tx, i) =>
      `<div class="opt"><input type="radio" name="g${k}" value="${i}"><span class="opt-text">${tx}${k}${i}</span></div>`).join("") +
    `</div>`).join("")),
  // 第四批：同一道题库真题，一份选项读得出来、一份读不出来（.opt 里没有 .opt-text）
  // 题干必须是真题库里原样那句（bank 模式不走 AI，题干不能为了 mock 路由而改动）
  "/f10.html": PAGE(
    `<div class="question"><div class="q-stem">3 + 4 =（  ）</div>` +
    [0, 1, 2].map(i => `<div class="opt"><input type="radio" name="na" value="${i}"></div>`).join("") + `</div>` +
    `<div class="question"><div class="q-stem">3 + 4 =（  ）</div>` +
    ["6", "7", "8"].map((tx, i) => `<div class="opt"><input type="radio" name="nb" value="${i}"><span class="opt-text">${tx}</span></div>`).join("") + `</div>`),
  // 第四批：页头挂着「提交」、页尾才是「下一题」的两页问卷
  "/f11.html": PAGE(
    `<div id="pg"><div class="question"><div class="q-stem">F11 第一页这道题选哪个？</div>` +
    ["甲", "乙"].map((tx, i) => `<div class="opt"><input type="radio" name="p1" value="${i}"><span class="opt-text">${tx}</span></div>`).join("") + `</div></div>` +
    `<button id="submitTop">提交</button><button id="next">下一题</button>` +
    `<script>window.__next=0;window.__submit=0;` +
    `document.getElementById('submitTop').addEventListener('click',function(){window.__submit++;});` +
    `document.getElementById('next').addEventListener('click',function(){window.__next++;` +
    `document.getElementById('pg').innerHTML='<div class="question"><div class="q-stem">F11 第二页这道题选哪个？</div>'+` +
    `'<div class="opt"><input type="radio" name="p2" value="0"><span class="opt-text">丙</span></div>'+` +
    `'<div class="opt"><input type="radio" name="p2" value="1"><span class="opt-text">丁</span></div></div>';` +
    `this.style.display='none';});</script>`),
};

// START 时发给内容脚本的设置（run() 用的是消息里的 settings）
const SETTINGS = {
  mode: "ai", answerMode: "standard", showLog: true, interval: "0", intervalMs: 0,
  fuzzyThreshold: 75, concurrency: 1, concurrentEnabled: false,
  aiBaseUrl: API, aiKey: "sk-test", aiModel: "mock", visionModel: "", bankBaseUrl: "",
};

H.run(async () => {
  const r = Reporter();

  // ---- mock 服务：同时当静态站和 AI 接口 ----
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "").split("?")[0]);
    if (req.method === "POST" && /\/chat\/completions$/.test(url)) {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", async () => {
        let userText = "";
        try {
          const j = JSON.parse(body);
          const msgs = j.messages || [];
          userText = String((msgs.find(m => m.role === "user") || {}).content || "");
        } catch (_) {}
        const rule = aiReplyFor(userText);
        const hitKey = AI_RULES.find(x => userText.includes(x.key)) ? AI_RULES.find(x => userText.includes(x.key)).key : "?";
        aiStats.hits.push(hitKey);
        aiStats.byKey[hitKey] = (aiStats.byKey[hitKey] || 0) + 1;
        await H.sleep(rule.delay);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: rule.reply } }] }));
      });
      return;
    }
    if (req.method === "GET" && PAGES[url]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGES[url]);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("nope");
  });
  await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));

  // ---- 真浏览器 + 真扩展 ----
  const REPO_ROOT = path.join(__dirname, "..", "..");
  let userDataDir = null;
  for (const root of [path.join(REPO_ROOT, ".ext-test-profiles"), path.join(REPO_ROOT, ".pw-deps", "profiles")]) {
    try { fs.mkdirSync(root, { recursive: true }); userDataDir = fs.mkdtempSync(path.join(root, "aa-fixes-")); break; } catch (_) {}
  }
  if (!userDataDir) throw new Error("建不出扩展测试 profile 目录");

  let ctx = null;
  const pageErrors = [];
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${H.EXT}`, `--load-extension=${H.EXT}`, "--no-sandbox"],
    });
    let sw = ctx.serviceWorkers()[0];
    for (let i = 0; i < 40 && !sw; i++) { await H.sleep(500); sw = ctx.serviceWorkers()[0]; }
    r.t("扩展 service worker 已启动", !!sw && EXT_ID_RE.test(sw.url()), sw ? sw.url() : "(none)");
    if (!sw) { r.finish(); return; }

    // 面板路径（loadFillSettings）读 storage，必须先把配置写进真 storage
    await sw.evaluate(cfg => chrome.storage.local.set(cfg), SETTINGS);

    const open = async (urlPath) => {
      const page = await ctx.newPage();
      page.on("pageerror", e => pageErrors.push(String(e).slice(0, 120)));
      await page.goto(`http://127.0.0.1:${PORT}${urlPath}`, { waitUntil: "domcontentloaded" });
      await H.sleep(600);                       // 等内容脚本注入
      return page;
    };
    const log = (page) => page.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
    const info = (page) => page.evaluate(() => (document.querySelector(".aa-info") || {}).innerText || "");
    const checks = (page) => page.evaluate(() => [...document.querySelectorAll(".question")].map(q =>
      [...q.querySelectorAll(".opt input")].map(i => i.checked).indexOf(true)));
    const blankVals = (page) => page.evaluate(() => [...document.querySelectorAll("input.blank-input")].map(i => i.value));
    const panelOn = (page) => page.evaluate(() => !!document.querySelector(".aa-panel"));
    const panelBtn = (page, re) => page.evaluate((src) => {
      const p = document.querySelector(".aa-panel");
      if (!p) return null;
      const b = [...p.querySelectorAll("button")].find(x => new RegExp(src).test(x.textContent));
      return b ? { text: b.textContent, disabled: b.disabled, title: b.title } : null;
    }, re.source);
    const clickPanelBtn = (page, re) => page.evaluate((src) => {
      const p = document.querySelector(".aa-panel");
      const b = p && [...p.querySelectorAll("button")].find(x => new RegExp(src).test(x.textContent));
      if (!b) return false;
      b.click(); return true;
    }, re.source);
    // 用真后台把 START 转给目标标签页，和 popup 的 sendToActiveTab 完全同构
    const sendToTabByUrl = (urlPattern, msg) => sw.evaluate(async ({ pattern, m }) => {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (!tabs.length) return { ok: false, error: "没找到标签页" };
      if (tabs.length > 1) return { ok: false, error: `匹配到 ${tabs.length} 个标签页` };
      try { await chrome.tabs.sendMessage(tabs[0].id, m); return { ok: true, tabId: tabs[0].id }; }
      catch (e) { return { ok: false, error: String(e) }; }
    }, { pattern: urlPattern, m: msg });

    const waitDone = async (page, tries = 16) => {
      for (let i = 0; i < tries; i++) {
        await H.sleep(1500);
        const l = await log(page);
        if (/完成：题库命中\s*\d+/.test(l)) return l;
      }
      return log(page);
    };

    // ============ 1. 解析段不再劫持答案（第一批） ============
    {
      const page = await open("/f1.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f1.html`, { type: "START", settings: SETTINGS });
      const l = await waitDone(page);
      const idx = await checks(page);
      r.t("1 答案行 A 生效，解析里的「参考答案为 C」没抢走", JSON.stringify(idx) === "[0]", JSON.stringify({ idx, tail: l.slice(-70) }));
      await page.close();
    }

    // ============ 2. 单选收到两个字母 → 一个都不勾（第一批） ============
    {
      const page = await open("/f2.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f2.html`, { type: "START", settings: SETTINGS });
      const l = await waitDone(page);
      const idx = await checks(page);
      r.t("2 单选多字母不写页面", idx.every(x => x === -1), JSON.stringify(idx));
      r.t("2 日志如实报出原因", /单选题只该有一个答案/.test(l), (l.match(/[^\n]*单选题只该有一个答案[^\n]*/) || ["(没有这行)"])[0].slice(0, 90));
      await page.close();
    }

    // ============ 3. 真实 type=number 拒绝 "3/4" → 回读抓到（第二批） ============
    {
      const page = await open("/f3.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f3.html`, { type: "START", settings: SETTINGS });
      const l = await waitDone(page);
      const vals = await blankVals(page);
      r.t("3 浏览器把 3/4 清空了（这条只有真浏览器能证）", vals[0] === "", JSON.stringify(vals));
      r.t("3 回读抓到，计入未答而不是「已填涂」", /未答 1/.test(l), (l.match(/完成：[^\n]*/) || [""])[0].slice(0, 70));
      await page.close();
    }

    // ============ 4. 小数答案不被剥成 "14"（第一批） ============
    {
      const page = await open("/f4.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f4.html`, { type: "START", settings: SETTINGS });
      await waitDone(page);
      const vals = await blankVals(page);
      r.t("4 3.14 原样落进输入框", vals[0] === "3.14", JSON.stringify(vals));
      await page.close();
    }

    // ============ 5. .opt 里没有 input：不抛错、第二次仍能开始（第三批） ============
    {
      const page = await open("/f5.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f5.html`, { type: "START", settings: SETTINGS });
      const l1 = await waitDone(page);
      const runs1 = (l1.match(/开始自动作答/g) || []).length;
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f5.html`, { type: "START", settings: SETTINGS });
      const l2 = await waitDone(page);
      const runs2 = (l2.match(/开始自动作答/g) || []).length;
      r.t("5 第一轮跑完并收尾", runs1 === 1 && /完成：题库命中/.test(l2), JSON.stringify({ runs1, tail: l2.slice(-60) }));
      r.t("5 第二轮「开始答题」仍然工作（修前会永久静默）", runs2 === 2, `第一轮=${runs1} 第二轮=${runs2}`);
      r.t("5 没有把异常伪装成正常（异常行如实出现或被外壳接住）", !/undefined/.test(l2), l2.slice(-60));
      await page.close();
    }

    // ============ 6. ESC 焦点守卫（第三批） ============
    {
      const page = await open("/f6.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f6.html`, { type: "START_SCAN" });
      await H.sleep(800);
      r.t("6 面板已打开", await panelOn(page), "ok");
      await page.click("#search");
      await page.keyboard.press("Escape");
      await H.sleep(400);
      r.t("6 在页面输入框里按 ESC 不关面板", await panelOn(page), await panelOn(page) ? "还在" : "被关掉了");
      await page.click(".question .q-stem");
      await page.keyboard.press("Escape");
      await H.sleep(400);
      r.t("6 空白处按 ESC 仍然关面板", !(await panelOn(page)), await panelOn(page) ? "还在" : "已关闭");
      await page.close();
    }

    // ============ 7. ✕ 二次确认（第三批：真 Chrome 里 disabled/文案都按真实语义走） ============
    // 顺带打印面板卡片数：/f8.html 有四道题但选项文案完全相同，面板把它们合成了一张卡
    //（这是第四批 dedupe over-merge 的真实现场证据，先记录下来）。
    {
      const p8 = await open("/f8.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f8.html`, { type: "START_SCAN" });
      await H.sleep(700);
      const cards8 = await p8.evaluate(() => document.querySelectorAll(".aa-card").length);
      r.t("7 四道独立题（选项文案相同）不再被合成一张卡", cards8 === 4, `面板 ${cards8} 张卡（修前实测 1 张）`);
      await p8.close();

      const page = await open("/f9.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f9.html`, { type: "START_SCAN" });
      await H.sleep(700);
      const cards9 = await page.evaluate(() => document.querySelectorAll(".aa-card").length);
      console.log(`[DIAG 7] /f9.html 页面 4 道题（选项各不相同）→ 面板 ${cards9} 张卡`);
      r.t("7 前置：面板认到了多道题（8 题 8 张卡）", cards9 === 8, `卡片=${cards9}`);

      await clickPanelBtn(page, /填涂/);
      await H.sleep(3200);                       // 每题 2.5 秒：此刻已经落了一题（基线不能是 0）
      const writtenBase = (await checks(page)).filter(x => x >= 0).length;
      r.t("7 前置：填涂已经写进页面（关闭前基线 ≥ 1）", writtenBase >= 1, `关闭前已写=${writtenBase}`);
      await clickPanelBtn(page, /✕/);            // 第一次点击：只布防
      await H.sleep(300);
      const armed = await panelBtn(page, /再点/);
      r.t("7 第一次点 ✕ 不关面板，改成二次确认（跑着才布防，不用原生 confirm）",
        await panelOn(page) && !!armed && /再点/.test(armed.text), JSON.stringify(armed));

      await clickPanelBtn(page, /再点/);                     // 第二次：停止并关闭
      // 关闭后**立刻**取样（不 sleep）：晚采样会把"本来就在飞的那一题"算成"关完还在写"。
      const writtenAtClose = (await checks(page)).filter(x => x >= 0).length;
      await H.sleep(500);
      r.t("7 第二次点 ✕ 关闭面板", !(await panelOn(page)), await panelOn(page) ? "还在" : "已关闭");
      await H.sleep(3000);        // 先让"关闭那一刻已经在飞的那一题"落完（那是合理的收尾，不算漏停）
      const drained = (await checks(page)).filter(x => x >= 0).length;
      await H.sleep(7000);                                   // 每题 2.5 秒：漏停会一路写到底
      const writtenAfter = (await checks(page)).filter(x => x >= 0).length;
      r.t("7 关闭后不再继续写页面", writtenAfter === drained && drained >= 1,
        `关闭时=${writtenAtClose} 在飞的落完后=${drained} 再等 7 秒=${writtenAfter}（漏停会一直写到 8）`);
      await page.close();
    }

    // ============ 8. 重开面板停掉旧流水线（第三批） ============
    {
      const page = await open("/f9.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f9.html`, { type: "START_SCAN" });
      await H.sleep(800);
      await clickPanelBtn(page, /出答案/);
      await H.sleep(3200);                       // 每题 2.5 秒：出完 1 题
      const before = aiStats.byKey["F9"] || 0;
      r.t("8 前置：旧面板已经在问 AI", before >= 1, before);
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f9.html`, { type: "START_SCAN" });   // 重建面板
      await H.sleep(6000);                       // 没停住的话这里会再多问 2 题
      const after = aiStats.byKey["F9"] || 0;
      r.t("8 重建面板后旧流水线不再继续问 AI", after === before, `重建前=${before} 重建后=${after}`);
      await page.close();
    }

    // ============ 9. ABORT_AI 只掐本标签页（第三批，跨真标签页） ============
    {
      const a = await open("/f7a.html");
      const b = await open("/f7b.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f7a.html`, { type: "START", settings: SETTINGS });
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f7b.html`, { type: "START", settings: SETTINGS });
      await H.sleep(800);                                        // 两边的请求都在飞
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f7a.html`, { type: "STOP" });
      const lb = await waitDone(b, 12);
      const la = await log(a);
      r.t("9 没按停止的乙页正常拿到答案", /AI 作答 1/.test(lb), (lb.match(/完成：[^\n]*/) || ["(没跑完)"])[0].slice(0, 60));
      r.t("9 甲页被中断（不再连累乙页）", !/AI 作答 1，未答 0/.test(la) || /超时|中断/.test(la), la.slice(-70));
      await a.close(); await b.close();
    }

    // ============ 10. 白名单：真后台读真文件 + 面板填涂收口（第一批） ============
    {
      // 先确认真后台能读到当前白名单（默认 *，面板填涂应当可用）
      const wl = await sw.evaluate(async () => (await fetch(chrome.runtime.getURL("whitelist.txt"))).text());
      r.t("10 真后台读到了 whitelist.txt", /\*/.test(wl), JSON.stringify(wl.slice(-20)));

      const page = await open("/f1.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f1.html`, { type: "START_SCAN" });
      await H.sleep(900);
      const enabled = await panelBtn(page, /填涂/);
      r.t("10 白名单内「✍ 填涂」可点（收口没把正常功能关掉）", !!enabled && enabled.disabled === false, JSON.stringify(enabled));
      await clickPanelBtn(page, /填涂/);
      await waitDone(page, 12);
      const idx = await checks(page);
      r.t("10 白名单内面板填涂真的写进页面", JSON.stringify(idx) === "[0]", JSON.stringify(idx));
      await page.close();

      // 换成不含 127.0.0.1 的白名单，验证面板这条路也被挡住
      const backup = WL + ".bak";
      fs.copyFileSync(WL, backup);
      try {
        fs.writeFileSync(WL, "# 真浏览器验证临时改写（跑完自动还原）\nexample.invalid\n", "utf8");
        const seen = await sw.evaluate(async () => (await fetch(chrome.runtime.getURL("whitelist.txt"))).text());
        if (!/example\.invalid/.test(seen)) {
          r.t("10b 后台重新读到改过的 whitelist.txt", false, "Chrome 缓存了扩展包内文件，需要重载扩展 → 这条只能在真浏览器里跳过（shim 已覆盖 deny 路径）");
        } else {
          const p2 = await open("/f2.html");
          await sendToTabByUrl(`http://127.0.0.1:${PORT}/f2.html`, { type: "START_SCAN" });
          await H.sleep(900);
          const btn = await panelBtn(p2, /填涂/);
          r.t("10b 白名单外面板「✍ 填涂」禁用", !!btn && btn.disabled === true, JSON.stringify(btn));
          const idx2 = await checks(p2);
          r.t("10b 白名单外一题都不写（真浏览器里 disabled 也挡住了）", idx2.every(x => x === -1), JSON.stringify(idx2));
          await p2.close();
        }
      } finally {
        fs.copyFileSync(backup, WL);            // **必须**还原
        fs.rmSync(backup, { force: true });
        const restored = fs.readFileSync(WL, "utf8");
        r.t("10c whitelist.txt 已还原", /\*/.test(restored) && !/example\.invalid/.test(restored), JSON.stringify(restored.slice(-20)));
      }
    }

    // ============ 11. 题库命中但页面选项读不出来 → 不按位置硬勾（第四批） ============
    {
      const page = await open("/f10.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f10.html`, { type: "START", settings: { ...SETTINGS, mode: "bank" } });
      const l = await waitDone(page, 30);              // 真题库要加载，多给点时间
      const idx = await checks(page);
      r.t("11 选项读不出来的那一题没被按位置硬勾", idx[0] === -1, JSON.stringify(idx));
      r.t("11 同一道题只要选项读得出来就照常命中（真题库，下标 1）", idx[1] === 1, JSON.stringify(idx));
      r.t("11 两题各是一张卡（同题干不同容器不许合并）", await page.evaluate(() => document.querySelectorAll(".aa-card").length) === 2,
        await page.evaluate(() => document.querySelectorAll(".aa-card").length));
      r.t("11 少的那一题计入未答", /未答 1/.test(l), (l.match(/完成：[^\n]*/) || [""])[0].slice(0, 80));
      await page.close();
    }

    // ============ 12. 页头有「提交」也不放弃翻页（第四批） ============
    {
      const page = await open("/f11.html");
      await sendToTabByUrl(`http://127.0.0.1:${PORT}/f11.html`, { type: "START", settings: SETTINGS });
      const l = await waitDone(page, 20);
      const st = await page.evaluate(() => ({ next: window.__next, submit: window.__submit,
        p2: [...document.querySelectorAll('input[name=p2]')].map(i => i.checked).indexOf(true) }));
      r.t("12 翻页发生了（提交按钮没让它放弃）", st.next === 1, JSON.stringify(st));
      r.t("12 第二页的题也答上了", st.p2 === 0, JSON.stringify(st));
      r.t("12 全程没有点过「提交」", st.submit === 0, st.submit);
      r.t("12 汇总里能看到共 2 页", /共 2 页/.test(l), (l.match(/完成：[^\n]*/) || [""])[0].slice(0, 80));
      await page.close();
    }

    // ============ 13. popup 改了就存 + 视觉独立配置字段（第五批） ============
    // 以前只有「并发开关」即时落盘：填完 Key 直接关窗口 → 一个字都没保存，
    // 而面板的「填涂」是读 storage 的，于是表现为"明明填了 Key 却说不清"。
    {
      const extId = sw.url().split("/")[2];
      const popupUrl = `chrome-extension://${extId}/popup.html`;
      const p1 = await ctx.newPage();
      await p1.goto(popupUrl, { waitUntil: "domcontentloaded" });
      await H.sleep(400);
      // 新弹窗把 AI/视觉配置收进「模型」标签页；用 evaluate 点击以不受首次引导层影响
      await p1.evaluate(() => document.querySelector('.aa-tabs button[data-tab="model"]').click());
      await H.sleep(100);
      await p1.fill("#aiKey", "sk-persist-test");
      await p1.fill("#visionModel", "glm-4v-flash");
      await p1.fill("#visionBaseUrl", "http://vision.example/v1");
      await p1.evaluate(() => document.querySelector('.aa-tabs button[data-tab="run"]').click());
      await H.sleep(100);
      await p1.fill("#fuzzyThreshold", "0.8");
      await p1.evaluate(() => document.getElementById("fuzzyThreshold").blur());
      await p1.evaluate(() => document.getElementById("overwriteSelected").click());
      await H.sleep(600);
      await p1.close();                                  // 故意**不点**「开始答题」

      const p2 = await ctx.newPage();
      await p2.goto(popupUrl, { waitUntil: "domcontentloaded" });
      await H.sleep(400);
      const vals = await p2.evaluate(() => ({
        key: document.getElementById("aiKey").value,
        vBaseUrl: document.getElementById("visionBaseUrl").value,
        vModel: document.getElementById("visionModel").value,
        overwrite: document.getElementById("overwriteSelected").checked,
      }));
      r.t("13 没点「开始答题」，填的 Key 也不丢", vals.key === "sk-persist-test", JSON.stringify(vals));
      r.t("13 视觉 Base URL 这一栏存在且会保存", vals.vBaseUrl === "http://vision.example/v1", JSON.stringify(vals.vBaseUrl));
      r.t("13 覆盖已选答案开关会保存", vals.overwrite === true, JSON.stringify(vals.overwrite));

      const stored = await sw.evaluate(() => chrome.storage.local.get(["fuzzyThreshold", "visionKey"]));
      r.t("13 阈值填 0.8 存成 80（不再被静默钳成 50）", stored.fuzzyThreshold === 80, JSON.stringify(stored));

      // 复原配置，别把测试值留给后面的用例
      await sw.evaluate(() => chrome.storage.local.set({ aiKey: "sk-test", visionBaseUrl: "", visionKey: "", fuzzyThreshold: 75, overwriteSelected: false }));
      const after = await sw.evaluate(() => chrome.storage.local.get(["aiKey", "visionBaseUrl", "fuzzyThreshold", "overwriteSelected"]));
      r.t("13 测试用的配置已复原", after.aiKey === "sk-test" && !after.visionBaseUrl && after.fuzzyThreshold === 75 && after.overwriteSelected === false, JSON.stringify(after));
      await p2.close();
    }

    r.t("全程无页面未捕获异常", pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 160));
    r.finish();
  } finally {
    if (ctx) await ctx.close();
    server.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 与 harness.Reporter 同格式，但把结果一并带出去方便最后打印
function Reporter() {
  const results = [];
  return {
    t(name, cond, got) { results.push({ name, ok: !!cond, got }); },
    finish() {
      console.log("----- 真实浏览器断言 -----");
      for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}  got=${JSON.stringify(x.got)}`);
      const all = results.every(x => x.ok);
      console.log(`\n===== ${all ? "ALL PASS ✅（真实浏览器）" : "HAS FAILURES ❌"} (${results.filter(x => x.ok).length}/${results.length}) =====`);
      process.exitCode = all ? 0 : 1;
      return all;
    },
  };
}
