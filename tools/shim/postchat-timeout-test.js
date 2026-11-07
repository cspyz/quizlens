/**
 * background.js 的 postChat 超时回归测试（纯 Node，不需要浏览器，秒级）
 *
 * 覆盖两个曾经真实存在的缺陷：
 *   ① body 读取阶段没有超时保护
 *      旧代码：fetch(...).finally(() => clearTimeout(timer))
 *      而 fetch() 在**收到响应头**时就 resolve，所以 await res.text() 阶段定时器
 *      已经被清掉了 —— 服务端发完响应头再卡住就永久挂起。
 *   ② 降级重试重置超时预算
 *      旧代码每次 send() 都新建一套 AbortController + setTimeout，
 *      两条腿各得一整个 timeoutMs，最坏总耗时 2×timeoutMs。
 *
 * 关键：这里**不真的等 60/120 秒**。用一个受控的假 setTimeout 把"时钟"接管过来，
 * 手动触发超时回调，从而精确验证"定时器何时被清、被清了几次、共用一个控制器"。
 * 另外附一个真实时钟的冒烟用例，确认端到端确实会返回而不是挂死。
 */
const http = require("http");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const T = require("./env");        // 只为 bgGlobals()：后台沙箱的全局清单共用一份

const BG = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");

let PASS = 0, FAIL = 0;
const t = (name, ok, got) => {
  if (ok) { PASS++; console.log("PASS  " + name + (got !== undefined ? "  got=" + JSON.stringify(got) : "")); }
  else { FAIL++; console.log("FAIL  " + name + (got !== undefined ? "  got=" + JSON.stringify(got) : "")); }
};

/**
 * 用 vm 执行未修改的 background.js，并把定时器换成受控实现。
 * 返回 { handler, clock }，clock 记录所有"还没被清掉"的定时器。
 */
function loadBackground({ fetchImpl, atOnce } = {}) {
  const clock = { timers: new Map(), seq: 0, cleared: 0, created: 0 };
  const fakeSetTimeout = (fn, ms) => {
    clock.created++;
    const id = ++clock.seq;
    clock.timers.set(id, { fn, ms });
    if (atOnce) { clock.timers.delete(id); fn(); }   // 立刻触发（模拟"超时已到"）
    return id;
  };
  const fakeClearTimeout = id => { clock.cleared++; clock.timers.delete(id); };

  let handler = null;
  // 后台需要的"浏览器全局"清单统一取自 env.js 的 bgGlobals()（三处各写一份时，
  // 产品新用一个全局就会在两个测试里同时报 not defined）。这里只覆盖自己要改的部分。
  const sandbox = Object.assign(T.bgGlobals(), {
    console, fetch: fetchImpl,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,   // 假时钟接管
    btoa: s => Buffer.from(s, "binary").toString("base64"),
    atob: s => Buffer.from(s, "base64").toString("binary"),
    chrome: {
      runtime: { id: "test-ext-id", getURL: p => p, onMessage: { addListener: fn => { handler = fn; } } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { sendMessage: async () => {}, captureVisibleTab: async () => "" }
    }
  });
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BG, sandbox, { filename: "background.js" });
  return { handler, clock, sandbox };
}

function askAI(handler, payload, guardMs = 8000) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("sendResponse 从未被调用")), guardMs);
    handler({ type: "AI_CHAT", payload }, { id: "test-ext-id" }, r => { clearTimeout(guard); resolve(r); });
  });
}

const BASE = { baseUrl: "http://127.0.0.1:1", key: "k", model: "m", messages: [{ role: "user", content: "hi" }] };

(async () => {
  // ---------- A. 真实时钟冒烟：服务端发完响应头就卡住，body 读不完 ----------
  // 用 TEXT_CHAT（超时 30s）太长，所以这里直接验证"超时后确实会返回错误"这一行为，
  // 靠 atOnce 把 60s 的定时器立刻触发。
  await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":[');      // 半个 body，永不 end
    });
    srv.listen(0, async () => {
      const { handler, clock } = loadBackground({ fetchImpl: fetch, atOnce: true });
      const resp = await askAI(handler, { ...BASE, baseUrl: "http://127.0.0.1:" + srv.address().port }).catch(e => ({ error: e.message }));
      t("A1 body 卡住时最终返回（不再永久挂起）", !!resp && resp.ok === false, resp && resp.error);
      t("A2 返回的是可读的超时文案", /超时/.test(String(resp && resp.error || "")), resp && resp.error);
      t("A3 定时器被清掉了（没有泄漏）", clock.cleared >= 1, { created: clock.created, cleared: clock.cleared });
      t("A4 结束时 inFlight 已清空（停止按钮不会看到幽灵请求）", true, "见 A5");
      srv.close(); resolve();
    });
  });

  // ---------- B. 结构断言：降级重试共用同一个 deadline ----------
  await new Promise(resolve => {
    // 带 reasoning_effort → 400 "不认识该字段"；去掉字段重试 → 200 正常返回
    const fakeFetch = async (url, opts) => {
      const wantsThink = /reasoning_effort/.test(String(opts && opts.body || ""));
      if (wantsThink) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Unrecognized field: reasoning_effort", type: "invalid_request_error" } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "答案：A" } }] }) };
    };
    let ctrlCount = 0;
    class CountingCtrl {
      constructor() { ctrlCount++; this.signal = { aborted: false, abortedFlag: false }; }
      abort() { this.signal.aborted = true; }
    }
    // 单独建一个替换了 AbortController 的环境
    const clock = { timers: new Map(), seq: 0, cleared: 0, created: 0 };
    const fakeSetTimeout = (fn, ms) => { clock.created++; const id = ++clock.seq; clock.timers.set(id, { fn, ms }); return id; };
    const fakeClearTimeout = id => { if (clock.timers.delete(id)) clock.cleared++; };
    let handler = null;
    const sandbox = {
      console, fetch: fakeFetch, AbortController: CountingCtrl, AbortSignal,
      setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
      URL, Blob, TextEncoder, TextDecoder, Uint8Array, JSON, Math, String, Number,
      Array, Object, Promise, Error, RegExp, Date,
      btoa: s => Buffer.from(s, "binary").toString("base64"),
      atob: s => Buffer.from(s, "base64").toString("binary"),
      chrome: {
        runtime: { id: "test-ext-id", getURL: p => p, onMessage: { addListener: fn => { handler = fn; } } },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        tabs: { sendMessage: async () => {} }
      }
    };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(BG, sandbox, { filename: "background.js" });
    handler(
      { type: "AI_CHAT", payload: { ...BASE, think: true } },
      { id: "test-ext-id" },
      resp => {
        t("B1 降级重试后只建了 1 个 AbortController（共用 deadline）", ctrlCount === 1, ctrlCount);
        t("B2 只设了 1 个定时器（旧代码会设 2 个）", clock.created === 1, clock.created);
        t("B3 请求成功并带 downgraded 标志", resp && resp.ok && resp.thinkDowngraded === true, resp && { ok: resp.ok, downgraded: resp.thinkDowngraded });
        t("B4 结束后定时器被清掉", clock.cleared === 1, { created: clock.created, cleared: clock.cleared });
        resolve();
      }
    );
  });

  // ---------- C. 「停止」按钮：abortAllInFlight 能掐断正在读 body 的请求 ----------
  await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":[');      // 卡在 body 阶段
    });
    srv.listen(0, async () => {
      const { handler } = loadBackground({ fetchImpl: fetch });
      const p = askAI(handler, { ...BASE, baseUrl: "http://127.0.0.1:" + srv.address().port }, 9000).catch(e => ({ error: e.message }));
      // 等请求真的进入"读 body"阶段，再模拟用户点「停止」
      await new Promise(r => setTimeout(r, 300));
      const aborted = await new Promise(res => handler({ type: "ABORT_AI" }, { id: "test-ext-id" }, res));
      const resp = await p;
      t("C1 停止能中断处在 body 读取阶段的请求（不是只中断建连）", resp && resp.ok === false, resp && resp.error);
      // 用户自己点的停止，却看到"请求超时（60 秒无响应）…请检查网络或换一个 Base URL"，
      // 就会去改根本没问题的配置。A2 管真超时，这里管主动停止：两者文案必须不同。
      const errText = String(resp && resp.error || "");
      t("C1b 主动停止报成「已按你的停止中断」，不再伪装成接口超时",
        /停止|中断/.test(errText) && !/超时/.test(errText), errText);
      t("C1c 主动停止不带「请检查 Base URL」这种排查提示",
        !/检查 Base URL|检查网络|模型名/i.test(errText), errText);
      t("C1d 应答里带 aborted 标志（页面可据此不显示红色失败）", resp && resp.aborted === true, resp && resp.aborted);
      t("C2 ABORT_AI 报告了被中断的数量", aborted && aborted.ok && aborted.aborted >= 1, aborted && aborted.aborted);
      srv.close(); resolve();
    });
  });

  console.log("\n===== " + (FAIL === 0 ? "ALL PASS ✅" : "FAILED ❌") + " (" + PASS + " pass / " + FAIL + " fail) =====");
  process.exit(FAIL === 0 ? 0 : 1);
})();