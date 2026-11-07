"use strict";
/*
 * 无浏览器测试台架：在纯 Node 里加载**未修改的** extension/content.js
 * （以及 extension/background.js 的真实逻辑），用来验证那些必须在真实
 * 消息/prompt 层才能观察到的行为。
 *
 * 背景：本仓库原有的 tools/extension-test/*（Playwright）在当前机器上
 * 一律以 "browserType.launch: spawn EPERM" 失败 —— 沙箱不允许拉起浏览器进程。
 * 那套测试无法用来验证本次改动，所以这里提供一个不依赖浏览器、不依赖网络、
 * 也不依赖任何 npm 依赖的最小环境（Node 标准库 + reviews 里的 DOM shim）。
 *
 * 用法：
 *   const T = require("./env");
 *   const env = T.makeEnv({ storage: {...}, aiReply: "答案：C\n\n解析…" });
 *   env.injectContent();
 *   env.startScan();
 *   ...
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const dom = require("./dom.js");

const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension");
const EXT_ID = "gplbpplopfmhbcmpcglgcaocghpkjbfg";
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readFileMaybe = p => { try { return fs.readFileSync(p, "utf8"); } catch (_) { return null; } };

// ---------------------------------------------------------------- 测试页面
// 一个最小但"插件真的认得出题"的页面：三道单选 + 一道填空。
// 结构与 tools/extension-test/*.js 里的 mock 保持一致（.q-stem / .opt input / input.blank-input）。
function pageHtml({ blanks = 1 } = {}) {
  const blankInputs = Array.from({ length: blanks }, (_, i) =>
    `<input class="blank-input" id="b${i + 1}" type="text">`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>shim</title></head><body>
<div class="question">
  <div class="q-stem">1. 下列哪个是数据库？</div>
  <div class="opt"><input type="radio" name="q1" value="0"><span class="opt-text">MySQL</span></div>
  <div class="opt"><input type="radio" name="q1" value="1"><span class="opt-text">Nginx</span></div>
  <div class="opt"><input type="radio" name="q1" value="2"><span class="opt-text">Redis</span></div>
</div>
<div class="question">
  <div class="q-stem">2. 下列哪个是编程语言？</div>
  <div class="opt"><input type="radio" name="q2" value="0"><span class="opt-text">JavaScript</span></div>
  <div class="opt"><input type="radio" name="q2" value="1"><span class="opt-text">HTML</span></div>
  <div class="opt"><input type="radio" name="q2" value="2"><span class="opt-text">CSS</span></div>
</div>
<div class="question">
  <div class="q-stem">3. 下列哪个是操作系统？</div>
  <div class="opt"><input type="radio" name="q3" value="0"><span class="opt-text">Linux</span></div>
  <div class="opt"><input type="radio" name="q3" value="1"><span class="opt-text">Chrome</span></div>
  <div class="opt"><input type="radio" name="q3" value="2"><span class="opt-text">Nginx</span></div>
</div>
<div class="question">
  <div class="q-stem">4. 中国的首都是 ____ 。</div>
  ${blankInputs}
</div>
</body></html>`;
}

// ---------------------------------------------------------------- fetch shim
// 默认把 URL 当扩展目录内的相对路径解析（测 content.js 取内置题库）。
// 传入 pageDir 后改为相对**该目录**解析 —— 用来加载真实的 quiz-app/index.html：
// 页面自己的 ./questions.json、./bank/index.json 必须能取到，
// 否则「本地练习页」这条最关键的链路根本跑不起来。
function makeFetch(stats, pageDir) {
  return async function fetchShim(input, init) {
    const url = String(input);
    stats.fetches.push({ url, body: init && init.body });
    let file;
    if (pageDir) {
      const rel = url.replace(/^https?:\/\/[^/]+\//, "").replace(/^\.\//, "").replace(/^\//, "");
      file = path.join(pageDir, decodeURIComponent(rel.split("?")[0]));
    } else {
      file = path.join(EXT, decodeURIComponent(url.replace(/^chrome-extension:\/\/[^/]+\//, "")));
    }
    const text = readFileMaybe(file);
    if (text === null) return { ok: false, status: 404, async text() { return "404"; }, async json() { throw new Error("no json"); } };
    return { ok: true, status: 200, async text() { return text; }, async json() { return JSON.parse(text); } };
  };
}

// ---------------------------------------------------------------- chrome stub（页面侧）
// 只实现 content.js 真正用到的接口。AI_CHAT 的回复由 aiReplies 队列/函数给出，
// 并把**完整的 payload** 记进 stats.aiCalls —— 本次功能要验证的正是 payload 内容
// （system prompt 措辞 + think 字段），所以必须原样留档，不能只留截断文本。
function makeChrome(storage, stats, opts) {
  const listeners = [];
  const aiReplies = Array.isArray(opts.aiReplies) ? opts.aiReplies.slice() : null;
  const nextReply = () => {
    if (aiReplies) return aiReplies.length ? aiReplies.shift() : (opts.aiFallback || { ok: true, text: "A" });
    if (typeof opts.aiReply === "function") return opts.aiReply(stats.aiCalls.length);
    if (opts.aiReply === null) return { ok: false, error: "未配置 API Key" };
    if (opts.aiReply === undefined) return { ok: true, text: "A" };
    // 对象 = 完整的后台应答（可带 reasoning 字段）；字符串 = 只给 text 的简写
    if (typeof opts.aiReply === "object") return opts.aiReply;
    return { ok: true, text: opts.aiReply };
  };
  return {
    __listeners: listeners,
    __fire(msg) { return listeners.map(fn => fn(msg, {}, () => {})); },
    runtime: {
      getManifest: () => MANIFEST,
      getURL: p => "chrome-extension://" + EXT_ID + "/" + String(p).replace(/^\//, ""),
      id: EXT_ID,
      onMessage: { addListener: fn => listeners.push(fn) },
      async sendMessage(msg) {
        if (!msg || !msg.type) return { ok: false, error: "bad message" };
        if (msg.type === "AI_CHAT") {
          stats.aiCalls.push({ payload: msg.payload, system: systemOf(msg.payload), think: !!(msg.payload && msg.payload.think) });
          return nextReply();
        }
        if (msg.type === "TEXT_CHAT") {
          stats.textCalls.push({ payload: msg.payload, system: systemOf(msg.payload), think: !!(msg.payload && msg.payload.think) });
          return nextReply();
        }
        // 白名单可由测试指定（默认放行全部，保持既有用例的行为不变）。
        // content.js 的台架 location 是 http://localhost:8080，所以要拦它填一个不含 localhost 的列表。
        if (msg.type === "GET_WHITELIST") return { ok: true, hosts: opts.whitelist || ["*"] };
        if (msg.type === "FETCH_BANK") {
          stats.bankFetches.push(msg.payload && msg.payload.url);
          return { ok: false, error: "no bank (shim)" };
        }
        return { ok: false, error: "stub: unknown " + msg.type };
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          const compute = () => {
            if (keys === undefined || keys === null) return { ...storage };
            if (typeof keys === "string") return keys in storage ? { [keys]: storage[keys] } : {};
            if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) if (k in storage) out[k] = storage[k];
              return out;
            }
            return { ...storage, ...keys };
          };
          if (typeof keys === "function") { keys({ ...storage }); return undefined; }
          if (typeof cb === "function") { cb(compute()); return undefined; }
          return Promise.resolve(compute());
        },
        set(obj) { Object.assign(storage, obj); return Promise.resolve(); },
        remove(k) { for (const key of [].concat(k)) delete storage[key]; return Promise.resolve(); }
      }
    },
    tabs: { query: async () => [], sendMessage: async () => ({ ok: false, error: "no tab" }) }
  };
}

// 从 payload 里取 system 消息文本（断言 prompt 措辞用）
function systemOf(payload) {
  const msgs = (payload && payload.messages) || [];
  const sys = msgs.find(m => m.role === "system");
  return sys ? String(sys.content || "") : "";
}

// ---------------------------------------------------------------- 环境
function makeEnv(opts = {}) {
  const stats = { fetches: [], bankFetches: [], aiCalls: [], textCalls: [], logs: [], errors: [] };
  const storage = Object.assign({ mode: "ai", aiKey: "sk-test", aiModel: "deepseek-chat", interval: "0" }, opts.storage || {});
  const html = opts.html || pageHtml(opts);
  const doc = dom.parseDocument(html);

  const timers = [];
  const sandbox = {};
  const win = {};
  sandbox.window = win;
  sandbox.self = win;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, {
    document: doc,
    console: {
      log: (...a) => stats.logs.push({ kind: "log", text: a.map(String).join(" ") }),
      warn: (...a) => stats.logs.push({ kind: "warn", text: a.map(String).join(" ") }),
      error: (...a) => stats.logs.push({ kind: "error", text: a.map(String).join(" ") }),
      info: (...a) => stats.logs.push({ kind: "info", text: a.map(String).join(" ") }),
    },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
    clearTimeout: t => clearTimeout(t),
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
    clearInterval: t => clearInterval(t),
    queueMicrotask,
    Promise, Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp, Error, TypeError,
    Map, Set, WeakSet, WeakMap, Symbol, Proxy, Reflect, Intl, Buffer,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone,
    alert: m => stats.logs.push({ kind: "alert", text: String(m) }),
    confirm: () => true,
    prompt: () => null,
    navigator: { userAgent: "NodeShim/1.0", language: "zh-CN" },
    location: new URL("http://localhost:8080/index.html"),
    Event: dom.ShimEvent,
    CustomEvent: dom.ShimEvent,
    // Node.DOCUMENT_POSITION_* 是标准常量，真实浏览器里一定存在。
    // 而 reviews 里那份最小 DOM 实现**没有**定义它们，于是 content.js 的
    // `pos & Node.DOCUMENT_POSITION_FOLLOWING` 变成 `pos & undefined === 0`，
    // 卡片排序比较器恒返回 0 —— 排序在台架里是 no-op，
    // 导致"卡片顺序 == 页面题目顺序"这类断言静默失效（verifier2 发现）。
    // 这里按 DOM 规范补上（只加常量，不动实现）。
    Node: Object.assign(dom.Node, {
      ELEMENT_NODE: 1,
      TEXT_NODE: 3,
      DOCUMENT_NODE: 9,
      DOCUMENT_POSITION_DISCONNECTED: 1,
      DOCUMENT_POSITION_PRECEDING: 2,
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_CONTAINS: 8,
      DOCUMENT_POSITION_CONTAINED_BY: 16,
      DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
    }),
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    CSS: { escape: s => String(s).replace(/[^\w-]/g, c => "\\" + c) },
    HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    getComputedStyle: dom.getComputedStyle,
    chrome: makeChrome(storage, stats, opts),
  });
  sandbox.fetch = makeFetch(stats, opts.pageDir);
  Object.assign(win, sandbox);
  win.innerWidth = 1280;
  win.innerHeight = 800;
  win.scrollTo = () => {};
  win.scrollY = 0;
  win.addEventListener = (t, f) => doc.addEventListener(t, f);
  win.removeEventListener = (t, f) => doc.removeEventListener(t, f);
  win.dispatchEvent = e => doc.dispatchEvent(e);
  win.document = doc;
  win.location = sandbox.location;
  win.chrome = sandbox.chrome;
  win.performance = sandbox.performance;
  win.setTimeout = sandbox.setTimeout;
  win.clearTimeout = sandbox.clearTimeout;
  win.fetch = sandbox.fetch;
  doc.defaultView = win;

  const ctx = vm.createContext(sandbox);
  function runScript(code, name) {
    try { vm.runInContext(code, ctx, { filename: name, displayErrors: true }); }
    catch (e) { stats.errors.push({ name, error: String((e && e.stack) || e) }); throw e; }
  }

  const api = {
    sandbox, win, doc, stats, storage, ctx, runScript,
    injectContent() {
      runScript(fs.readFileSync(path.join(EXT, "content.js"), "utf8"), "content.js");
      return api;
    },
    // 跑页面自己的内联 <script>（真实练习页靠它渲染题目）。
    // 必须在 injectContent 之前调用，否则插件扫描时页面还是空的。
    runInlineScripts() {
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      const html = opts.html || "";
      let m, i = 0;
      while ((m = re.exec(html))) runScript(m[1], "page-inline-" + (i++) + ".js");
      return api;
    },
    startScan() { return sandbox.chrome.__fire({ type: "START_SCAN" }); },
    start(settings) { return sandbox.chrome.__fire({ type: "START", settings: Object.assign({}, storage, settings) }); },
    stop() { return sandbox.chrome.__fire({ type: "STOP" }); },
    panel() { return doc.querySelector(".aa-panel"); },
    cards() { return [...doc.querySelectorAll(".aa-card")]; },
    // 卡片上的可见文本（答案/解析/思考分块）
    cardParts() {
      return api.cards().map(c => ({
        answer: (c.querySelector(".aa-answer") || {}).textContent || "",
        answerShown: !!c.querySelector(".aa-answer") && c.querySelector(".aa-answer").style.display === "block",
        explain: (c.querySelector(".aa-explain") || {}).textContent || "",
        explainShown: !!c.querySelector(".aa-explain") && c.querySelector(".aa-explain").style.display === "block",
        think: (c.querySelector(".aa-think") || {}).textContent || "",
        thinkShown: !!c.querySelector(".aa-think") && c.querySelector(".aa-think").style.display === "block",
      }));
    },
    // 页面上的勾选状态
    checked() {
      return [...doc.querySelectorAll(".question")].map(q => ({
        stem: ((q.querySelector(".q-stem") || {}).textContent || "").trim(),
        idx: [...q.querySelectorAll(".opt input")].map((inp, i) => (inp.checked ? i : -1)).filter(i => i >= 0),
      }));
    },
    blanks() {
      return [...doc.querySelectorAll("input.blank-input")].map(i => i.value);
    },
    // 点卡片上的「答」（第 n 张）
    async clickAnswer(n) {
      const btns = [...api.cards()[n].querySelectorAll("button")].filter(b => b.textContent === "答");
      btns[0].click();
      await sleep(120);
    },
    async clickAllAnswers() {
      const btn = [...api.panel().querySelectorAll("button")].find(b => /出答案/.test(b.textContent));
      btn.click();
      for (let i = 0; i < 120; i++) {
        await sleep(50);
        if (!/停止/.test(btn.textContent)) break;
      }
      await sleep(120);
    },
    logText() { const el = doc.getElementById("aa-log"); return el ? el.textContent : ""; },
    errors() { return stats.errors.concat(stats.logs.filter(l => l.kind === "error").map(l => ({ name: "console.error", error: l.text }))); },
  };
  return api;
}

// ---------------------------------------------------------------- 后台沙箱的标准全局
// background.js 跑在 MV3 service worker 里，测试要在 vm 里给它一套"浏览器全局"。
// 以前 env.js、postchat-timeout-test.js、vision-fix-test.js 各写了一份清单，
// 产品里每多用一个标准全局就得改三处 —— 后台用了 setInterval 推心跳那次，
// 就是两处漏注入同时报 "setInterval is not defined"（看着像产品崩了，其实是台架缺口）。
// 收拢到这里，只维护一份；各测试再用 Object.assign 覆盖自己要改的部分（如假定时器）。
function bgGlobals() {
  return {
    console: { log() {}, warn() {}, error() {}, info() {} },
    AbortSignal, AbortController, Blob, atob, btoa, Uint8Array,
    JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp,
    Error, TypeError, Promise, Map, Set, Symbol,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    // 截图链路要的两个图像 API：service worker 里没有真实 DOM，只能桩
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    OffscreenCanvas: class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { arrayBuffer: async () => new ArrayBuffer(4) }; }
    },
  };
}

// ---------------------------------------------------------------- 后台 background.js 的真实逻辑
// background.js 是 MV3 service worker：顶层调用 chrome.runtime.onMessage.addListener，
// 所有 handler 都在监听器内部。这里给它一个最小 chrome + fetch 环境后 eval，
// 就能用真实代码验证「思考模式字段透传」与「平台不支持时自动降级重发」。
function makeBackground({ fetchImpl, storage = {} } = {}) {
  const calls = [];
  const replies = [];
  let listener = null;
  const chromeStub = {
    runtime: {
      id: EXT_ID,
      onMessage: { addListener: fn => { listener = fn; } },
      getURL: p => "chrome-extension://" + EXT_ID + "/" + p,
    },
    storage: { local: { get: async keys => {
      if (typeof keys === "string") return keys in storage ? { [keys]: storage[keys] } : {};
      if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (k in storage) o[k] = storage[k]; return o; }
      return { ...storage };
    } } },
    tabs: {
      captureVisibleTab: async () => "data:image/jpeg;base64,AAAA",
      // 截图解题路径的结果是靠 tabs.sendMessage 回给页面的，
      // 记下来测试才能断言"思考模式在截图路径上也生效了"
      sendMessage: async (tabId, payload) => { replies.push(payload); },
    },
  };
  const sandbox = {
    // AbortController/AbortSignal、setInterval 等都是 Chrome 的标准全局
    // （MV3 service worker 里一定有）；清单在 bgGlobals() 里统一维护，
    // 缺一个就会报成 "xxx is not defined" —— 那是台架缺口，不是产品问题。
    chrome: chromeStub,
    fetch: async (url, init) => {
      calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
      return fetchImpl(url, init, calls.length);
    },
  };
  Object.assign(sandbox, bgGlobals());
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), sandbox, { filename: "background.js" });

  return {
    calls,
    replies,   // 后台通过 tabs.sendMessage 推给页面的消息（截图解题的进度与结果）
    // 模拟真实 chrome.runtime.sendMessage 的"回调式"应答：返回 Promise，值即 sendResponse 的内容
    send(msg, sender) {
      return new Promise((resolve, reject) => {
        const keepAlive = listener(msg, Object.assign({ id: EXT_ID, tab: { id: 1, windowId: 1 }, frameId: 0 }, sender || {}), resolve);
        // 监听器返回 true 表示异步应答；不返回且没有同步 resolve 时视为无响应
        if (!keepAlive) setTimeout(() => resolve(undefined), 0);
        setTimeout(() => reject(new Error("sendMessage 超时：后台没有调用 sendResponse")), 4000).unref?.();
      });
    },
  };
}

module.exports = { makeEnv, makeBackground, bgGlobals, pageHtml, systemOf, sleep, EXT, ROOT, EXT_ID, MANIFEST, dom };
