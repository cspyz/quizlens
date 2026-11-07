/**
 * QuizLens 练习助手 - 后台 Service Worker
 * 统一代理 AI 请求：在后台发 fetch 不受页面 CORS 限制，
 * 且能给出明确的错误信息（状态码/网络错误）。
 */

// OpenAI 兼容接口的通用请求头
function apiHeaders(key) {
  const h = { "Content-Type": "application/json" };
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

// data:URL → Blob（service worker 里 fetch data: 地址不可靠，用 atob 手动解码）
function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = (head.match(/:(.*?);/) || [", image/jpeg"])[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 统一的超时错误文案：默认的 "The operation was aborted" 用户看不懂
function timeoutText(ms) {
  return `请求超时（${Math.round(ms / 1000)} 秒无响应）：接口没在预期时间内返回，请检查网络或换一个 Base URL`;
}

// 用户主动「停止」掐掉的请求，不能报成"请求超时，请检查网络"——
// 用户会照着提示去改根本没问题的 Base URL/模型名。
// 这里用独立的 name 标记，errText/failPayload 据此给不同文案。
const USER_ABORT_NAME = "QuizLensUserAbort";
const userAbortedCtrls = new WeakSet();

function isUserAbort(e) { return !!(e && e.name === USER_ABORT_NAME); }

// 把异常转成给用户看的文案：主动停止、超时、其余三种分开说
function errText(e, ms) {
  const name = e && e.name;
  const text = String((e && e.message) || e || "");
  if (name === USER_ABORT_NAME) return "已按你的「停止」中断这次请求（不是接口出问题）";
  if (name === "TimeoutError" || name === "AbortError" || /aborted|timeout/i.test(text)) {
    return timeoutText(ms);
  }
  return text;
}

// 失败应答的统一出口：主动停止时**不加**"请检查 Base URL"那句排查提示。
function failPayload(e, ms, hint) {
  if (isUserAbort(e)) return { ok: false, aborted: true, error: errText(e, ms) };
  return { ok: false, error: `网络错误: ${errText(e, ms)}${hint || ""}` };
}

// ---- 思考模式（「完整功能」输出模式）----
// 各平台开启思考的写法不统一：
//   · DeepSeek 推理模型（deepseek-reasoner）：reasoning_effort 由服务端默认，**不要**显式传，
//     传了部分版本会直接 400；思考内容走 choices[].message.reasoning_content
//   · OpenAI 兼容 / vLLM / SGLang 等：reasoning_effort（minimal|low|medium|high）或 enable_thinking
// 这里统一按 OpenAI 兼容的 reasoning_effort 发。认不出来的平台会返回 400，
// 由 postChat() 自动去掉字段重发一次 —— 用户要的是"能思考就思考"，
// 不能因为平台不认这个字段就整个请求失败。
const REASONING_EFFORT = "medium";

// 只有明确表示"不认识思考字段"的 400 才值得降级重试；
// 上下文超长、余额不足、模型名写错同样是 400，去掉字段重发只会再失败一次（白等一轮）。
//
// 判定必须**同时**满足两条，缺一不可：
//   ① 错误里点名了思考相关的东西（reasoning_effort / enable_thinking / thinking）；
//   ② 有"不认识/不支持"的措辞。
// 为什么不能只看 ②：OpenAI 兼容接口对**任何** 400 都会带
// `"type":"invalid_request_error"`，只匹配 invalid...parameter 的话，
// 模型名写错、余额不足、上下文超长全会被当成"字段不认识"而白重发一次。
function looksLikeUnsupportedParam(status, body) {
  if (status !== 400) return false;
  const b = String(body || "").toLowerCase();
  if (!/reasoning_effort|reasoning|enable_thinking|thinking/.test(b)) return false;
  return /unrecognized|unknown|unsupported|not supported|not allowed|unexpected|extra|invalid|does not support/.test(b);
}

// 从响应里取出思考内容（不同平台字段名不同，都兜住）
function reasoningOf(message) {
  const m = message || {};
  return String(m.reasoning_content || m.reasoning || m.thinking || "").trim();
}

// 「完整功能」模式：把思考内容回给页面。
//
// 关键：思考内容必须走**独立字段**，不能拼进 text ——
// 思考里几乎必然出现"答案是 C、因为 A 不对"这类字样，拼进 text 后
// content.js 的 extractAnswerLetters 会把它当成答案段来解析，
// 轻则解析出错误字母，重则多选题全勾。页面拿到 reasoning 只用于显示。
//
// 例外是截图解题（REGION_SELECTED）：那条路径的结果只显示、不解析，拼在一起
// 用户才一眼看得到"思考模式确实生效了"。
function withReasoning(text, message, think) {
  if (!think) return text;
  const r = reasoningOf(message);
  return r ? `🧠 思考过程\n${r}\n\n📝 答案与解析\n${text}` : text;
}

// 输出模式（只影响 TEXT_CHAT 这条老接口；content.js 的 AI_CHAT 自带 prompt）。
// 取值与 content.js / popup.js 完全一致：answer | standard | full，非法值落回 standard。
function normAnswerMode(v) {
  return (v === "answer" || v === "standard" || v === "full") ? v : "standard";
}

const PLAIN_TEXT_MATH = "数学公式一律用普通文本书写（如 y2 = 3/x、x>3），禁止使用 LaTeX 记号。";

// 截图解题的输出格式。答案必须落在第一行（复制/核对时一眼能看到），
// 解析放空行之后；answer 模式则一个字的解释都不给。
function visionOutputRule(mode) {
  if (mode === "answer") {
    return "第一行只写「题号. 选项字母」（无题号则只写字母）。不要输出任何解释。";
  }
  if (mode === "full") {
    return "第一行只写「题号. 选项字母」（无题号则只写字母），空一行后给出详细解析：" +
      "逐项说明为什么对、为什么错，必要时给出推理步骤或依据。用清晰中文。";
  }
  return "第一行只写「题号. 选项字母」（无题号则只写字母），空一行后简要解释，" +
    "不超过 150 字，用清晰中文。";
}

function textAnswerSystemPrompt(mode) {
  const common = "你是答题助手。只回答用户给出的最后一道题，严禁顺带回答其他题号。" +
    "如果用户提供了【阅读材料】：阅读理解题必须依据材料内容作答；" +
    "完形填空/选词填空（题干只有空格编号，可能附 A-O 词库）请根据上下文的语法、语义和词性选出最合适的选项；" +
    "段落匹配/信息判断题（题干要求从 A-K 中选择）请从给定选项池中选出对应字母并简述依据。";
  if (mode === "answer") {
    return common + "第一行只写「题号. 选项字母」（如 47. D；没有题号时只写字母如 B）。" +
      "不要输出任何解释。" + PLAIN_TEXT_MATH;
  }
  const head = "回答第一行只写「题号. 选项字母」（如 47. D；没有题号时只写字母如 B），空一行后再写解析。";
  if (mode === "full") {
    return common + head + "解析要详细：逐项说明依据与易错点。" + PLAIN_TEXT_MATH;
  }
  return common + head + "解析要简明，全程不超过 150 字。" + PLAIN_TEXT_MATH;
}

// 正在飞的请求控制器：用户点「停止」时要能**立刻掐断**，
// 否则内容脚本得等这个请求返回（慢接口下可能要等数秒）才轮得到检查 running。
// 正在飞的请求 → 它来自哪个标签页。
// 记 tab 是为了让「停止」只掐**本标签页**的请求：inFlight 若是全局 Set，
// A 标签页点停止会把 B 标签页正在作答的请求一起打断（B 那边成片报失败）。
// tabId === undefined 表示来源不是标签页（例如 popup 自己发的请求），
// 此时按全局兜底处理，保证"停止就是全停"。
const inFlight = new Map();   // AbortController -> tabId | undefined

function abortInFlight(tabId) {
  let n = 0;
  for (const [ctrl, from] of [...inFlight]) {
    if (tabId !== undefined && from !== tabId) continue;
    inFlight.delete(ctrl);
    n++;
    // 先登记"这是用户主动停的"，再 abort：postChat 的 catch 据此换文案，
    // 免得用户点了停止却看到"请求超时，请检查网络"。
    try { userAbortedCtrls.add(ctrl); } catch (_) {}
    try { ctrl.abort(); } catch (_) {}
  }
  return n;
}

// 可被 abort 打断的 sleep：退避等待期间用户点了「停止」要立刻醒过来，
// 不能干等满 1.6 秒再发现"其实早该停了"。
function sleepAbort(ms, ctrl) {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    let t = null;
    const cleanup = () => {
      if (t) clearTimeout(t);
      if (ctrl && ctrl.signal) ctrl.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    if (ctrl && ctrl.signal) {
      if (ctrl.signal.aborted) { reject(abortError()); return; }
      ctrl.signal.addEventListener("abort", onAbort);
    }
    t = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}

// 接口"过一会儿大概率就好"的状态：限流与网关/服务端抖动。
// 400/401/403/404 这类是配置问题，重试只会再失败一次，不在此列。
const RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];
const MAX_RETRY = 2;
function retryWaitMs(res, tries) {
  // 服务端给了 Retry-After 就听它的（只认秒数那种，且别超过 8 秒）
  try {
    const ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    const secs = Number(ra);
    if (ra !== null && Number.isFinite(secs) && secs >= 0) return Math.min(8000, Math.round(secs * 1000));
  } catch (_) {}
  return 800 * Math.pow(2, tries);      // 800ms → 1600ms
}

// 发一次 chat/completions。think=true 时先带 reasoning_effort，
// 被平台拒绝（400 且像"不认识这个字段"）就自动去掉重发一次。
// 返回 { ok, status, body, data }；网络异常直接抛给调用方处理。
//
// ⚠ timeoutMs 覆盖的是**整个请求生命周期**（建连 → 响应头 → 读完 body → 必要时降级重试），
// 不是"每次 fetch 各给一份"。两个关键点：
//   ① fetch() 在**收到响应头**时就 resolve，body 是之后才流式读的。若在 fetch 的
//      .finally() 里 clearTimeout，`await res.text()` 阶段**完全没有超时保护**：
//      服务端发完响应头再卡住（网关/反代很常见）就会永久挂起，用户看到的是
//      "点了没反应、也不报超时"，只能靠「停止」按钮救回来。
//   ② 降级重试若重新给一整个 timeoutMs，最坏总耗时 2×timeoutMs，超时承诺不准。
// 因此一次 postChat 只建**一个**控制器和一个定时器，两条腿共用同一个 deadline。
async function postChat({ baseUrl, key, body, think, timeoutMs, tabId }) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;

  // 一次 postChat 只有这一个 ctrl：
  //   · 超时到点 → abort()，正在建连、正在等响应头、正在读 body 的那一步都会立刻中断；
  //   · 用户点「停止」→ abortInFlight(本标签页) 对同一个 ctrl 调 abort()，同样立刻中断。
  const ctrl = new AbortController();
  // 整条链路（含降级重试与退避重试）共用的**唯一** deadline
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs);
  inFlight.set(ctrl, tabId);
  const done = () => { clearTimeout(timer); inFlight.delete(ctrl); };

  try {
    // 发一次请求，并把 body 读完再返回（读不完也算这一腿没结束，超时同样管得着）
    const send = async payload => {
      const res = await fetch(url, {
        method: "POST",
        headers: apiHeaders(key),
        signal: ctrl.signal,
        body: JSON.stringify(payload)
      });
      // 注意：响应头到手 ≠ 请求结束，body 可能还挂在流上，所以这里**不能**清定时器，
      // 统一由 finally 里的 done() 清。
      //
      // 读 body 失败（含被 abort 中断）时**不能**吞成空串就往下走：
      // 那样 res.ok 仍是 true、text 为空，最后会报成"返回内容为空，请检查模型名"，
      // 而真实原因是"你点了停止"或"读到一半超时了"——错误归因会让用户去改根本没问题的配置。
      // 这里把中断单独抛出去，交给调用方的 errText() 转成超时/中断文案。
      let text;
      try {
        text = await res.text();
      } catch (e) {
        // 请求确实被中断（超时到点 / 用户点停止）：如实抛出，不要伪装成"空响应"
        if (ctrl.signal.aborted) throw e;
        // 其余读取失败（如连接被对端重置）退化成空串，保持容错行为
        text = "";
      }
      return { res, text };
    };

    const withThink = think && !("reasoning_effort" in body);
    let { res, text } = await send(withThink ? Object.assign({}, body, { reasoning_effort: REASONING_EFFORT }) : body);
    let downgraded = false;
    if (withThink && !res.ok && looksLikeUnsupportedParam(res.status, text)) {
      console.warn("[QuizLens] 平台不接受 reasoning_effort，已自动降级为普通请求：", text.slice(0, 200));
      ({ res, text } = await send(body));
      downgraded = true;
    }
    // 限流与网关抖动：退避后重试，最多 MAX_RETRY 次。
    // 一次都不重试的后果是"免费额度/整点限流时成片漏答"——每道题都直接记失败，
    // 而用户看到的是接口返回 429，不知道稍等一下就能过。
    // 仍受**同一个 deadline** 约束：等下去会超出预算就不等了；共用同一个 ctrl，
    // 所以用户点「停止」能立刻打断退避等待（见 sleepAbort）。
    let tries = 0;
    while (!res.ok && RETRY_STATUS.includes(res.status) && tries < MAX_RETRY) {
      const wait = retryWaitMs(res, tries);
      const left = deadline - Date.now();
      if (left <= wait + 300) break;
      tries++;
      console.warn(`[QuizLens] 接口返回 ${res.status}，${wait}ms 后第 ${tries}/${MAX_RETRY} 次重试`);
      await sleepAbort(wait, ctrl);
      ({ res, text } = await send(body));
    }
    let data = null;
    if (res.ok) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    return { ok: res.ok, status: res.status, body: text, data, downgraded };
  } catch (e) {
    // 同一个 ctrl 既可能被定时器 abort，也可能被用户点「停止」abort，
    // 光看 AbortError 分不出来 —— 这里按 abortInFlight 登记的来源改名，
    // 让上层能给两句完全不同的文案（停止 vs 超时）。
    if (ctrl.signal.aborted && userAbortedCtrls.has(ctrl)) {
      const tagged = new Error("已被用户停止");
      tagged.name = USER_ABORT_NAME;
      throw tagged;
    }
    throw e;
  } finally {
    done();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---- 只接受来自本扩展自己的消息 ----
  // 不校验 sender 的话，任何能执行 chrome.runtime.sendMessage 的扩展上下文
  // （内容脚本、被注入的帧）都能让后台按它指定的 baseUrl/key 发 POST，
  // 等于一个不受限的出网代理（SSRF / 借后台绕过页面 CSP）。
  // 注意：这里**只**校验来源扩展，不能把 AI_CHAT 限制成"只允许 popup 调用"——
  // content.js 的 askAI()/askAIFill() 正是靠 AI_CHAT 走 AI 兜底的，那样会直接废掉 AI 答题。
  if (!sender || sender.id !== chrome.runtime.id) return;

  // ---- 用户点了「停止」：立刻掐断所有在飞的 AI 请求 ----
  // 不这么做的话，内容脚本要等当前请求自然返回（慢接口下可能数秒）
  // 才轮到下一轮循环检查 running —— 用户看到的就是"按了停止没反应"。
  if (msg.type === "ABORT_AI") {
    // 只中断**发起者所在标签页**的请求：A 页点停止不该把 B 页正在作答的请求打断。
    // 非标签页来源（没有 sender.tab）按全局处理，保证"停止就是全停"。
    const tabId = sender.tab && sender.tab.id;
    const n = abortInFlight(tabId);
    console.log("[QuizLens] 已中断", n, "个在飞请求", tabId === undefined ? "(全部)" : "(标签页 " + tabId + ")");
    sendResponse({ ok: true, aborted: n });
    return;
  }

  // ---- 白名单：从扩展目录 whitelist.txt 读取（一行一个域名，# 注释）----
  if (msg.type === "GET_WHITELIST") {
    (async () => {
      try {
        const txt = await (await fetch(chrome.runtime.getURL("whitelist.txt"))).text();
        const hosts = txt.split(/\r?\n/)
          .map(s => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, ""))
          .filter(s => s && !s.startsWith("#"));
        sendResponse({ ok: true, hosts });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ---- 代理拉取题库文件 ----
  // 为什么不直接在 content script 里 fetch：
  //   · 自定义题库地址往往是另一个站点，而页面可能是 https://ks.wjx.top ——
  //     跨域，content script 的 fetch 受页面 CORS 限制会直接失败；
  //   · 很多静态服务不会返回 CORS 头。
  // 后台 service worker 有 <all_urls> host_permissions，不受页面 CORS 约束，
  // 由它代取再回传，题库地址才能真正填哪儿都能用。
  if (msg.type === "FETCH_BANK") {
    const url = msg.payload && msg.payload.url;
    (async () => {
      try {
        if (!/^(https?|chrome-extension):/i.test(String(url || ""))) {
          sendResponse({ ok: false, error: "题库地址协议不支持：" + url });
          return;
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status, error: `HTTP ${res.status}` });
          return;
        }
        sendResponse({ ok: true, text: await res.text() });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // ---- 拉取平台可用模型列表（GET {baseUrl}/models）----
  if (msg.type === "LIST_MODELS") {
    const { baseUrl, key } = msg.payload;
    const TIMEOUT = 30000;
    (async () => {
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
          headers: apiHeaders(key),
          signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!res.ok) {
          sendResponse({ ok: false, error: `接口返回 ${res.status}（请检查 Base URL 和 Key）` });
          return;
        }
        const data = await res.json();
        // 兼容不同平台：标准为 {data:[{id}]}，部分平台返回 {models:[...]} 或裸数组
        const raw = data.data || data.models || data;
        const ids = (Array.isArray(raw) ? raw : [])
          .map(m => (typeof m === "string" ? m : m.id || m.name))
          .filter(Boolean)
          .sort();
        sendResponse({ ok: true, models: ids });
      } catch (e) {
        // 没有超时的话，popup 的「测试连接」会永远转圈
        sendResponse(failPayload(e, TIMEOUT, "（请检查 Base URL 是否可访问）"));
      }
    })();
    return true;
  }

  // ---- 截图解题：截取当前可见区域 → 按框选区域裁剪 → 多模态 AI ----
  if (msg.type === "REGION_SELECTED") {
    (async () => {
      const tabId = sender.tab.id;
      // 必须带 frameId，把结果只回给**发起请求的那个 frame**。
      //
      // 注意：当前 manifest 里 content script 是 all_frames:false（只注入顶层文档），
      // 所以正常情况下 sender.frameId 就是 0。但这里仍然显式回传 frameId，
      // 因为：① 以后若改成 all_frames:true，不带 frameId 会广播给页面里每一个 iframe，
      // 广告/内嵌框架里会各弹一个答案浮窗、各发一次请求；
      // ② frameId 为 undefined 时退回广播，兼容缺字段的调用方。
      const frameId = sender.frameId;
      // 把页面带来的 shotId 原样回给页面：页面据此丢弃"上一次框选"的迟到回复，
      // 也不会把用户刚关掉的结果窗重新建出来。
      const shotId = msg.shotId;
      const reply = async payload => {
        try { await chrome.tabs.sendMessage(tabId, Object.assign({ shotId }, payload), frameId === undefined ? {} : { frameId }); } catch (_) {}
      };
      try {
        // answerMode 一起读出来：截图解题的输出格式跟随 popup 的「输出模式」
        const st = await chrome.storage.local.get(
          ["aiKey", "aiBaseUrl", "aiModel", "visionModel", "visionBaseUrl", "visionKey", "answerMode"]);
        // 视觉模型经常和文本模型**不是一家的**：popup 的提示推荐 glm-4v-flash（智谱），
        // 而 aiBaseUrl 默认是 api.deepseek.com。两者共用一套地址/Key 时，
        // 用户照提示填了就必然 400，报错还是接口原文（model_not_found），
        // 完全看不出是"这家服务商没有这个模型"。所以视觉用独立的地址与 Key，
        // 留空才回退到文本那套配置（同一家时用一次填写就够了）。
        const visionModel = String(st.visionModel || "").trim();
        const baseUrl = String(st.visionBaseUrl || "").trim() || st.aiBaseUrl || "https://api.deepseek.com";
        const key = String(st.visionKey || "").trim() || st.aiKey || "";
        const model = visionModel || st.aiModel || "glm-4v-flash";
        const answerMode = normAnswerMode(st.answerMode);
        const think = answerMode === "full";
        if (!key) {
          await reply({ type: "ANSWER", ok: false, text: "未配置 API Key：截图解题要用「视觉模型」那一栏的 Key（没填则回退到上面的 AI Key）。点插件图标填写。" });
          return;
        }
        if (!visionModel) {
          await reply({
            type: "ANSWER", ok: false,
            text: "📷 截图解题需要单独填写「视觉模型」。\n\n" +
                  "点插件图标 → 在「视觉模型」一栏填入一个支持看图的模型，例如 glm-4v-flash（免费）。\n" +
                  "注意：普通的文本模型（如 deepseek-chat）看不了图片，填了也会报错。\n" +
                  "如果视觉模型和文本模型不是同一家（例如模型填 glm-4v-flash、而 Base URL 是 deepseek），" +
                  "请把它自己的 Base URL 和 Key 也填在「视觉模型」下面那一组里。"
          });
          return;
        }

        // 1. 截取当前可见区域
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 92 });

        // 2. 按框选区域裁剪（框选是 CSS 像素，截图是物理像素）
        await reply({ type: "ANSWER", ok: null, text: "✓ 已截屏，正在裁剪…" });
        const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
        const scale = bitmap.width / msg.vw;
        const r = msg.rect;
        const canvas = new OffscreenCanvas(
          Math.max(1, Math.round(r.width * scale)),
          Math.max(1, Math.round(r.height * scale))
        );
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap,
          Math.round(r.left * scale), Math.round(r.top * scale),
          Math.round(r.width * scale), Math.round(r.height * scale),
          0, 0, canvas.width, canvas.height);
        // OffscreenCanvas 没有 toDataURL，用 convertToBlob + btoa 转 base64
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        const cropped = "data:image/jpeg;base64," + btoa(bin);
        await reply({ type: "ANSWER", ok: null, text: `✓ 已裁剪（${canvas.width}×${canvas.height}），正在请求模型 ${model}…` });

        // 3. 发给视觉模型（普通 60 秒 / 思考模式 120 秒，避免永久转圈）
        const visionSys = "你是答题助手。用户发来一张题目截图。" + visionOutputRule(answerMode) +
          "只回答截图中的题目。" +
          "数学公式一律用普通文本书写（如 y2 = 3/x、x>3、a²+b²=c²），" +
          "禁止使用 LaTeX 记号（\\( \\) \\frac 等一律不要出现）。";
        // 页面那边的看门狗是"30 秒没有任何动静就算超时"，而这里等模型的预算是 60/120 秒，
        // 中间这一整段原本一条消息都不发 → 推理慢的视觉模型**必定**先弹「⏰ 超时（30 秒）」，
        // 几秒后答案才盖上来（用户以为是配置问题）。每 12 秒推一条进度：
        // 既让用户看得见"还在等"，也把那个空闲计时复位。
        const t0 = Date.now();
        const beat = setInterval(() => {
          reply({ type: "ANSWER", ok: null, text: `⏳ 模型仍在作答…已等 ${Math.round((Date.now() - t0) / 1000)} 秒` }).catch(() => {});
        }, 12000);
        let vres;
        try {
          vres = await postChat({
            baseUrl, key, think, timeoutMs: think ? 120000 : 60000, tabId,
            body: {
              model,
              temperature: 0,
              messages: [
                { role: "system", content: visionSys },
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: cropped } },
                    { type: "text", text: "请回答截图中的题目" }
                  ]
                }
              ]
            }
          });
        } finally {
          clearInterval(beat);
        }
        if (!vres.ok) {
          await reply({ type: "ANSWER", ok: false, text: `接口返回 ${vres.status} ${vres.body.slice(0, 120)}` });
          return;
        }
        const m = (vres.data && vres.data.choices && vres.data.choices[0] && vres.data.choices[0].message) || {};
        const text = m.content || "";
        if (vres.downgraded) {
          await reply({ type: "ANSWER", ok: null, text: "⚠ 当前平台/模型不支持思考字段（reasoning_effort），本次已按普通模式作答" });
        }
        await reply(text
          ? { type: "ANSWER", ok: true, text: withReasoning(text, m, think) }
          : { type: "ANSWER", ok: false, text: "返回内容为空，请在插件设置里填一个支持看图的视觉模型（如 glm-4v-flash）" });
      } catch (e) {
        // 用户中途点了停止：不要报成"截图解题失败: The operation was aborted"
        if (isUserAbort(e)) {
          await reply({ type: "ANSWER", ok: false, text: "已按你的「停止」中断这次截图解题（不是接口出错）。" });
          return;
        }
        const msg = String(e.message || e);
        let tip = "";
        if (/activeTab|all_urls|permission/i.test(msg)) {
          tip = "\n\n解决方法：到 edge://extensions 给本插件点『重新加载』；" +
                "若 Edge 提示新增了权限请点『允许』；再到本插件的『详细信息 → 网站访问权限』" +
                "确认已选择『在所有网站上』，然后刷新题目页面重试。";
        }
        await reply({ type: "ANSWER", ok: false, text: `截图解题失败: ${msg}${tip}` });
      }
    })();
    return;
  }

  // ---- 文字答题（任意页面的题目识别模式用）----
  if (msg.type === "TEXT_CHAT") {
    const p = msg.payload || {};
    const TIMEOUT = p.think ? 120000 : 30000;
    (async () => {
      try {
        const key = (await chrome.storage.local.get("aiKey")).aiKey || "";
        const baseUrl = (await chrome.storage.local.get("aiBaseUrl")).aiBaseUrl || "https://api.deepseek.com";
        const model = (await chrome.storage.local.get("aiModel")).aiModel || "deepseek-chat";
        if (!key) { sendResponse({ ok: false, error: "未配置 API Key" }); return; }
        const r = await postChat({
          baseUrl, key, think: !!p.think, timeoutMs: TIMEOUT, tabId: sender.tab && sender.tab.id,
          body: {
            model,
            temperature: 0,
            messages: [
              { role: "system", content: textAnswerSystemPrompt(normAnswerMode(p.answerMode)) },
              { role: "user", content: p.question }
            ]
          }
        });
        if (!r.ok) {
          sendResponse({ ok: false, error: `接口返回 ${r.status} ${r.body.slice(0, 100)}` });
          return;
        }
        const m = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message) || {};
        const text = m.content || "";
        sendResponse(text
          ? { ok: true, text, reasoning: p.think ? reasoningOf(m) : "", thinkDowngraded: !!r.downgraded }
          : { ok: false, error: "返回内容为空，请检查模型名" });
      } catch (e) {
        // 没有超时的话，单题按钮会永久 disabled（content.js 里 btn.disabled=false 永远执行不到）
        sendResponse(failPayload(e, TIMEOUT, ""));
      }
    })();
    return true;
  }

  // ---- AI 对话 ----
  if (msg.type !== "AI_CHAT") return;

  const { baseUrl, key, model, messages, think } = msg.payload;
  // 思考模式下模型要先生成思考内容，60 秒经常不够（推理模型单题可能 20~60 秒），放宽到 120 秒
  const AI_TIMEOUT = think ? 120000 : 60000;
  (async () => {
    try {
      const r = await postChat({
        baseUrl, key, think: !!think, timeoutMs: AI_TIMEOUT, tabId: sender.tab && sender.tab.id,
        body: { model, temperature: 0, messages }
      });
      if (!r.ok) {
        sendResponse({ ok: false, error: `接口返回 ${r.status} ${r.body.slice(0, 120)}` });
        return;
      }
      const m = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message) || {};
      const text = m.content || "";
      if (!text) {
        sendResponse({ ok: false, error: "接口返回内容为空，请检查模型名是否正确" });
        return;
      }
      // 思考内容走独立字段（reasoning），只用于面板显示；
      // text 保持"只有模型正式回答"，保证取答案的解析逻辑不被污染。
      // thinkDowngraded：平台不认识思考字段、后台已自动降级 ——
      // 不告诉页面的话，「完整功能」会**静默**变成普通模式（🧠 块永远空着），
      // 用户以为思考模式生效了，其实一次都没思考过。
      sendResponse({
        ok: true, text,
        reasoning: think ? reasoningOf(m) : "",
        thinkDowngraded: !!r.downgraded
      });
    } catch (e) {
      sendResponse(failPayload(e, AI_TIMEOUT, "（请检查 Base URL 是否可访问）"));
    }
  })();

  return true; // 保持消息通道开放，等待异步 sendResponse
});
