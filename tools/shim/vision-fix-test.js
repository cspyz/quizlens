/**
 * 截图解题的两处修复回归（纯 Node，秒级）
 *
 * 修复 1（content.js）：前端超时闸门从"总共 30 秒"改成"30 秒没动静"。
 *   旧行为：固定 30s 总闸门，而后台预算 60s/120s → 慢模型先弹"超时"、答案后到。
 *   且旧注释以为"推进度能拦住闸门"，实际进度消息 ok:null 不会重置 resultToken。
 *   新行为：每收到一条进度/结果就重置计时；只有整整 30 秒毫无音讯才报超时。
 *
 * 修复 2（background.js）：未填「视觉模型」时不再悄悄回退到 aiModel。
 *   旧行为：visionModel 空 → 用 aiModel（默认 deepseek-chat）→ 400 接口原文。
 *   新行为：直接给一句中文提示，告诉用户去哪填、填什么。
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const T = require("./env");        // 只为 bgGlobals()：后台沙箱的全局清单共用一份

const BG = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");
const CJ = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "content.js"), "utf8");

let PASS = 0, FAIL = 0;
const t = (n, ok, got) => { if (ok) { PASS++; console.log("PASS  " + n + (got !== undefined ? "  got=" + JSON.stringify(got) : "")); } else { FAIL++; console.log("FAIL  " + n + (got !== undefined ? "  got=" + JSON.stringify(got) : "")); } };

// ============ 修复 2：后台视觉模型守卫 ============
function runBg(storage, fetchImpl) {
  const replies = []; const sent = []; let listener = null;
  // 后台沙箱的浏览器全局取自 env.js 的 bgGlobals()（只维护一份），这里只给自己要的
  // chrome 桩与抓请求的 fetch。
  const sandbox = Object.assign(T.bgGlobals(), {
    chrome: {
      runtime: { id: "ext", getURL: p => p, onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: async keys => {
        if (typeof keys === "string") return keys in storage ? { [keys]: storage[keys] } : {};
        if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (k in storage) o[k] = storage[k]; return o; }
        return { ...storage };
      } } },
      tabs: { captureVisibleTab: async () => "data:image/jpeg;base64,AAAA", sendMessage: async (i, p) => { replies.push(p); } }
    },
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return fetchImpl(JSON.parse(init.body)); },
  });
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BG, sandbox, { filename: "background.js" });
  listener({ type: "REGION_SELECTED", rect: { left: 0, top: 0, width: 10, height: 10 }, vw: 100 },
           { id: "ext", tab: { id: 1, windowId: 1 }, frameId: 0 }, () => {});
  return { replies, sent };
}
const okFetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "1. B" } }] }); } });

(async () => {
  // --- 2a: 未填视觉模型 → 不调接口，直接给中文提示 ---
  {
    const { replies, sent } = runBg({ aiKey: "k", aiBaseUrl: "http://x", aiModel: "deepseek-chat", visionModel: "", answerMode: "standard" }, okFetch);
    await new Promise(r => setTimeout(r, 300));
    const final = replies.filter(r => r.type === "ANSWER" && r.ok === false).pop();
    t("2a 未填视觉模型时不再把图发给 aiModel（零请求）", sent.length === 0, { fetches: sent.length });
    t("2a 给出中文提示且点名「视觉模型」", !!final && /视觉模型/.test(final.text), final && final.text.slice(0, 40));
    t("2a 提示里给了可照做的例子 glm-4v-flash", !!final && /glm-4v-flash/.test(final.text), final && /glm-4v-flash/.test(final.text));
    t("2a 不再出现接口原文式的英文报错", !!final && !/invalid type|deserialize/i.test(final.text), final && final.text.slice(0, 50));
  }

  // --- 2b: 填了视觉模型 → 正常发图并成功 ---
  {
    const { replies, sent } = runBg({ aiKey: "k", aiBaseUrl: "http://x", aiModel: "deepseek-chat", visionModel: "glm-4v-flash", answerMode: "standard" }, okFetch);
    await new Promise(r => setTimeout(r, 300));
    t("2b 填了视觉模型就走它", sent[0] && sent[0].model === "glm-4v-flash", sent[0] && sent[0].model);
    t("2b 图片按 image_url 发出", sent[0] && sent[0].messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url")), true);
    const ok = replies.filter(r => r.type === "ANSWER" && r.ok === true).pop();
    t("2b 成功返回答案", !!ok && ok.text === "1. B", ok && ok.text);
  }

  // --- 2c: visionModel 只有空白字符也算未填 ---
  {
    const { sent, replies } = runBg({ aiKey: "k", aiBaseUrl: "http://x", aiModel: "deepseek-chat", visionModel: "   ", answerMode: "standard" }, okFetch);
    await new Promise(r => setTimeout(r, 300));
    t("2c 纯空白的 visionModel 视为未填（零请求 + 提示）",
      sent.length === 0 && replies.some(r => r.type === "ANSWER" && r.ok === false && /视觉模型/.test(r.text)),
      { fetches: sent.length });
  }

  // ============ 修复 1：看门狗语义（在 vm 里跑真实 content.js 的相关片段）============
  // 直接跑整个 content.js 需要 DOM 台架；这里改为把它的看门狗逻辑逐字复刻并断言语义，
  // 同时用源码断言确保实现与测试同步（避免"改了产品没改测试"）。
  t("1a 源码里不再有固定的 30000 总闸门 setTimeout（已换成看门狗）",
    !/\}, 30000\);\s*\n\s*chrome\.runtime\.sendMessage\(\{ type: "REGION_SELECTED"/.test(CJ),
    "checked");
  t("1b 存在 armVisionWatchdog 且用 VISION_IDLE_MS", /function armVisionWatchdog/.test(CJ) && /VISION_IDLE_MS = 30000/.test(CJ), "checked");
  t("1c 进度消息会重置看门狗（showAnswerResult 的 else 分支）",
    /\} else if \(visionWatchdog\) \{[\s\S]{0,200}armVisionWatchdog\(resultToken, VISION_IDLE_MS\)/.test(CJ), "checked");
  t("1d cleanupAll 会撤掉看门狗（关窗后不再弹超时）",
    /function cleanupAll\(\) \{[\s\S]{0,300}clearTimeout\(visionWatchdog\)/.test(CJ), "checked");

  // 逐字复刻新语义，验证行为
  {
    let resultToken = 0, watchdog = null, now = 0;
    const shown = [];
    const IDLE = 30000;
    const clearW = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    function arm(token, ms) {
      clearW();
      watchdog = { fireAt: now + ms, fn() { if (token !== resultToken) return; showAnswerResult({ ok: false, text: "⏰ 超时（30 秒没有任何响应）未收到结果。" }); } };
    }
    function showAnswerResult(msg) {
      if (msg.ok === true || msg.ok === false) { resultToken++; clearW(); }
      else if (watchdog) { arm(resultToken, IDLE); }
      shown.push({ at: now, ok: msg.ok, text: msg.text });
    }
    function advanceTo(ms, events) {
      for (const e of (events || []).sort((a, b) => a.at - b.at)) { now = e.at; e.fn(); }
      now = ms;
      if (watchdog && now >= watchdog.fireAt) { const w = watchdog; watchdog = null; w.fn(); }
    }

    // 场景：模型 35 秒返回，期间每 8 秒一条进度 —— 旧实现会误报，新实现不该报
    resultToken = 0; watchdog = null; now = 0; shown.length = 0;
    showAnswerResult({ ok: null, text: "⏳ 识别中，请稍候…" });
    const tok = ++resultToken;
    arm(tok, IDLE);
    advanceTo(35000, [
      { at: 8000,  fn: () => showAnswerResult({ ok: null, text: "✓ 已截屏，正在裁剪…" }) },
      { at: 16000, fn: () => showAnswerResult({ ok: null, text: "✓ 已裁剪，正在请求模型…" }) },
      { at: 24000, fn: () => showAnswerResult({ ok: null, text: "…仍在等待模型" }) },
      { at: 35000, fn: () => showAnswerResult({ ok: true, text: "1. B" }) },
    ]);
    const texts = shown.map(s => s.text);
    t("1e 慢模型(35s)且有进度：不再误报超时", !texts.some(x => /超时/.test(x)), texts);
    t("1f 慢模型(35s)：最终拿到答案", texts[texts.length - 1] === "1. B", texts[texts.length - 1]);

    // 场景：后台真卡死（无任何进度）→ 30 秒后应报超时
    resultToken = 0; watchdog = null; now = 0; shown.length = 0;
    showAnswerResult({ ok: null, text: "⏳ 识别中，请稍候…" });
    const tok2 = ++resultToken;
    arm(tok2, IDLE);
    advanceTo(30000, []);
    t("1g 后台毫无音讯时仍会报超时（没有把保护整个丢掉）",
      shown.some(s => s.ok === false && /超时/.test(s.text)), shown.map(s => s.text));

    // 场景：思考模式 120 秒预算，只要一直在推进度就不该报
    resultToken = 0; watchdog = null; now = 0; shown.length = 0;
    showAnswerResult({ ok: null, text: "⏳ 识别中，请稍候…" });
    const tok3 = ++resultToken;
    arm(tok3, IDLE);
    const evs = [];
    for (let s = 25000; s <= 110000; s += 25000) evs.push({ at: s, fn: () => showAnswerResult({ ok: null, text: "…进行中" }) });
    evs.push({ at: 115000, fn: () => showAnswerResult({ ok: true, text: "1. C" }) });
    advanceTo(115000, evs);
    t("1h 思考模式(115s)持续有进度：全程不报超时并拿到答案",
      !shown.some(s => /超时/.test(s.text)) && shown[shown.length - 1].text === "1. C",
      shown.map(s => s.text));
  }

  console.log("\n===== " + (FAIL === 0 ? "ALL PASS ✅" : "FAILED ❌") + " (" + PASS + " pass / " + FAIL + " fail) =====");
  process.exit(FAIL === 0 ? 0 : 1);
})();
