const $ = id => document.getElementById(id);

// ============================================================
// 首次使用：一次性「使用边界」确认（无计时）
// ============================================================
//
// 旧版是「阅读说明书满 20 秒」的强制门禁。它量的是墙上时钟而不是阅读，
// 放着不动也会通过；而 background / content 从不检查 docReadAt，
// 面板里的「出答案」「填涂」根本不经过它 —— 只挡 UI，不挡功能。
// 现在改成一次勾选确认：没有计时器，也就没有计时器的 bug。
const ACK_KEY = "boundaryAckAt";
const ACK_TEXT =
  "本插件是练习 / 自测辅助工具，不是考试工具。\n\n" +
  "· 只要这一份作答会被打分、被记录、被当作证据，或需要证明是你本人独立完成的，就不要用；\n" +
  "· 正式考试、在线测评、监考环境请勿使用；\n" +
  "· 是否合规由你所在院校的规定与平台服务条款决定，插件无从判断，作者也不代为判断；\n" +
  "· 使用产生的后果由使用者自行承担；\n" +
  "· 插件不会、也不能替你交卷 —— 提交按钮始终由你本人点击。\n\n" +
  "完整条款见「免责声明」（仓库 DISCLAIMER.md）。";

// getURL() 会把 "/" 编码成 %2F 导致 ERR_FILE_NOT_FOUND，所以手动拼
function openExtDoc(page) {
  chrome.tabs.create({ url: "chrome-extension://" + chrome.runtime.id + "/docs/" + page });
}

async function ensureBoundaryAck() {
  const acked = await new Promise(r =>
    chrome.storage.local.get([ACK_KEY], st => r(!!(st && st[ACK_KEY]))));
  if (acked) return true;
  showAck(true);
  return await new Promise(resolve => { pendingResolve = resolve; });
}

let pendingResolve = null;

function showAck(on) {
  const el = $("ackGate");
  const body = document.querySelector(".body");
  if (!el) return;
  el.style.display = on ? "flex" : "none";
  if (on) {
    // 每次打开都从零开始：否则上次「取消」时留着的勾会让「确认并开始」
    // 看起来该是可点的，而它其实还锁着（实测踩过）。
    const chk = $("ackChk"), yes = $("ackYes");
    if (chk) chk.checked = false;
    if (yes) yes.disabled = true;
  }
  if (body) {
    body.style.opacity = on ? "0.35" : "";
    body.style.pointerEvents = on ? "none" : "";
  }
}

function settleAck(v) {
  const r = pendingResolve;
  pendingResolve = null;
  if (r) r(v);
}

function initAckFlow() {
  const chk = $("ackChk"), yes = $("ackYes"), no = $("ackNo"), open = $("ackOpen");
  if (!chk || !yes) return;
  open.addEventListener("click", () => openExtDoc("user-guide.html"));
  const ackD = $("ackDisclaimer");
  if (ackD) ackD.addEventListener("click", e => { e.preventDefault(); openExtDoc("disclaimer.html"); });
  chk.addEventListener("change", () => { yes.disabled = !chk.checked; });
  yes.addEventListener("click", () => {
    chrome.storage.local.set({ [ACK_KEY]: Date.now() }, () => {
      showAck(false);
      settleAck(true);
    });
  });
  no.addEventListener("click", () => { showAck(false); settleAck(false); });
}

function bindHelpDisclaimerLink() {
  const el = $("docDisclaimer");
  if (!el) return;
  el.addEventListener("click", e => { e.preventDefault(); openExtDoc("disclaimer.html"); });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initAckFlow(); bindHelpDisclaimerLink(); });
} else {
  initAckFlow();
  bindHelpDisclaimerLink();
}
const FIELDS = ["mode", "answerMode", "showLog", "overwriteSelected", "interval", "fuzzyThreshold", "concurrency", "concurrentEnabled",
  "aiBaseUrl", "aiKey", "aiModel", "visionModel", "visionBaseUrl", "visionKey", "bankBaseUrl"];

// 输出模式：AI 回答里到底给多少内容。
//   answer   - 只输出答案，不要解析（最省 token，答错看不出原因）
//   standard - 答案 + 简明解析，不开思考模式（默认；用户明确要求默认不带思考）
//   full     - 完整功能：思考模式 + 详细解析
// 这个值会被 content.js 读去决定 system prompt 与 reasoning_effort，
// 拼错一个字母就等于静默退回默认行为，所以这里集中定义 + 校验。
const ANSWER_MODES = ["answer", "standard", "full"];
const ANSWER_MODE_DEFAULT = "standard";
const normAnswerMode = v => (ANSWER_MODES.includes(v) ? v : ANSWER_MODE_DEFAULT);

// 模糊阈值：与 content.js 的 thresholdFraction 同一套规则（两处必须一致）。
//   ≤1 当小数（0.8 → 80%），>1 当百分数（80 → 80%），结果夹在 50~95。
// 存进 storage 的一直是**百分数**，content.js 读出来再 /100。
const normThresholdPct = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 75;
  const pct = n <= 1 ? n * 100 : n;
  return Math.min(95, Math.max(50, Math.round(pct)));
};

// 载入已保存的配置（白名单在插件目录 whitelist.txt 配置）
chrome.storage.local.get(FIELDS, cfg => {
  if (cfg.mode) $("mode").value = cfg.mode;
  // 存储里没有的值 / 被手改成乱七八糟的值，必须落回默认，
  // 否则 select.value = "xxx" 会让三个选项一个都不选中（界面空白）
  $("answerMode").value = normAnswerMode(cfg.answerMode);
  // 运行日志面板：默认关（老配置里没有这个 key 时也必须是关，不能因为"undefined 是假值"
  // 之类的巧合而变成开——显式写出来，行为才好预测）
  $("showLog").checked = cfg.showLog === true;
  // 覆盖已选答案：默认关（保留页面上已有的选择）
  $("overwriteSelected").checked = cfg.overwriteSelected === true;
  if (cfg.interval !== undefined) $("interval").value = cfg.interval;
  if (cfg.fuzzyThreshold !== undefined) $("fuzzyThreshold").value = cfg.fuzzyThreshold;
  if (cfg.concurrency !== undefined) $("concurrency").value = cfg.concurrency;
  // 并发开关：配置里没有这个字段时按"开"处理（不能因为 undefined 是假值就默认关掉）
  $("concurrentEnabled").checked = cfg.concurrentEnabled !== false;
  $("concurrencyRow").style.display = $("concurrentEnabled").checked ? "" : "none";
  if (cfg.aiBaseUrl) $("aiBaseUrl").value = cfg.aiBaseUrl;
  if (cfg.aiKey) $("aiKey").value = cfg.aiKey;
  if (cfg.aiModel) $("aiModel").value = cfg.aiModel;
  if (cfg.visionModel) $("visionModel").value = cfg.visionModel;
  if (cfg.visionBaseUrl) $("visionBaseUrl").value = cfg.visionBaseUrl;
  if (cfg.visionKey) $("visionKey").value = cfg.visionKey;
  if (cfg.bankBaseUrl) $("bankBaseUrl").value = cfg.bankBaseUrl;
  // 视觉代理控件（分段按钮 / 滑杆）在配置载入后同步一次
  document.dispatchEvent(new Event("aa-settings-ready"));
});

// 改了就存。所有配置字段（Key / Base URL / 模型 / 视觉模型 / 阈值 / 间隔 / 模式）
// 都在输入时即时落盘；否则用户填完 API Key 直接关弹窗，配置一个字都没保存，
// 下次打开还是空的，而且面板的「填涂」走 storage 读设置，读到的就是过期值。
// 文本框的 change 在失焦时触发，下拉/复选框在切换时触发，覆盖所有正常编辑路径。
FIELDS.forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => { collectSettings(); });
  // 数字/文本框：改了但没失焦就点 ✕ 关掉弹窗时 change 不会触发，blur 兜一层
  if (el.tagName === "INPUT" && el.type !== "checkbox") {
    el.addEventListener("blur", () => { collectSettings(); });
  }
});

// 从表单读配置并落盘。字段列表只在这里维护，避免各入口各写一份、漏字段。
async function collectSettings() {
  const settings = {
    mode: $("mode").value,
    answerMode: normAnswerMode($("answerMode").value),
    showLog: $("showLog").checked,
    overwriteSelected: $("overwriteSelected").checked,
    interval: $("interval").value,
    intervalMs: Math.max(0, Number($("interval").value) || 0) * 1000,
    fuzzyThreshold: normThresholdPct($("fuzzyThreshold").value),
    concurrency: Math.max(1, Math.min(5, Number($("concurrency").value) || 3)),
    concurrentEnabled: $("concurrentEnabled").checked,
    aiBaseUrl: $("aiBaseUrl").value.trim() || "https://api.deepseek.com",
    aiKey: $("aiKey").value.trim(),
    aiModel: $("aiModel").value.trim() || "deepseek-chat",
    visionModel: $("visionModel").value.trim(),
    // 视觉模型经常和文本模型不同家 → 独立的地址与 Key；留空时后台回退到上面那套
    visionBaseUrl: $("visionBaseUrl").value.trim(),
    visionKey: $("visionKey").value.trim(),
    bankBaseUrl: $("bankBaseUrl").value.trim()
  };
  // 直接把 settings 写进去。字段清单只保留上面这一份：
  // 再手写一份逐字重复的清单必然会漏字段，新加的 visionBaseUrl / visionKey 就是例子。
  await chrome.storage.local.set(settings);
  return settings;
}

// 把消息发给当前标签页。发失败（比如页面是 chrome://、file:// 或还没注入
// content script）不能静默吞掉，否则用户点了按钮什么都没发生也不知道为什么 ——
// 按标签页类型给不同提示，尤其是最常见的本地文件。
// frameId:0 = 只发给主框架。content script 现在 all_frames:false，不带 frameId
// 时消息会广播，若页面里有同源 iframe 可能收到多份。
async function sendToActiveTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) { alert("找不到当前标签页"); return; }
  const url = String(tab.url || "");
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch (e) {
    if (/^file:\/\//i.test(url)) {
      alert("没能和页面通信：当前是本地文件（file://）。\n\n" +
        "浏览器不会把扩展脚本注入 file:// 页面，所以插件看不到这个页面。\n" +
        "请通过 http:// 或 https:// 地址打开这个页面，再试。");
      return;
    }
    if (/^(chrome|edge|about|chrome-extension|moz-extension):\/\//i.test(url) ||
        /chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons/i.test(url)) {
      alert("没能和页面通信：当前是浏览器内置页或扩展页面，扩展脚本不会注入。\n" +
        "请先切回要答题的网页标签，再点扩展图标。");
      return;
    }
    alert("没能和页面通信：" + e.message +
      "\n\n页面可能是扩展安装/重载前打开的，刷新一下再试。\n" +
      "如果还不行，确认扩展已启用，且页面不是 file:// 或浏览器内置页。");
  }
}

$("start").addEventListener("click", async () => {
  if (!(await ensureBoundaryAck())) return;
  const settings = await collectSettings();
  await sendToActiveTab({ type: "START", settings });
  window.close();
});

$("stop").addEventListener("click", async () => {
  await sendToActiveTab({ type: "STOP" });
  window.close();
});

$("startScan").addEventListener("click", async () => {
  if (!(await ensureBoundaryAck())) return;
  // 面板里的「✍ 填涂」要读这些配置来找答案，所以扫描模式也要把配置存下来
  await collectSettings();
  await sendToActiveTab({ type: "START_SCAN" });
  window.close();
});

// 测试连接：填完 Base URL / Key / 模型先打一次 /models，别等答题时才发现配错
$("testConn").addEventListener("click", async () => {
  const btn = $("testConn");
  const baseUrl = $("aiBaseUrl").value.trim();
  const key = $("aiKey").value.trim();
  if (!baseUrl) { alert("请先填写 Base URL"); return; }
  btn.textContent = "测试中…";
  btn.disabled = true;
  const reply = await chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: { baseUrl, key } });
  btn.textContent = "测试连接";
  btn.disabled = false;
  if (!reply || !reply.ok) {
    alert("❌ 连接失败：" + (reply?.error || "后台无响应") +
      "\n\n检查：Base URL 是否以 /v1 结尾（如 https://api.deepseek.com/v1）、Key 是否有效、网络是否可达。");
    return;
  }
  const want = $("aiModel").value.trim();
  if (!reply.models.length) {
    alert("✅ 能连上，但平台没返回模型列表（有些平台不提供 /models）。手动填模型名即可。");
  } else if (want && !reply.models.includes(want)) {
    alert(`⚠ 能连上，但模型列表里没有「${want}」。\n\n可用的有：` +
      reply.models.slice(0, 12).join("、") + (reply.models.length > 12 ? " …" : "") +
      "\n点「拉取模型」可以挑选。");
  } else {
    alert(`✅ 连接正常，平台共 ${reply.models.length} 个模型。`);
  }
});

// ---------- 模型列表拉取 + 过滤选择 ----------
let allModels = [];

$("fetchModels").addEventListener("click", async () => {
  const baseUrl = $("aiBaseUrl").value.trim();
  if (!baseUrl) { alert("请先填写 Base URL"); return; }
  const btn = $("fetchModels");
  btn.textContent = "拉取中…";
  btn.disabled = true;

  const reply = await chrome.runtime.sendMessage({
    type: "LIST_MODELS",
    payload: { baseUrl, key: $("aiKey").value.trim() }
  });

  btn.textContent = "拉取模型";
  btn.disabled = false;

  if (!reply || !reply.ok) {
    alert("拉取失败：" + (reply?.error || "后台无响应"));
    return;
  }
  if (!reply.models.length) {
    alert("平台返回了空列表（有些平台不提供 /models 接口，请手动填模型名）");
    return;
  }
  allModels = reply.models;
  $("modelPicker").style.display = "block";
  $("modelSearch").value = "";
  renderModelList("");
  $("modelSearch").focus();
});

function renderModelList(filter) {
  const kw = filter.trim().toLowerCase();
  const hits = kw ? allModels.filter(m => m.toLowerCase().includes(kw)) : allModels;
  const list = $("modelList");
  list.innerHTML = "";

  const info = document.createElement("div");
  info.style.cssText = "padding:4px 10px;font-size:11px;color:var(--c-ink-4)";
  info.textContent = `${hits.length} / ${allModels.length} 个模型`;
  list.appendChild(info);

  hits.slice(0, 100).forEach(id => {
    const item = document.createElement("div");
    item.textContent = id;
    item.style.cssText = "padding:6px 10px;font-size:12px;cursor:pointer;" +
      "font-family:var(--font-mono);border-bottom:1px solid var(--c-line)";
    item.addEventListener("mouseenter", () => item.style.background = "var(--c-accent-soft)");
    item.addEventListener("mouseleave", () => item.style.background = "");
    item.addEventListener("click", () => {
      $("aiModel").value = id;
      chrome.storage.local.set({ aiModel: id });
      $("modelPicker").style.display = "none";
    });
    list.appendChild(item);
  });
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:8px 10px;font-size:12px;color:var(--c-ink-4)";
    empty.textContent = "没有匹配的模型";
    list.appendChild(empty);
  }
}

$("modelSearch").addEventListener("input", e => renderModelList(e.target.value));

// 并发开关：勾上才显示"并发数"，并立刻落盘（用户可能直接关掉弹窗，不点「开始答题」）
$("concurrentEnabled").addEventListener("change", e => {
  const on = e.target.checked;
  $("concurrencyRow").style.display = on ? "" : "none";
  chrome.storage.local.set({ concurrentEnabled: on });
});

// ---------- 视觉代理：标签页 / 分段 / 步进 / 滑杆 / 站点状态 ----------
// 原生 select / number / checkbox 仍是唯一数据源；这里只把点击映射回去，
// collectSettings / storage 读写逻辑完全不变。
try { $("extVersion").textContent = "v" + chrome.runtime.getManifest().version; } catch (_) {}

const syncSegments = () => {
  document.querySelectorAll(".aa-seg[data-select]").forEach(seg => {
    const sel = $(seg.dataset.select);
    if (!sel) return;
    seg.querySelectorAll("button[data-value]").forEach(btn => {
      btn.setAttribute("aria-pressed", String(btn.dataset.value === sel.value));
    });
  });
};

document.querySelectorAll(".aa-seg[data-select]").forEach(seg => {
  const sel = $(seg.dataset.select);
  if (!sel) return;
  seg.querySelectorAll("button[data-value]").forEach(btn => {
    btn.addEventListener("click", () => {
      sel.value = btn.dataset.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      syncSegments();
    });
  });
  sel.addEventListener("change", syncSegments);
});
syncSegments();

document.querySelectorAll(".aa-tabs button[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    document.querySelectorAll(".aa-tabs button[data-tab]").forEach(b => {
      b.setAttribute("aria-selected", String(b === btn));
    });
    document.querySelectorAll(".aa-tabpanel[data-panel]").forEach(p => {
      p.hidden = p.dataset.panel !== name;
    });
    document.querySelector(".aa-pop-body").scrollTop = 0;
  });
});

document.querySelectorAll(".aa-stepper").forEach(st => {
  const input = st.querySelector('input[type="number"]');
  if (!input) return;
  const step = Number(st.dataset.step) || 1;
  st.querySelectorAll("button[data-dir]").forEach(btn => {
    btn.addEventListener("click", () => {
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const dir = Number(btn.dataset.dir) || 0;
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = 0;
      v = Math.min(max, Math.max(min, Math.round((v + dir * step) * 100) / 100));
      input.value = String(v);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
});

const thresholdRange = $("fuzzyThresholdRange");
const thresholdNum = $("fuzzyThreshold");
function thresholdPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 75;
  return Math.min(95, Math.max(50, Math.round(n <= 1 ? n * 100 : n)));
}
function syncRangeFromNumber() {
  if (!thresholdRange || !thresholdNum) return;
  thresholdRange.value = String(thresholdPct(thresholdNum.value));
}
if (thresholdRange && thresholdNum) {
  thresholdNum.addEventListener("input", syncRangeFromNumber);
  thresholdNum.addEventListener("change", syncRangeFromNumber);
  thresholdRange.addEventListener("input", () => {
    thresholdNum.value = thresholdRange.value;
    thresholdNum.dispatchEvent(new Event("change", { bubbles: true }));
  });
  syncRangeFromNumber();
}

document.addEventListener("aa-settings-ready", () => {
  syncSegments();
  syncRangeFromNumber();
});

function setSiteState(text, badgeKind, dotKind) {
  const badge = $("siteState");
  if (badge) {
    badge.textContent = text;
    badge.className = "aa-badge " + badgeKind;
    badge.title = text === "未连接"
      ? "当前页面没有连接上扩展脚本。如果是刚重载扩展，请刷新页面后再试。"
      : text === "需 HTTP 打开"
        ? "浏览器不会把扩展脚本注入 file:// 页面；请用本地 HTTP 服务打开。"
        : "";
  }
  const dot = $("siteDot");
  if (dot) dot.className = "aa-dot" + (dotKind ? " " + dotKind : "");
}

async function initSiteCard() {
  const hostEl = $("siteHost");
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {}
  const url = String((tab && tab.url) || "");
  if (/^file:\/\//i.test(url)) {
    if (hostEl) hostEl.textContent = "本地文件（file://）";
    setSiteState("需 HTTP 打开", "warn", "warn");
    return;
  }
  if (!tab) {
    if (hostEl) hostEl.textContent = "当前标签页";
    setSiteState("未连接", "muted", "bad");
    return;
  }
  if (/^(chrome|edge|about|chrome-extension|moz-extension):\/\//i.test(url)) {
    if (hostEl) hostEl.textContent = "浏览器内置页";
    setSiteState("未连接", "muted", "bad");
    return;
  }
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  if (hostEl) hostEl.textContent = host || "当前标签页";
  if (tab.id === undefined) { setSiteState("未连接", "muted", "bad"); return; }
  try {
    const stats = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATS" }, { frameId: 0 });
    if (!stats || !stats.ok) throw new Error("no stats");
    if (stats.hasPanel) {
      $("metricTotal").textContent = String(stats.total);
      $("metricAnswered").textContent = String(stats.answered);
      $("metricMissed").textContent = String(stats.missed);
    }
    if (stats.allowed === true) setSiteState("白名单内 · 可填涂", "accent", "ok");
    else if (stats.allowed === false) setSiteState("仅显示答案", "warn", "warn");
    else setSiteState("已连接", "muted", "");
  } catch (_) {
    setSiteState("未连接", "muted", "bad");
  }
}
initSiteCard();
