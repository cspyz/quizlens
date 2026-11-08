/**
 * QuizLens 练习助手 - Content Script
 * 注入答题页面，识别题目并自动作答。
 * 两种模式：
 *   bank  - 题库匹配：题目文本归一化后在题库里精确/模糊匹配
 *   ai    - AI 模式：把题目发给 OpenAI 兼容接口，解析返回的选项字母并点选
 *   mixed - 先查题库，匹配不到再问 AI
 */

(() => {
  "use strict";

  // 扩展版本号。代码更新后未重新加载扩展时，面板会显示不一致的版本号，
  // 便于直接看出"没生效"，而不是误判成功能故障。
  const EXT_VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; }
  })();
  const BLANK_ICON = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const LOGO_ICON_URL = (() => {
    try { return chrome.runtime.getURL("icons/icon128.png") || BLANK_ICON; } catch (_) { return BLANK_ICON; }
  })();
  const LOGO_MARK_URL = (() => {
    try { return chrome.runtime.getURL("icons/logo-mark.png") || BLANK_ICON; } catch (_) { return BLANK_ICON; }
  })();

  // 防重复注入 + 版本接管。
  // Chrome 对已解压扩展点「重新加载」时，会往**已打开的页面**再注入一次 content script。
  //   · 同一版本再注入 → 直接退出（否则两份监听器、两个面板，点一次跑两遍）
  //   · 不同版本再注入 → 新版**接管**：清掉上一版遗留的面板，自己注册监听器
  // 不同版本必须接管，否则未刷新的页面会继续运行上一版脚本，界面与功能看起来都没更新。
  const PREV_LOADED = window.__aaContentLoaded;
  if (PREV_LOADED === EXT_VERSION) return;
  if (PREV_LOADED) {
    try {
      document.querySelectorAll(".aa-panel, .aa-ball, .aa-result, .aa-overlay, #aa-run-panel")
        .forEach(n => n.remove());
      const oldStyle = document.getElementById("aa-panel-style");
      if (oldStyle) oldStyle.remove();
      console.log(`[QuizLens] 检测到已加载版本 v${PREV_LOADED}，已由 v${EXT_VERSION} 接管（刷新页面可彻底清理）。`);
    } catch (_) {}
  }
  window.__aaContentLoaded = EXT_VERSION;

  let running = false;
  // 停止令牌：用户点「停止」时立刻置位并唤醒所有在等的 sleep。
  // sleep 必须可被令牌唤醒，否则在 30 秒间隔下点停止要等满 30 秒才轮到下一轮
  // 检查 running —— 用户看到的就是"按了没反应"。
  let stopWaiters = [];
  // 启动阶段（running 还是 false）点的停止：记下来，等 run() 真正开始时兑现
  let stopRequested = false;
  // 「暂停」：与「停止」不同，暂停**不退出** run 循环，只是停在原地不往下答；
  // 再点一次「继续」就从暂停处接着答，已答过的题不会重答（filledEls/skipped 逻辑照旧）。
  // 用户诉求：想从**面板本身**随时暂停，而不是只能去插件弹窗里点停止（那是一去不回）。
  let paused = false;
  // "平台不支持思考字段"只提示一次（每张卡片都提示会把面板刷满）
  let thinkDowngradeNotified = false;
  // 已经点过的选项元素：重复运行或翻页回来时不重复点（否则会来回翻转选中态）
  const filledEls = new WeakSet();
  // **回读确认过**的写入（勾上了 / 输入框里确实是这个值）。
  // 与 filledEls 分开的理由：filledEls 只表示"动过"，拿它当"已答"就会把
  // 被页面拒绝的写入（type=number 吞掉 "3/4"、框架把 checked 改回去）报成成功，
  // 之后还永远拒绝重试。成败看 writtenOk，防重复点看 filledEls。
  const writtenOk = new WeakSet();

  // ---------- 文本归一化：去空白、去标点、转小写，让匹配只看内容 ----------
  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .trim();
  }

  // ---------- 剥掉 HTML 标签：题库侧专用 ----------
  //
  // 题库里有一部分题干混进了原始 HTML（如
  // `用重铬酸钾标定硫代硫酸钠溶液的反应式如下：K<img class='showpics' data-preview-src='' …>`），
  // 页面侧题干取自 textContent，永远不含标签文字；两边归一化后长度差很大，
  // 这类题在精确匹配里无法命中。只在题库侧剥标签（页面侧没有标签，剥了反而多此一举）。
  function stripHtml(text) {
    return String(text == null ? "" : text)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#\d+;/g, " ");
  }

  // ---------- 最长公共子序列长度（用于模糊匹配） ----------
  function lcsLength(a, b) {
    const m = a.length, n = b.length;
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  // 相似度：LCS 占较长字符串的比例，0~1
  function similarity(a, b) {
    if (!a || !b) return 0;
    return lcsLength(a, b) / Math.max(a.length, b.length);
  }

  // ---------- 题库匹配（大题库版：精确哈希 + 2-gram 倒排粗排 + LCS 精排） ----------
  let bankIndex = null; // { items, exact:Map<norm, q[]>, grams:Map }，与索引同生命周期
  // 同一页面生命周期内复用已建好的索引：否则每点一次「开始答题」都要重拉 41MB / 18.6 万题
  let bankCache = null;

  // 预处理：归一化文本 + 2-gram 集合
  function gramSet(normText) {
    const set = new Set();
    for (let i = 0; i + 1 < normText.length; i++) set.add(normText.slice(i, i + 2));
    // 短题干可能不足 2 个字，退化为单字
    if (!set.size && normText) set.add(normText);
    return set;
  }

  // 一道题能不能进题库索引。
  //   选择题：必须有 options 且有下标答案（answer 数组）
  //   填空题：没有 options，但必须有文本答案（answers 字符串数组，或 answer 是字符串/字符串数组）
  // 填空题由 resolveAnswer 的 bankBlankAnswer() 分支处理，命中后直接把文本写进空里，
  // 所以也要收进索引。
  // 判据不能只看 type 字段：题库里的题可能没写 type，靠"有没有 options"更可靠。
  function isIndexableBankQuestion(q) {
    if (!q || !q.question) return false;
    const hasOpts = Array.isArray(q.options) && q.options.length > 0;
    if (hasOpts) return Array.isArray(q.answer) && q.answer.length > 0;
    // 无选项 → 只接受有文本答案的填空题
    return blankAnswerTexts(q).length > 0;
  }

  // 取一道填空题的标准答案文本数组。三种写法都要认：
  //   answers: ["96"]                    —— 页面题库的写法
  //   answer:  "96"                      —— 手写题库的写法
  //   answer:  ["96","180"]              —— 数组写法
  // 选择题的 answer 是**下标数组**（[0,2]），不能当成文本答案，所以先排除有 options 的题。
  function blankAnswerTexts(q) {
    if (!q) return [];
    if (Array.isArray(q.options) && q.options.length) return [];
    const norm = v => String(v == null ? "" : v).trim();
    if (Array.isArray(q.answers)) return q.answers.map(norm).filter(Boolean);
    if (Array.isArray(q.answer)) {
      // 数字下标是选择题的残留，不是文本答案
      if (q.answer.every(v => typeof v === "number")) return [];
      return q.answer.map(norm).filter(Boolean);
    }
    const s = norm(q.answer);
    return s ? [s] : [];
  }

  // 把主线程让出去：分片之间必须走普通任务队列，不能只依赖 scheduler.yield ——
  // 它的续作优先级会连续抢跑，实测能把页面的计时器饿住数秒（长任务看着不大，实际照样卡）。
  // setTimeout(0) 每片多几毫秒，但渲染、输入和计时器都能插进来。
  function yieldToMain() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // 索引构建分片：每片约 1000 题（实测几十毫秒），片间让出主线程。
  // 不再一次同步跑完 18.6 万题——那会阻塞页面 4~5 秒。
  async function buildBankIndex(bank, onProgress) {
    const items = [], exact = new Map(), grams = new Map();
    const total = bank.length;
    const CHUNK = 1000;
    let lastPct = 0;
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(total, start + CHUNK);
      for (let i = start; i < end; i++) {
        const q = bank[i];
        const norm = normalize(stripHtml(q.question || ""));
        if (!norm) continue;
        // 2-gram 集合：**倒排索引完全靠它建**（下面的 ng.forEach 填 bankIndex.grams），
        // 所以必须保留。它只作为局部变量用完即弃：不要塞进 item，
        // 否则每道题都会多挂一个 Set，白白占用大量堆内存，也不影响倒排表。
        const ng = gramSet(norm);
        items.push({ norm, q });
        // 同一题干在不同题库里可能是选项顺序不同、甚至答案互相矛盾的题。
        // 不能只保留第一份，全部留下，匹配时按页面选项挑对得上的。
        const list = exact.get(norm);
        if (list) list.push(q); else exact.set(norm, [q]);
        ng.forEach(g => {
          let set = grams.get(g);
          if (!set) grams.set(g, (set = new Set()));
          set.add(items.length - 1);
        });
      }
      const pct = Math.floor(end / total * 100);
      if (onProgress && end < total && pct >= lastPct + 10) {
        lastPct = pct;
        onProgress(end, total, pct);
      }
      if (end < total) await yieldToMain();
    }
    bankIndex = { items, exact, grams };
    return items.length;
  }

  // 粗排：查询的 2-gram 命中倒排表，按共同 gram 数打分取 top N
  function roughCandidates(norm, topN) {
    const scores = new Map();
    gramSet(norm).forEach(g => {
      const set = bankIndex.grams.get(g);
      if (!set) return;
      set.forEach(i => scores.set(i, (scores.get(i) || 0) + 1));
    });
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([i]) => i);
  }

  let bankThreshold = 0.75; // 模糊匹配阈值（popup 可调，百分比 /100）

  // 模糊阈值解析。popup 那个输入框标的是"百分比 50~95"，但无条件 `/100` 再夹范围，
  // 于是填 `0.8`（想要 80%）和填 `10` 都变成**下限 50%** —— 用户改了半天，一个值都没生效。
  // 规则：≤1 当小数（0.8 → 80%），>1 当百分数（80 → 80%），最后夹在 50%~95%。
  // popup.js 里的 normThresholdPct 是同一套规则，两处必须保持一致。
  function thresholdFraction(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0.75;
    const frac = n <= 1 ? n : n / 100;
    return Math.min(0.95, Math.max(0.5, frac));
  }

  // 模糊匹配的绝对下限：页面题干与候选题干的最长公共子序列至少要有 11 个字。
  //
  // 为什么需要它：similarity 是「LCS 占较长串的比例」，页面题干一短，分母就小，
  // 分数极易虚高。页面题干只是某道题的前缀或子序列、共享内容只有 7~10 字时，
  // 仍可能拿到 0.75~0.83 分。
  // 取 11 是临界值：10 会放过 10 字共享的误配，12 会误伤只改一两个字的同题。
  // 只作用于模糊匹配，精确匹配不受影响，所以「3 + 4 =（  ）」这类短题照常命中。
  const MIN_FUZZY_LCS = 11;

  // 选项文本归一化。题库里存的是"大西洋"这种纯文本，页面上常带"A. "字母前缀，
  // 两边都抹掉才能比对。
  //
  // ⚠ 归一化后是空串时**退回"去空白的原文"**：像 "<"、">"、"&"、"++"、"//"、"3/4"
  // 这类纯符号/含符号选项，normalize 把标点全剥掉之后就什么都不剩，
  // 于是 usableOptions 判定"页面选项读不出来"、命中被放弃。
  // 这种选项恰恰最能用来对齐 —— 人和模型都读得懂，退回去即可继续**可验证**地匹配，
  // 而不是靠题库下标按位置硬猜。
  function optKey(t) {
    const stripped = String(t == null ? "" : t).replace(/^\s*[A-Za-z]\s*[).、．,，:：]\s*/, "");
    return normalize(stripped) || stripped.replace(/\s+/g, "").toLowerCase();
  }

  // 把选项渲染成给 AI 看的 "A. xxx" 行。
  // 页面上的选项有两种：自带字母前缀（问卷星的 .label 就是 "A. 高中及以下"、
  // 竖排列表的 <li>A. xxx</li>）和不带的。直接补字母会出现 "A. A. HTML…" 双前缀，
  // 字母被当成选项内容的一部分，模型容易答错。
  // 只在这个字母**正好是本选项自己的编号**时才剥掉，避免误伤 "C. elegans" 这类正文。
  function renderOptionLines(options) {
    return (options || []).map((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const t = String(opt == null ? "" : opt).trim();
      const m = t.match(/^([A-Za-z])\s*[).、．,，:：]\s*(.+)$/);
      const body = (m && m[1].toUpperCase() === letter) ? m[2].trim() : t;
      return `${letter}. ${body}`;
    });
  }

  // 页面选项是否"可用"：至少 2 个非空文本。
  // 选项没识别出来时不做重定位，保持"直接采信题库答案"的行为，
  // 免得把本来能命中的题判成未匹配。
  function usableOptions(opts) {
    if (!Array.isArray(opts) || opts.length < 2) return false;
    return opts.filter(t => optKey(t)).length >= 2;
  }

  // 「选项文字能不能读出来」——和 usableOptions **不是一回事**，别混用：
  // usableOptions 是给题库重定位用的，比的是**归一化后**的文本，
  // 像 "<"、">"、"/"、"++" 这类纯符号选项归一化后是空串，但人和模型都读得懂。
  // 拿它当"读不出标签"的判据会把整题拦下（例如「尖括号符号叫什么」那道题）。
  function readableOptions(opts) {
    return Array.isArray(opts) && opts.filter(t => String(t || "").trim()).length >= 2;
  }

  // 把题库答案的下标映射到当前页面的选项上：
  //   - 页面选项与题库同序 → 原样返回
  //   - 页面选项顺序不同 → 按选项文本重新定位
  //   - 答案选项在页面上根本找不到（题干相同但选项/答案对不上，即跨题库重题的冲突版本）
  //     → 返回 null，宁缺勿错
  function remapAnswer(cand, pageOptions) {
    const ans = Array.isArray(cand.answer) ? cand.answer : [];
    if (!ans.length) return null;
    // 页面选项文字读不出来时**不再按位置硬勾**题库下标。
    // 否则 `<div class="opt">A. 北京</div>`（没有 .opt-text）这类排版会得到 ["",""]，
    // 题库的顺序就成了唯一依据 —— 题干相同、选项顺序不同的跨题库重题就是掷硬币，
    // 日志还打「题库·精确」。勾错不可逆，宁可判未命中。
    if (!usableOptions(pageOptions)) return null;
    const bankOpts = Array.isArray(cand.options) ? cand.options : [];
    const pageKeys = pageOptions.map(optKey);
    const sameOrder = ans.every(i => {
      const k = optKey(bankOpts[i]);
      return k && pageKeys[i] === k;
    });
    if (sameOrder) return ans;
    const mapped = ans.map(i => {
      const k = optKey(bankOpts[i]);
      return k ? pageKeys.indexOf(k) : -1;
    });
    if (mapped.every(i => i >= 0)) return [...new Set(mapped)].sort((a, b) => a - b);
    return null;
  }

  // ---------- 填空题的题库匹配 ----------
  // 为什么不复用 matchInBank：那个函数是围绕"选项"设计的（remapAnswer 要靠选项文本
  // 重定位答案），填空题没有选项，走进去会走 remapAnswer 的 usableOptions=false 分支，
  // 直接把选择题的下标答案当结果返回 —— 类型对不上。
  // 这里单独一条：只在**填空题候选**里找，命中后返回文本答案数组。
  //
  // 一个容易忽略的情况：题库里选择题和填空题的题干可能完全相同（比如"三角形的内角和是 ____ 度"
  // 既有选择题版本也有填空题版本）。所以不能只用题干判重，必须核对"这条题库记录
  // 是不是填空题"（即 blankAnswerTexts 非空）。
  function matchBlankInBank(q) {
    if (!bankIndex) return null;
    const stem = String((q && (q.stem || q.stemText)) || "").trim();
    const norm = normalize(stem);
    if (!norm) return null;

    const pick = (cand) => {
      const texts = blankAnswerTexts(cand);
      return texts.length ? texts : null;
    };

    // 第一轮：精确匹配
    const variants = bankIndex.exact.get(norm);
    if (variants) {
      for (const cand of variants) {
        const texts = pick(cand);
        if (texts) return { q: cand, texts, exact: true };
      }
      // 精确命中的全是选择题版本 → 说明这道填空题没被收录，落到模糊匹配没有意义
      return null;
    }

    // 第二轮：2-gram 粗排 + LCS 精排（与选择题同一套阈值，行为一致）
    const cand = roughCandidates(norm, 40);
    const scored = [];
    for (const i of cand) {
      const it = bankIndex.items[i];
      if (Math.abs(it.norm.length - norm.length) > Math.max(norm.length, it.norm.length) * 0.4) continue;
      const lcs = lcsLength(norm, it.norm);
      if (lcs < MIN_FUZZY_LCS) continue;
      const score = lcs / Math.max(norm.length, it.norm.length);
      if (score >= bankThreshold) scored.push({ score, q: it.q });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, 5)) {
      const texts = pick(s.q);
      if (texts) return { q: s.q, texts, exact: false, score: s.score };
    }
    return null;
  }

  function matchInBank(stem, pageOptions) {
    if (!bankIndex) return null;
    const norm = normalize(stem);
    if (!norm) return null;

    // 第一轮：精确匹配 O(1)
    const variants = bankIndex.exact.get(norm);
    if (variants) {
      if (variants.length === 1) {
        // 唯一版本：能按文本重定位就重定位，重定位不了仍沿用题库答案（保持直接采信）
        const ans = remapAnswer(variants[0], pageOptions);
        return ans ? { q: variants[0], answer: ans, exact: true } : null;
      }
      // 多版本（跨题库重题）：挑选项对得上的那一份，全都对不上就判未匹配
      for (const cand of variants) {
        const ans = remapAnswer(cand, pageOptions);
        if (ans) return { q: cand, answer: ans, exact: true };
      }
      return null;
    }

    // 第二轮：2-gram 粗排（处理"多几个字少几个字"），再 LCS 精排
    const cand = roughCandidates(norm, 40);
    const scored = [];
    for (const i of cand) {
      const it = bankIndex.items[i];
      // 长度差剪枝：增删字超过 40% 不可能是同题
      if (Math.abs(it.norm.length - norm.length) > Math.max(norm.length, it.norm.length) * 0.4) continue;
      // 一次 LCS 同时得到相似度与绝对下限判据（similarity 内部本来就要算 LCS，这里复用省一半开销）
      const lcs = lcsLength(norm, it.norm);
      if (lcs < MIN_FUZZY_LCS) continue;
      const score = lcs / Math.max(norm.length, it.norm.length);
      if (score >= bankThreshold) scored.push({ score, q: it.q });
    }
    scored.sort((a, b) => b.score - a.score);
    // 分数最高的未必是同一道题（题干相近、选项不同的情况很常见），
    // 依次做选项校验，取分数最高的那个"能对上"的
    for (const s of scored.slice(0, 5)) {
      const ans = remapAnswer(s.q, pageOptions);
      if (ans) return { q: s.q, answer: ans, exact: false, score: s.score };
    }
    return null;
  }

  // ---------- 题库加载：多来源依次尝试 + 页面自带 questions.json，无需勾选 ----------
  //
  // 注意 fetch("./bank/index.json") 里的 "./" 是相对**当前网页**解析的，不是扩展目录。
  // 结果：
  //   · 页面自带 ./bank/ 时       → <页面域名>/bank/index.json              ✅ 有
  //   · 问卷星 ks.wjx.top         → https://ks.wjx.top/bank/index.json       ❌ 404
  // 因此这里按优先级尝试多个来源，失败时给出**能照着做**的提示。
  function bankBaseCandidates(settings) {
    const out = [];
    // ① 用户显式填写的题库地址（本地 http 服务、内网、云端站点都行）
    const custom = String((settings && settings.bankBaseUrl) || "").trim();
    if (custom) out.push({ base: custom.replace(/\/+$/, "") + "/", label: "自定义题库地址" });
    // ② 随扩展一起打包的题库 extension/bank/
    try {
      const bundled = chrome.runtime.getURL("bank/");
      if (bundled) out.push({ base: bundled, label: "扩展内置题库" });
    } catch (_) { /* 拿不到扩展 URL 就跳过这一档 */ }
    // ③ 当前页面自带的 bank/（页面自带题库时的兜底路径）
    try {
      out.push({ base: new URL("./bank/", location.href).href, label: "当前页面" });
    } catch (_) {}
    return out;
  }

  // 取一个 URL 的文本。优先走后台代理：内容脚本的 fetch 受**页面** CORS 限制，
  // 而题库常放在本机 http 服务上（页面可能是 https，直接跨域必失败）；
  // 后台有 <all_urls> 权限不受此限。
  // 后台失败时才退回直接 fetch（同源场景仍可用；两者都失败时报告后台那个更准确的错误，
  // 因为直接 fetch 失败多半只是 CORS，会把"HTTP 404"这种真正原因盖掉）。
  async function fetchText(url) {
    let bgError = null;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "FETCH_BANK", payload: { url } });
      if (reply && reply.ok) return reply.text;
      bgError = new Error(reply?.error || "后台无响应");
    } catch (e) {
      bgError = e;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      throw bgError || e;
    }
  }

  async function fetchJson(url) {
    const txt = await fetchText(url);
    try {
      return JSON.parse(txt);
    } catch (_) {
      throw new Error("返回的不是合法 JSON（可能拿到的是一张 404 页面）");
    }
  }

  // 从某个题库根目录把全部类别拉下来。返回 { questions, loaded, total }
  async function fetchBankFrom(base, label) {
    const idx = await fetchJson(base + "index.json");
    if (!Array.isArray(idx)) throw new Error("index.json 不是数组格式");
    // 建索引要拉完整题库，耗时可能达到数秒。先写一行"开始加载"的日志，
    // 否则这段等待时间里板没有任何新内容，用户会以为卡死。
    if (idx.length > 1) log(`正在加载题库并建索引（${idx.length} 个类别，首次约 2~5 秒）…`, "var(--c-accent)");
    // index.json 两种格式都兼容：纯文件名数组，或 [{file,label,count}]
    let loaded = 0;
    const results = await Promise.all(idx.map(async item => {
      const f = typeof item === "string" ? item : (item && item.file);
      if (!f) return { error: "index.json 里有一项缺少 file 字段" };
      try {
        const qs = (await fetchJson(base + f)).questions;
        loaded++;
        // 每完成一个类别报一次进度：慢网下用户能看出"在动"，而不是干等
        if (idx.length > 1) log(`  题库加载 ${loaded}/${idx.length}：${f}`, "var(--c-ink-4)");
        return qs;
      } catch (e) {
        return { error: `${f}: ${e.message}` };
      }
    }));
    const errs = results.filter(r => r && r.error).map(r => r.error);
    const questions = results.filter(r => Array.isArray(r)).flat();
    if (!questions.length) throw new Error(errs[0] || "题库文件里没有题目");
    if (errs.length) console.warn(`[QuizLens] ${label} 部分题库加载失败：`, errs);
    return { questions, loaded: idx.length - errs.length, total: idx.length };
  }

  async function loadBank(settings) {
    // 同一页面里索引只建一次：41MB / 18.6 万题的加载+建索引要好几秒，
    // 重复点「开始答题」不该重复付出这个代价。
    //
    // 但缓存必须**跟着题库地址走**：用户在弹窗里换了「题库地址」后，旧缓存
    // 仍然是上一个地址的题，日志还会显示旧来源 —— 用户以为新地址生效了，
    // 其实要刷新页面才会换。所以键里带上地址，不一致就重建。
    const cacheKey = String((settings && settings.bankBaseUrl) || "").trim();
    if (bankCache && bankCache.key === cacheKey) {
      bankIndex = bankCache.index;
      return { total: bankCache.total, cached: true, from: bankCache.from };
    }
    bankIndex = null;
    let bank = [];
    let from = null;

    // 1) 大题库：按优先级试各个来源，第一个成功的就用
    const tried = [];
    for (const c of bankBaseCandidates(settings)) {
      try {
        const r = await fetchBankFrom(c.base, c.label);
        bank = bank.concat(r.questions);
        from = c.label;
        // 前缀固定成「大题库：N/M」，来源信息只能往后放，不能插在冒号前。
        log(`大题库：${r.loaded}/${r.total} 个类别加载成功（来源：${c.label}）`);
        break;
      } catch (e) {
        tried.push(`${c.label}(${e.message})`);
      }
    }
    if (!from && tried.length) {
      // 报错要能照着做，不能只说"失败了"
      log("大题库没加载到。已尝试：" + tried.join("；"), "var(--c-warn)");
      log("→ 在插件弹窗里填「题库地址」（题库的站点地址）。" +
          "只靠 AI 的话把模式改成「仅 AI」。", "var(--c-warn)");
    }

    // 2) 页面自带的 questions.json 也并入索引（页面自带题库可直接命中）。
    //    这一份始终按页面解析——它就是"这个网页自己的卷子"，跟题库来源无关。
    try {
      const legacy = (await (await fetch("./questions.json")).json()).questions || [];
      // 只索引"题库匹配得上的题"：
      //   选择题 —— 有 options + 下标答案（answer 数组）
      //   填空题 —— 有文本答案（answers 字符串数组），没有 options
      // 填空题走 bankBlankAnswer() 分支，能命中，所以也要一并收进来。
      bank = bank.concat(legacy.filter(q => isIndexableBankQuestion(q)));
    } catch (_) { /* 页面没有自带题库就忽略 */ }
    if (!bank.length) throw new Error("没有任何可用题库（内置/自定义/页面三个来源都没拿到）");
    const n = await buildBankIndex(bank, (done, total, pct) => {
      log(`索引初始化 ${pct}%（${done}/${total}）…`, "var(--c-ink-4)");
    });
    bankCache = { key: cacheKey, index: bankIndex, total: n, from: from || "当前页面" };
    return { total: n, from: bankCache.from };
  }

  // ---------- 输出模式：只输出答案 / 答案+解析 / 完整功能（思考模式） ----------
  // 用户要的三档：
  //   answer   - 只要答案，不要解析（最省 token，答错看不出原因）
  //   standard - 答案 + 简明解析，**不开思考模式**（默认；用户明确要求默认不带思考）
  //   full     - 完整功能：思考模式 + 详细解析
  // 只影响 AI 作答：题库命中的题本来就只有答案。非法值一律落回 standard ——
  // popup 里存进一个拼错的值时，绝不能静默变成"没有解析"或"多花一份思考的钱"。
  const ANSWER_MODES = ["answer", "standard", "full"];
  const ANSWER_MODE_DEFAULT = "standard";
  // 思考强度由 background.js 统一决定（REASONING_EFFORT = "medium"）：
  // 内容脚本只负责"要不要思考"这一个布尔量，具体字段怎么写是后台的事，
  // 免得两边各写一份强度值、改了一处忘了另一处。
  function normAnswerMode(v) {
    return ANSWER_MODES.includes(v) ? v : ANSWER_MODE_DEFAULT;
  }
  const isThinkMode = m => normAnswerMode(m) === "full";
  const answerModeOf = settings => normAnswerMode(settings && settings.answerMode);

  // 数学公式写法：解析要在面板里以纯文本显示（没有 MathJax），
  // LaTeX 记号会原样露出一堆反斜杠，所以要求普通文本。
  const PLAIN_TEXT_MATH = "数学公式一律用普通文本书写（如 y2 = 3/x、x>3、a²+b²=c²），禁止使用 LaTeX 记号。";

  // 选择题的"答案格式"规则，三种模式共用同一套约定：
  // 答案必须落在第一行 —— extractAnswerLetters 只在「答案：X」标记或第一行里取字母，
  // 解析里出现的"因为 A 选项错误"绝不能把答案带偏。
  function choiceOutputRule(mode) {
    if (mode === "answer") {
      return "只输出正确选项的大写字母，多选用顿号分隔，如：C 或 A、C、D。不要输出任何解释。";
    }
    const head = "第一行只写「答案：大写选项字母」，多选用顿号分隔，如「答案：C」「答案：A、C、D」；空一行后再写解析。";
    if (mode === "full") {
      return head +
        "解析要详细：逐个选项说明为什么对、为什么错（选项多时也要覆盖全部选项），" +
        "必要时给出关键推理步骤或依据。可以充分推理，但**不要输出思考过程本身**，" +
        "答案必须出现在第一行；解析不限字数，但不要重复抄写题干和选项全文。";
    }
    return head +
      "解析要简明（不超过 150 字，用清晰中文），说清答案依据即可，" +
      "不要输出思考过程，也不要重复抄写题干和选项全文。";
  }

  // 从模型回复里切出「解析」部分（填空题路径用）。
  // 只在出现独立的「解析：/解释：」行时才切 —— 填空题的答案是**按行取**的
  // （cleanFillTexts 多空时取前 n 行），万一模型没按格式回，
  // 宁可整段丢掉解析，也不能把解析那一行当成第 2 个空的答案填进去。
  function splitAiExplanation(text) {
    const src = String(text || "");
    // 标记不必独占一行，但必须"自成一段"：行首，或前面是空白/左括号。
    // 「答案 + 解析」模式会主动让模型写解析，常出现
    //   "北京 解析：因为是首都" / "北京（解析：因为是首都" 这类**同行**写法。
    // 只认行首标记会把整串当成答案写进输入框（填涂不可逆，写错很难发现）。
    // 放宽后仍不会误伤正常答案："解析几何：…"这种不含"解析："的写法匹配不上。
    // 标记词本身允许被 markdown 包裹（模型常写「**解析：**」「## 解析：」）：
    //   前缀：行首任意 markdown 记号（#、-、>、*）与空白（含全角空格 U+3000）
    //   标记：解析/解释/说明/分析，可选「答案」前缀
    //   包裹：标记词两侧可有 * _ `（"**解析：**" / "**解析**："）
    //   冒号：半角/全角；也接受"标记词 + 空白"的无冒号写法（"解析 北京是政治中心。"）
    // 注意这里**不能**给正则加 ^ 锚点：解析标记既可能在行首（"\n解析：…"），
    // 也可能与答案同行（"北京 解析：…" / "北京（解析：…"）。
    // 加了 ^ 就只能认行首，同行写法会整串被当成答案写进输入框。
    const W = "[ \t\u3000]";   // 半角空格 / 制表 / 全角空格
    const re = new RegExp(
      `${W}*(?:[#>\\-*+]${W}*)*(?:\\*\\*|__|\\*|_|\`)?${W}*[（(【\\[]?${W}*(?:答案)?${W}*(解析|解释|说明|分析)` +
      `${W}*(?:\\*\\*|__|\\*|_|\`)?${W}*(?::|：|${W})${W}*(?:\\*\\*|__|\\*|_|\`)?${W}*`,
      "g");
    let cut = -1, markLen = 0, m;
    while ((m = re.exec(src))) {
      const before = src.slice(0, m.index);
      // 认三种位置：① 文件/行首；② 前面是空白或左括号；③ 匹配串自己以空白/左括号开头
      //（③ 覆盖"北京 解析：…"与"北京（解析：…"——分隔符被正则吃进匹配里了，
      //  只看 m.index 前的字符会误判成"紧贴答案"而拒掉）
      if (m.index === 0 || /\n[ \t\u3000]*$/.test(before) ||
          /[\s（(【\[]$/.test(before) || /^[ \t\u3000（(【\[]/.test(m[0])) {
        cut = m.index; markLen = m[0].length; break;
      }
    }
    if (cut < 0) return { body: src, explain: "" };
    // 标记前的左括号属于解析这一侧（"北京（解析：…"），从答案里剥掉
    const bodyEnd = cut > 0 && /[（(【\[]/.test(src[cut - 1]) ? cut - 1 : cut;
    const body = src.slice(0, bodyEnd).trim();
    const explain = src.slice(cut + markLen).trim();
    return { body: body || src.trim(), explain };
  }

  // 结果对象里带着模型原文（面板要显示解析），但**绝不**让解析参与填涂：
  // 填涂只认 res.answer / res.texts，原文单独放在 res.raw 里。
  const cleanRaw = t => String(t == null ? "" : t).trim();

  // ---------- AI 模式（请求由后台 service worker 代理发出） ----------
  async function askAI(question, settings) {
    const mode = answerModeOf(settings);
    // 选项文字读不出来、**且这题有可点控件**时，不许问模型要字母：模型回的 A/B/C
    // 在页面上到底对应哪一项无从核对，勾下去就是盲勾（选项容器里没有 .opt-text 的页面）。
    // 没有可点控件的题（选项挤在题干里的排版）不在本判据内 —— 它点不动任何东西，
    // 把答案显示给人看仍然有价值，拦掉反而让面板空着。
    const clickable = (question.inputs || []).filter(Boolean).length || (question.optEls || []).length;
    if (clickable && !readableOptions(question.optionTexts)) {
      return {
        answer: null, raw: "", explain: "", reasoning: "",
        error: "页面有可点的选项但文字读不出来，无法确定该勾哪一项（已避免盲勾）。请手动作答，或用 📷 截图解题看答案。",
      };
    }
    const optionLines = renderOptionLines(question.optionTexts).join("\n");

    // 阅读理解/完形填空：材料必须一起发过去，否则模型看到的是一道没头没脑的题干。
    // 后台的 TEXT_CHAT 已经约定了【阅读材料】这个前缀（background.js），
    // 但 AI_CHAT 这条路上，填空题（askAIFill）会带材料，选择题也必须带。
    const blocks = [];
    if (question.passage) blocks.push("【阅读材料】\n" + question.passage);
    if (question.clozeNum) {
      blocks.push(`【完形填空】请结合材料上下文，选出最适合填入材料中第 ${question.clozeNum} 空的选项。`);
    }
    blocks.push(choiceStem(question) + "\n" + optionLines);

    const reply = await chrome.runtime.sendMessage({
      type: "AI_CHAT",
      payload: {
        baseUrl: settings.aiBaseUrl || "https://api.deepseek.com",
        key: settings.aiKey || "",
        model: settings.aiModel || "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "你是答题助手。" + choiceOutputRule(mode) + PLAIN_TEXT_MATH +
              "如果给了【阅读材料】，必须依据材料内容作答，不要凭常识猜。"
          },
          { role: "user", content: blocks.join("\n\n") }
        ],
        // 只有「完整功能」才请求思考模式；后台不认识这个字段时会自动降级重发
        think: isThinkMode(mode)
      }
    });

    if (!reply || !reply.ok) throw new Error(reply?.error || "后台无响应，请刷新插件后重试");
    // 解析响应里的选项字母，范围跟随实际选项数（问卷星常见 5+ 选项，不能只认 A-D）
    //
    // 必须先把解析段切掉：standard/full 两档都**主动要求**模型在答案行后面写解析，
    // 而解析里「参考答案为 B」「答案 B 更合适」是高频措辞。extractAnswerLetters 的显式
    // 标记规则是「有多个标记时取最后一个」（那是为了接住模型自我纠正，本身要保留），
    // 整段一起扫就会被解析里的字样抢走真正的答案行 —— 例如
    // "答案：C\n\n解析：…参考答案为 B。" 会取到 B，勾错且不可逆。
    // 填空题路径一直用 splitAiExplanation 切分，选择题这条也要接上。
    const answer = extractAnswerLetters(splitAiExplanation(reply.text).body, question.optionTexts.length);
    // 原文一并带回：面板要显示解析（full 模式还会显示思考过程），
    // 但调用方只能拿它显示，填涂一律只看 answer（见 resolveAnswer 的注释）。
    // reasoning 来自后台的独立字段，不含在 text 里，所以不影响上面的字母解析。
    return {
      answer, raw: cleanRaw(reply.text), explain: cleanRaw(reply.text),
      reasoning: cleanRaw(reply.reasoning), thinkDowngraded: !!reply.thinkDowngraded, how: "AI"
    };
  }

  // ---------- 从 AI 回复里取答案字母（自动填涂与面板共用这一份） ----------
  // 绝不能全文扫描字母：模型很爱回"答案是 C。因为 A 选项错误，B 也不对"，
  // 全文扫描会把 A、B、C 全当成答案 → 多选题三选全勾。
  // 而填涂是"点下去不可逆"的，宁少勿多。
  //
  // 取法（顺序即优先级）：
  //   ① 显式答案标记（"答案：C" / "正确答案是 A、C" / "Answer: B"）——
  //      有多个时取**最后一个**：模型自我纠正时结论在后面；
  //   ② 肯定式线索（"故选 C" / "不是 A，是 C"）—— 只在没有标记时才用；
  //   ③ 都没有就退回第一行（约定俗成的答案行）。
  // 每一段内部只认「字母列表」写法：顿号/半角逗号/和/及/斜杠/与/空格分隔
  // （A、C、D），或紧挨着的大写字母串（AC）；再取第一个片段，后面的都算解释。
  // 这样"因为 A 选项错误"里的孤立 A 不会连成列表，自然被排除。
  //
  // 为什么不能只取第一个字母串：「答案 + 解析」「完整功能」两档**主动要求**模型写解析、
  // 还鼓励推理，于是"因为 A、B 都不对，所以选 C""答案是 A 吗？不是。最终答案：C、D"
  // 这类句子很常见。只取第一个字母串会把被否定的选项当成答案勾上。
  function extractAnswerLetters(text, optionCount) {
    const limit = String.fromCharCode(64 + Math.min(26, Math.max(4, optionCount || 4)));
    const src = String(text || "");

    // 两个分支顺序不能换：连续字母串必须排在前面，
    // 否则 "AC" 会被前一个分支先匹配成单个 "A"，把 C 丢掉。
    // 分隔符含「与」（和/及的近义词），以及空格/制表 ——
    // "答案：A C" / "答案：A 与 C" 都是模型真实写法。
    // **不含**全角逗号「，」：中文里它是分句符，
    // 带上它会让"A 和 C，因为 B、D 都不对"被连成 A,C,B,D 一条长列表。
    // SEP 里带顶层 | 分支，插进模板时**必须**再包一层 (?:)，
    // 否则"后面的 [A-D]"会被并进最后一个分支，整条列表只剩第一个字母
    //（"答案：A、C、D" 会被取成 [0]，多选题只勾一个）。
    const SEP = "(?:[ \\t]*[、,和及/与][ \\t]*|[ \\t]+)";
    // 连写字母串的上限必须跟着**选项数**走，不能写死 {2,6}：
    // 选项一多（A~H 共 8 个）时"答案：ABCDEFGH"这种全选会被截成前 6 个，
    // 多选题直接漏勾最后两个。上限取 limit-64+1 即选项总数。
    const RUN_MAX = Math.min(26, Math.max(4, optionCount || 4));
    // 每个候选字母后面必须不是拉丁字母/数字，否则 "答案：Docker…" 里的 D、
    // "答案：CPU…" 里的 C 会被当成选项。连写多选（AC / ABC）仍由前面的
    // 连续串分支整体匹配，后面再跟单词边界检查。
    const re = new RegExp(
      `[A-${limit}]{2,${RUN_MAX}}(?![A-Za-z0-9])` +     // "AC" / "ABCDEFGH"
      `|[A-${limit}](?![A-Za-z0-9])(?:${SEP}[A-${limit}](?![A-Za-z0-9]))*`, // "A、C、D" / "A, C" / "A和C" / "A C" / "A 与 C"
      "g");
    const runOf = s => ((String(s).match(re) || [])[0] || "");   // 只看第一段，后面的字母都是解释
    const toIdx = s => [...new Set(String(s).match(new RegExp(`[A-${limit}]`, "g")) || [])]
      .map(ch => ch.charCodeAt(0) - 65);
    const pick = seg => {
      const hit = runOf(seg);
      if (!hit) return null;
      const out = toIdx(hit);
      return optionCount ? out.filter(i => i < optionCount) : out;
    };

    // ---- 小写字母兜底 ----
    // prompt 明确要求「大写选项字母」，正常回复都是大写；模型不遵守约定时会回
    // 「答案：c」，大写路径直接取不到 → 这道题判失败。这里补一道兜底：大写路径
    // **完全没取到**时，把整段转成大写再走一遍同样的解析。
    //
    // ⚠ 不能无脑全局 toUpperCase：题库里有选项本身就是英文字母的题
    // （驾考挡位题，如选项 ["D","P","N","R"]）。若把题干/选项一起大写，会污染
    // 这类题。所以这道兜底只作用于 **AI 回复文本**，且只在「大写一个都没取到」时
    // 才启用 —— 正常大写回复的行为不变。
    //
    // 代价与取舍：**不能**把整段无脑大写 —— 中文正文里夹带的英文单词也会被大写，
    // 其中的字母会被当成选项。例如「所谓 good 就是好的意思」大写后 GOOD 里
    // 有 D，4 选项时被取成选项 D（错误的勾选）。所以兜底必须是**有指向的**：
    // 只在大写路径完全没取到答案时，去「答案标记 / 肯定式线索」紧邻的小写字母里取，
    // 且该字母前后必须有分隔词（如「答案：c」），不能是英文单词内部的字母。
    const pickAny = seg => {
      const direct = pick(seg);
      if (direct && direct.length) return direct;
      const s = String(seg == null ? "" : seg);
      // 没有任何 ASCII 小写字母的段落不必重试（绝大多数中文解析属于这类，零开销）
      if (!/[a-z]/.test(s)) return direct;
      // 只在「答案/选项/选择」这类**明确指向答案**的标记后面找小写字母。
      // 关键约束：每个字母后面必须**不是**英文字母（避免把 good 里的 d、bad 里的 a 当成选项）。
      // 支持多选与列表写法（"答案：a、c" / "答案：abcd"），与上面的 SEP 规则保持一致。
      const lowSep = "(?:[ \\t]*[、,和及/与][ \\t]*|[ \\t]+)";
      const lowLimit = limit.toLowerCase();
      // ① 紧挨着的连写串（abcd）—— 要求最后一个字母后面也不是字母
      const runRe = new RegExp("[a-" + lowLimit + "]{2,}(?![a-zA-Z])", "i");
      // ② 列表式（a、c / a, c / a和c），每项都要求后面不是字母
      const listRe = new RegExp("[a-" + lowLimit + "](?![a-zA-Z])(?:" + lowSep + "[a-" + lowLimit + "](?![a-zA-Z]))*", "i");
      const cueHead = "(?:正确答案|答案|正确选项|应选|answer|选)\\s*(?:是|为|is|are|[:：])?\\s*";
      const toIndices = str => {
        const out = [...new Set(String(str).toLowerCase().match(new RegExp("[a-" + lowLimit + "]", "g")) || [])]
          .map(ch => ch.charCodeAt(0) - 97)
          .filter(i => !optionCount || i < optionCount);
        return out.length ? out.sort((x, y) => x - y) : null;
      };
      const runHit = s.match(new RegExp(cueHead + "(" + runRe.source + ")"));
      if (runHit) { const r = toIndices(runHit[1]); if (r) return r; }
      const listHit = s.match(new RegExp(cueHead + "(" + listRe.source + ")"));
      if (listHit) { const r = toIndices(listHit[1]); if (r) return r; }
      return direct;
    };

    // 三个防串味处理：
    //   (?<!不) 别把"不是 A"里的"是 A"当肯定式；
    //   (?<!因) 别把「因为」的"为"当线索；
    //   (?<!候) 别把「候选」的"选"当线索。
    // 这里的连写串上限同样要跟随选项数（与上面 re 的 RUN_MAX 同一个理由）：
    // 写死 {2,6} 会让"故选 ABCDEFGH"这种 8 选项全选只取到前 6 个。
    const cueRe = new RegExp(
      `(?<!不)\\s*(?:(?<!因)为|是|(?<!候)选|应选|answer)\\s*[:：]?\\s*([A-${limit}]{2,${RUN_MAX}}(?![A-Za-z0-9])|[A-${limit}](?![A-Za-z0-9])(?:${SEP}[A-${limit}](?![A-Za-z0-9]))*)`,
      "gi");
    const NEGATED = /不对|不是|不选|并非|错误|排除/;

    // ---- 否定语境的安全取法（宁缺勿错）----
    //
    // 段内出现否定词时，先找「肯定式线索」（"不是 A，是 C" 取 C），
    // 但**找不到线索时会直接退回 pickAny(seg)**，于是把被否定的字母本身当成了答案：
    //   "答案不是 A。"        → A ❌（模型明说不是 A，却勾了 A）
    //   "答案是 A 吗？不是。"  → A ❌
    // 填涂不可逆，勾错比不勾严重得多。所以否定语境下取不到肯定答案时，
    // **必须返回 null**，让上层把这道题判为"未取到答案"，而不是硬填一个错的。
    //
    // 三种情况分开处理：
    //   ① 段内有肯定式线索（"不是 A，是 C"）      → 用线索后面的字母
    //   ② 否定词之前已有字母（"C。解析：A 错误"）   → 用否定词**之前**的第一个字母串
    //   ③ 整段都在否定语境里（"答案不是 A。"）      → 返回 null，绝不填
    const pickSafe = seg => {
      const s = String(seg == null ? "" : seg);
      if (!NEGATED.test(s)) return pickAny(s);
      // ① 肯定式线索优先
      const cues = [...s.matchAll(cueRe)];
      if (cues.length) {
        const out = pickAny(cues[cues.length - 1][1]);
        if (out && out.length) return out;
      }
      // ② 只认第一个否定词**之前**的字母
      const firstNeg = s.search(NEGATED);
      if (firstNeg > 0) {
        const before = s.slice(0, firstNeg);
        // ⚠ 但「疑问式否定」要排除：字母后面跟「吗/呢/吧」或问号，说明这是在**提问**，
        // 不是在给答案 —— 「答案是 A 吗？不是。」里的 A 是被否定的选项。
        // （填涂不可逆，这种句子必须判为取不到答案，而不是把 A 勾上。）
        const questioning = /[吗呢吧]/;
        const letterEnd = before.search(/[A-Za-z](?![A-Za-z])/);
        if (letterEnd >= 0) {
          const tail = before.slice(letterEnd + 1, letterEnd + 8);
          if (!questioning.test(tail) && !/[?？]/.test(tail)) {
            const out = pickAny(before);
            if (out && out.length) return out;
          }
        }
      }
      // ③ 没有任何可信的肯定答案
      return null;
    };

    // 取一段文字里的答案。段内出现否定时，答案在被**肯定**的那部分：
    // "不是 A，是 C" → 取 C 而不是 A。没有否定就直接取第一个字母串。
    const pickSeg = pickSafe;

    // ---- ① 显式答案标记优先，且**取最后一个** ----
    // 为什么取最后一个：「答案 + 解析」「完整功能」模式会主动让模型写解析，
    // 而 full 模式还鼓励"充分推理"，于是模型常把推理写进正文并自我纠正：
    //   "答案是 A、B 吗？不是。最终答案：C、D"
    //   "答案：A、B\n\n再检查一下……\n答案：C、D"
    // 只认第一个「答案」就会取到被推翻的 A、B → 把错误选项勾上（填涂不可逆，最贵的错法）。
    //
    // 捕获组必须**非贪婪 + 前瞻停在下一个标记**：贪婪的 [^\n]{0,80} 会把同一行里
    // 后面的"最终答案：C、D"一起吞进来，取到被推翻的 A、B。
    const markRe = new RegExp(
      "(?:正确答案|答案|正确选项|应选|answer)\\s*(?:是|为|is|are|[:：])?\\s*([^\\n]{0,80}?)" +
      "(?=(?:正确答案|答案|正确选项|应选|answer)|[\\n]|$)",
      "gi");
    const marks = [...src.matchAll(markRe)];
    if (marks.length) {
      const out = pickSeg(marks[marks.length - 1][1]);
      if (out && out.length) return out;
    }

    // ---- ② 没有显式标记时，才用肯定式线索 ----
    // 必须放在标记之后：像"候选：A、B、C、D 都有可能。答案：C、D"这种句子，
    // 线索词会把"候选"里的"选"误当成"选 A、B、C、D"，抢在真正的答案标记前面。
    const cues = [...src.matchAll(cueRe)];
    if (cues.length) {
      // 整段带否定词时答案在最后（"不是 A，是 C"）；否则在第一个（"故选 C"）
      const idx = NEGATED.test(src) ? cues.length - 1 : 0;
      const out = pickAny(cues[idx][1]);
      if (out && out.length) {
        // ⚠ 关键：线索字母可能**紧接着就被否定**。
        //   "答案是 A 吗？不是。"  → cueRe 捕获到 "A"，但 A 后面 3 个字符内就是「不是」
        //   "选A不对"            → 同理
        // 这种情况下 A 是被否定的选项，绝不能当答案返回。判据看**线索匹配位置之后**的
        // 一小段文本（而不是整段），才区分得开「A 被否定」和「A 是答案、别处提到否定」。
        const after = src.slice(cues[idx].index + cues[idx][0].length, cues[idx].index + cues[idx][0].length + 6);
        if (NEGATED.test(after)) return [];
        return out;
      }
      // 线索指向却取不到字母、且整段带否定 → 不退回第一行硬填（第一行可能就是被否定的那句）
      if (NEGATED.test(src)) return [];
    }

    // ---- ③ 什么都没有：退回第一行（约定俗成的答案行）----
    const firstLine = src.split(/\n+/).map(s => s.trim()).filter(Boolean)[0] || "";
    // 第一行也必须走否定安全取法："答案不是 A。" 不能被退回第一行后重新取成 A。
    return pickSafe(firstLine) || [];
  }

  // ---------- 取答案：题库优先，未命中再走 AI 兜底 ----------
  // radio 组（单选/判断题）只接受恰好一个字母。
  //
  // 为什么判在 resolveAnswer 而不是写入层：勾下去就不可逆，而"多个字母"只有两种来源
  //   ① 模型确实回了多选（它对单选题就该只回一个，属于回复质量问题）；
  //   ② 解析里被否定的选项也被当成了答案。
  // 两种情况下"取第一个还是取最后一个"纯看运气，比取到哪个更糟的是它照样落进页面。
  // 这里判成"本题没取到答案"，卡片与日志会如实显示失败，由用户自己决定勾哪个。
  // checkbox 与没有 input 的纯选项列表不在本判据内（那两类本来就可能是多选）。
  function enforceSingleChoice(q, res) {
    if (!res || !res.answer || res.answer.length < 2) return res;
    const inp = (q && q.inputs || []).find(Boolean);   // 本地结构的 inputs 里可能混着 null
    if (!inp || String(inp.type).toLowerCase() !== "radio") return res;
    const letters = res.answer.map(i => String.fromCharCode(65 + i)).join("、");
    return {
      answer: null, raw: res.raw, explain: res.explain, reasoning: res.reasoning,
      error: `单选题只该有一个答案，这次取到 ${res.answer.length} 个字母（${letters}），已跳过不勾`,
    };
  }

  // 「开始答题」和扫描面板的「填涂」共用这一份，避免各写一套导致行为不一致。
  // 返回 { answer, how } 或 { answer: null, error? }
  async function resolveAnswer(q, settings) {
    // 这一题有几个空（填空题用）。多空时"取到几行"必须够数才算答上。
    const needBlanks = (q && q.blankInputs || []).length || 1;
    // 填空题：先查题库（题库里可以存填空题），命中直接写，未命中再走 AI。
    if (q.fillText) {
      if (settings.mode !== "ai") {
        const hitB = matchBlankInBank(q);
        if (hitB) {
          // 空数与答案数不一致时不能硬填：题库存 1 个答案、页面有 3 个空，
          // 多出来的空会被留空，用户看到"填了一半"。这种情况按未命中处理，交给 AI。
          const need = (q.blankInputs || []).length;
          if (!need || hitB.texts.length === need) {
            return {
              texts: hitB.texts,
              how: hitB.exact ? "题库·精确" : "题库·模糊",
              score: hitB.exact ? 1 : hitB.score,
              raw: hitB.texts.join(" / "),
            };
          }
        }
      }
      if (settings.mode === "bank") {
        return { answer: null, error: "填空题只能靠 AI。请把模式改成「题库 + AI 兜底」或「仅 AI」并填好 API Key，然后重新扫描" };
      }
      if (!settings.aiKey) return { answer: null, error: "填空题需要 API Key" };
      try {
        const r = await askAIFill(q, settings);
        // texts 是**清洗过的答案行**（多空时按行取前 n 行），填涂只认它；
        // raw/explain 只给面板显示用，绝不参与写入。
        // 注意 texts 可能是 null（模型两次都拒答，askAIFill 会显式返回 null 并带 error），
        // 所以这里必须先判空再取 length，否则会抛 "Cannot read properties of null"。
        //
        // ⚠ 多空时条数不够要**照写但不算答完**：只判 `texts.length` 的话，2 个空
        // 只回 1 行也记成功，第二个空留白、卡片与汇总却报「✓ 已填涂」，用户以为答完了
        // 直接交卷。这里不推翻那一行的作答（它是对的，丢掉更糟），而是把"还差几个空"
        // 标出来，由调用方计入未答并说清楚。
        if (r && r.texts && r.texts.length) {
          const short = needBlanks > 1 ? Math.max(0, needBlanks - r.texts.length) : 0;
          return {
            texts: r.texts, raw: r.raw, explain: r.explain, reasoning: r.reasoning,
            how: "AI·填空", incomplete: short || undefined,
          };
        }
        return {
          answer: null, reasoning: r && r.reasoning,
          explain: r && r.explain,
          error: (r && r.error) || "AI 没返回内容",
        };
      } catch (e) {
        return { answer: null, error: e.message };
      }
    }

    if (settings.mode !== "ai") {
      const hit = matchInBank(q.stemText, q.optionTexts);
      if (hit && hit.answer && hit.answer.length) {
        // score 一并透传：模糊命中的 0.76 和 0.94 不是一回事，调用方要能显示出来
        return enforceSingleChoice(q, { answer: hit.answer, how: hit.exact ? "题库·精确" : "题库·模糊", score: hit.exact ? 1 : hit.score });
      }
      // 题库压根没加载成功时，别让用户看到"未匹配"这种误导性说法——
      // 那是"没有这道题"，而这是"整个题库都没拿到"，处理方式完全不同。
      // ⚠ 但只有**纯题库模式**才到此为止：mixed 的语义就是"题库 + AI 兜底"，
      // 题库挂了必须继续问 AI。mixed 下早退会让一次 AI 都不调、
      // 整页 0 答案，而提示还叫用户"改用「题库 + AI 兜底」"——他本来就在这一档。
      if (!bankIndex && !q.fillText && settings.mode === "bank") {
        return { answer: null, error: "题库没有加载成功（见上方日志），不是这道题没收录。可填「题库地址」，或改用「仅 AI」模式" };
      }
    }
    if (settings.mode === "ai" || settings.mode === "mixed") {
      try {
        const r = await askAI(q, settings);
        // 关键：只有 r.answer（选项下标数组）会进入填涂路径。
        // r.raw / r.explain 是模型的完整回复，里面有"因为 A 选项错误"这类字母，
        // 一旦被当成答案就会把 A、B 一起勾上。
        return r.answer && r.answer.length
          ? enforceSingleChoice(q, { answer: r.answer, raw: r.raw, explain: r.explain, reasoning: r.reasoning, how: "AI" })
          : { answer: null, raw: r.raw, explain: r.explain, reasoning: r.reasoning,
              error: r.error || "AI 没解析出选项字母（回复格式不符合要求）" };
      } catch (e) {
        return { answer: null, error: e.message };
      }
    }
    return { answer: null };
  }

  // 面板填涂用的设置：从 storage 读（扫描模式启动时 popup 已把配置写进去）
  async function loadFillSettings() {
    const keys = ["mode", "answerMode", "interval", "fuzzyThreshold", "concurrency", "concurrentEnabled", "overwriteSelected", "aiBaseUrl", "aiKey", "aiModel", "visionModel", "bankBaseUrl"];
    const st = await chrome.storage.local.get(keys).catch(() => ({})) || {};
    return {
      mode: st.mode || "bank",
      answerMode: normAnswerMode(st.answerMode),
      intervalMs: Math.max(0, Number(st.interval) || 0) * 1000,
      fuzzyThreshold: Number(st.fuzzyThreshold) || 75,
      // 并发开关：关掉 = 串行（等价于并发数 1）；配置里没有这个字段时按"开"处理
      concurrentEnabled: st.concurrentEnabled !== false,
      overwriteSelected: st.overwriteSelected === true,
      // 并发数：1~5，上限锁 5（见 popup 的说明）
      concurrency: Math.max(1, Math.min(5, Number(st.concurrency) || 3)),
      aiBaseUrl: st.aiBaseUrl || "https://api.deepseek.com",
      aiKey: st.aiKey || "",
      aiModel: st.aiModel || "deepseek-chat",
      visionModel: st.visionModel || "",
      bankBaseUrl: st.bankBaseUrl || "",
    };
  }

  // 选择题的题干：同样两个字段都要认，空题干直接拒绝（交由调用方报错）。
  function choiceStem(q) {
    const s = stemOf(q);
    if (!s) throw new Error("没识别到这道题的题干，为避免瞎答已跳过，请手动作答");
    return s;
  }

  // 填空题的题干：优先 stem，其次 stemText。
  // 两道来源都要认 —— 不同识别策略产出的字段名不一样（.q-stem 结构给 stemText，
  // scanTextInputs 给 stem）。只认一个就会漏，P2 就是这么来的。
  function stemOf(q) {
    return String((q && (q.stem || q.stemText)) || "").trim();
  }

  // ---------- 填空题：问 AI 要"内容"而不是字母 ----------
  // 和选择题的 prompt 完全不同（选择题只准回字母，填空题必须回内容），所以单独一份。
  // blanks > 1 时要求按空逐行输出。
  async function askAIFill(question, settings) {
    const mode = answerModeOf(settings);
    const n = (question.blankInputs || []).length || 1;
    // 硬闸门：题干为空就**绝不发请求**。
    // 为什么必须拦：模型收到一道没有题目的填空题，会照着"看起来像答案"瞎编一句，
    // 而那句话会被原样写进输入框、界面还显示"已答完"，用户从任何界面都看不出异常。
    // 填涂是不可逆的，宁可如实报"没识别到题干，请手动填"，也不能塞一个编的答案。
    const stem = stemOf(question);
    if (!stem) {
      return { texts: null, raw: "", explain: "", reasoning: "",
        error: "没识别到这道填空题的题干，为避免瞎填已跳过，请手动填写" };
    }
    const blocks = [];
    if (question.passage) blocks.push("【阅读材料】\n" + question.passage);
    if (question.options && question.options.length) blocks.push("【备选词库】\n" + question.options.join("\n"));
    blocks.push(stem);

    // 答案部分：answer 模式与 standard/full 模式完全一样（填空答案不能省），
    // 差别只在 standard/full 允不允许再补一段「解析：」——而 cleanFillTexts
    // 是按行取前 n 行的，所以解析必须另起一行并带标记，否则会被当成第 2 个空的答案。
    const freeKind = question.freeTextKind || (question.freeText ? "text" : "");
    const freeRule = freeKind === "rewrite"
      ? "只输出改写后的完整句子：保持原意，按题目要求变换语态、句型或时态；不要题号、不要解释、不要引号，就一行。"
      : freeKind === "correct"
        ? "只输出改正后的完整句子：找出并改正句中的错误；不要题号、不要解释、不要引号，就一行。"
        : freeKind === "essay"
          ? "只输出应该写下的完整答案正文：可以分多段，保留条目与换行；不要题号、不要选项字母、不要解释、不要引号。"
        : freeKind
          ? "只输出应该写下的完整答案：不要题号、不要解释、不要引号，就一行。"
          : "";
    const rule = freeKind ? freeRule : (n > 1
      ? `这道题有 ${n} 个空。**每个空输出一行，按空的先后顺序**，行首带上空号，如「1. 北京」。`
      : "只输出应该填入的内容本身：不要题号、不要选项字母、不要引号，就一行。");

    const tail = freeKind
      ? (mode === "answer"
          ? "不要输出答案之外的任何文字，不要解释。"
          : "写完答案之后，空一行再以「解析：」开头另起一段写解析。" +
            (mode === "full"
              ? "解析要详细：说明依据、推理过程与易错点，并指出答案为什么唯一。"
              : "解析要简明（不超过 150 字），说清答案依据即可。"))
      : (mode === "answer"
          ? "不要输出空之外的任何文字，不要解释。"
          : (n > 1
              ? "写完所有空之后，**空一行**再以「解析：」开头另起一段写解析；解析里不要再出现「数字. 」这种行首格式，免得被当成答案行。"
              : "空一行后以「解析：」开头另起一段写解析。") +
            (mode === "full"
              ? "解析要详细：说明依据、推理过程与易错点，并指出答案为什么唯一。"
              : "解析要简明（不超过 150 字），说清答案依据即可。"));

    const lead = freeKind
      ? (freeKind === "rewrite" ? "用户给的是一道句子改写题。"
        : freeKind === "correct" ? "用户给的是一道改错题。"
        : freeKind === "essay" ? "用户给的是一道简答题。"
        : "用户给的是一道文字作答题。")
      : "用户给的是一道填空题。";
    const systemContent = "你是答题助手。" + lead + rule +
      "如果给了【备选词库】，从词库里挑一个原样输出。" + tail + PLAIN_TEXT_MATH;

    const reply = await chrome.runtime.sendMessage({
      type: "AI_CHAT",
      payload: {
        baseUrl: settings.aiBaseUrl || "https://api.deepseek.com",
        key: settings.aiKey || "",
        model: settings.aiModel || "deepseek-chat",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: blocks.join("\n\n") }
        ],
        think: isThinkMode(mode)
      }
    });
    if (!reply || !reply.ok) throw new Error(reply?.error || "后台无响应，请刷新插件后重试");
    const raw = cleanRaw(reply.text);
    const parts = splitAiExplanation(raw);
    // texts 只从 parts.body 里取：解析那一段永远进不了填空框。
    // 多空时优先取"带空号行首"的那些行：prompt 明确要求「1. 北京」这种格式，
    // 于是模型在答案前多写一行说明（"这道题考地理常识。"）时也不会把说明当成第 1 个空。
    // 只有凑够 n 行才启用，否则回退到按行取法，不改变既有的容错行为。
    let body = parts.body;
    if (n > 1) {
      const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
      const numbered = lines.filter(l => /^\s*(?:第\s*)?\d{1,3}\s*(?:空|题)?\s*[.、．)）:：]\s*(?!\d)\S/.test(l));
      if (numbered.length >= n) body = numbered.join("\n");
    }
    const texts = freeKind === "essay" ? cleanEssayTexts(body) : cleanFillTexts(body, n);
    if (!looksLikeRefusal(texts.join(" "))) {
      return {
        texts, raw, explain: parts.explain,
        reasoning: cleanRaw(reply.reasoning), thinkDowngraded: !!reply.thinkDowngraded
      };
    }

    // 模型拒答（"无法判断""题目未提供题干""请补充完整题目"…）时自动重问一次。
    //
    // 模型偶尔会这样回一句，如果把它当成最终答案缓存下来，卡片会显示"无法判断"，
    // 再点一下才拿到答案；更糟的是这段套话还会被 cleanFillTexts 当成"答案"写进卡片。
    // 与其让用户自己点第二次，不如这里直接重试一轮；仍失败才如实报错。
    const retry = await chrome.runtime.sendMessage({
      type: "AI_CHAT",
      payload: {
        baseUrl: settings.aiBaseUrl || "https://api.deepseek.com",
        key: settings.aiKey || "",
        model: settings.aiModel || "deepseek-chat",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: blocks.join("\n\n") },
          // 把上次的拒答作为**反面示例**塞回去，明确要求直接给答案
          { role: "assistant", content: raw.slice(0, 200) },
          { role: "user", content: "刚才你没有直接给出答案。题目内容就是上面这些，信息是完整的，请**直接作答**，不要再要求补充题干。" }
        ],
        think: isThinkMode(mode)
      }
    });
    if (retry && retry.ok) {
      const raw2 = cleanRaw(retry.text);
      const parts2 = splitAiExplanation(raw2);
      let body2 = parts2.body;
      if (n > 1) {
        const lines2 = body2.split(/\n+/).map(s => s.trim()).filter(Boolean);
        const numbered2 = lines2.filter(l => /^\s*(?:第\s*)?\d{1,3}\s*(?:空|题)?\s*[.、．)）:：]\s*(?!\d)\S/.test(l));
        if (numbered2.length >= n) body2 = numbered2.join("\n");
      }
      const texts2 = freeKind === "essay" ? cleanEssayTexts(body2) : cleanFillTexts(body2, n);
      if (!looksLikeRefusal(texts2.join(" "))) {
        return {
          texts: texts2, raw: raw2, explain: parts2.explain,
          reasoning: cleanRaw(retry.reasoning), thinkDowngraded: !!retry.thinkDowngraded, retried: true
        };
      }
    }

    // 重试仍拒答：如实返回错误，让卡片显示"没取到答案"而不是把套话当答案。
    return {
      texts: null, raw, explain: parts.explain,
      reasoning: cleanRaw(reply.reasoning), thinkDowngraded: !!reply.thinkDowngraded,
      error: "模型没有直接给答案（它回的是：「" + raw.slice(0, 30) + "…」），重试一次仍未给出。可再点一次「答」"
    };
  }

  // 模型"拒答/要补充题干"的识别。这些回复的共同特征：不是答案内容，而是一句解释。
  // 只在填空题路径用（选择题有自己的 extractAnswerLetters，取不到字母会走另一条路）。
  function looksLikeRefusal(text) {
    const s = String(text || "").trim();
    if (!s) return true;                       // 空 = 等同没答出来
    return /无法(判断|确定|作答|给出)|不能(判断|确定|作答)|没有(提供|给出)|未(提供|给出)|请补充|补充完整|题干(不足|不完整|缺失)|信息不足|缺少(题干|上下文)|无法从|抱歉|作为一个(AI|人工智能)|I (can'?t|cannot)/i.test(s);
  }

  // 填空答案清洗：按行取，剥掉行首的答案标记、空号/题号、行尾引号。
  // 多空时不足就留空（不猜），多了截断——宁可少写，也不要把答案写错位。
  //
  // 「剥行首编号」必须要求编号后面**不是数字**：答案本身就是小数的题太常见了，
  // 否则 "3.14" 会被剥成 "14"、"0.5" 剥成 "5"，写进框里从界面看不出异常。
  // 同理 "2、3"（一个空里填两个数）不能被当成"第 2 空"。
  const ANSWER_HEAD = /^\s*(?:正确答案|答案|应选|填空答案|答)\s*(?:是|为|[:：])\s*/;
  const NUMBER_HEAD = /^\s*(?:第\s*)?\d{1,3}\s*(?:空|题)?\s*[.、．)）:：]\s*(?!\d)/;
  // 简答/论述：答案可能有多段，不能按“单个空只取第一行”截断。
  // 只剥掉行首的「答案：」标记和代码围栏，保留段落与换行。
  function cleanEssayTexts(text) {
    let s = String(text || "").trim();
    if (!s) return [];
    s = s.replace(ANSWER_HEAD, "").trim();
    s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```\s*$/, "").trim();
    return s ? [s] : [];
  }

  function cleanFillTexts(text, n) {
    const lines = String(text || "").split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.replace(ANSWER_HEAD, "")
                 .replace(NUMBER_HEAD, "")
                 .replace(/^["'“”‘’【\[（(]+|["'“”‘’】\]）)]+$/g, "")
                 .trim())
      .filter(Boolean);
    if (n > 1) return lines.slice(0, n);
    // 单空时，以冒号收尾的行是模型的前言（"我的思路是：" / "分析如下："）而不是答案。
    // 无条件取第一行会把这种前言原样写进输入框。
    const value = lines.find(s => !/[:：]\s*$/.test(s)) || lines[0] || "";
    return value ? [value] : [];
  }

  // 把文字写进填空框（一个或多个空）。
  // 关键：React/Vue 的受控组件必须走原生 setter —— 直接 el.value = x 框架收不到，
  // 界面上看着写进去了、提交时是空的。这与"直接改 checked 不生效"是同一类问题。
  //
  // 写完必须**回读**：type=number 的输入框会静默拒绝 "3/4"、"1,5" 这类值（把它清空），
  // 不回读就会报成"已填涂"而框里其实是空的。回读不符时不记成功，
  // 但仍记 filledEls —— 同一个值再写一遍也还是同样结果，别浪费请求；
  // 只是从此如实说"这一空要手动填"。
  // UEditor 旁边那个隐藏 textarea 是提交时表单真正读走的值。
  // 直接改 iframe body 不一定触发 UEditor 自己的 sync，所以两边都写一份。
  function syncBlankTarget(q, i, text) {
    const target = (q.blankSyncTargets || [])[i];
    if (!target || !text) return;
    try {
      const win = winOf(target);
      const proto = target.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, text);
    } catch (_) {
      try { target.value = text; } catch (_) {}
    }
    const w = winOf(target);
    target.dispatchEvent(new w.Event("input", { bubbles: true }));
    target.dispatchEvent(new w.Event("change", { bubbles: true }));
  }

  function fillBlankTexts(q, texts) {
    const inputs = q.blankInputs || [];
    if (!inputs.length || !texts || !texts.length) return 0;
    let n = 0;
    inputs.forEach((el, i) => {
      const text = texts[i];
      if (!el || !text) return;
      if (writtenOk.has(el)) { syncBlankTarget(q, i, text); n++; return; } // 上一轮回读确认过：不重写、不重问
      if (filledEls.has(el)) return;                 // 写过但页面没接住：不重复写同一个值
      if (el.isContentEditable) {
        // 多段答案按段落写进去：direct textContent 会把换行压成一行，
        // UEditor.getContent() 读到的也就不是用户看到的排版。
        const html = String(text).split(/\r?\n/)
          .map(line => `<p>${line ? escapeHtml(line) : "<br>"}</p>`).join("");
        try {
          el.focus();
          el.innerHTML = html;
        } catch (_) {
          try { el.textContent = text; } catch (_) {}
        }
        const w = winOf(el);
        try {
          el.dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        } catch (_) {
          el.dispatchEvent(new w.Event("input", { bubbles: true }));
        }
        el.dispatchEvent(new w.Event("change", { bubbles: true }));
        filledEls.add(el);
        // 富文本会包 <p>，textContent 不再逐字相等；按去掉空白后的内容核对。
        if (String(el.textContent || "").replace(/\s+/g, "") === String(text).replace(/\s+/g, "")) {
          writtenOk.add(el);
          n++;
        } else {
          log(`[失败] 富文本作答框没有接住「${text}」，请手动填写`, "var(--c-danger)");
        }
        syncBlankTarget(q, i, text);
        return;
      }
      try {
        // 元素可能在同源 iframe 里：构造器和原型都必须取它自己文档的 window，
        // 用顶层 realm 的 HTMLInputElement 会抛 Illegal invocation。
        const win = winOf(el);
        const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, text);
      } catch (_) {
        el.value = text;
      }
      const w = winOf(el);
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      el.dispatchEvent(new w.Event("change", { bubbles: true }));
      filledEls.add(el);
      if (String(el.value) === String(text)) {
        writtenOk.add(el);
        n++;
      } else {
        log(`[失败] 填空被页面拒绝：要写「${text}」，回读是「${el.value}」（type=number 常会吞分数/带单位的答案），这一空请手动填`, "var(--c-danger)");
      }
    });
    return n;
  }

  // ---------- 页面操作 ----------
  // 本页题卡结构的题目块。注意：这里**必须**只认"内容完整"的块，不能只数元素个数。
  // 不能直接 querySelectorAll(".question") 就返回：.question 是真实网站上
  // 极其常见的类名（FAQ、考试系统、帮助中心都在用）。一旦页面碰巧有这类元素，
  // 但里面没有 .q-stem/.opt，extractQuestion 会返回一堆 {stemText:"", optionTexts:[]}
  // 的空壳题 —— 调用处又用 `if (!questions.length)` 判断要不要走通用识别，
  // 空壳题 length > 0 就把通用识别整个跳过了：既不报错也不降级，整页一道题都答不出。
  function getQuestionBlocks() {
    const blocks = scanEachDoc(() => [...rootDoc().querySelectorAll(".question")]).flat();
    // 阅读理解/完形填空的材料也要挂上（与通用路径同一份规则，见 attachPassages）。
    // 少了这一步，任何使用 .question/.q-stem 结构的网站上的阅读题，
    // 发给模型的都是一道没头没脑的题干。
    return attachPassages(
      blocks
        .map(extractQuestion)
        .filter(isUsableLocalQuestion)
    );
  }

  // 空壳判定：题干为空、且没有任何选项/填空框 → 这不是题，只是撞了类名。
  // 题干允许空的情况：完形填空这类题面就是选项本身（有 options 即可）。
  function isUsableLocalQuestion(q) {
    if (!q) return false;
    const hasStem = !!(q.stemText && q.stemText.trim());
    const hasOpts = !!(q.optionTexts && q.optionTexts.some(t => t && t.trim()));
    const hasInputs = !!(q.inputs && q.inputs.some(Boolean));
    const hasBlanks = !!(q.blankInputs && q.blankInputs.length);
    if (!hasStem && !hasOpts && !hasInputs && !hasBlanks) return false;   // 纯空壳
    return hasStem || hasOpts || hasBlanks;
  }

  // .q-stem 结构页面上没有单独题干元素时的兜底：把题目容器里除选项/输入框之外
  // 的文字当题干。填空题常见的排版是「题干和输入框在同一个 div、题干没套 .q-stem」，
  // 这种情况会得到空题干。
  function localStemFallback(div) {
    // 直接遍历文本节点拼题干，**不用 cloneNode**：
    //   ① 省一次整棵子树的深拷贝（大页面下这点开销不白花）；
    //   ② 不依赖克隆实现 —— 某些最小 DOM 环境没有 cloneNode，
    //      用它会让这段兜底静默失效（被 try/catch 吞掉返回空串）。
    const SKIP = /^(opt|blanks|blank-item|explanation|q-tag|q-num|script|style)$/;
    const SKIP_TAG = /^(input|textarea|select|option|button|script|style)$/i;
    const parts = [];
    const walk = node => {
      if (!node) return;
      if (node.nodeType === 3) { parts.push(node.data || ""); return; }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || "").toLowerCase();
      if (SKIP_TAG.test(tag)) return;
      const cls = String((node.getAttribute && node.getAttribute("class")) || "");
      if (cls && cls.split(/\s+/).some(c => SKIP.test(c))) return;
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(div);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function extractQuestion(div) {
    const stemEl = div.querySelector(".q-stem");
    const optionEls = [...div.querySelectorAll(".opt")];
    // ⚠ 题干必须**同时**写进 stemText 和 stem 两个字段：
    //   stemText —— 选择题路径（askAI）、卡片显示、材料挂接的判据；
    //   stem     —— 填空题路径（askAIFill 的 blocks.push(question.stem)）。
    // 只写 stemText 的话，.q-stem 结构页面上的填空题交给模型的题干是空字符串，
    // 模型对着空题目瞎猜，答案照样写进输入框、界面还报「已作答」，用户完全看不出异常。
    // 题干兜底只对**有可填控件**的块生效（见 localStemFallback 的注释）。
    // 这点是空壳过滤能否生效的关键：兜底会把这个 div 里的任意文字
    // 都收成题干，于是撞了类名的 FAQ 块也会得到非空 stemText，
    // isUsableLocalQuestion 的 hasStem 立刻为真 —— 空壳过滤形同虚设，
    // 整页会多出若干"假题"，还会吃掉本该给真题的 AI 回复（顺序错位）。
    const stemText = stemEl
      ? stemEl.textContent.trim()
      : (div.querySelector("input, textarea, select, .opt") ? localStemFallback(div) : "");
    const out = {
      div,
      el: div,                     // attachPassage/findPassage 统一按 el 找材料，这里给个别名
      stemText,
      stem: stemText,
      inputs: optionEls.map(o => o.querySelector("input")),
      optionTexts: optionEls.map(o => o.querySelector(".opt-text")?.textContent.trim() || "")
    };
    // 填空题：一题可能有多个空（一个空一个输入框），按 DOM 顺序收齐
    const blankInputs = [...div.querySelectorAll("input.blank-input, textarea.blank-input")];
    if (blankInputs.length) {
      out.fillText = true;
      out.blankInputs = blankInputs;
    }
    // 句改/改错/翻译这类自由文本题：没有 A/B/C/D，但块里有文字输入框。
    if (!out.fillText) {
      const freeInputs = [...div.querySelectorAll("input, textarea, [contenteditable]")]
        .filter(el => isFillInput(el) && visibleEl(el) && !looksLikeFormField(el) && looksLikeFreeTextInput(el));
      if (freeInputs.length) {
        out.fillText = true;
        out.blankInputs = freeInputs;
        out.freeText = true;
        const rich = extractStemText(div, freeInputs).replace(/\s+/g, " ").trim();
        if (rich && normText(rich).length >= 6 && normText(rich).length <= 500) {
          out.stemText = rich;
          out.stem = rich;
        }
        out.freeTextKind = freeInputs.some(isCorrectTextInput) ? "correct"
          : looksLikeRewriteStem(out.stem) ? "rewrite" : "text";
      }
    }
    return out;
  }

  function pick(q, answerIndexes) {
    const chosen = new Set(answerIndexes);
    let ok = 0;
    q.inputs.forEach((input, i) => {
      if (!input) return;                 // .opt 里没有 input 的排版会得到 null
      const want = chosen.has(i);
      if (input.checked !== want) {
        input.checked = want;
        // 直接赋值被框架立刻改写回去（React/Vue 受控组件）→ 改走真实点击。
        // 直接赋值能生效的页面不会走到这一支。
        if (input.checked !== want) setOptionState(input, want);
      }
      if (want && input.checked === want) ok++;
    });
    if (q.div) q.div.dispatchEvent(new (winOf(q.div).Event)("change", { bubbles: true }));
    return ok;
  }

  // 扫描面板的题目对象来自四条策略，字段名各不相同（有的叫 stem，有的叫 options）。
  // 取答案前统一成 run() 认的格式，否则 askAI 会因为读不到 optionTexts 直接抛错。
  function normalizePanelQuestion(q) {
    return Object.assign({}, q, {
      stemText: q.stemText || q.stem || "",
      optionTexts: q.optionTexts || q.options || [],
    });
  }

  // 这道题有没有"可以点"的东西：  //   有 input 控件（含被 CSS 隐藏的）→ 能
  //   有独立选项元素（<li>A. xxx</li>）→ 能
  //   选项挤在同一段文本里 / 下拉 / 填空框 → 不能，只能显示答案
  function canFill(q) {
    return !!((q.inputs && q.inputs.length) || (q.optEls && q.optEls.length)
      || (q.blankInputs && q.blankInputs.length));
  }

  // 把答案落到页面上：填空题写文字（可多个空），选择题点选项。
  // byClick=true（扫描面板用）时一律模拟真实点击；false（开始答题）优先直接改属性。
  function applyAnswer(q, res, byClick) {
    if (!res) return 0;
    if (res.texts) return fillBlankTexts(q, res.texts);
    return byClick ? fillOneByClick(q, res.answer) : fillOne(q, res.answer);
  }

  // 面板路径的每题间隔：优先用 popup 的「每题间隔」；读不到时退回 400ms（防连点抢跑）。
  // 0 是合法值（用户明确要求不额外等待），所以不能用 `|| 400`。
  function panelGap(settings) {
    const ms = Number(settings && settings.intervalMs);
    return Number.isFinite(ms) && ms >= 0 ? ms : 400;
  }

  // AI 并发度：**三条流水线（开始答题 / 出答案 / 填涂）共用这一份解析**。
  //
  // 并发设置必须在所有会发 AI 请求的地方生效：只接到 run() 上，而面板的
  // 「⚡ 出答案」「✍ 填涂」两个循环照旧串行的话，用户从面板走时开关和数字怎么调
  // 都毫无效果，看起来就像"并发是写死的"。同一设置项不能有两套行为。
  //
  // 语义：
  //   · concurrentEnabled === false → 1（完全串行）
  //   · 否则取 concurrency，夹在 1~5
  //   · 缺省 3
  const MAX_CONCURRENCY = 5;
  function resolveConcurrency(settings) {
    if (settings && settings.concurrentEnabled === false) return 1;
    const n = Number(settings && settings.concurrency);
    return Math.max(1, Math.min(MAX_CONCURRENCY, Number.isFinite(n) && n > 0 ? n : 3));
  }

  // 把 resolveAnswer 的结果转成一句给人看的话（日志/卡片共用）
  function answerToText(res) {
    if (!res) return "";
    if (res.texts) return res.texts.join(" / ");
    return (res.answer || []).map(i => String.fromCharCode(65 + i)).join("");
  }

  // 面板要显示的解析文字。选择题的回复第一行是「答案：C」，而答案已经单独显示过一行了，
  // 这里把它去掉，避免同一句话在卡片上出现两遍。
  // 注意：这段文字**只用于显示**，填涂永远只看 res.answer / res.texts。
  function explainForDisplay(res) {
    if (!res) return "";
    // 填空题：res.explain 已经是切好的解析段（答案本身由 texts 显示）。
    // 这里**不能**回退到 res.raw —— answer 模式下模型只回一个词，
    // 回退就会把答案原样再显示一遍，看着像重复渲染。
    if (res.texts) return String(res.explain || "").trim();
    // 选择题：题库命中没有解析（res.explain/raw 都是 undefined），AI 作答才有原文。
    const text = String(res.explain || res.raw || "").trim();
    if (!text) return "";
    const lines = text.split(/\n/);
    // 第一行就是答案行时整行去掉 —— 答案已经由 answerToText 显示在上一行了。
    // 「只输出答案」模式下模型只回一个 "C"，不去掉的话解析块里会再显示一遍 "C"，
    // 看着像重复渲染，也会让人以为"说好的不要解析怎么还有内容"。
    const first = (lines[0] || "").trim();
    const isAnswerLine =
      /^(?:正确答案|答案|正确选项|应选|answer)\s*[:：是]?\s*[A-Z][A-Z、,，和及/\s]*$/i.test(first) ||
      /^[A-Z]{1,6}$/.test(first) ||
      /^[A-Z](?:\s*[、,，和及/]\s*[A-Z])*$/.test(first);
    if (isAnswerLine) return lines.slice(1).join("\n").trim();
    return text;
  }

  // 把解析画进卡片。没有解析就不动（保持上一次显示的内容，别把已有解析抹掉）。
  function renderExplain(item, res) {
    const box = item && item.explainBox;
    if (!box) return;
    const text = explainForDisplay(res);
    if (!text) return;
    box.textContent = text;
    box.style.display = "block";
  }

  // 思考内容（「完整功能」模式）单独一块：后台用独立字段 reasoning 回传，
  // 只显示、不参与取答案 —— 思考里出现"答案是 C"不会影响填涂。
  //
  // 平台不认识思考字段时后台会自动降级，这时必须**明说**：
  // 否则「完整功能」看起来正常、🧠 块一直空着，用户以为思考模式生效了，
  // 其实一次都没思考过（这是"静默降级"，比报错更难发现）。
  function renderThink(item, res) {
    const box = item && item.thinkBox;
    if (!box) return;
    const text = String((res && res.reasoning) || "").trim();
    if (text) {
      box.textContent = "🧠 思考过程\n" + text;
      box.style.display = "block";
      return;
    }
    if (res && res.thinkDowngraded && !thinkDowngradeNotified) {
      thinkDowngradeNotified = true;   // 只提示一次，不然每张卡片都刷一遍
      box.textContent = "⚠ 当前平台/模型不支持思考字段，已按普通模式作答。" +
        "想真正开启思考，请换用支持 reasoning_effort 的推理模型（如 deepseek-reasoner）。";
      box.style.display = "block";
    }
  }

  // 填涂分派（「开始答题」用）：先直接改 checked，页面不接受时再模拟真实点击
  function fillOne(q, answer) {
    if (!answer || !answer.length) return 0;
    if (q.optEls && q.optEls.length) return pickByOptionList(q, answer);
    if (!q.inputs || !q.inputs.length) return 0;
    if (q.generic) return pickGeneric(q, answer);
    // pick 自己回读并返回"真的勾上了几个"。无条件返回 answer.length 的话，
    // 下标越界/被框架改写/一个都没勾中也会报成功。
    return pick(q, answer);
  }

  // 填涂分派（扫描面板用）：一律模拟真实点击。
  // 面板就是为任意网页准备的，不依赖页面允许直接改属性。
  function fillOneByClick(q, answer) {
    if (!answer || !answer.length) return 0;
    if (q.optEls && q.optEls.length) return pickByOptionList(q, answer);
    if (q.inputs && q.inputs.length) return pickGeneric(q, answer);
    return 0;
  }

  // ---------- 通用站点填涂：模拟真实点击，而不是直接设 checked ----------
  // 问卷星等平台的选项状态由它自己的 JS（绑定在选项容器/行上的 click）维护，
  // 直接改 checked 不会更新内部数据；必须走事件路径。
  // setOptionState 的点击顺序（按问卷星页面的行为排定）：
  //   1. 选项文本容器（div.label/label）—— 问卷星点它才会同步 input.checked
  //   2. 选项行（.ui-radio/li 等）—— 覆盖逻辑绑在行上的站点
  //   3. input 本身 —— 逻辑直接绑在 input 的站点
  // 每一步都同步校验 inp.checked，不成功才试下一步，最多 3 次真实点击
  function setOptionState(inp, want) {
    if (inp.checked === want) return true;
    const cont = optOf(inp);
    const wrap = cont ? (cont.closest(".ui-radio, li") || cont.parentElement) : inp.parentElement;
    const tries = [cont, wrap, inp].filter(Boolean);
    for (const t of tries) {
      try { t.click(); } catch (_) {}
      if (inp.checked === want) return true;
    }
    return inp.checked === want;
  }

  function pickGeneric(q, answerIndexes) {
    const first = (q.inputs || []).find(Boolean);   // inputs 里可能混着 null
    const isMulti = !!first && String(first.type).toLowerCase() === "checkbox";
    const chosen = new Set(answerIndexes);
    // 多选组先把不在答案里的已勾选项取消，保证答案准确。
    // 但**取消不算"填上了"**：把取消也计入 clicked 的话，
    // "取消 B 成功、勾选 A 失败"会返回 ≥1，卡片报成「✓ 已填涂」。
    if (isMulti) {
      q.inputs.forEach((inp, i) => {
        if (inp && inp.checked && !chosen.has(i)) setOptionState(inp, false);
      });
    }
    let ok = 0;
    for (const i of answerIndexes) {
      const inp = q.inputs[i];
      if (inp && setOptionState(inp, true)) ok++;
    }
    return ok;
  }

  // 纯 div/li 选项（页面没有 input）点完之后，页面通常会把选中态写在元素自己身上：
  // aria-checked/aria-selected、class 里的 selected/active/checked、或内层 input。
  // 一处都读不到时**不能**认定"已填涂"：el.click() 不抛错不等于填涂成功，被遮挡、
  // 被 disabled、被框架重渲染掉的选项会一路报「✓ 已填涂」，页面其实没动。
  // 读不到也不等于失败（不少站点把状态只存在 JS 里），所以这里只把措辞降级成
  // "点了但确认不了"，计数仍按已点击算 —— 不能借"失败"再点第二下，那会把选中态翻回去。
  const SELECTED_CLS = /(^|[\s_-])(selected|active|checked|chosen|current|choose|cur)([\s_-]|$)/i;
  function looksSelected(el) {
    if (!el || !el.getAttribute) return false;
    const a = el.getAttribute("aria-checked") || el.getAttribute("aria-selected") || "";
    if (/^true$/i.test(String(a))) return true;
    if (SELECTED_CLS.test(String(el.getAttribute("class") || ""))) return true;
    // 学习通：点中后在 .answerBg 里插入 .checkanswer/.checkanswerdx，
    // 或给 .num_option/.numoption 自身加上 checkanswer 类。
    if (el.querySelector && el.querySelector(".checkanswer, .checkanswerdx, [class*='check_answer']")) return true;
    const num = el.querySelector && el.querySelector(".num_option, .numoption");
    if (num && (SELECTED_CLS.test(String(num.className || "")) || /checkanswer/i.test(String(num.className || "")))) return true;
    const inp = el.querySelector && el.querySelector("input");
    return !!(inp && inp.checked);
  }

  // 竖排选项列表（页面没有 input 控件）：直接点击选项元素本身。
  // 元素在识别阶段已定位好（q.optEls[i] 就是第 i 个选项），不再按文本满页面去找，
  // 免得在无关页面上点到别的元素。会真正跳转的链接一律不点。
  function pickByOptionList(q, answerIndexes) {
    let clicked = 0;
    let unverifiable = 0;
    const chosen = new Set(answerIndexes);
    // 多选题按“答案集合”落地：先取消不在答案里的已选项，再补齐答案。
    // 只加不减会让页面上残留用户之前选的项（A/B/C 全亮）。
    if (q.multi) {
      (q.optEls || []).forEach((el, i) => {
        if (!el || chosen.has(i) || !looksSelected(el)) return;
        const href = el.getAttribute && el.getAttribute("href");
        if (el.tagName === "A" && href && !/^\s*(#|javascript:)/i.test(href)) return;
        try { el.click(); } catch (_) {}
        filledEls.add(el);
        if (!looksSelected(el)) writtenOk.add(el);
        else unverifiable++;
      });
    }
    for (const i of answerIndexes) {
      const el = q.optEls && q.optEls[i];
      if (!el) continue;
      if (looksSelected(el)) {              // 已经是选中态：不要再点，点一下反而会取消
        filledEls.add(el);
        writtenOk.add(el);
        clicked++;
        continue;
      }
      if (filledEls.has(el)) {              // 点过了：再点一下就把选中态翻没
        if (writtenOk.has(el)) clicked++;
        continue;
      }
      const href = el.getAttribute && el.getAttribute("href");
      if (el.tagName === "A" && href && !/^\s*(#|javascript:)/i.test(href)) {
        log(`[跳过] 选项 ${String.fromCharCode(65 + i)} 是跳转链接，不点`, "var(--c-warn)");
        continue;
      }
      try { el.click(); } catch (_) {}
      filledEls.add(el);
      clicked++;
      if (looksSelected(el)) writtenOk.add(el);
      else unverifiable++;
    }
    // 调用方（run / 面板填涂）据此把"✓ 已填涂"换成"已点击，请核对这一题"
    q.optionClickUnverified = unverifiable > 0;
    return clicked;
  }

  // 分页/逐题问卷的「下一题」按钮（问卷星是 #ctlNext）。
  // 只认纯导航文案；文本含「提交/交卷」的一律不碰——是否交卷必须由用户手动决定
  function findNextPageButton(preferredDoc) {
    // 考试/作业的「下一题」可能在同源 iframe 里。优先搜题目所在文档，
    // 再退回其他可访问文档 —— 顶层外壳里偶尔也有「下一页」，不能让它抢先。
    const docs = scanDocuments();
    if (preferredDoc && docs.includes(preferredDoc)) {
      docs.splice(docs.indexOf(preferredDoc), 1);
      docs.unshift(preferredDoc);
    }
    for (const doc of docs) {
      const candidates = [
        doc.getElementById ? doc.getElementById("ctlNext") : null,
        ...doc.querySelectorAll("a,button,div[id*='next' i],input[type=button]")
      ].filter(Boolean);
      for (const b of candidates) {
        if (!visibleEl(b)) continue;
        const t = (b.value || b.textContent || "").replace(/\s+/g, "");
        if (!t || t.length > 8) continue;
        // 含「提交/交卷/登录」的按钮是**跳过它继续找**，不是整轮放弃：
        // 页头挂着「提交」、页尾才是「下一题」的自建问卷很常见，
        // 一撞上这条就 return null 的话，整轮停在第 1 页不再翻页。
        if (/提交|交卷|登录|Submit/i.test(t)) continue;
        if (/^(下一题|下一页|下一步|下一部分|继续答题|Next)$/.test(t)) return b;
      }
    }
    return null;
  }

  // 暂停期间"挂起"的等待者：恢复时一次性唤醒它们。
  // 放在 waitOrStop 之前声明，避免 TDZ（waitOrStop 在 run 里被调用时它早已初始化）。
  let pauseResolvers = [];

  // 可被「停止 / 暂停」立刻打断的等待：stopRun()/pauseRun() 会把所有等待者当场唤醒。
  // 返回值与 sleep 一样是 Promise，调用点不用改结构。
  //
  // 暂停语义：唤醒后**不返回**，而是原地等恢复 —— 这样调用方（run 的主循环）
  // 完全不用改结构，暂停就发生在它当前所在的那一处 await 上。
  // 恢复时若期间被停止过（running 已 false），就直接返回让上层退出。
  function waitOrStop(ms) {
    if (!running) return Promise.resolve();
    return new Promise(resolve => {
      let t = null;
      const done = () => {
        if (t) { clearTimeout(t); stopWaiters = stopWaiters.filter(w => w !== done); }
        // 若正处于暂停，挂起直到恢复（或期间被停止）
        if (paused && running) { pauseResolvers.push(done); return; }
        resolve();
      };
      t = setTimeout(done, ms);
      stopWaiters.push(done);
    });
  }

  // 当前这一页的"指纹"：题数 + 第一题题干。翻页后指纹变了，才说明新页真的渲染出来了。
  function pageSignature(qs) {
    if (!qs || !qs.length) return "0|";
    const first = String((qs[0] && (qs[0].stemText || qs[0].stem)) || "").replace(/\s+/g, "").slice(0, 40);
    return qs.length + "|" + first;
  }

  // 点完「下一题」要**等页面真的换了**，而不是固定睡一段时间。
  // 只用 waitOrStop(max(1500, intervalMs+500)) 不够：新页渲染慢一点（SPA、逐题问卷都常见），
  // 到点重扫到的还是旧页甚至 0 题，于是整页漏答，而汇总写着「未答 0」。
  // 每轮都重新扫一遍 DOM，指纹一变立即返回；到上限也返回（由调用方如实报）。
  async function waitPageChange(prevSig, maxMs) {
    const deadline = Date.now() + Math.max(1200, maxMs);
    let qs = [];
    for (;;) {
      qs = getQuestionBlocks();
      if (!qs.length) qs = getFillableQuestions();
      if (!running) return qs;
      if (pageSignature(qs) !== prevSig) return qs;
      if (Date.now() >= deadline) return qs;
      await waitOrStop(150);
    }
  }

  // 面板路径的中断：通知后台掐断在飞的 AI 请求。
  // 面板的停止有自己的 stopFlag/fillStop（与 run 的 running 是两套），
  // 但"掐断请求"这件事是共用的 —— 否则按了停止仍要等接口慢慢返回。
  function abortPanelAI() {
    try { chrome.runtime.sendMessage({ type: "ABORT_AI" }).catch(() => {}); } catch (_) {}
  }

  // 面板路径（出答案 / 填涂）用的可中断等待：每 10ms 看一眼是否已被叫停。
  // 面板用的是自己的 stopFlag / fillStop（与 run 的 running 是两套），
  // 所以不能复用 waitOrStop，得把"是否该停"作为谓词传进来。
  // isPaused：面板任务的"暂停"谓词（各自一套）。暂停时挂起不返回，
  // 恢复时由 resumeXxx 唤醒 —— 与 run 的 waitOrStop 同一套思路，
  // 这样三个循环（run / 出答案 / 填涂）的暂停语义完全一致。
  // 纯闸门：**不睡**，但暂停时会挂起（恢复后返回）、停止时立即返回。
  // 为什么需要它：waitOrStopPanel(0, ...) 会走下面的 `ms<=0 → 立即 resolve` 短路，
  // 于是"每题间隔=0"时暂停就完全失效（循环一路冲到底）。并发流水线里
  // "每取一题之前先看一眼是否被叫停"用的就是它。
  function gatePanel(isStopped, isPaused, park) {
    if (isStopped && isStopped()) return Promise.resolve();
    if (!isPaused || !isPaused()) return Promise.resolve();
    return new Promise(resolve => { if (park) park.push(resolve); });
  }

  function waitOrStopPanel(ms, isStopped, isPaused, park) {
    if (!ms || ms <= 0) return gatePanel(isStopped, isPaused, park);
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => {
        if (isStopped()) return resolve();
        if (isPaused && isPaused()) {
          // 挂起：把自己交给调用方的 park 数组，等恢复时唤醒后重新计时
          if (park) park.push(() => resolve());
          return;
        }
        if (Date.now() - t0 >= ms) return resolve();
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  // 立刻停止：置位 running、唤醒所有等待者、并通知后台中断在飞的 AI 请求。
  // 三件事缺一不可 —— 只置位 running 的话，循环还卡在 sleep 或 fetch 里，
  // 用户仍然要等好几秒才看到它停，而且期间还会再发一个请求。
  function stopRun(reason) {
    stopRequested = true;   // 启动阶段点停止也记下来（见 run() 里的兑现）
    running = false;
    // 必须**先**把 paused 清掉再唤醒：done() 里会判断 `paused && running`，
    // 若此时还留着 paused=true，被唤醒者会再次把自己挂回去，run 就永远醒不过来了。
    paused = false;
    const waiters = stopWaiters.concat(pauseResolvers);   // 暂停中挂起的也要唤醒
    stopWaiters = [];
    pauseResolvers = [];
    waiters.forEach(fn => { try { fn(); } catch (_) {} });
    try { chrome.runtime.sendMessage({ type: "ABORT_AI" }).catch(() => {}); } catch (_) {}
    // 面板的「出答案 / 填涂」是**另一套**停止标志（stopFlag/fillStop），光置 running 管不到它们。
    // 停止必须同时停掉 run() 和面板上的填涂 —— 弹窗文案承诺的是"立刻生效"。
    if (scanPanelApi.stopPanelTasks) { try { scanPanelApi.stopPanelTasks(); } catch (_) {} }
    // 停止后「出答案 / 填涂」要立刻恢复可用（它们现在是"运行中可点"的状态样式）
    if (scanPanelApi.setBusy) { try { scanPanelApi.setBusy(false); } catch (_) {} }
    if (scanPanelApi.setRunState) { try { scanPanelApi.setRunState("stopped"); } catch (_) {} }
    if (reason) log(reason, "var(--c-warn)");
  }

  // 暂停 / 恢复。与「停止」的关键区别：暂停**不退出**循环，只是停在原地。
  // 唤醒当前等待者，让主循环立刻转到"暂停中"这个状态上（用户按键马上有反应）。
  function pauseRun() {
    if (!running || paused) return;
    paused = true;
    const ws = stopWaiters;
    stopWaiters = [];
    // 注意：这里**不能**清空 pauseResolvers —— 它们代表"已挂起的等待者"，
    // 恢复时要靠它们把自己唤醒。
    ws.forEach(fn => { try { fn(); } catch (_) {} });
    log("已暂停（点「▶ 继续」接着答，已答过的题不会重答）", "var(--c-warn)");
    if (scanPanelApi.setRunState) { try { scanPanelApi.setRunState("paused"); } catch (_) {} }
  }

  function resumeRun() {
    if (!running || !paused) return;
    paused = false;
    const rs = pauseResolvers;
    pauseResolvers = [];
    rs.forEach(fn => { try { fn(); } catch (_) {} });
    log("已继续", "var(--c-sky)");
    if (scanPanelApi.setRunState) { try { scanPanelApi.setRunState("running"); } catch (_) {} }
  }

  // ---------- 悬浮日志面板 ----------
  // 是否显示运行日志面板。由 popup 的「显示运行日志面板」开关控制，**默认关**：
  // 多数人只想让它安静地答完，不想屏幕上一直挂着一个窗口。
  // 关掉时 log() 改写浏览器控制台，信息不丢、也不占屏幕。
  let logPanelEnabled = false;

  // 运行日志不再单独开一个悬浮窗，而是**并进识别面板**（题卡面板）里那一块。
  // 答题时不再单开小窗口：只有一个面板，上面是题卡，下面是运行日志（可折叠）。
  let runLogBox = null;   // 面板里的日志容器；没开面板时为 null

  // 面板向外暴露的少数几个口子（run() 要用）。
  // run() 与面板是两条并行流水线：run() 负责"把答案填进页面"，
  // 面板负责"把答案显示给人看"。两者必须同步，否则页面填对了、面板却空白。
  // paintByStem 由 startScanMode 挂上（面板存在时才有），run() 每答完一题就调一次。
  const scanPanelApi = { paintByStem: null, paintError: null, setBusy: null, setRunState: null, stopPanelTasks: null, fillList: null };

  function showPanel() {
    if (!logPanelEnabled) return;      // 用户不要面板：全程不创建 DOM
    if (!scanPanel) {
      // 没有面板就先建一个（会自动扫描并列出题卡）。
      // startScanMode 是同步建 DOM 的，返回时 .aa-runlog 已经存在，
      // 所以这里建完要**继续往下走**把 runLogBox 挂上。
      // 直接 return 的话 runLogBox 仍是 null，run() 开头的日志全丢了
      //（用户看到的"面板只有 3 行日志"就是这个原因）。
      startScanMode(false, null, "run");
    }
    const box = scanPanel && scanPanel.querySelector(".aa-runlog");
    if (box) runLogBox = box;
    const wrap = scanPanel && scanPanel.querySelector(".aa-runlog-wrap");
    // 用显式 "block" 而不是 ""：清空行内值不会覆盖样式表里的规则，
    // 能不能显示就变得依赖 CSS 里写了什么（否则整行表头可能被藏掉）。
    if (wrap) wrap.style.display = "block";
    // 面板是 run 模式下建的，日志标题已经在 startScanMode 里设好；这里再兜一次，
    // 覆盖"先开了扫描面板、再点开始答题"的情况。
    const title = scanPanel && scanPanel.querySelector(".aa-runlog-head > span");
    if (title) title.textContent = "QuizLens 运行中";
  }

  function hidePanel() {
    const wrap = scanPanel && scanPanel.querySelector(".aa-runlog-wrap");
    if (wrap) wrap.style.display = "none";
  }

  // 写日志：优先写进面板的日志区，没面板就写控制台。
  // 没有面板也必须在控制台留下日志，否则出问题没法排查。
  function log(msg, color) {
    if (!runLogBox) runLogBox = scanPanel && scanPanel.querySelector(".aa-runlog");
    if (!runLogBox) {
      try { console.log("[QuizLens]", msg); } catch (_) {}
      return;
    }
    const line = document.createElement("div");
    if (color) line.style.color = color;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    runLogBox.prepend(line);
  }

  // ---------- 非阻塞提示条（不占用户的点击，不打断操作） ----------
  //
  // 为什么不用 alert/confirm：这两个会**冻结页面 JS**（包括正在跑的作答循环），
  // 而且弹在画面中央、必须点掉。学生只想"看一眼知不知道"，提示条挂在右下角、
  // 几秒后自己消失、点一下能看到详情，才是对的交互。
  //
  // 提示条只做“事后告知”，不拦截点击；交卷操作完全由页面和用户处理。
  let toastTimer = null;

  function ensureToastStyles() {
    if (document.getElementById("aa-toast-style")) return;
    const st = document.createElement("style");
    st.id = "aa-toast-style";
    st.textContent = `
      .aa-toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;
        max-width:min(360px,92vw);background:#241C10;color:#FFFDF8;border:1px solid rgba(255,253,248,.12);
        border-radius:14px;padding:11px 14px;
        font:13px/1.6 "PingFang SC","Microsoft YaHei","HarmonyOS Sans SC",-apple-system,"Segoe UI",system-ui,sans-serif;
        box-shadow:0 10px 30px rgba(52,37,18,.32);display:flex;gap:10px;align-items:flex-start;
        cursor:default;animation:aa-toast-in .18s ease-out}
      @keyframes aa-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .aa-toast.aa-toast-warn{background:#6F3B06;color:#FFF3DE;border-color:rgba(255,243,222,.14)}
      .aa-toast.aa-toast-ok{background:#2E6B87;color:#FFFDF8;border-color:rgba(255,253,248,.16)}
      .aa-toast-text{flex:1 1 auto;white-space:pre-wrap;word-break:break-word}
      .aa-toast-act{flex:none;background:rgba(255,253,248,.16);border:0;border-radius:8px;
        color:#FFFDF8;font-size:12px;font-weight:600;padding:4px 10px;cursor:pointer;font-family:inherit}
      .aa-toast-act:hover{background:rgba(255,253,248,.26)}
      .aa-toast-x{flex:none;background:transparent;border:0;color:rgba(255,253,248,.6);
        font-size:14px;line-height:1;cursor:pointer;padding:0 2px}
    `;
    document.documentElement.appendChild(st);
  }

  /**
   * 弹一条非阻塞提示。
   * @param text     正文
   * @param kind     "ok" | "warn" | 其他（默认深色）
   * @param ms       自动消失毫秒数；传 0 表示不自动消失（需要用户点掉）
   * @param onClick  点正文时的回调（可选）
   * @param actLabel 操作按钮文案（可选）
   * @param onAct    操作按钮的回调（可选，配合 actLabel）
   */
  function toast(text, kind, ms, onClick, actLabel, onAct) {
    ensureToastStyles();
    document.querySelectorAll(".aa-toast").forEach(n => n.remove());   // 同时只留一条，免得刷屏

    const box = document.createElement("div");
    box.className = "aa-toast" + (kind === "warn" ? " aa-toast-warn" : kind === "ok" ? " aa-toast-ok" : "");

    const txt = document.createElement("div");
    txt.className = "aa-toast-text";
    txt.textContent = String(text || "");
    box.appendChild(txt);

    if (actLabel) {
      const act = document.createElement("button");
      act.className = "aa-toast-act";
      act.textContent = actLabel;
      act.addEventListener("click", () => { try { onAct && onAct(); } catch (_) {} });
      box.appendChild(act);
    }

    const x = document.createElement("button");
    x.className = "aa-toast-x";
    x.textContent = "×";
    x.title = "关闭提示";
    const close = () => {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      try { box.remove(); } catch (_) {}
    };
    x.addEventListener("click", close);
    box.appendChild(x);

    if (onClick) {
      box.style.cursor = "pointer";
      box.addEventListener("click", e => { if (e.target === x) return; try { onClick(); } catch (_) {} });
    }

    document.documentElement.appendChild(box);
    if (ms) {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(close, ms);
    }
    return box;
  }

  // 交卷边界已关闭：插件不再拦截或二次确认提交/交卷控件，是否提交只由用户操作。

  // ---------- 主流程 ----------
  // 自动填涂白名单：默认全部站点可填；设置白名单限制后，其余页面只读题显示答案。
  function parseHosts(str) {
    const list = String(str || "localhost,127.0.0.1")
      .split(/[\s,;]+/)
      .map(s => s.trim().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").toLowerCase())
      .filter(Boolean);
    return list.length ? list : ["localhost", "127.0.0.1"];
  }

  // 白名单来源：扩展目录下的 whitelist.txt（后台 service worker 读取，一行一个域名）。
  // 文件读取失败时退回兼容字段 fillHosts
  async function getWhitelist(settings) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "GET_WHITELIST" });
      if (reply && reply.ok && reply.hosts && reply.hosts.length) return reply.hosts;
    } catch (_) {}
    return parseHosts(settings && settings.fillHosts);
  }

  // 白名单匹配：全等，或作为父域覆盖其子域（填 wjx.top 也能覆盖 ks.wjx.top）
  function hostAllowed(allowed, host) {
    const h = String(host || "").toLowerCase();
    // "*" = 放行全部站点
    if (allowed.includes("*")) return true;
    return allowed.some(a => h === a || h.endsWith("." + a));
  }

  // ---- 自动填涂的唯一收口 ----
  // 「往页面写」有两条互不经过的路径：run()（开始答题）与扫描面板的「✍ 填涂」。
  // 两条路都必须查白名单，否则"白名单外只显示答案"
  // 只是面板上的一句提示文案，按钮照样能把答案勾进页面。
  // 判定按域名缓存：run() 已经算过的结果面板直接用，重建面板也不必重新拉 whitelist.txt。
  let fillAllowedCache = null;
  async function fillAllowedOk(settings) {
    if (fillAllowedCache === null) {
      const allowed = await getWhitelist(settings);
      fillAllowedCache = hostAllowed(allowed, location.hostname);
    }
    return fillAllowedCache;
  }
  const fillNotAllowedText = () =>
    `当前域名 ${location.hostname} 不在自动填涂白名单内，本页只显示答案、不替你勾选。` +
    `要让它代填：在插件目录的 whitelist.txt 里加上这个域名（或填 *），到扩展管理页点「重新加载」，再刷新本页。`;

  // 题干"像不像一道题"。只用于选项列表/表单路径的自动点击兜底：
  // 该路径没有 input 那种强信号，而一段分点说明（"本方案分三阶段：A. … B. … C. …"）
  // 或站点的普通设置项（"请选择你偏好的界面主题风格" + 三个 radio）
  // 在 DOM 结构上与选择题完全一致，只能靠题干措辞区分。
  // 判定保守一点没关系——不点而已，只读面板里照样能看答案；点错是不可逆的。
  //
  // 软判据会放过"请选择你偏好的界面主题风格"、"请选择你所在的省份地区"这类设置项；
  // 本判据要求硬标记，能把这些排除。
  // 代价：题库里少量判断题不再自动点，但只读面板照样看得到答案。
  // 「硬」题干标记：问号、题号开头、空括号/下划线。
  // 这三样几乎只出现在题干上，说明文字、使用条款、页面提示语里基本不会同时满足。
  function hasHardStemMark(s) {
    if (s.includes("？") || s.includes("?")) return true;
    if (/^\s*(?:第\s*)?\d{1,3}\s*[.、．)]/.test(s)) return true;   // 以题号开头
    return /（\s*）|\(\s*\)|_{2,}|____/.test(s);                    // 空括号 / 下划线：填空位的强信号
  }

  function looksLikeQuestionStem(stem) {
    const s = (stem || "").trim();
    if (!s) return false;
    if (hasHardStemMark(s)) return true;
    if (/下列|以下|哪一?[个些种项]?|正确|错误|说法|属于|是指|意味着|最[适合佳优]/.test(s)) return true;
    // 陈述句 + 答题措辞（判断题常见：「……的，应当如何处置：」）
    if (/[。.]$/.test(s) && /应当|应该|不得|可以|必须|允许|禁止|需要|属于/.test(s)) return true;
    // 「请选择」单独出现太常见（设置项、下拉框提示语），必须与答题措辞同现才算
    return /请选择/.test(s) && /答案|正确|错误|选项/.test(s);
  }

  // 页面选项是不是「判断题选项」（正确/错误、对/错、是/否、√/×…）。
  // 判断题的题干是陈述句，上面那道闸门挡不住它；但选项只有这两个词时，
  // 本身就是"这是一道题"的强信号 —— 被题干闸门挡住的判断题
  // 会由这道闸门救回，两重都挡不住的极少。
  const JUDGMENT_KEYS = new Set(["正确", "错误", "对", "错", "是", "否", "true", "false", "√", "×", "t", "f"]);
  function isJudgmentOptions(opts) {
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) return false;
    const keys = opts.map(optKey);
    if (keys.some(k => !k)) return false;
    return keys.every(k => JUDGMENT_KEYS.has(k));
  }

  // 这道题的题干够不够格被自动点：题干像问句，或者选项本身是判断题选项。
  function stemOkForClick(stem, options) {
    return looksLikeQuestionStem(stem) || isJudgmentOptions(options);
  }

  // 可自动填涂的题目 → run() 内部统一格式。两条来源：
  //   A. 真实表单控件（radio/checkbox 组）—— 靠模拟点击控件
  //   B. 竖排选项列表（<li>A. xxx</li> 这类没有 input 的页面）—— 直接点选项元素本身
  // 单块文本里的内联选项（"A. xx B. yy" 挤在一个 <p> 里）没有独立的可点元素，无法自动填
  function getFillableQuestions() {
    // 每个文档（顶层 + 同源 iframe）各扫一遍，文档内按 DOM 顺序排好再合并。
    // 学习通的题在内容 iframe 里，这一步是它能被「开始答题」看到的前提。
    const perDoc = scanEachDoc(() => {
      const fromForm = scanFormGroups()
        .filter(q => q.inputs && q.inputs.length >= 2)
        .map(q => ({
          generic: true,
          // 去掉问卷星常见的「【单选题】」标记和必填星号，题干更干净利于匹配
          stemText: q.stem.replace(/^【[^】]{1,10}】\s*/, "").replace(/^[*＊\s]+/, "").trim(),
          stem: q.stem,
          // 会不会被自动点，取决于题干像不像问句（见 looksLikeQuestionStem）。
          // 表单控件看似是强信号，其实不然：设置页的「请选择你偏好的界面主题风格」
          // 加三个 radio、筛选页的「按条件筛选搜索结果」加四个 checkbox，
          // 结构上与选择题一模一样，只能靠题干措辞拦下。
          stemIsQuestion: stemOkForClick(q.stem, q.labels || []),
          inputs: q.inputs,
          options: q.labels || [],
          optionTexts: q.labels || [],
          el: q.el,
          ...(q.num !== undefined ? { num: q.num } : {}),
          ...(q.clozeNum !== undefined ? { clozeNum: q.clozeNum } : {})
        }))
        .filter(q => q.stemText && q.optionTexts.length);

      const fromList = scanOptionLists()
        .filter(q => q.optEls && q.optEls.length)
        .map(q => ({
          generic: true,
          byOptionList: true,
          stemText: q.stem,
          stem: q.stem,
          // 会不会被自动点，取决于题干像不像问句（见 looksLikeQuestionStem）
          stemIsQuestion: stemOkForClick(q.stem, q.options),
          inputs: [],
          options: q.options,
          optionTexts: q.options,
          optEls: q.optEls,
          el: q.el,
          ...(q.num !== undefined ? { num: q.num } : {}),
          ...(q.clozeNum !== undefined ? { clozeNum: q.clozeNum } : {})
        }))
        .filter(q => q.stemText && q.optionTexts.length);

      // 填空题：答案要写进输入框。题干在扫描阶段已经过了 looksLikeBlankStem 这道闸门。
      const fromBlank = scanTextInputs().map(q => ({
        generic: true,
        fillText: true,
        stemText: q.stem,
        stem: q.stem,
        inputs: [],
        options: q.options || [],
        optionTexts: [],
        blankInputs: q.blankInputs,
        el: q.el,
        ...(q.freeText ? { freeText: true, freeTextKind: q.freeTextKind } : {}),
        ...(q.num !== undefined ? { num: q.num } : {})
      }));

      // 纯文本识别出来的题（问句 / 内联 A. B. 选项 / 题号开头），只有 resolveOptionEls
      // 真的找到了可点元素才收进来 —— 否则它在自动路径里毫无意义（点不了），
      // 留在只读面板里看答案就好。题干是裸文本 + 内联选项的页面走的就是这条。
      const fromText = scanTextQuestions()
        .filter(q => q.optEls && q.optEls.length >= 2 && q.options && q.options.length >= 2)
        .map(q => ({
          generic: true,
          byOptionList: true,
          stemText: q.stem,
          stem: q.stem,
          stemIsQuestion: stemOkForClick(q.stem, q.options),
          inputs: [],
          options: q.options,
          optionTexts: q.options,
          optEls: q.optEls,
          el: q.el,
          ...(q.num !== undefined ? { num: q.num } : {}),
          ...(q.clozeNum !== undefined ? { clozeNum: q.clozeNum } : {})
        }))
        .filter(q => q.stemText);

      // 学习通适配器放最前：它的选项配对最准，去重时优先保留它。
      // 必须**先去重再排序**：排序只影响展示顺序，不能改变"哪一份被保留"——
      // 填空题的纯文本副本和带 blankInputs 的那份谁先谁后，决定的是一整题能不能填。
      const merged = dedupeQuestions([
        ...scanChaoxing(), ...fromForm, ...fromList, ...fromText, ...fromBlank
      ]);
      return sortByDomPosition(merged);
    });

    // 跨文档再去一次重（同一题同时出现在顶层和 iframe 的极端情况），保持扫描顺序。
    return attachPassages(
      dedupeQuestions(perDoc.flat()).filter(q => q.stemText)
    );
  }

  // run() 的外壳：任何一处抛错都必须把 running/setBusy 复位。
  //
  // 为什么要单独一层：`running = false` 只写在最末尾的话，
  // 一处 TypeError（例如 .opt 里没有 input、
  // inputs 数组混着 null，而筛选题时读了 inp.checked）就会让 running 永远卡在 true，
  // 之后每次点「开始答题」都在入口 `if (running) return` 处静默失效 ——
  // 界面显示"运行中"、一题不答，只能刷新页面自救。
  async function run(settings) {
    try {
      await runInner(settings);
    } catch (e) {
      log("⚠ 自动作答异常中断（已复位状态，可以再点一次「开始答题」）：" + ((e && e.message) || e), "var(--c-danger)");
      try { console.error("[QuizLens] run() 抛出异常", e); } catch (_) {}
    } finally {
      running = false;
      paused = false;
      if (scanPanelApi.setBusy) { try { scanPanelApi.setBusy(false); } catch (_) {} }
    }
  }

  async function runInner(settings) {
    if (running) return;
    // 「开始答题」和面板的「出答案 / 填涂」不能同时跑（两条流水线会同时改同一个页面）。
    // 面板那边早就挡住了反向的情况（running 时点击只提示不干活），但正向的一直没人管：
    // 面板在填涂时点弹窗「开始答题」，两边各点各的。弹窗按钮的语义是"现在就开始"，
    // 所以这里把面板任务叫停并说明，而不是让按钮看起来失灵。
    if (scanPanelApi.stopPanelTasks) { try { scanPanelApi.stopPanelTasks(); } catch (_) {} }
    // 起点就复位：上一轮停止/暂停后残留的标志不能影响这一轮
    stopRequested = false;
    paused = false;
    // 防御：配置缺失时补默认值，避免 undefined 引发隐性错误
    settings = Object.assign(
      { mode: "bank", intervalMs: 1000, fuzzyThreshold: 75, concurrency: 3, concurrentEnabled: true, overwriteSelected: false, aiBaseUrl: "https://api.deepseek.com", aiKey: "", aiModel: "deepseek-chat", bankBaseUrl: "", fillHosts: "localhost,127.0.0.1" },
      settings || {}
    );
    // 白名单外页面：不自动填涂，进"只显示答案"的识别面板
    const allowed = await getWhitelist(settings);
    // 这段 await 期间用户可能已经点了「停止」——那时 running 还是 false，
    // stopRun() 置的位会落空，于是"停止"被丢掉、答题照常跑起来。
    // 这里补一次检查，把那次停止兑现。
    if (stopRequested) {
      stopRequested = false;
      log("已按你的要求停止（启动阶段点的停止也生效）", "var(--c-warn)");
      return;
    }
    // 判定结果缓存给面板的「✍ 填涂」复用：降级过去的那块面板本来就该是只读的
    fillAllowedCache = hostAllowed(allowed, location.hostname);
    if (!fillAllowedCache) {
      startScanMode(true);
      return;
    }
    running = true;
    // 面板开关在读设置时就定下来（run 期间不再变），避免中途改设置造成半开半关
    logPanelEnabled = !!(settings && settings.showLog);
    // 统一面板：题卡 + 运行日志在同一个面板里（不再单开悬浮窗）。
    // showLog 关掉时完全不建面板，日志进控制台。
    //
    // 顺序很关键：showPanel() 在面板不存在时会去建（建的过程是同步的），
    // 建完 runLogBox 才指向真实容器。若 showPanel 在没有面板时直接 return，
    // 紧接着的这几行日志会写进 null → 全丢。
    showPanel();
    if (scanPanelApi.setBusy) scanPanelApi.setBusy(true);
    log("开始自动作答（白名单：" + allowed.join(", ") + `）扩展 v${EXT_VERSION}`);

    if ((settings.mode === "ai" || settings.mode === "mixed") && !settings.aiKey) {
      log("⚠ 未填写 API Key，AI 模式将无法工作", "var(--c-danger)");
    }

    // 先识别题目再加载题库：本页没有可填涂的题时，就不用白拉那 41MB 题库了
    let questions = getQuestionBlocks();
    let source = "题卡结构";
    if (questions.length) {
      // 一个页面可能同时有 .question 选择题和独立的句子改写/改错输入框
      //（A/B 阅读 + C 句改 + D 改错这类混合题型）。
      // getQuestionBlocks 只认 .question，会把 C/D 整段漏掉；这里补上自由文本题。
      const freeExtras = scanEachDoc(() => scanTextInputs()).flat().filter(q => q.freeText);
      if (freeExtras.length) {
        questions = dedupeQuestions([...questions, ...freeExtras]);
        source = "题卡结构 + 改写/简答题";
      }
    } else {
      questions = getFillableQuestions();
      source = "通用表单/选项列表";
    }
    log(`页面识别到 ${questions.length} 道题（${source}）`);

    // 一道可填涂的题都没有（比如纯 div 选项、下拉/填空页）→ 自动降级为只读识别面板，
    // 而不是干巴巴地报一句"识别到 0 道题"就结束
    if (!questions.length) {
      running = false;
      if (scanPanelApi.setBusy) scanPanelApi.setBusy(false);
      if (scanPanel) { scanPanel.remove(); scanPanel = null; }
      startScanMode(true, `本页没有可自动填涂的控件（既没有 radio/checkbox 选项组，也没有可点击的选项列表），已切换为只读识别：点题卡上的「答」拿答案，自己填。`);
      return;
    }

    let bankInfo = null;
    if (settings.mode !== "ai") {
      // 模糊匹配阈值（%），限定在 50~95 之间，默认 75
      bankThreshold = thresholdFraction(settings.fuzzyThreshold);
      try {
        const t0 = performance.now();
        bankInfo = await loadBank(settings);
        const ms = Math.round(performance.now() - t0);
        log(`题库索引构建完成：共 ${bankInfo.total} 题（来源：${bankInfo.from}，${ms}ms${bankInfo.cached ? "，复用上次索引" : ""}），模糊阈值 ${(bankThreshold * 100).toFixed(0)}%`);
      } catch (e) {
        log("题库加载失败：" + e.message, "var(--c-danger)");
        if (settings.mode === "bank") {
          log("→ 题库模式没有可用题库，本次一道题也答不出来。请填「题库地址」，或把模式切到「题库 + AI 兜底」。", "var(--c-danger)");
        }
      }
    }

    let bankHit = 0, aiHit = 0, miss = 0, skipped = 0, lowConf = 0;
    // 未答清单：只报「未答 N」这个数字，用户既不知道是哪几道、也不知道为什么，
    // 更没法定位。这里把题号与原因一并收下来，收尾时列出来。
    const missList = [];

    // ===== 取答案（可并发）与写页面（必须串行）拆成两半 =====
    //
    // 为什么拆：串行做的话，问 AI（几秒到几十秒）→ 写页面 → 歇 intervalMs → 下一题，
    // 仅 AI 模式下耗时很长，而这期间浏览器只是干等网络。
    //
    // 后台**能并发**：inFlight 按 AbortController 记账，ABORT_AI 会遍历中断
    //（现在还会按来源标签页过滤），
    // postChat 每次自建 AbortController。所以限制只在前台这个串行 for 循环。
    //
    // 拆分点很关键：**只有"取答案"能并发**。写页面（applyAnswer 点选项/填输入框）
    // 是"点下去不可逆"的操作，必须按题序串行，否则：
    //   · 多选题的勾选顺序会乱，页面自身的联动逻辑（如"选 A 时禁用 B"）会错乱；
    //   · 停止/暂停的语义会失守 —— 用户喊停后还可能有一批结果排队往页面里写。
    // 所以并发只发生在网络这一段，落地仍然严格按序。
    async function fetchOne(q) {
      return resolveAnswer(q, settings);
    }

    // 把一道题的答案写进页面并记账。**必须按题序调用**（见上）。
    function applyOne(q, idx, res) {
      // 停止发生在"请求在飞"期间时，结果回来也**不要再改页面**：
      // 用户已经喊停了，这时候还去动它的答卷是越权（点下去不可逆）。
      // 注意：这里只是不再写页面/不再计数，不 return 会影响统计口径的地方已经避开。
      const stopped = !running || paused;

      // 已经喊停了：结果一律不落地（不写页面、不计数、不写卡片），直接返回。
      // 填涂是**不可逆**的，用户按了停止之后再替它勾选项，比少答一题更糟。
      if (stopped) return;

      if (!res.answer && !res.texts) {
        miss++;
        const why = res.error || "题库未收录，且当前模式不允许 AI 兜底";
        missList.push({ no: q.num !== undefined ? q.num : idx, stem: q.stemText, why });
        log(res.error
          ? `[失败] ${q.stemText.slice(0, 18)}… ${res.error}`
          : `[未匹配] ${q.stemText.slice(0, 24)}…`, "var(--c-danger)");
        // 卡片上也要能看到"为什么没答"：否则面板一片空白，
        // 用户分不清是这道题漏了、还是整轮压根没跑起来。
        if (scanPanelApi.paintError) scanPanelApi.paintError(q.stemText, q.num, why);
        return;
      }

      // 先落地，再按"真的写进去几个"决定计数。
      // 顺序反过来的话，一题都没落进页面也能报「已填 8 题」、未答永远是 0；
      // 失败要进 miss 与未答清单。
      const n = applyAnswer(q, res, false);
      if (!n) {
        miss++;
        const why = `答案 ${answerToText(res)} 没能写进页面（该题型可能不支持自动填涂），请手动补这一题`;
        missList.push({ no: q.num !== undefined ? q.num : idx, stem: q.stemText, why });
        log(`[失败] ${q.stemText.slice(0, 18)}… ${why}`, "var(--c-danger)");
        // 卡片上先显示答案与解析（这一题的 token 已经花了，人得能看到答案），再压一行失败原因
        if (scanPanelApi.paintByStem) scanPanelApi.paintByStem(q.stemText, q.num, res);
        if (scanPanelApi.paintError) scanPanelApi.paintError(q.stemText, q.num, why);
        return;
      }

      // 半题：只填上了一部分空。**不能算答完** —— 否则卡片与「已填 N 题」都在说谎，
      // 而剩下那个空是空的，用户会直接交卷。写进去的答案保留，同时进未答清单。
      if (res.incomplete) {
        miss++;
        const why = `只填上 ${n} 个空，还差 ${res.incomplete} 个，请手动补`;
        missList.push({ no: q.num !== undefined ? q.num : idx, stem: q.stemText, why });
        log(`[半答] ${q.stemText.slice(0, 18)}… ${why}`, "var(--c-warn)");
        if (scanPanelApi.paintByStem) scanPanelApi.paintByStem(q.stemText, q.num, res);
        if (scanPanelApi.paintError) scanPanelApi.paintError(q.stemText, q.num, why);
        return;
      }

      if (String(res.how).indexOf("AI") === 0) aiHit++; else bankHit++;
      const pct = res.score && res.score < 1 ? `（相似度 ${Math.round(res.score * 100)}%）` : "";
      // 纯选项列表（没有 input）点不出选中态时如实标注：不能让它读起来像"已确认填好"
      const unsure = q.optionClickUnverified ? "（已点击，但页面选中态读不到，请核对）" : "";
      log(`[${res.how}]${pct} ${q.stemText.slice(0, 18)}… → ${answerToText(res)}${unsure}`, res.how === "AI" ? "var(--c-violet)" : "var(--c-sky)");

      // 面板上同步显示答案 / 解析 / 思考。
      // 否则答案只落在页面控件上，人看面板什么都看不到。
      if (scanPanelApi.paintByStem) scanPanelApi.paintByStem(q.stemText, q.num, res);
    }

    // 逐页作答循环：单页问卷一轮结束；
    // 分页/逐题问卷（如问卷星逐题模式）答完当前页后自动点「下一题」继续
    const MAX_PAGES = 80;
    let page = 1;

    // 并发度：同时在飞的 AI 请求数。
    // 为什么默认 3：既能明显缩短总时长，又不至于把免费/限流接口打爆（429）。
    // 题库命中不联网，这条设置对纯题库模式没有影响。
    // 并发度：走共用的解析（见 resolveConcurrency）——开关关掉即 1 路，上限锁 5。
    const CONCURRENCY = resolveConcurrency(settings);

    while (running && questions.length) {
      let answeredThisPage = 0;

      // ① 先按题序筛出这一页"真正要作答"的题（跳过已答的、低置信的）。
      //    筛选题很便宜（纯 DOM 判断），仍然串行做，保证 skipped/lowConf 的计数与
      //    日志顺序稳定 —— 用户看到的日志不会因为并发而错位。
      const todo = [];
      for (const q of questions) {
        if (!running) break;
        // 暂停检查点：waitOrStop 已经能"停在原地"，但它只在**等待**里生效；
        // 若上一题刚答完（intervalMs=0 时 waitOrStop 立即返回），循环会直接冲进下一题。
        // 这里补一道闸门，保证暂停期间一道题都不再答。
        await waitOrStop(0);
        // await 之后必须**再查一次** running：waitOrStop(0) 在未暂停时是"立即 resolve"，
        // 但 await 本身会让出一个微任务，用户正好在这个缝隙里点了停止时，
        // 下面照样会进入作答 —— 表现就是"点了停止又多发 1 个 AI 请求"。
        if (!running) break;
        // 已作答过就跳过（重复运行/翻页回来）：
        // 有控件的看有没有选中项；选项列表型的看对应元素是否已经被点过；
        // 填空题看所有空是否都写过。
        //
        // 已作答过的题直接跳过，对所有识别路径生效；判定只看页面现状
        //（有没有勾选、有没有被写过），与题目来自哪条识别路径无关。
        // inputs 里可能混着 null（.opt 里没有 <input> 的排版），判空才能读 checked
        if (!settings.overwriteSelected && (q.inputs || []).some(inp => inp && inp.checked)) { skipped++; continue; }
        if (!settings.overwriteSelected && q.byOptionList && (q.optEls || []).some(el => looksSelected(el))) { skipped++; continue; }
        if (q.byOptionList && (q.optEls || []).some(el => filledEls.has(el))) { skipped++; continue; }
        // 填空题这条也要防：翻页重扫后同一道题会再走一遍，
        // 于是 ① 重复请求一次 AI（白花 token）② fillBlankTexts 因 filledEls
        // 去重返回 0，被下面误报成"[失败] 没能写进页面"——其实早就写好了。
        if (q.fillText && (q.blankInputs || []).length &&
            (q.blankInputs || []).every(el => filledEls.has(el))) { skipped++; continue; }
        // 题干不够格就不自动点（表单路径与选项列表路径同一套闸门）：
        // 没有 input 那种强信号，分点说明、设置项、筛选器在结构上与选择题无法区分，
        // 只能靠题干措辞。只读面板里照常能看答案。
        if (q.stemIsQuestion === false) {
          lowConf++;
          log(`[跳过·低置信] ${q.stemText.slice(0, 18)}… 题干不像问句，不自动点`, "var(--c-warn)");
          continue;
        }
        todo.push(q);
      }

      // ② 流水线：N 个 worker 在前面并发取答案，一个消费者**按题序**边就绪边落地。
      //
      // 为什么不是"先全部取完、再按序写页面"：那样落地阶段是一段纯串行的长尾，
      // 总耗时 = 取答案 + 写页面（两段不重叠），并发收益有限；
      // 而且**整轮结束前屏幕上一条答案都不会出现**，用户以为卡死了。
      //
      // 现在：取答案与写页面重叠进行，总耗时 ≈ max(取答案, 写页面)；
      // 且第 i 题一就绪就立刻显示，用户能实时看到进度。
      //
      // 保序的关键是 slots：消费者严格按 i 递增地等 slots[i]，
      // 即使第 5 题比第 1 题先返回，也绝不会先写第 5 题（填涂不可逆，顺序必须对）。
      const results = new Array(todo.length);
      const slots = todo.map(() => { let go; const p = new Promise(r => { go = r; }); return { p, go }; });
      const workers = Math.min(CONCURRENCY, todo.length);
      if (workers > 1 && todo.length > 1) {
        log(`开始并发作答（${workers} 路并行请求，答案仍按题序填涂）`, "var(--c-accent)");
      }

      const producers = (async () => {
        let cursor = 0;
        try {
          await Promise.all(Array.from({ length: workers }, async () => {
            while (running) {
              const i = cursor++;
              if (i >= todo.length) break;
              // 暂停/停止闸门：每取一题前都检查一次，保证停止后不再发新请求
              await waitOrStop(0);
              if (!running) break;
              try {
                results[i] = await fetchOne(todo[i]);
              } catch (e) {
                // 单题异常不能拖垮整批：记成"这题失败"，落地阶段照常报出来
                results[i] = { answer: null, error: e && e.message ? e.message : String(e) };
              }
              slots[i].go();   // 通知消费者：第 i 题就绪
              await waitOrStop(settings.intervalMs);
            }
          }));
        } finally {
          // ⚠ 放行剩余 slot **必须**放在"全部生产者都结束之后"（这里是 Promise.all 之后），
          // 不能在单个 worker 退出时放行：先跑完的 worker（拿到最后一题、
          // 延迟最短）会把还没被任何 worker 取到的题的 slot 一起放行，消费者 await 立刻返回、
          // 而 results[i] 还是 undefined，落地就成了"未取得答案"。
          //
          // 这个 finally 同时防另一种死锁：停止时消费者可能正 await slots[i].p，
          // 而对应的 worker 已因 !running 退出、永远不会 go()；
          // 这里统一放行后，消费者 await 返回 → 再查 !running → 正常退出。
          for (let j = 0; j < slots.length; j++) { try { slots[j].go(); } catch (_) {} }
        }
      })();

      // ③ 消费者：严格按题序落地。等待期间生产者仍在并发取后面的题（流水线重叠）。
      for (let i = 0; i < todo.length; i++) {
        if (!running) break;
        // 暂停检查点：暂停时在这里挂起，恢复后接着从这一题落地
        await waitOrStop(0);
        if (!running) break;
        await slots[i].p;
        if (!running) break;
        applyOne(todo[i], answeredThisPage + 1, results[i] || { answer: null, error: "未取得答案" });
        answeredThisPage++;
      }
      await producers;

      const nextBtn = findNextPageButton(
        questions[0] && questions[0].el && questions[0].el.ownerDocument);
      if (!nextBtn || !answeredThisPage || page >= MAX_PAGES) break;
      // 停止检查点：用户喊停之后**绝不再翻页**。翻页会触发页面自己的保存/跳转，
      // "按了停止还跳一页"比少答一题严重得多。
      if (!running) break;

      const prevSig = pageSignature(questions);
      page++;
      log(`第 ${page - 1} 页完成，自动进入下一页…`, "var(--c-accent)");
      try { nextBtn.click(); } catch (_) {}

      const waitMs = Math.max(3000, settings.intervalMs + 1500);
      questions = await waitPageChange(prevSig, waitMs);
      if (!running) break;
      // 页面已经换了，但识别面板的题卡还是上一页建的。手动「重新扫描」能好，
      // 自动翻页后也必须走同一条刷新路径；否则 run() 按题干找不到新卡片，
      // 面板会一直停在上页。放在空页/同页判断之前，空页也要先清掉旧卡片。
      const pageChanged = pageSignature(questions) !== prevSig;
      if (pageChanged && scanPanel && scanPanelApi.fillList) {
        try {
          scanPanelApi.fillList();
        } catch (e) {
          log("面板刷新失败，继续作答：" + ((e && e.message) || e), "var(--c-warn)");
        }
      }
      if (!questions.length) {
        log("翻页后没有识别到题目，停止。请自己核对这一页有没有答上。", "var(--c-danger)");
        break;
      }
      if (!pageChanged) {
        // 等了上限页面还是那一页：不再原地重试，如实说明可能漏答
        log(`翻页后页面没有变化（等了 ${Math.round(waitMs / 1000)} 秒），停止。后面若还有题请自己翻，答完记得自己核对。`, "var(--c-danger)");
        break;
      }
    }

    log(`完成：题库命中 ${bankHit}，AI 作答 ${aiHit}，未答 ${miss}${skipped ? `，跳过已答 ${skipped}` : ""}${lowConf ? `，低置信跳过 ${lowConf}` : ""}${page > 1 ? `，共 ${page} 页` : ""}`, "var(--c-accent)");
    // 未答清单：逐条给出题号与原因，用户才知道该手动补哪几道、为什么没答上
    if (missList.length) {
      const nums = missList.map(m => m.no).filter(n => n !== undefined && n !== null);
      log(`未答的题：${nums.length ? nums.join("、") : missList.length + " 道（页面没给题号）"}`, "var(--c-danger)");
      const byReason = {};
      missList.forEach(m => { byReason[m.why] = (byReason[m.why] || 0) + 1; });
      Object.keys(byReason).forEach(why => log(`  · ${byReason[why]} 道：${why}`, "var(--c-warn)"));
    }
    // 这一行按真实落地数显示，不能一题都没写进去也报绿色「已答完当前页面」。
    // bankHit/aiHit 只在回读确认写入成功后才自增。
    const wrote = bankHit + aiHit;
    log(wrote
      ? `已答完当前页面：写进页面 ${wrote} 题${miss ? `，另有 ${miss} 题要你手动补（原因见上面的清单）` : ""}。下拉/矩阵题请手动补答，是否交卷由你手动决定`
      : `本页 ${miss} 题**一题都没能写进页面**，请核对题目结构后手动作答（下拉题/矩阵题本来就只能手动）。`,
      wrote ? "var(--c-sky)" : "var(--c-danger)");
    running = false;

    // ---- 收尾提示条：不管面板开没开，用户都必须看见这一句 ----
    // 只写进 log() 的话，面板默认关闭时日志只在控制台，
    // 于是「插件到底替没替我交卷」会变成一个悬念 —— 这是最该说清的一句。
    (() => {
      const filled = bankHit + aiHit;
      const left = missList.length;
      const tail = left ? (`，还有 ${left} 道没答上（点这里看清单）`) : "";
      toast(
        `已填 ${filled} 题${tail}。\n核对后请自己点「提交」——插件不会替你交卷。\n练习工具，正式考试 / 监考环境请勿使用。`,
        left ? "warn" : "ok",
        12000,
        () => { try { if (scanPanel && scanPanelApi.fillList) scanPanelApi.fillList(); else startScanMode(); } catch (_) {} }
      );
    })();
    if (scanPanelApi.setBusy) scanPanelApi.setBusy(false);
  }

  // ---------- 接收 popup 指令 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 已被更新版本接管时，旧实例不再响应 ——
    // 否则重载扩展后新旧两版会同时动作（两个面板、答两遍）
    if (window.__aaContentLoaded !== EXT_VERSION) return;
    // 弹窗站点卡：只读统计，不扫描、不写页面。没有面板时返回 hasPanel:false。
    if (msg.type === "GET_STATS") {
      (async () => {
        let allowed = null;
        try { allowed = await fillAllowedOk(await loadFillSettings()); } catch (_) {}
        const cards = [...document.querySelectorAll(".aa-card")];
        const answers = cards.map(c => {
          const a = c.querySelector(".aa-answer");
          return a && a.style.display !== "none" ? String(a.textContent || "").trim() : "";
        });
        const out = {
          ok: true,
          host: location.hostname,
          allowed,
          hasPanel: !!scanPanel,
          total: cards.length,
          answered: answers.filter(t => t.startsWith("✓")).length,
          missed: answers.filter(t => t.startsWith("✗") || t.startsWith("⚠")).length
        };
        if (typeof sendResponse === "function") { try { sendResponse(out); } catch (_) {} }
      })();
      return true;
    }
    if (msg.type === "START") run(msg.settings);
    if (msg.type === "START_SCAN") startScanMode(false);
    if (msg.type === "ANSWER") showAnswerResult(msg);
    if (msg.type === "STOP") {
      // 必须走 stopRun：只置 running 的话，循环还卡在 sleep 或在飞的请求里，
      // 用户会觉得"点了停止没反应"。stopRun 会当场唤醒等待并中断请求。
      stopRun("已手动停止");
      hidePanel();
    }
  });

  // ================= 页面题目识别模式（任意页面，只显示答案，不填涂） =================

  // ---------- 扫描上下文：顶层文档 + 同源 iframe ----------
  // 学习通等平台把题目放在内容 iframe 里，而 content script 只注入顶层
  // （manifest 的 all_frames:false）。顶层对**同源** iframe 的 DOM 有完整访问权，
  // 所以这里按文档分别跑同一套扫描器 —— 不用给每个 frame 再注入一份脚本，
  // 也不会重复建 17 万题的索引。跨域 frame 读不到，只能计数并在空态里明说。
  let scanRoot = null;              // 当前正在扫的 Document；null = 顶层
  let scanBlockedFrames = 0;        // 最近一次扫描遇到的无权访问的 frame 数

  function rootDoc() { return scanRoot || document; }

  function scanIn(doc, fn) {
    const prev = scanRoot;
    scanRoot = doc;
    try { return fn(); } finally { scanRoot = prev; }
  }

  function scanDocuments() {
    const docs = [];
    const seen = new Set();
    scanBlockedFrames = 0;
    // 广告位、埋点、隐藏编辑器也是 iframe；扫描它们既慢又会让「跨域」提示误报。
    // 只认可见且有实际尺寸的 frame（Chaoxing 的内容区远大于 20px）。
    const usableFrame = f => {
      try {
        const st = winOf(f).getComputedStyle(f);
        if (f.offsetParent === null && st.position !== "fixed") return false;
        const r = f.getBoundingClientRect();
        return r.width >= 20 && r.height >= 20;
      } catch (_) { return true; }
    };
    const visit = doc => {
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      docs.push(doc);
      let frames = [];
      try { frames = [...doc.querySelectorAll("iframe,frame")]; } catch (_) {}
      for (const f of frames) {
        if (!usableFrame(f)) continue;
        let child = null;
        try { child = f.contentDocument; } catch (_) {}
        // 跨域 iframe 的 contentDocument 是 null（不是抛异常），两种都按不可读计
        if (child && child.documentElement) visit(child);
        else scanBlockedFrames++;
      }
    };
    visit(document);
    return docs;
  }

  // 每个文档单独跑一遍；回调返回数组。保持文档顺序（顶层 → 各 iframe 的文档顺序），
  // 文档内部再按 DOM 位置排序 —— compareDocumentPosition 跨文档只会返回 DISCONNECTED。
  function scanEachDoc(fn) {
    return scanDocuments().map(doc => scanIn(doc, fn));
  }

  function sortByDomPosition(qs) {
    return qs.slice().sort((a, b) => {
      if (!a.el || !b.el || a.el === b.el) return 0;
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 :
             pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
  }

  function isDocRoot(node) {
    const d = node && node.ownerDocument;
    return !!d && (node === d.body || node === d.documentElement);
  }

  // iframe 里的元素必须用它自己文档的 window：顶层 window.getComputedStyle
  // 对子文档元素不可靠，Event 构造器也不是同一个 realm。
  function winOf(el) {
    const w = el && el.ownerDocument && el.ownerDocument.defaultView;
    return w || window;
  }

  function visibleEl(el) {
    return el.offsetParent !== null || winOf(el).getComputedStyle(el).position === "fixed";
  }

  // 题目里的 <img> 不会被 textContent 读到，AI 只能拿到文字。这里只统计
  // 有实际渲染尺寸的图：题型小图标、站点 logo 不算“图片材料”。
  // 阈值取 80×40：能覆盖材料图、表格图、公式长条图，又放过绝大多数图标。
  function countQuestionImages(el) {
    if (!el || !el.querySelectorAll) return 0;
    let n = 0;
    for (const img of el.querySelectorAll("img")) {
      if (scanPanel?.contains(img)) continue;
      if (!visibleEl(img)) continue;
      const r = img.getBoundingClientRect();
      const w = r.width || img.naturalWidth || img.width || 0;
      const h = r.height || img.naturalHeight || img.height || 0;
      if (w >= 80 && h >= 40) n++;
    }
    return n;
  }

  function normText(t) {
    return (t || "").replace(/\s+/g, "").trim();
  }

  function extractStemText(container, excludeEls) {
    const exclude = new Set(excludeEls);
    const doc = container.ownerDocument || document;
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(t) {
        const p = t.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // 只要祖先链上出现过被排除的元素，这段文字就属于选项（或表单控件），不能算题干。
        // 只查"父元素本身是不是被排除"的话，选项文本套一层 <span> 时就会漏进来
        // （<div class="opt"><span>A、正确</span></div> 里的「A、正确」被当成题干）。
        // 注意终点要**含 container 本身**：被排除的选项容器常常就是 container
        // （<label><input><span>JavaScript</span></label>，此时文本父节点是 span，
        // 只查到 label 之前就停下的话选项文字会整段变成题干）。
        for (let a = p; a; a = a.parentElement) {
          if (exclude.has(a)) return NodeFilter.FILTER_REJECT;
          if (a === container) break;
        }
        const st = winOf(p).getComputedStyle(p);
        if (st.display === "none" || st.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return t.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let s = "";
    while (walker.nextNode()) s += walker.currentNode.textContent.trim() + " ";
    return s.replace(/\s+/g, " ").trim();
  }

  // 选项的可点击/文本容器。优先级：
  //   1. <label>（标准）
  //   2. [for="<input.id>"] 关联元素 —— 问卷星的选项文本在 <div class="label" for="q4_1">，
  //      而 input 被裹在空文本的 span.jqradiowrapper 里，parentElement 取不到文本
  //   3. 向上最多 3 层找第一个有文本的祖先（空 wrapper → div.ui-radio）
  function optOf(inp) {
    if (inp.id) {
      try {
        const doc = inp.ownerDocument || document;
        const byFor = doc.querySelector('[for="' + CSS.escape(inp.id) + '"]');
        if (byFor && byFor.textContent.trim()) return byFor;
      } catch (_) {}
    }
    const lab = inp.closest("label");
    if (lab) return lab;
    let n = inp.parentElement;
    for (let i = 0; i < 3 && n; i++) {
      if (n.textContent.trim()) return n;
      n = n.parentElement;
    }
    return inp.parentElement;
  }

  // 策略1：radio/checkbox 选项组。真实网站的选项经常不共享 name，
  // 所以按"文档顺序相邻 + 公共祖先"聚类，name 只作为强制分题的辅助信号。
  // 注意：问卷星等站点会把原生 input 藏起来（display:none）用 CSS 自绘样式，
  // 因此可见性判断放宽为「input 可见 或 其选项容器可见」
  function scanFormGroups() {
    const inputs = [...rootDoc().querySelectorAll('input[type=radio],input[type=checkbox]')]
      .filter(inp => visibleEl(inp) || visibleEl(optOf(inp)));
    if (!inputs.length) return [];

    const nameCount = new Map();
    inputs.forEach(i => nameCount.set(i.name, (nameCount.get(i.name) || 0) + 1));
    const informative = n => {
      const c = nameCount.get(n) || 0;
      return n && c >= 2 && c <= 10;
    };

    function clusterByDocOrder(list) {
      const groups = [];
      let cur = [], curOpt = null, curName = null;
      list.forEach(inp => {
        const opt = optOf(inp);
        if (!cur.length) { cur = [inp]; curOpt = opt; curName = inp.name; return; }
        const sameQ = sharesAncestor(curOpt, opt, 5) &&
          !(informative(inp.name) && informative(curName) && inp.name !== curName);
        if (sameQ) cur.push(inp);
        else { groups.push(cur); cur = [inp]; }
        curOpt = opt; curName = inp.name;
      });
      if (cur.length) groups.push(cur);
      return groups;
    }

    // 优先按 name 分组；若组特别碎（平均 < 2.5 选项/组）说明 name 不可靠，改用聚类
    const byName = new Map();
    inputs.forEach(inp => {
      const key = inp.name || "__anon__";
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(inp);
    });
    const nameGroups = [...byName.entries()]
      .filter(([k, v]) => k !== "__anon__" && v.length >= 2 && v.length <= 10)
      .map(([, v]) => v);
    const totalNamed = nameGroups.reduce((s, v) => s + v.length, 0);

    let clusters;
    if (nameGroups.length >= 4 && totalNamed / nameGroups.length < 2.5) {
      clusters = clusterByDocOrder(inputs);
    } else if (nameGroups.length) {
      clusters = nameGroups;
      const anon = byName.get("__anon__") || [];
      if (anon.length >= 2) clusters = clusters.concat(clusterByDocOrder(anon));
    } else {
      clusters = clusterByDocOrder(inputs);
    }

    return clusters.map(buildQuestionFromInputs).filter(Boolean);
  }

  function sharesAncestor(a, b, maxLevels) {
    let p = a;
    for (let i = 0; i <= maxLevels && p; i++) {
      if (p.contains(b)) return true;
      p = p.parentElement;
    }
    return false;
  }

  // 候选题干容器里是不是还装着「别人的选项组」？
  // 装了说明这是个页面级大容器，从它里面抽出来的"题干"其实是好几块文字拼起来的
  // ——例如侧边栏筛选器的容器里抽出过 "按价格筛选 1. 下列哪一个是编程语言？"，
  // 结果拿真题的题干给筛选器的四个 checkbox 作答，答案点到了价格区间上。
  // 单打独斗的一个 input（搜索框、表单里的"其他"项）不算别人的选项组，不阻塞。
  function hasForeignOptionGroup(node, ownInputs) {
    const own = new Set(ownInputs);
    const others = [...node.querySelectorAll("input[type=radio],input[type=checkbox]")]
      .filter(inp => !own.has(inp) && (visibleEl(inp) || visibleEl(optOf(inp))));
    if (!others.length) return false;
    const byName = new Map();
    others.forEach(inp => byName.set(inp.name, (byName.get(inp.name) || 0) + 1));
    for (const c of byName.values()) if (c >= 2) return true;
    return false;
  }

  function buildQuestionFromInputs(inputs) {
    if (inputs.length < 2 || inputs.length > 12) return null;
    const labs = inputs.map(inp => inp.closest("label")).filter(Boolean);
    // 选项容器（label / [for=id] 关联元素 / 有文本的父级，见 optOf）：
    // 提题干时把它整个排除，题干才不会混入选项文字
    const optContainers = inputs.map(optOf).filter(Boolean);
    const labels = inputs.map(inp =>
      (optOf(inp)?.textContent || "").replace(/\s+/g, " ").trim() || "");
    if (labels.some(l => !l)) return null;

    // 题干提取两轮：干净模式（排除整个选项容器）优先，
    // 找不到再退回宽松模式（只排除 label），照顾选项容器过大的页面。
    // 每一层都要先确认"这层容器里没有别人的选项组"：容器一旦装下第二道题，
    // 从里面抽出来的文字就是几块拼起来的，拼出来的题干配不上这组选项。
    let stem = "";
    let qEl = null;
    for (const exclude of [optContainers, labs]) {
      stem = "";
      qEl = null;
      let node = inputs[0];
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node || isDocRoot(node)) break;
        if (hasForeignOptionGroup(node, inputs)) continue;
        const s = extractStemText(node, exclude);
        if (normText(s).length >= 8) { stem = s; qEl = node; break; }
      }
      if (stem) break;
    }
    // 兜底：题干和选项不在同一个容器里（题干是选项容器的前一个兄弟节点）时，
    // 向上走的同时看一眼前兄弟，否则这种情况整道题会被直接丢掉。
    if (!stem) {
      let node = inputs[0];
      for (let i = 0; i < 4 && node && !stem; i++) {
        node = node.parentElement;
        if (!node || isDocRoot(node)) break;
        let prev = node.previousElementSibling;
        for (let hop = 0; hop < 3 && prev; hop++) {
          if (!/^(script|style|noscript)$/i.test(prev.tagName)) {
            const t = prev.textContent.replace(/\s+/g, " ").trim();
            const n = normText(t).length;
            // 排除"另一个选项块"：以 A. / B. 开头的一律不当题干
            if (n >= 4 && n <= 300 && !/^\s*[A-H]\s*[).、．]/.test(t) && !parseOptionPool(prev)) {
              stem = t;
              qEl = node;
              break;
            }
          }
          prev = prev.previousElementSibling;
        }
      }
    }
    if (!stem) return null;
    stem = stem.replace(/^(单选|多选|判断)\s*/i, "")
               .replace(/^第\s*\d+\s*\/\s*\d+\s*题\s*/i, "")
               .trim();
    // 完形填空的表单形式：radio 的 name 直接是题号（如 name="36"），
    // 且题干要么爬丢了要么是整段文章——这时按完形填空处理
    const nm = inputs[0].name || "";
    const nStem = normText(stem).length;
    if (/^\d{1,3}$/.test(nm) && (nStem > 200 || nStem < 8)) {
      const num = parseInt(nm);
      return {
        stem: `第 ${num} 空（完形填空）`,
        options: labels.map(l => l.replace(/\s+/g, " ").slice(0, 60)),
        clozeNum: num,
        el: qEl
      };
    }
    // 题干过长说明爬到了页面级大容器：只取靠近选项的尾部
    if (normText(stem).length > 200) {
      stem = "…" + stem.slice(-240).replace(/^\S*\s/, "");
    }
    const numM = stem.match(/^\s*(\d{1,3})\s*[.、．)]/);
    return {
      stem: stem.slice(0, 300),
      options: labels.map(l => l.replace(/\s+/g, " ").trim()),
      labels,
      inputs,                    // 与 labels/options 一一对应，自动填涂用
      el: qEl,
      ...(numM ? { num: parseInt(numM[1]) } : {})
    };
  }

  // 策略5：填空题 —— 文本输入框。与选择题最大的不同是：答案不是字母而是"内容"，
  // 而且要真的写进框里，所以准入门槛比识别别的题型更保守（见 looksLikeFormField）。
  const FREE_TEXT_CLASS_RE = /(^|\s)answer-input(\s|$)/i;
  const FREE_TEXT_HINT_RE = /write (the )?(full |whole )?(new )?sentence|write the whole|corrected sentence|rewrite|translate|paraphrase|type your answer|your answer|完整句子|改写|翻译|改错|简答|作答|回答|请输入答案/i;
  const REWRITE_STEM_RE = /改为|改写|改错|翻译|重写|转述|合并成|开头合并|用.{0,24}(改写|合并|开头)|rewrite|translate|paraphrase|correct(?:ed| the sentence)|change (?:it )?into|indirect speech|passive voice|inversion|too\s*(?:…|\.\.\.)?\s*to|so\s*(?:…|\.\.\.)?\s*that|unless|in spite of/i;

  // 句改/改错/翻译/简答这类题没有 A/B/C/D，但页面上有文字输入框。
  // 只看占位符/类名/aria 文案，避免把登录、搜索框当成答题框。
  function looksLikeFreeTextInput(el) {
    if (!el) return false;
    if (FREE_TEXT_CLASS_RE.test(String(el.className || ""))) return true;
    const hint = (el.placeholder || "") + " " + (el.getAttribute && el.getAttribute("aria-label") || "") +
      " " + (el.title || "");
    return FREE_TEXT_HINT_RE.test(hint);
  }

  function isCorrectTextInput(el) {
    return /correct/i.test(((el && el.placeholder) || "") + " " + ((el && el.className) || ""));
  }

  function looksLikeRewriteStem(stem) {
    return REWRITE_STEM_RE.test(stem || "");
  }

  // 自由文本题的题干应该包含"原句 + 改写要求"。
  // findStemForInput 先看前一个兄弟，句改题那里只会拿到「改为间接引语…」这段要求
  // （原句在再前一个兄弟），所以这里向上找最近的完整题目容器，再把输入框排除。
  function findFreeTextStem(input) {
    let node = input;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node || isDocRoot(node)) break;
      const t = extractStemText(node, [input]).replace(/\s+/g, " ").trim();
      const n = normText(t).length;
      if (n < 6 || n > 320) continue;
      if (/^\s*(?:第\s*)?\d{1,3}\s*[.、．)]/.test(t) ||
          looksLikeRewriteStem(t) || looksLikeBlankStem(t)) {
        return { stem: t, stemEl: node };
      }
    }
    return null;
  }

  function scanTextInputs() {
    const groups = new Map();                       // 题干 → 该题的输入框列表
    rootDoc().querySelectorAll("input, textarea, [contenteditable]").forEach(el => {
      if (!isFillInput(el) || !visibleEl(el)) return;
      if (scanPanel?.contains(el)) return;
      if (looksLikeFormField(el)) return;
      const freeText = looksLikeFreeTextInput(el);
      let { stem, stemEl } = findStemForInput(el);
      if (freeText) {
        const rich = findFreeTextStem(el);
        if (rich) { stem = rich.stem; stemEl = rich.stemEl; }
      }
      if (!stem || (!looksLikeBlankStem(stem) && !freeText)) return;
      const key = normText(stem);
      if (!key) return;
      // 同一题干下的多个输入框 = 一道题里的多个空，合成一道（拆开答会各写各的、顺序也乱）
      if (!groups.has(key)) {
        groups.set(key, {
          stem, stemEl, inputs: [],
          freeText: !!freeText,
          correct: !!(freeText && isCorrectTextInput(el)),
          rewrite: !!(freeText && looksLikeRewriteStem(stem))
        });
      }
      const g = groups.get(key);
      g.inputs.push(el);
      if (freeText) g.freeText = true;
      if (freeText && isCorrectTextInput(el)) g.correct = true;
      if (freeText && looksLikeRewriteStem(stem)) g.rewrite = true;
    });

    return [...groups.values()].map(g => {
      const q = {
        stem: g.stem,
        stemText: g.stem,
        options: [],
        fillText: true,
        blankInputs: g.inputs,
        el: g.stemEl || g.inputs[0],
      };
      if (g.freeText) {
        q.freeText = true;
        q.freeTextKind = g.correct ? "correct" : g.rewrite ? "rewrite" : "text";
      }
      const numM = g.stem.match(/^\s*第?\s*(\d{1,3})\s*(?:空|题)?\s*[.、．)]/);
      if (numM) q.num = parseInt(numM[1]);
      // 文章里的选词填空（空在正文中、旁边有 A-O 词库）：把词库挂上，AI 才能选对词
      // 自由文本题（改写/改错/翻译）没有词库，跳过，免得把页面其他文字当成候选词。
      if (!g.freeText) {
        const up = g.stemEl && g.stemEl.closest("article,section,div");
        if (up && normText(up.textContent).length >= 300) {
          const bank = findWordBankNear(g.inputs[0]);
          if (bank) q.options = bank;
        }
      }
      return q;
    });
  }

  // 能填文字的控件：text/search/tel/email/number/无 type/textarea
  function isFillInput(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.isContentEditable || (el.getAttribute && el.getAttribute("contenteditable") === "true")) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "tel", "email", "number", ""].indexOf(t) >= 0;
  }

  // 明显是"网站表单"而不是"题目"的输入框。这是防止把登录框/搜索框当填空题、往里面乱写的第一道闸门。
  const FORM_FIELD_RE = /user|pass|pwd|login|account|search|query|email|mail|phone|mobile|tel|sms|captcha|verify|token|url|address|zip|card|nick|avatar/i;
  const FORM_HINT_RE = /用户名|密码|账号|搜索|搜一搜|手机号|手机号码|邮箱|验证码|短信|昵称|收货|地址|订单|登录|注册|绑定|姓名|身份证|银行卡/;

  function looksLikeFormField(el) {
    if ((el.getAttribute("type") || "").toLowerCase() === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/^(username|current-password|new-password|email|tel|one-time-code|cc-number)$/.test(ac)) return true;
    if (FORM_FIELD_RE.test(((el.name || "") + " " + (el.id || "")))) return true;
    const hint = (el.placeholder || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.title || "");
    if (FORM_HINT_RE.test(hint)) return true;
    return false;
  }

  // 题干"像不像一道填空"：有空格标记，或者像问句/带题号。
  // 不满足就不认——宁可漏，也不能往陌生页面的输入框里写东西。
  function looksLikeBlankStem(stem) {
    const s = stem || "";
    if (/_{2,}|＿{2,}|（\s*）|\(\s*\)|【\s*】|\[\s*\]/.test(s)) return true;
    if (/[？?]/.test(s)) return true;
    if (/^\s*(?:第\s*)?\d{1,3}\s*(?:空|题)?\s*[.、．)]/.test(s)) return true;
    if (/下列|以下|哪一?[个些种项]?|正确|错误|填空|填入|填上|应为|请填/.test(s)) return true;
    return false;
  }

  // 给填空题找题干。顺序很关键：
  //   ① 先看输入框前面的兄弟节点 —— 题干通常就紧挨在前面（<div class="q-stem">…</div><input>），
  //      这样取到的是干净题干
  //   ② 再向上找容器 —— 题干和输入框混在同一段文字里（"中国的首都是 <input>"），
  //      这时整块容器的文字才是题干
  // 反过来（先向上）会把题号、标签之类的一起捞进来。
  function findStemForInput(input) {
    let node = input;
    for (let i = 0; i < 3 && node; i++) {
      let prev = node.previousElementSibling;
      for (let hop = 0; hop < 3 && prev; hop++) {
        if (!/^(script|style|noscript)$/i.test(prev.tagName)) {
          const t = prev.textContent.replace(/\s+/g, " ").trim();
          const n = normText(t).length;
          if (n >= 4 && n <= 300 && !parseOptionPool(prev)) return { stem: t, stemEl: prev };
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
      if (!node || isDocRoot(node)) break;
    }

    node = input;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node || isDocRoot(node)) break;
      const t = extractStemText(node, [input]).replace(/\s+/g, " ").trim();
      const n = normText(t).length;
      if (n >= 4 && n <= 300) return { stem: t, stemEl: node };
    }
    return { stem: "", stemEl: null };
  }

  // 从纯文本解析 "A. xx B. yy C. zz" / "A) xx B) yy" 形式的内联选项（很多网站不用表单控件）
  function parseInlineOptions(text) {
    const re = /(?:^|\s)([A-P])\s*[).、．]\s*/g;
    let m;
    const marks = [];
    while ((m = re.exec(text))) marks.push({ letter: m[1], start: m.index, end: re.lastIndex });
    if (marks.length < 2) return null;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].letter.charCodeAt(0) !== 65 + i) return null; // 必须从 A 连续编号
    }
    const stem = text.slice(0, marks[0].start).trim();
    // 题干须≥6字符；但完形填空的题干就是纯编号（如 "36."），放行
    if (normText(stem).length < 6 && !/^\d{1,3}\.?$/.test(stem.trim())) return null;
    const options = marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      return mk.letter + ". " + text.slice(mk.end, end).trim();
    });
    return { stem, options };
  }

  // 给「只靠文本规则认出来」的题目补上可点的选项元素。
  // 这条路径很关键：scanTextQuestions 只看文本，认得出「A、正确 / B、错误」，
  // 产出的题却没有 optEls → canFill() 恒 false → 面板能列出 50 题、点「填涂」却说
  // 「50 道题都没有可填的东西」。
  // 做法：在题目容器里按 A/B/C… 逐个找"以该字母开头"的最内层元素，并且要求
  // 剥掉字母后的文本与该选项的文本一致（optKey 比对）——对不上就整体放弃，
  // 宁可保持只读，也不点一个来路不明的元素。
  function resolveOptionEls(container, options) {
    if (!container || !Array.isArray(options) || options.length < 2) return null;
    const els = [];
    for (let i = 0; i < options.length; i++) {
      const letter = String.fromCharCode(65 + i);
      const want = optKey(options[i]);
      if (!want) return null;
      const lead = new RegExp("^" + letter + "(?![A-Za-z0-9])\\s*[.、．)]?\\s*(.+)$");
      const leadRe = new RegExp("^" + letter + "(?![A-Za-z0-9])\\s*[.、．)]?\\s*\\S");
      let hit = null;
      for (const node of container.querySelectorAll("*")) {
        if (!visibleEl(node)) continue;
        const t = node.textContent.replace(/\s+/g, " ").trim();
        if (!t || t.length > 200) continue;
        const m = t.match(lead);
        if (!m || optKey(m[1]) !== want) continue;
        // 子元素也以同一字母开头 → 还能往下钻，取最内层（点内层才有效）
        if ([...node.children].some(c => visibleEl(c) && leadRe.test(c.textContent.replace(/\s+/g, " ").trim()))) continue;
        hit = node;
        break;
      }
      if (!hit) return null;
      els.push(hit);
    }
    return els;
  }

  // 策略2：文本特征 —— 问句 / 括号填空 / 内联 A. B. C. 选项 / 题号开头 / 完形填空纯编号
  // 认出来的题尽量补上可点的 optEls（见 resolveOptionEls）：纯文本规则能认出判断题，
  // 但拿不到元素就只能看答案、不能填涂 —— 表现就是「50 道题都没有可填的东西」。
  function scanTextQuestions() {
    const out = [];
    const seen = new Set();
    rootDoc().querySelectorAll("p,div,li,td,span,h1,h2,h3,h4").forEach(el => {
      if (!visibleEl(el) || scanPanel?.contains(el)) return;
      if (el.children.length > 6) return;
      const text = el.textContent.replace(/\s+/g, " ").trim();
      const n = normText(text);
      if (n.length < 8 || n.length > 600) return;
      const parsed = parseInlineOptions(text);
      // 完形填空特征：题干只有编号 + 连续选项（如 "36. A. however B. while …"）
      const clozeLike = parsed && /^\d{1,3}\.?$/.test(parsed.stem.trim()) &&
        parsed.options.length >= 3;
      if (!clozeLike && n.length > 400) return;
      const looksLikeQ =
        clozeLike ||
        /[？?]\s*$/.test(text) ||
        /（\s*）|\(\s*\)|____+/.test(text) ||
        parsed !== null ||
        (/^\d{1,3}\s*[.、．)]/.test(text) && n.length > 12);
      if (!looksLikeQ) return;
      const key = n.slice(0, 40);
      if (seen.has(key)) return;
      seen.add(key);
      if (clozeLike) {
        const num = parseInt(parsed.stem);
        out.push({ stem: `第 ${num} 空（完形填空）`, options: parsed.options, clozeNum: num, el });
      } else {
        const base = parsed ? { ...parsed, el } : { stem: text, options: [], el };
        const numM = base.stem.match(/^\s*第?\s*(\d{1,3})\s*(?:空)?\s*[.、．)]/);
        if (numM) base.num = parseInt(numM[1]);
        // 文本里认出了选项（A、正确 / B、错误）时，把对应的 DOM 元素也找出来 ——
        // 找不到就保持只读（不塞半截 optEls），找到才能真的点下去
        if (base.options && base.options.length >= 2) {
          const els = resolveOptionEls(el, base.options);
          if (els) base.optEls = els;
        }
        out.push(base);
      }
    });
    return out;
  }

  // 候选材料是不是"另一道题"？题干以题号开头、带页面上的「第 N / M 题」标记，
  // 或内部出现两个以上不同字母的选项标记，都算。
  // 列表页里每道题的前一个兄弟就是上一道题，不排掉它，材料就会挂成上一题整块
  // （token 白烧，还会让模型照着上一题的材料答本题）。
  function looksLikeQuestionBlock(t) {
    if (/^\s*第?\s*\d{1,3}\s*[.、．)]/.test(t)) return true;
    if (/第\s*\d+\s*\/\s*\d+\s*题/.test(t)) return true;
    const letters = new Set(
      (t.match(/(?<![A-Za-z0-9])([A-H])\s*[.、．)]\s*\S/g) || []).map(s => s.trim().charAt(0))
    );
    return letters.size >= 2;
  }

  // ---------- 阅读材料：整篇容器 / 多段散装 / 题组共享 ----------
  const PASSAGE_MIN_CHARS = 150;
  const PASSAGE_MAX_CHARS = 6000;
  // 材料字数只给长材料看；短材料直接按普通题样式展示，避免每张卡都挂一串标签。
  const PASSAGE_CHIP_MIN_CHARS = 300;
  const PASSAGE_TAG_RE = /^(nav|header|footer|aside|script|style|noscript|template|head|link|meta|title|iframe|button|select|option|textarea|input)$/i;
  const PASSAGE_CHROME_RE = /(^|[\s_-])(nav|navbar|menu|breadcrumb|crumb|ad|ads|advert|banner|footer|header|sidebar|toolbar|share|comment|comments|related|recommend|pagination|pager|login|search)([\s_-]|$)/i;
  const PASSAGE_BOX_RE = /(^|[\s_-])(passage|article|reading|readingtext|material|excerpt|textcontent|articlecontent|passagecontent)([\s_-]|$)/i;

  function passageClassOf(el) {
    return String((el && el.className) || "") + " " + String((el && el.id) || "");
  }
  function isPassageContainer(el) {
    return !!el && PASSAGE_BOX_RE.test(passageClassOf(el));
  }
  function looksLikePageChrome(el) {
    if (!el || !el.tagName) return true;
    if (PASSAGE_TAG_RE.test(el.tagName)) return true;
    if (PASSAGE_CHROME_RE.test(passageClassOf(el))) return true;
    // 链接密度高的块通常是导航/相关推荐，不是阅读材料
    const links = el.querySelectorAll ? el.querySelectorAll("a").length : 0;
    const n = normText(el.textContent || "").length;
    if (links >= 3 && n > 0 && n / links < 30) return true;
    return false;
  }
  function hasQuestionInside(el) {
    if (!el || !el.querySelector) return false;
    return !!(el.matches && el.matches(".question, .singleQuesId, .questionLi, .TiMu, .question-item, .top-question")) ||
      !!el.querySelector(".question, .singleQuesId, .questionLi, .TiMu, .question-item, .top-question");
  }

  // 材料容器里的段落要保留换行：整个 .passage 的 textContent 会把三段粘成
  // "carefully.Paragraph 2."，模型和预览都更难读。标题也一起带上（阅读材料常靠标题定位）。
  function passageBlockText(el) {
    const paras = [...el.querySelectorAll("p, li")].filter(p => !p.querySelector("p, li"));
    if (paras.length >= 2) {
      const title = el.querySelector("h1, h2, h3, h4");
      const body = paras.map(p => p.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      return ((title && title.textContent.trim()) ? title.textContent.trim() + "\n" : "") + body;
    }
    return el.textContent.replace(/\s+/g, " ").trim();
  }

  // 从 node 往**前**收集连续文本块。整篇材料常在同一个 .passage 里，
  // 也有站点把每段直接摆成兄弟 <p>，所以不能只取最近的那一个。
  function collectPrecedingTextBlocks(node) {
    const parts = [];
    let prev = node && node.previousElementSibling;
    for (let hop = 0; hop < 12 && prev; hop++) {
      if (looksLikePageChrome(prev)) break;
      if (hasQuestionInside(prev)) break;
      const t = passageBlockText(prev);
      if (!t) { prev = prev.previousElementSibling; continue; }
      if (looksLikeQuestionBlock(t)) break;
      parts.unshift(t);
      if (normText(parts.join("")).length >= PASSAGE_MAX_CHARS) break;
      // 整个材料容器已经拿到，别再往前吞页头/导航
      if (isPassageContainer(prev)) break;
      prev = prev.previousElementSibling;
    }
    let text = parts.join("\n").trim();
    if (normText(text).length < PASSAGE_MIN_CHARS) return null;
    if (normText(text).length > PASSAGE_MAX_CHARS) {
      text = text.slice(0, PASSAGE_MAX_CHARS) + "…(材料已截断)";
    }
    return text;
  }

  // 从 startEl 向上爬，逐层看前置兄弟；到 stopAt（题组容器）为止。
  function collectPassageBefore(startEl, stopAt) {
    let node = startEl;
    for (let level = 0; level < 8 && node; level++) {
      if (isDocRoot(node)) break;
      const text = collectPrecedingTextBlocks(node);
      if (text) return text;
      if (node === stopAt) break;
      node = node.parentElement;
    }
    return null;
  }

  // 兼容单题调用：单题材料 = 从元素向上收集前置文本块。
  function findPassage(el) {
    return collectPassageBefore(el, null);
  }

  // 题干自己有没有"要参考材料"的指示语？单题路径仍用它兜底；
  // 题组路径不再依赖它（同一组题共享材料）。
  const PASSAGE_HINT =
    /阅读|根据(上述|上文|下文|以下|材料|短文|文章|文段)|文中|本文|这段话|这段文字|上述材料|上文|下文|作者(写|说|认为)|(?:the|this)\s+(?:passage|text|article|paragraph|excerpt|author|writer)|according to|main idea|infer|what can we learn|the first paragraph|the second paragraph|the third paragraph|in paragraph\s*\d+/i;
  // 只用于"题干像阅读题却没挂上材料"的提示，不参与自动挂载。
  const READING_LIKE_HINT =
    /阅读|文中|本文|根据(上述|上文|下文|材料|短文|文章)|作者|(?:the|this)\s+(?:passage|text|article|author|writer)|according to|main idea|infer|what can we learn|paragraph|excerpt/i;

  function applyPassage(q, p) {
    if (!p) return;
    const stem = stemOf(q);
    if (normText(p).length < Math.max(PASSAGE_MIN_CHARS, normText(stem).length * 1.5)) return;
    q.passage = p;
    q.passageMissing = false;
  }

  function markPassageMissing(q) {
    if (q.passage) return;
    if (READING_LIKE_HINT.test(stemOf(q))) q.passageMissing = true;
  }

  // 阅读题组：先找"最近的、包含至少两道题"的祖先作为题组容器，
  // 再从组内第一题往前收材料，挂给组内所有题 —— 这样没有提示词的题也能拿到材料。
  function attachPassagesInDoc(list) {
    const ordered = sortByDomPosition(list);
    const assigned = new Set();
    for (const q of ordered) {
      if (!q.el || assigned.has(q)) continue;
      let container = null;
      let node = q.el.parentElement;
      for (let level = 0; level < 8 && node; level++) {
        if (isDocRoot(node)) break;
        const count = ordered.filter(x => x.el && node.contains(x.el)).length;
        if (count >= 2) { container = node; break; }
        node = node.parentElement;
      }
      if (container) {
        const members = ordered.filter(x => x.el && container.contains(x.el));
        members.forEach(x => assigned.add(x));
        const shared = collectPassageBefore(members[0].el, container);
        for (const m of members) {
          if (m.clozeNum !== undefined) applyPassage(m, findClozeMaterial(m.el));
          else applyPassage(m, shared);
          markPassageMissing(m);
        }
      } else {
        assigned.add(q);
        if (q.clozeNum !== undefined) applyPassage(q, findClozeMaterial(q.el));
        else if (PASSAGE_HINT.test(stemOf(q))) applyPassage(q, collectPassageBefore(q.el, null));
        markPassageMissing(q);
      }
    }
  }

  // 批量入口：按文档分组，保持题组不跨 iframe。
  function attachPassages(qs) {
    if (!Array.isArray(qs) || !qs.length) return qs;
    const byDoc = new Map();
    for (const q of qs) {
      if (!q || !q.el) continue;
      const doc = q.el.ownerDocument || document;
      if (!byDoc.has(doc)) byDoc.set(doc, []);
      byDoc.get(doc).push(q);
    }
    for (const list of byDoc.values()) attachPassagesInDoc(list);
    return qs;
  }

  // 单题兜底：题组路径没覆盖时仍按提示词找一次。
  function attachPassage(q) {
    if (!q || q.passage) return q;
    if (!q.el || !q.el.isConnected) return q;
    const stem = stemOf(q);
    if (q.clozeNum === undefined && !PASSAGE_HINT.test(stem)) return q;
    const p = q.clozeNum !== undefined ? findClozeMaterial(q.el) : collectPassageBefore(q.el, null);
    if (p && normText(p).length >= Math.max(PASSAGE_MIN_CHARS, normText(stem).length * 1.5)) q.passage = p;
    return q;
  }

  // 相近题干去重（复用题库匹配的 LCS 相似度），保留选项更多的一份
  // 完形填空的题干高度相似（第36空/第37空），只按编号精确合并
  //
  // 判定分两级，顺序不能换：
  //   ① **结构级**（可信）：同一元素、互为祖先/后代、或落在同一个题目容器里
  //      —— 这些必然是"同一道题被两条策略各识别一次"，可以放心合并；
  //   ② **文本级**（启发式）：题干包含或相似度 ≥0.85 —— 只用于兜住结构判不出的重复。
  // ② 必须加一道"选项/答案不冲突"的闸门：两道**不同的题**完全可能措辞相近，
  // 例如「下列哪些数是质数？(2/9/11/15，答案 2、11)」与
  // 「下列哪些是质数？(2/3/11/15，答案 2、3、11)」相似度 0.90，
  // 被误判成同一题合并 → 题卡少一张，且被吞掉那道**永远答不到**
  //（用户看到的是"少了一道题"，很难联想到去重）。题干相近但选项集不同 = 两道题。
  // 一份检测里「选项文字条数」与「可点元素个数」是否配套。
  const clickableCount = x => ((x.inputs || []).filter(Boolean).length) || (x.optEls || []).length;

  // 两条检测指向的是不是**同一道题的 DOM**：容器相同/嵌套，或至少共用一个可点元素。
  //
  // 为什么非加这条不可：题干提取常会把选项文字一起吞进来（例如得到
  // 「F8 一 MySQL Nginx Redis」这种题干），于是四道**各自独立**的题两两相似度 0.9+，
  // 而它们的选项集又完全相同 —— 下面那道"选项集一致才许合"的闸门不但没挡住，
  // 反而成了合并的理由（4 道题只剩 1 张卡，多出来的三道永远答不到）。
  // 规则：容器不同、选项元素也不相交 → 就是两道题，文本再像都不许合。
  function sameQuestionNodes(o, q) {
    const nodesOf = x => [...(x.inputs || []).filter(Boolean), ...(x.optEls || []), ...(x.blankInputs || [])];
    if (o.el && q.el && (o.el === q.el || o.el.contains(q.el) || q.el.contains(o.el))) return true;
    const no = nodesOf(o), nq = nodesOf(q);
    if (!no.length || !nq.length) return true;   // 有一方根本没有可点元素：让文本判据去决定
    return no.some(n => nq.includes(n));
  }

  function dedupeQuestions(qs) {
    const out = [];
    // 选项集指纹：用于判断"题干相近但其实是两道题"
    const optKeyOf = q => (q.options || []).map(o => normText(o)).filter(Boolean).sort().join("|");
    for (const q of qs) {
      const dup = out.find(o => {
        // ① 结构级：同一元素的克隆（如空格题被"文本策略"和"空格策略"各识别一次）
        if (o.el && q.el && o.el !== q.el && (o.el.contains(q.el) || q.el.contains(o.el))) return true;
        const a = normText(o.stem), b = normText(q.stem);
        if (!a || !b) return false;
        // 文本判据（下面三条）都必须先过结构判据：不是同一道题的 DOM 就不许靠文字合并
        const sameNodes = sameQuestionNodes(o, q);
        if ((q.clozeNum !== undefined) || (o.clozeNum !== undefined)) {
          // 完形/选词填空只合并同编号；只看编号的话，第二篇完形的"第 1 空"会被第一篇吞掉
          return q.clozeNum === o.clozeNum && sameNodes;
        }
        if (!sameNodes) return false;
        // ②a 包含关系：同一道题被两条策略各识别一次，其中一条多带了前缀。
        // 有些页面的判断题就是这种情况：一种识别路径给出「光年是时间单位。」，
        // 通用文本策略给出「判断 第 19 / 85 题 光年是时间单位。」——短题干完整
        // 出现在长题干里，是很强的"同一道题"证据，直接合并（不能加选项闸门，
        // 两条路径提取出的选项写法可能不同，加了就合不上，会多出重复卡片）。
        if (a.includes(b) || b.includes(a)) return true;

        // ②b 相似度兜底：措辞相近但**互不包含**时才走这里，必须再确认选项集一致。
        // 两道不同的题完全可能措辞相近，例如「下列哪些数是质数？(2/9/11/15，答案 2、11)」
        // 与「下列哪些是质数？(2/3/11/15，答案 2、3、11)」相似度 0.90、互不包含，
        // 被误判成同一题合并 → 题卡少一张，被吞掉那道**永远答不到**
        //（用户只看到"少了一道题"，很难联想到去重）。
        if (similarity(a, b) < 0.85) return false;
        const ka = optKeyOf(o), kb = optKeyOf(q);
        // 双方都有选项且集合不同 → 是两道不同的题（选项顺序不同不算，已排序）
        if (ka && kb && ka !== kb) return false;
        return true;
      });
      if (dup) {
        // 保留"选项更全"的那一份 —— 但必须**连同可点元素与容器一起换**。
        // 只换 options 与 stem 的话：卡片显示 A 的选项、按索引点 B 的 inputs，
        // 勾错不可逆（而且两条路径的选项条数本来就可能不一样）。
        const qc = clickableCount(q), dc = clickableCount(dup);
        const canSwapWithTargets = q.options.length > dup.options.length && qc > 0 && qc === q.options.length;
        const bothTextOnly = q.options.length > dup.options.length && qc === 0 && dc === 0;
        if (canSwapWithTargets || bothTextOnly) {
          dup.options = q.options;
          dup.stem = q.stem;
          if (q.labels) dup.labels = q.labels;
          if (canSwapWithTargets) {
            if (q.inputs) dup.inputs = q.inputs;
            if (q.optEls) dup.optEls = q.optEls;
            if (q.blankInputs) dup.blankInputs = q.blankInputs;
            if (q.el) dup.el = q.el;
            if (q.div) dup.div = q.div;
            if (q.byOptionList !== undefined) dup.byOptionList = q.byOptionList;
            if (q.stemIsQuestion !== undefined) dup.stemIsQuestion = q.stemIsQuestion;
          }
          if (q.num !== undefined) dup.num = q.num;
          if (q.passage && !dup.passage) dup.passage = q.passage;
        }
      } else {
        out.push(q);
      }
    }
    return out;
  }

  let scanPanel = null;

  // ---------- 面板样式（白色主题，注入一次全局复用） ----------
  function ensurePanelStyles() {
    if (document.getElementById("aa-panel-style")) return;
    const st = document.createElement("style");
    st.id = "aa-panel-style";
    st.textContent = `
      .aa-panel{position:fixed;right:12px;top:12px;z-index:2147483646;width:420px;min-width:320px;
        min-height:220px;max-width:96vw;max-height:92vh;contain:layout paint;
        display:flex;flex-direction:column;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;
        box-shadow:0 12px 40px rgba(15,23,42,.14);color:#1e293b;overflow:hidden;
        font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
      .aa-panel.aa-resizing{will-change:width,height}
      .aa-resize{position:absolute;right:1px;bottom:1px;width:16px;height:16px;cursor:nwse-resize;
        background:linear-gradient(135deg,transparent 0 46%,#cbd5e1 46% 54%,transparent 54% 60%,
          #cbd5e1 60% 68%,transparent 68%);border-bottom-right-radius:14px}
      .aa-resize:hover{background:linear-gradient(135deg,transparent 0 46%,var(--c-ink-4) 46% 54%,
        transparent 54% 60%,var(--c-ink-4) 60% 68%,transparent 68%)}
      /* 头部必须能换行：按钮组最小约 344px，而面板 min-width 是 320px 且
         .aa-panel 是 overflow:hidden —— 拖到最窄时最右边的「✕」会被裁到可视区外，
         用户连关都关不掉（不是不好看，是失去出口）。 */
      .aa-head{padding:10px 12px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;row-gap:6px;
        border-bottom:1px solid #eef1f6;
        background:linear-gradient(180deg,#fdfefe,#f7f9fc)}
      .aa-logo{width:28px;height:28px;border-radius:9px;flex:none;display:block;
        object-fit:contain;background:transparent;
        box-shadow:0 2px 6px rgba(37,99,235,.18)}
      .aa-title{font-weight:600;font-size:14px;color:#0f172a;flex:0 1 auto;
        display:flex;align-items:center;gap:6px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;min-width:0}
      .aa-count{display:inline-block;background:#e0e7ff;color:#4338ca;font-size:11px;font-weight:600;
        border-radius:999px;padding:1px 9px;white-space:nowrap;flex:none}
      .aa-ver{flex:none;font-size:10px;color:var(--c-ink-4);border:1px solid #e2e8f0;border-radius:999px;
        padding:0 6px;line-height:15px;white-space:nowrap}
      .aa-spacer{flex:1 1 auto;min-width:4px}
      .aa-btn{border:0;border-radius:9px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;
        white-space:nowrap;transition:filter .15s,box-shadow .15s,background .15s;font-family:inherit;
        display:inline-flex;align-items:center;justify-content:center;text-align:center;line-height:1.2}
      .aa-btn:hover{filter:brightness(.95)}
      .aa-btn:active{filter:brightness(.9)}
      .aa-btn:disabled{opacity:.45;cursor:default}
/* 自动答题进行中：「出答案 / 填涂」不再置灰（灰着点不了让用户以为坏了），
   改成淡化 + 主题色边框，点了会提示"正在自动答题"，不误触发。 */
.aa-btn.aa-busy{opacity:.6;border-color:#93c5fd}
      .aa-btn-primary{background:var(--c-accent);color:#fff;box-shadow:0 2px 6px rgba(37,99,235,.28)}
      .aa-btn-danger{background:#fee2e2;color:var(--c-danger)}
      .aa-btn-soft{background:#eef2ff;color:#4f46e5}
      .aa-btn-muted{background:#f1f5f9;color:var(--c-ink-3)}
      .aa-btn-green{background:var(--c-sky);color:#fff;box-shadow:0 2px 6px rgba(22,163,74,.25);flex:none}
      .aa-iconbtn{width:30px;height:30px;padding:0;border-radius:9px;background:transparent;
        color:var(--c-ink-4);font-size:14px}
      .aa-iconbtn:hover{background:#f1f5f9;color:#475569;filter:none}
      .aa-warn{padding:9px 14px;background:#fffbeb;color:var(--c-warn);font-size:12px;line-height:1.7;
        border-bottom:1px solid #fde68a}
      /* ⚠ 这里**不能**写 display:none。
   若样式表里写 display:none，JS 里 style.display="" 只是**清掉行内值**，
   并不会覆盖样式表里的 display:none —— CSS 级联里类选择器照样生效，
   于是整行表头（含「暂停 / 停止」按钮）永远是隐藏的。
   默认就是显示，由 JS 用 style.display="none" 显式隐藏（行内优先级才够）。 */
.aa-runlog-wrap{border-bottom:1px solid #eef1f6;background:#fbfcfe;flex:0 0 auto}
      .aa-runlog-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;color:var(--c-ink-3)}
      .aa-runlog-head>span{font-weight:600;flex:1 1 auto}
      .aa-runlog-toggle,.aa-runlog-stop{border:1px solid #d7dee8;background:#fff;color:#475569;
        border-radius:7px;padding:2px 10px;font-size:11.5px;cursor:pointer;font-family:inherit}
      .aa-runlog-toggle:hover{background:#f1f5f9}
      .aa-runlog-stop{border-color:#fecaca;background:#fef2f2;color:var(--c-danger);font-weight:600}
/* 「暂停 / 继续」：暂停中换成醒目的绿色实心，一眼能看出"现在停着，点它继续" */
.aa-runlog-pause{border:1px solid #d7dee8;background:#fff;color:#475569;
  border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer;font-weight:600}
.aa-runlog-pause:hover{background:#f1f5f9}
.aa-runlog-pause:disabled{opacity:.45;cursor:default}
.aa-runlog-pause-on{border-color:#86efac;background:#f0fdf4;color:var(--c-sky)}
.aa-runlog-pause-on:hover{background:#dcfce7}
      .aa-runlog-stop:hover{filter:brightness(.97)}
      .aa-runlog{max-height:132px;overflow-y:auto;padding:0 12px 8px;
        font:12px/1.7 Consolas,'Courier New',monospace;color:#4b5563}
      .aa-runlog::-webkit-scrollbar{width:6px}
      .aa-runlog::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:3px}
      .aa-list{overflow-y:auto;padding:12px 12px 16px;flex:1 1 auto;contain:layout paint;
        background:linear-gradient(180deg,#fbfcfe,#fff 120px)}
      .aa-list::-webkit-scrollbar{width:6px}
      .aa-list::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:3px}
      .aa-info{padding:2px 2px 10px;color:#8fa0b5;font-size:12px}
      .aa-empty{padding:34px 16px 30px;text-align:center;display:flex;flex-direction:column;
        align-items:center;gap:4px}
      .aa-empty-icon{width:52px;height:52px;border-radius:16px;background:#f1f5f9;
        display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:8px}
      .aa-empty-title{font-size:14px;font-weight:600;color:#475569}
      .aa-empty-sub{font-size:12px;color:var(--c-ink-4);line-height:1.7;margin-bottom:14px}
      .aa-empty .aa-btn{margin-top:2px}
      .aa-card{background:#fff;border:1px solid #eef2f7;border-radius:12px;padding:11px 12px;
        margin-bottom:9px;transition:border-color .15s,box-shadow .15s;
        box-shadow:0 1px 2px rgba(15,23,42,.03)}
      .aa-card:hover{border-color:#d7dfee;box-shadow:0 3px 10px rgba(37,99,235,.07)}
      .aa-row{display:flex;gap:10px;align-items:flex-start}
      .aa-stem{flex:1;color:#1e293b;word-break:break-all;line-height:1.65}
      .aa-num{color:var(--c-accent);font-weight:700;margin-right:2px}
      .aa-chip{display:inline-block;background:#eef2ff;color:#4f46e5;font-size:11px;border-radius:999px;
        padding:0 8px;margin-left:6px;vertical-align:1px}
      .aa-chip-passage{display:inline-block;background:#fef3c7;color:var(--c-warn);font-size:11px;border-radius:999px;
        padding:1px 8px;margin-left:6px;cursor:pointer;user-select:none}
      .aa-chip-passage:hover{filter:brightness(.96)}
      .aa-chip-warn{display:inline-block;background:#fef2f2;color:#b91c1c;font-size:11px;border-radius:999px;
        padding:0 8px;margin-left:6px;vertical-align:1px;cursor:help}
      .aa-passage{display:none;margin-top:8px;padding:8px 10px;background:#fffbeb;border-radius:8px;
        font-size:12px;color:#78716c;line-height:1.7;max-height:140px;overflow-y:auto;white-space:pre-wrap;
        word-break:break-all;border:1px solid #fde68a}
      .aa-answer{display:none;margin-top:9px;padding:8px 11px;background:#f0fdf4;border-radius:9px;
        border-left:3px solid var(--c-sky);
        white-space:pre-wrap;word-break:break-all;color:var(--c-ink-2);line-height:1.7;font-size:12.5px}
      .aa-think{display:none;margin-top:6px;padding:8px 11px;background:#f5f3ff;border-radius:9px;
        border-left:3px solid #8b5cf6;
        white-space:pre-wrap;word-break:break-all;color:#5b21b6;line-height:1.7;font-size:11.5px;
        max-height:170px;overflow-y:auto}
      .aa-think::-webkit-scrollbar{width:6px}
      .aa-think::-webkit-scrollbar-thumb{background:#ddd6fe;border-radius:3px}
      .aa-explain{display:none;margin-top:6px;padding:8px 11px;background:#f8fafc;border-radius:9px;
        border-left:3px solid var(--c-ink-4);
        white-space:pre-wrap;word-break:break-all;color:#475569;line-height:1.75;font-size:12px;
        max-height:220px;overflow-y:auto}
      .aa-explain::-webkit-scrollbar{width:6px}
      .aa-explain::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:3px}
      .aa-chip-pool{display:inline-block;background:#dcfce7;color:#15803d;font-size:11px;border-radius:999px;
        padding:1px 8px;margin-left:6px}
      .aa-ball{position:fixed;z-index:2147483646;width:46px;height:46px;border-radius:50%;
        background:var(--c-surface);color:var(--c-ink-2);border:2px solid var(--c-line-2);
        box-shadow:0 6px 20px rgba(37,99,235,.22);display:flex;align-items:center;justify-content:center;
        font-size:19px;cursor:grab;user-select:none}
      .aa-ball-logo{width:30px;height:30px;display:block;pointer-events:none}
      .aa-ball:active{cursor:grabbing}
      .aa-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:10px;
        border-radius:999px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px}
      .aa-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,40,.25);cursor:crosshair}
      .aa-tip{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;
        font:bold 14px/1 'Segoe UI','Microsoft YaHei';padding:10px 22px;border-radius:20px;z-index:2147483647}
      .aa-selbox{position:fixed;display:none;border:2px solid var(--c-accent);background:rgba(37,99,235,.08);
        z-index:2147483647;pointer-events:none}
      .aa-result{position:fixed;z-index:2147483647;width:320px;min-width:280px;min-height:120px;
        max-width:96vw;max-height:60vh;display:flex;flex-direction:column;background:#fff;
        border:1px solid #e5e7eb;border-radius:14px;padding:12px 14px;
        box-shadow:0 12px 40px rgba(15,23,42,.14);
        font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1e293b}
      .aa-result-title{font-weight:600;font-size:14px;margin-bottom:6px;cursor:move;user-select:none}
      .aa-result-body{white-space:pre-wrap;word-break:break-all;color:var(--c-ink-2);
        flex:1 1 auto;min-height:0;overflow-y:auto}
      .aa-result-body::-webkit-scrollbar{width:6px}
      .aa-result-body::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:3px}

      /* ============================================================
         暖砂琥珀皮肤
         ------------------------------------------------------------
         只覆盖视觉属性（颜色/字体/圆角/阴影/间距）。position、尺寸、
         flex、overflow、display 等布局与交互属性一律沿用上面的基础规则，
         避免换肤动到功能。令牌只挂在自家浮层根节点上，不污染宿主页面。
         ============================================================ */
      .aa-panel,.aa-result,.aa-ball,.aa-toast,.aa-overlay,.aa-tip,.aa-selbox{
        --c-canvas:#FBF6EC;--c-surface:#FFFDF8;--c-surface-2:#F7F0E2;--c-surface-3:#F1E7D4;
        --c-line:#E7DBC3;--c-line-2:#D3C19E;
        --c-ink-1:#241C10;--c-ink-2:#4A3F2C;--c-ink-3:#77683F;--c-ink-4:#9B8B6C;
        --c-accent:#B4690E;--c-on-accent:#FFFFFF;--c-accent-soft:#FBEBD2;--c-accent-line:#EBCBA0;
        --c-warn:#9A5B0B;--c-warn-soft:#FCEFD6;--c-warn-line:#E9D3A4;
        --c-danger:#B3261E;--c-danger-soft:#FBE7E5;--c-danger-line:#EFC0BC;
        --c-violet:#6D4BC0;--c-violet-soft:#F0E9FB;--c-sky:#2E6B87;--c-sky-soft:#E4F0F5;
        --sh-1:0 1px 2px rgba(90,70,35,.07);
        --sh-2:0 3px 10px -2px rgba(90,70,35,.12);
        --sh-3:0 20px 46px -14px rgba(90,70,35,.30),0 2px 6px rgba(90,70,35,.08);
        --r-sm:8px;--r-md:12px;--r-lg:18px;--r-xl:24px;
        --font-sans:"PingFang SC","Microsoft YaHei","HarmonyOS Sans SC",-apple-system,"Segoe UI",system-ui,sans-serif;
        --font-display:"Songti SC","STSong","SimSun",Georgia,serif;
        --font-mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Consolas,monospace;
        color-scheme:light;
      }
      .aa-panel,.aa-panel *,.aa-result,.aa-result *,.aa-ball,.aa-ball *,
      .aa-toast,.aa-toast *{box-sizing:border-box}

      /* ---------- 面板外壳 / 头部 ---------- */
      .aa-panel{background:var(--c-canvas);border-color:var(--c-line-2);border-radius:var(--r-xl);
        box-shadow:var(--sh-3);color:var(--c-ink-1);font-family:var(--font-sans);
        font-size:13.5px;line-height:1.65}
      .aa-resize{background:linear-gradient(135deg,transparent 0 46%,var(--c-line-2) 46% 54%,
        transparent 54% 60%,var(--c-line-2) 60% 68%,transparent 68%);border-bottom-right-radius:22px}
      .aa-resize:hover{background:linear-gradient(135deg,transparent 0 46%,var(--c-ink-4) 46% 54%,
        transparent 54% 60%,var(--c-ink-4) 60% 68%,transparent 68%)}
      .aa-head{background:linear-gradient(180deg,var(--c-surface),var(--c-canvas));
        border-bottom:1px solid var(--c-line);padding:11px 13px;gap:5px;row-gap:5px}
      .aa-logo{background:transparent;box-shadow:var(--sh-1)}
      .aa-title{font-family:var(--font-display);font-size:15px;font-weight:700;
        color:var(--c-ink-1);letter-spacing:.01em}
      .aa-count{background:var(--c-accent-soft);color:var(--c-accent);border:1px solid var(--c-accent-line);
        font-family:var(--font-mono);font-weight:700}
      .aa-ver{color:var(--c-ink-4);border-color:var(--c-line);font-family:var(--font-mono)}
      .aa-status{display:flex;align-items:center;gap:9px;flex:none;padding:7px 12px;
        background:var(--c-surface-2);border-bottom:1px solid var(--c-line)}
      .aa-pill{display:inline-flex;align-items:center;gap:5px;flex:none;height:20px;
        padding:0 9px 0 7px;border-radius:999px;background:var(--c-surface-3);
        color:var(--c-ink-3);font-size:10.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
      .aa-pill i{width:5px;height:5px;border-radius:50%;background:currentColor}
      .aa-pill.running{background:var(--c-accent-soft);color:var(--c-accent)}
      .aa-pill.paused{background:var(--c-warn-soft);color:var(--c-warn)}
      .aa-track{flex:1 1 auto;height:3px;border-radius:999px;background:var(--c-line);overflow:hidden}
      .aa-track-fill{height:100%;width:0;border-radius:999px;background:var(--c-accent);
        transition:width .22s ease}
      .aa-readout{flex:none;font-family:var(--font-mono);font-size:10.5px;color:var(--c-ink-3);white-space:nowrap}
      .aa-info{color:var(--c-ink-3)}

      /* ---------- 按钮 ---------- */
      .aa-btn{border-radius:10px;font-family:var(--font-display);font-weight:700;letter-spacing:.02em;
        padding:6px 10px}
      .aa-btn:hover{filter:brightness(1.03)}
      .aa-btn:active{filter:brightness(.97)}
      .aa-btn.aa-busy{opacity:.68;box-shadow:inset 0 0 0 1px var(--c-accent-line);filter:saturate(.75)}
      .aa-btn-primary{background:var(--c-accent);color:var(--c-on-accent);
        box-shadow:0 2px 8px rgba(180,105,14,.28)}
      .aa-btn-danger{background:var(--c-danger-soft);color:var(--c-danger);
        box-shadow:inset 0 0 0 1px var(--c-danger-line)}
      .aa-btn-soft{background:var(--c-accent-soft);color:var(--c-accent);
        box-shadow:inset 0 0 0 1px var(--c-accent-line)}
      .aa-btn-muted{background:var(--c-surface-2);color:var(--c-ink-2);
        box-shadow:inset 0 0 0 1px var(--c-line)}
      .aa-btn-green{background:var(--c-accent);color:var(--c-on-accent);
        box-shadow:0 2px 8px rgba(180,105,14,.25)}
      .aa-iconbtn{background:transparent;color:var(--c-ink-4);font-family:var(--font-sans);
        width:27px;height:27px}
      .aa-iconbtn svg{width:15px;height:15px;display:block}
      .aa-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
        clip:rect(0 0 0 0);white-space:nowrap;border:0}
      .aa-iconbtn:hover{background:var(--c-surface-3);color:var(--c-ink-1)}

      /* ---------- 提示条 / 运行日志 ---------- */
      .aa-warn{background:var(--c-warn-soft);color:var(--c-warn);border-bottom:1px solid var(--c-warn-line)}
      .aa-runlog-wrap{background:var(--c-surface-2);border-bottom:1px solid var(--c-line)}
      .aa-runlog-head{color:var(--c-ink-3)}
      .aa-runlog-toggle,.aa-runlog-stop{background:var(--c-surface);border:1px solid var(--c-line-2);
        color:var(--c-ink-2);border-radius:7px;font-family:var(--font-sans)}
      .aa-runlog-toggle:hover{background:var(--c-surface-3)}
      .aa-runlog-stop{border-color:var(--c-danger-line);background:var(--c-danger-soft);color:var(--c-danger)}
      .aa-runlog-pause{border:1px solid var(--c-line-2);background:var(--c-surface);color:var(--c-ink-2);
        border-radius:7px;font-family:var(--font-sans)}
      .aa-runlog-pause:hover{background:var(--c-surface-3)}
      .aa-runlog-pause-on{border-color:var(--c-accent-line);background:var(--c-accent-soft);color:var(--c-accent)}
      .aa-runlog-pause-on:hover{background:var(--c-warn-soft)}
      .aa-runlog{color:var(--c-ink-2);font-family:var(--font-mono);
        scrollbar-width:thin;scrollbar-color:var(--c-line-2) transparent}
      .aa-runlog::-webkit-scrollbar-thumb{background:var(--c-line-2)}
      .aa-list{background:var(--c-canvas);scrollbar-width:thin;scrollbar-color:var(--c-line-2) transparent}
      .aa-list::-webkit-scrollbar-thumb{background:var(--c-line-2)}
      .aa-panel-foot{display:flex;align-items:center;gap:7px;flex:none;padding:9px 10px;
        background:var(--c-surface);border-top:1px solid var(--c-line)}
      .aa-panel-foot .aa-btn{flex:1 1 0;padding:7px 8px;font-size:11.5px}
      .aa-empty-icon{background:var(--c-accent-soft);color:var(--c-accent);border-radius:var(--r-lg)}
      .aa-empty-title{font-family:var(--font-display);color:var(--c-ink-1)}
      .aa-empty-sub{color:var(--c-ink-4)}

      /* ---------- 题卡 ---------- */
      .aa-card{background:var(--c-surface);border:1px solid var(--c-line);border-radius:var(--r-lg);
        padding:12px 13px 12px 15px;margin-bottom:11px;box-shadow:var(--sh-1);
        content-visibility:auto;contain-intrinsic-size:auto 120px}
      .aa-card:hover{border-color:var(--c-line-2);box-shadow:var(--sh-2)}
      .aa-card-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
      .aa-card-top .aa-btn{flex:none;padding:2px 8px;font-size:10.5px;line-height:1.5;border-radius:7px}
      .aa-card-num{font-family:var(--font-mono);font-size:10.5px;font-weight:700;
        color:var(--c-ink-4);letter-spacing:.02em}
      .aa-card-state{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--c-ink-3);
        white-space:nowrap}
      .aa-card-state[data-state="filled"],.aa-card-state[data-state="answered"]{color:var(--c-accent)}
      .aa-card-state[data-state="failed"]{color:var(--c-danger)}
      .aa-card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
      .aa-card-tags .aa-chip,.aa-card-tags .aa-chip-warn,.aa-card-tags .aa-chip-passage,
      .aa-card-tags .aa-chip-pool{margin-left:0}
      .aa-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
        gap:4px 14px;margin-top:7px}
      .aa-options--long{grid-template-columns:1fr}
      .aa-opt{display:flex;align-items:flex-start;gap:8px;min-width:0;padding:3px 0;
        line-height:1.55}
      .aa-opt-mark{width:20px;height:20px;flex:none;border-radius:50%;border:1px solid var(--c-line-2);
        display:flex;align-items:center;justify-content:center;background:var(--c-surface);
        font-family:var(--font-mono);font-size:10.5px;font-weight:700;color:var(--c-ink-3);
        transition:background .15s,border-color .15s,color .15s}
      .aa-opt-text{font-size:12.5px;color:var(--c-ink-2);word-break:break-word;min-width:0}
      .aa-opt.on .aa-opt-mark{background:var(--c-accent);border-color:var(--c-accent);
        color:var(--c-on-accent)}
      .aa-opt.on .aa-opt-text{color:var(--c-ink-1);font-weight:600}
      .aa-card[data-answer-state="answered"]{box-shadow:inset 3px 0 0 var(--c-accent),var(--sh-1)}
      .aa-card[data-answer-state="failed"]{box-shadow:inset 3px 0 0 var(--c-danger),var(--sh-1)}
      .aa-card-foot{display:flex;align-items:flex-end;gap:8px;margin-top:9px}
      .aa-card-foot .aa-answer{margin-top:0;flex:0 1 auto;max-width:calc(100% - 64px)}
      .aa-card-foot .aa-btn{margin-left:auto;flex:none;padding:3px 10px;font-size:11px;border-radius:8px}
      .aa-stem{color:var(--c-ink-1)}
      .aa-num{color:var(--c-accent);font-family:var(--font-display)}
      .aa-chip{background:var(--c-accent-soft);color:var(--c-accent);border:1px solid var(--c-accent-line);
        font-family:var(--font-sans);font-weight:600}
      .aa-chip-passage{background:var(--c-accent-soft);color:var(--c-accent);
        border:1px solid var(--c-accent-line);font-family:var(--font-sans);font-weight:600}
      .aa-chip-passage:hover{filter:brightness(.97)}
      .aa-chip-warn{background:var(--c-danger-soft);color:var(--c-danger);
        border:1px solid var(--c-danger-line);font-family:var(--font-sans);font-weight:600}
      .aa-chip-pool{background:var(--c-sky-soft);color:var(--c-sky);
        border:1px solid rgba(46,107,135,.25);font-family:var(--font-sans);font-weight:600}
      .aa-passage{background:var(--c-surface-2);border:1px solid var(--c-line);
        border-radius:var(--r-md);color:var(--c-ink-2)}
      .aa-answer{background:var(--c-accent-soft);border-left:3px solid var(--c-accent);
        border-radius:var(--r-md);color:var(--c-ink-1);width:fit-content;max-width:100%;
        padding:6px 10px}
      .aa-think{background:var(--c-violet-soft);border-left:3px solid var(--c-violet);
        border-radius:var(--r-md);color:var(--c-violet)}
      .aa-think::-webkit-scrollbar-thumb{background:#D8C9F2;border-radius:3px}
      .aa-explain{background:var(--c-surface-2);border-left:3px solid var(--c-line-2);
        border-radius:var(--r-md);color:var(--c-ink-2)}
      .aa-explain::-webkit-scrollbar-thumb{background:var(--c-line-2);border-radius:3px}

      /* ---------- 悬浮球 / 框选 / 结果浮窗 / 提示条 ---------- */
      .aa-ball{background:var(--c-surface);border:2px solid var(--c-line-2);
        box-shadow:var(--sh-2)}
      .aa-badge{background:var(--c-danger);font-family:var(--font-mono)}
      .aa-overlay{background:rgba(36,28,16,.48)}
      .aa-tip{background:var(--c-ink-1);color:var(--c-surface);font-family:var(--font-sans)}
      .aa-selbox{border:2px solid var(--c-accent);background:rgba(180,105,14,.10)}
      .aa-result{background:var(--c-surface);border:1px solid var(--c-line-2);border-radius:var(--r-xl);
        box-shadow:var(--sh-3);color:var(--c-ink-1);font-family:var(--font-sans)}
      .aa-result-title{font-family:var(--font-display);font-size:15px;color:var(--c-ink-1)}
      .aa-result-body{color:var(--c-ink-2);scrollbar-width:thin;scrollbar-color:var(--c-line-2) transparent}
      .aa-result-body::-webkit-scrollbar-thumb{background:var(--c-line-2)}
      .aa-toast{background:var(--c-ink-1);color:var(--c-surface);
        border:1px solid rgba(255,253,248,.12);border-radius:14px;box-shadow:var(--sh-3);
        font-family:var(--font-sans)}
      .aa-toast.aa-toast-warn{background:#6F3B06;color:#FFF3DE;border-color:rgba(255,243,222,.14)}
      .aa-toast.aa-toast-ok{background:var(--c-sky);color:var(--c-surface);
        border-color:rgba(255,253,248,.16)}
      .aa-toast-act{background:rgba(255,253,248,.16)}
      .aa-toast-act:hover{background:rgba(255,253,248,.26)}
      .aa-toast-x{color:rgba(255,253,248,.6)}

      /* ---------- 窄屏与减少动效 ---------- */
      @media (max-width:480px){
        .aa-panel{border-radius:18px}
        .aa-head{padding:10px 11px}
        .aa-title{font-size:14.5px}
        .aa-list{padding:10px 10px 14px}
        .aa-card{padding:11px 11px 11px 13px;border-radius:16px}
        .aa-result{border-radius:18px}
      }
      @media (prefers-reduced-motion:reduce){
        .aa-panel,.aa-panel *,.aa-result,.aa-ball,.aa-toast{
          animation-duration:.01ms!important;transition-duration:.01ms!important}
      }
    `;
    document.documentElement.appendChild(st);
  }

  // mode: "scan"（识别题目，默认）| "run"（自动答题中，展开运行日志区）
  function startScanMode(fromFillGuard, noticeOverride, mode) {
    ensurePanelStyles();
    // 重建面板前**先叫停旧流水线**。旧循环的守卫是 `!scanPanel`，而这里马上就会把
    // scanPanel 指向新面板 —— 不停的话旧任务一路把新面板也当作"还在"，两条流水线
    // 并发烧 API、同时改页面（重复打开识别面板就会撞上）。stopPanelTasks 是旧闭包的，
    // 必须在重挂之前调。
    if (scanPanelApi.stopPanelTasks) { try { scanPanelApi.stopPanelTasks(); } catch (_) {} }
    if (scanPanel) { scanPanel.remove(); scanPanel = null; }
    // 重开面板时把悬浮球一起收掉：否则两者会同时挂在页面上（球点开的还是旧闭包的面板）
    document.querySelectorAll(".aa-ball").forEach(b => b.remove());
    runLogBox = null;   // 面板重建了，日志容器引用必须跟着失效（否则写进已摘除的旧节点）

    scanPanel = document.createElement("div");
    scanPanel.className = "aa-panel";
    document.documentElement.appendChild(scanPanel);

    // 恢复上次拖动的位置和窗口大小
    chrome.storage.local.get(["scanPanelPos", "scanPanelSize"], ({ scanPanelPos: pos, scanPanelSize: size }) => {
      if (!scanPanel) return;
      if (pos && typeof pos.x === "number") {
        scanPanel.style.right = "auto";
        scanPanel.style.left = Math.min(pos.x, window.innerWidth - 100) + "px";
        scanPanel.style.top = Math.min(pos.y, window.innerHeight - 60) + "px";
      }
      if (size && size.w >= 320) {
        scanPanel.style.width = Math.min(size.w, window.innerWidth - 20) + "px";
        scanPanel.style.height = Math.min(size.h, window.innerHeight - 20) + "px";
      }
    });
    makeResizable(scanPanel, saveScanSize);

    const head = document.createElement("div");
    head.className = "aa-head";
    head.innerHTML = `<img class="aa-logo" src="${LOGO_ICON_URL}" alt="">` +
      `<div class="aa-title">页面题目识别<span class="aa-count" style="display:none"></span></div>` +
      `<span class="aa-ver" title="扩展版本。改完代码要到扩展管理页点「重新加载」才会生效，这里显示的才是新版号">v${EXT_VERSION}</span>` +
      `<div class="aa-spacer"></div>`;
    const answerAllBtn = mkScanBtn("⚡ 出答案", "aa-btn-soft", () => answerAll());
    answerAllBtn.title = "只把答案算出来显示在卡片里，完全不碰页面";
    const fillBtn = mkScanBtn("✍ 填涂", "aa-btn-green", () => fillFromPanel());
    const FILL_TITLE_OK = "对列出的题目取答案并自动勾选（题库优先，可 AI 兜底）；没有可点选项的题只会显示答案";
    // 「✍ 填涂」是往页面写的动作 → 可用性跟着白名单走，不能只在文案上说"只显示答案"。
    // 判定顺序：run() 算过的结果优先（"本页没有可填涂控件"那种降级也走这里，
    // 而那种页面域名是放行过的，按钮该保持可用）；其次白名单外的降级；都没有才自己查。
    const applyFillGate = ok => {
      fillBtn.disabled = !ok;
      fillBtn.title = ok ? FILL_TITLE_OK
        : `当前域名 ${location.hostname} 不在自动填涂白名单内，填涂不可用（这里只显示答案）`;
    };
    if (fillAllowedCache !== null) applyFillGate(fillAllowedCache);
    else if (fromFillGuard) applyFillGate(false);
    else loadFillSettings()
      .then(st => fillAllowedOk(st))
      .then(applyFillGate)
      .catch(() => applyFillGate(false));   // 判不出来就不写：收口一律 fail-closed
    const shotBtn = mkScanBtn("📷", "aa-iconbtn", () => startSelectMode());
    shotBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg><span class="aa-sr">📷</span>';
    shotBtn.title = "截图解题";
    // 叫停面板自己的两条流水线：置位 + **唤醒 park 住的等待者** + 掐断在飞请求。
    // 「停止」按钮、✕ 关闭、重新扫描都走这一份。
    // 只置 stopFlag/fillStop 的话：暂停中挂起的 worker 永远醒不过来，filling 也不复位。
    function haltPanelTasks() {
      stopFlag = true;
      fillStop = true;
      answerPaused = false;
      fillPaused = false;
      answerResolvers.splice(0).forEach(f => { try { f(); } catch (_) {} });
      fillResolvers.splice(0).forEach(f => { try { f(); } catch (_) {} });
      abortPanelAI();
    }
    const rescan = mkScanBtn("↻ 重新扫描", "aa-btn-muted", () => {
      // 重新扫描会清空整个卡片列表。任务还在跑时不先停下，旧循环就拿着已被摘除的
      // 卡片继续发请求：已算出的答案凭空消失、进度条再也不动、token 白烧。
      if (answeringAll || filling) {
        haltPanelTasks();
        setFillMsg("重新扫描前已停止当前任务（答案按新一轮重新计算）。", "var(--c-warn)");
      }
      fillList();
    });
    rescan.title = "重新扫描";
    const minBtn = mkScanBtn("—", "aa-iconbtn", () => minimizeToBall());
    minBtn.title = "最小化为悬浮球";
    // 关闭面板：有任务在跑时需要**再点一次**确认。
    // 为什么不用原生 confirm()：Chrome/Edge 一旦触发「阻止此页面创建更多对话框」，
    // confirm() 之后恒返回 false，正在作答时面板就**永远关不掉**了。
    // 自动作答（running）不在这里被关掉：关掉面板 ≠ 停止作答，页面正在被填，
    // 突然停手更容易让人以为"答完了"；这里只把它已经不能显示日志这件事说清楚。
    let closeArmAt = 0;
    const CLOSE_LABEL = "✕";
    const close = mkScanBtn(CLOSE_LABEL, "aa-iconbtn", () => {
      const panelBusy = answeringAll || filling;
      if (panelBusy && Date.now() - closeArmAt > 2500) {
        closeArmAt = Date.now();
        close.textContent = "再点一次关闭";
        close.title = "有任务在跑：再点一次会停止它并关闭面板（2.5 秒内不点就取消）";
        setFillMsg(`正在${filling ? "填涂" : "出答案"}：再点一次「✕」会停止并关闭面板（已完成的结果保留）。`, "var(--c-warn)");
        setTimeout(() => {
          if (Date.now() - closeArmAt >= 2500) {
            close.textContent = CLOSE_LABEL;
            close.title = "关闭面板（有任务在跑时需要再点一次确认）";
          }
        }, 2600);
        return;
      }
      if (panelBusy) {
        haltPanelTasks();
      }
      runLogBox = null;      // 面板要没了，日志引用必须失效（否则 log 写进已摘除的节点，什么都看不见）
      scanPanel.remove();
      scanPanel = null;
      if (running && !panelBusy) {
        toast("面板已关闭，但自动作答**仍在继续**（要停请在插件弹窗里点「停止」，或按 ESC）。", "warn", 12000);
      }
    });
    close.title = "关闭面板（有任务在跑时需要再点一次确认）";
    head.append(shotBtn, minBtn, close);
    head.title = "按住标题栏可拖动面板";
    makeDraggable(head, scanPanel, saveScanPos);
    scanPanel.appendChild(head);

    const status = document.createElement("div");
    status.className = "aa-status";
    const statusPill = document.createElement("span");
    statusPill.className = "aa-pill readonly";
    statusPill.innerHTML = "<i></i>就绪";
    const statusTrack = document.createElement("div");
    statusTrack.className = "aa-track";
    const statusTrackFill = document.createElement("div");
    statusTrackFill.className = "aa-track-fill";
    statusTrack.appendChild(statusTrackFill);
    const statusReadout = document.createElement("div");
    statusReadout.className = "aa-readout";
    statusReadout.textContent = "等待扫描";
    status.append(statusPill, statusTrack, statusReadout);
    scanPanel.appendChild(status);

    // 填涂状态行（进度与结果摘要）
    const fillMsg = document.createElement("div");
    fillMsg.className = "aa-info";
    fillMsg.style.display = "none";
    fillMsg.style.padding = "8px 14px 0";
    function setFillMsg(text, color) {
      fillMsg.style.display = text ? "" : "none";
      fillMsg.textContent = text || "";
      fillMsg.style.color = color || "";
    }

    // 提示条：白名单外降级、和"本页没有可填涂控件"自动降级，共用这一块
    const notice = noticeOverride ||
      (fromFillGuard
        ? `当前域名 ${location.hostname} 不在自动填涂白名单内，这里只显示答案。在插件目录的 whitelist.txt 里加上它（一行一个域名，改完到扩展管理页点「重新加载」）即可启用填涂；填 * 则放行全部站点。`
        : "");
    if (notice) {
      const warn = document.createElement("div");
      warn.className = "aa-warn";
      warn.textContent = notice;
      scanPanel.appendChild(warn);
    }

    // 运行日志区：并进同一个面板（不再单开悬浮窗）。
    // 默认折叠：只看题卡的人不会被打扰；「开始答题」时会自动展开。
    const runLogWrap = document.createElement("div");
    runLogWrap.className = "aa-runlog-wrap";
    // 不预设 display: none —— 初始态由下面的 mode 分支显式决定，
    // 避免"预设隐藏 + 后面忘记恢复"这类漏显（这正是按钮消失那次的成因）。
    const runLogHead = document.createElement("div");
    runLogHead.className = "aa-runlog-head";
    const runLogTitle = document.createElement("span");
    runLogTitle.textContent = "运行日志";
    const runLogToggle = document.createElement("button");
    runLogToggle.className = "aa-runlog-toggle";
    runLogToggle.textContent = "收起";
    // 「暂停 / 继续」：用户要的是**在面板里**能随时暂停，而不是只能去插件弹窗点停止
    //（后者是一去不回）。这个按钮停止时不退出，再点一下接着答，已答过的题不重答。
    const runPauseBtn = document.createElement("button");
    runPauseBtn.className = "aa-runlog-pause";
    runPauseBtn.textContent = "⏸ 暂停";
    runPauseBtn.title = "暂停自动作答（不退出，再点一下接着答；已答过的题不会重答）";
    runPauseBtn.addEventListener("click", () => togglePause());
    // 「停止」：彻底结束本轮（与「暂停」区分，两者职责不同，都要有）
    const runStopBtn = document.createElement("button");
    runStopBtn.className = "aa-runlog-stop";
    runStopBtn.textContent = "■ 停止";
    runStopBtn.title = "彻底停止本轮自动作答（在飞的请求也会被中断；要接着答需重新点「开始答题」）";
    runStopBtn.addEventListener("click", () => stopActive());
    const runLogBoxEl = document.createElement("div");
    runLogBoxEl.className = "aa-runlog";
    runLogHead.append(runLogTitle, runLogToggle, runPauseBtn, runStopBtn);
    runLogWrap.append(runLogHead, runLogBoxEl);
    runLogToggle.addEventListener("click", () => {
      const hidden = runLogBoxEl.style.display === "none";
      runLogBoxEl.style.display = hidden ? "" : "none";
      runLogToggle.textContent = hidden ? "收起" : "展开";
    });

    // 运行状态 → 按钮外观。停止/暂停/继续三态都在这里统一切换，
    // 免得有的路径只改了状态、按钮文案没跟着变（用户会以为按钮失灵）。
    scanPanelApi.setRunState = (state) => {
      const pillLabel = state === "running" ? "运行中" : state === "paused" ? "已暂停"
        : state === "stopped" ? "已停止" : "就绪";
      statusPill.className = "aa-pill " + (state === "running" ? "running"
        : state === "paused" ? "paused" : "readonly");
      statusPill.innerHTML = "<i></i>" + pillLabel;
      if (state === "paused") {
        runPauseBtn.textContent = "▶ 继续";
        runPauseBtn.className = "aa-runlog-pause aa-runlog-pause-on";
        runPauseBtn.disabled = false;
        runPauseBtn.title = "继续（从暂停处接着答，已完成的不会重来）";
        runLogTitle.textContent = "QuizLens 已暂停";
      } else if (state === "running") {
        runPauseBtn.textContent = "⏸ 暂停";
        runPauseBtn.className = "aa-runlog-pause";
        runPauseBtn.disabled = false;      // 从 idle/stopped 进入运行态必须**解除**禁用
        runPauseBtn.title = "暂停（不退出，再点一下接着答；已完成的不会重来）";
        runLogTitle.textContent = "QuizLens 运行中";
      } else if (state === "idle") {
        // 没有任务在跑（刚打开识别面板，还没点「出答案 / 填涂」）
        runPauseBtn.textContent = "⏸ 暂停";
        runPauseBtn.className = "aa-runlog-pause";
        runPauseBtn.disabled = true;
        runLogTitle.textContent = "运行日志";
      } else {
        // stopped：本轮已结束，暂停按钮没有意义了
        runPauseBtn.textContent = "⏸ 暂停";
        runPauseBtn.className = "aa-runlog-pause";
        runPauseBtn.disabled = true;
        runLogTitle.textContent = "QuizLens 已停止";
      }
    };

    // 当前在跑的是哪条流水线？三条互斥：run（开始答题）/ 出答案 / 填涂。
    // 面板上的「暂停 / 停止」要对**正在跑的那一条**生效，否则用户按了没反应。
    function activeTask() {
      if (running) return "run";
      if (answeringAll) return "answer";
      if (filling) return "fill";
      return null;
    }
    function isPausedNow() {
      const task = activeTask();
      if (task === "run") return paused;
      if (task === "answer") return answerPaused;
      if (task === "fill") return fillPaused;
      return false;
    }
    // 「暂停 / 继续」按钮：按当前任务分派
    function togglePause() {
      const task = activeTask();
      if (task === "run") { if (paused) resumeRun(); else pauseRun(); return; }
      if (task === "answer") { if (answerPaused) resumeAnswerAll(); else pauseAnswerAll(); return; }
      if (task === "fill") { if (fillPaused) resumeFillFromPanel(); else pauseFillFromPanel(); return; }
      setFillMsg("当前没有正在进行的任务", "var(--c-ink-3)");
    }
    // 「停止」按钮：按当前任务分派
    function stopActive() {
      const task = activeTask();
      if (task === "run") { stopRun("已手动停止"); return; }
      if (task === "answer") { stopFlag = true; answerPaused = false; answerResolvers.splice(0).forEach(f => f()); abortPanelAI(); setFillMsg("已停止「出答案」", "var(--c-warn)"); scanPanelApi.setRunState("stopped"); return; }
      if (task === "fill") { fillStop = true; fillPaused = false; fillResolvers.splice(0).forEach(f => f()); abortPanelAI(); setFillMsg("已停止「填涂」", "var(--c-warn)"); scanPanelApi.setRunState("stopped"); return; }
      setFillMsg("当前没有正在进行的任务", "var(--c-ink-3)");
    }

    // ESC 关闭面板时要能**真正停住**这条面板流水线。
    // cleanupAll 在外层作用域，够不到这里的 stopFlag/fillStop/answerResolvers，
    // 所以把停止动作挂到 scanPanelApi 上（面板每次重建都会重挂，指向最新闭包）。
    scanPanelApi.stopPanelTasks = () => {
      if (!answeringAll && !filling) return;
      haltPanelTasks();
    };

    // 「暂停 / 停止」两个按钮**任何模式都要有**。
    // 走「🔍 识别页面题目」进来时，面板上的「⚡ 出答案 / ✍ 填涂」同样是长时间批量循环，
    // 一样需要能暂停、能停。只有"当前压根没有在跑的任务"时它们才该是灰的。
    // ⚠ 关键：这一行**必须显示**，否则里面的「暂停 / 停止」按钮全被父容器藏掉。
    // 只在 run 模式下显示 runLogWrap 不够：识别模式下只写了
    // runPauseBtn.style.display=""（子元素），父容器仍是 display:none，
    // 子元素的 display 再好，也救不了被父级藏起来的整块。
    runLogWrap.style.display = "block";

    if (mode === "run") {
      // 自动答题中：展开日志正文 + 状态置为运行中
      runLogBoxEl.style.display = "";
      runLogToggle.style.display = "";
      runLogToggle.textContent = "收起";
      scanPanelApi.setRunState("running");
    } else {
      // 识别模式：只留那一行表头（里面有「暂停 / 停止」），日志正文收起来 ——
      // 既不占地方，按钮又随手可点。用户点「展开」才看日志。
      runLogBoxEl.style.display = "none";
      // 识别模式下日志区本来就是空的（出答案/填涂的进度写在卡片与状态行里），
      // 留着「展开」按钮点开是个空盒子，反而让人以为坏了 —— 干脆藏掉切换按钮。
      runLogToggle.style.display = "none";
      scanPanelApi.setRunState("idle");
    }

    const list = document.createElement("div");
    list.className = "aa-list";
    scanPanel.appendChild(fillMsg);
    scanPanel.appendChild(runLogWrap);
    scanPanel.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "aa-panel-foot";
    foot.append(answerAllBtn, fillBtn, rescan);
    scanPanel.appendChild(foot);

    // 只读视觉同步：从答案框文本推出卡片状态与进度，不参与任何作答逻辑。
    // 所有写入都先比较再赋值，避免 MutationObserver 自己触发自己形成死循环。
    function syncPanelMeta() {
      const cards = [...list.querySelectorAll(".aa-card")];
      let processed = 0;
      cards.forEach(c => {
        const box = c.querySelector(".aa-answer");
        const txt = box && box.style.display !== "none" ? String(box.textContent || "").trim() : "";
        const stateEl = c.querySelector(".aa-card-state");
        if (!stateEl) return;
        let nextText = "", nextState = "";
        if (txt) {
          if (txt.startsWith("⏳")) {
            nextText = "取答案中…";
          } else {
            processed++;
            if (txt.startsWith("✓")) { nextText = "已填涂"; nextState = "filled"; }
            else if (txt.startsWith("↷")) { nextText = "已跳过"; }
            else if (txt.startsWith("✗") || txt.startsWith("❌")) { nextText = "未匹配"; nextState = "failed"; }
            else if (txt.startsWith("⚠")) { nextText = "需核对"; nextState = "failed"; }
            else { nextText = "已作答"; nextState = "answered"; }
          }
        }
        if (stateEl.textContent !== nextText) stateEl.textContent = nextText;
        if (stateEl.dataset.state !== nextState) stateEl.dataset.state = nextState;
      });
      const readout = cards.length ? `${processed} / ${cards.length} · 已处理` : "等待扫描";
      if (statusReadout.textContent !== readout) statusReadout.textContent = readout;
      const width = cards.length ? Math.round(processed / cards.length * 100) + "%" : "0%";
      if (statusTrackFill.style.width !== width) statusTrackFill.style.width = width;
    }
    try {
      new MutationObserver(syncPanelMeta).observe(list, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["style", "class"]
      });
    } catch (_) {}
    syncPanelMeta();

    // 每次建面板都要重新挂一遍：否则面板重建后，setBusy 仍指向**已摘除的旧按钮**，
    // 停止时去改一个不在文档里的节点，新面板上的按钮就恢复不了正常样式。
    scanPanelApi.setBusy = (busy) => {
      [answerAllBtn, fillBtn].forEach(b => { b.classList.toggle("aa-busy", !!busy); });
    };

    if (mode === "run") {
      // 「出答案 / 填涂」不在自动答题时禁用：灰着点不了很困惑，而且自动答题时
      // 用户**恰恰最想**能自己补两手。点击时先提示正在自动答题，不会误触发。
      runLogBox = runLogBoxEl;
    } else {
      // 扫描模式：日志区收起、不显示「停止答题」，按钮保持常态
      scanPanelApi.setBusy(false);
    }

    let qaItems = [];
    let answeringAll = false;
    let stopFlag = false;
    let filling = false;
    let fillStop = false;
    // 「出答案 / 填涂」各自的"暂停"状态与挂起的等待者。
    // 与 run 的 paused 分开：三条流水线互斥，各自的暂停不能串味。
    let answerPaused = false;
    let fillPaused = false;
    let answerResolvers = [];
    let fillResolvers = [];

    // ---------- 「开始答题」与面板共用同一个结果出口 ----------
    // 点「开始答题」后自动填涂正常，但**面板上不显示答案和解析**、
    // 还得手动点每张卡上的「答」；而且「出答案 / 填涂」是灰的、点不动。
    //
    // 根因：run() 与面板是两条互不相干的流水线 —— run() 扫描出自己的题目数组，
    // 答案只写进运行日志；面板扫描出自己的 qaItems，答案只写进卡片。
    // 两者各扫一遍、各算一遍，于是"页面上填对了、面板上却空空如也"。
    //
    // 修法：run() 每得出一个结果，就按题干找到对应卡片，复用面板的渲染逻辑写上去。
    // 按题干（而不是对象身份）匹配是必须的：两份对象来自两次独立扫描，没有共享引用。
    function normalizeStem(s) {
      return String(s || "").replace(/\s+/g, "").replace(/[．。，,：:；;、？?！!]/g, "").slice(0, 60);
    }
    function findItemByStem(stemText, num) {
      const key = normalizeStem(stemText);
      if (!key) return null;
      let loose = null;
      for (const it of qaItems) {
        const sameNum = num !== undefined && it.q && it.q.num !== undefined && it.q.num === num;
        const itKey = normalizeStem(it.q && (it.q.stem || it.q.stemText));
        if (itKey === key) { if (sameNum) return it; if (!loose) loose = it; }
      }
      return loose;
    }
    // 选项高亮只做展示：res.answer 是 0 基选项下标数组，与 q.options 一一对应。
    // 不参与判分/填涂，清空时只是去掉圆标填充和卡片左侧强调线。
    function markOptionAnswer(item, res) {
      if (!item) return;
      const picks = new Set(Array.isArray(res && res.answer) ? res.answer : []);
      if (item.optionWrap) {
        [...item.optionWrap.querySelectorAll(".aa-opt")].forEach((el, i) => {
          el.classList.toggle("on", picks.has(i));
        });
      }
      if (picks.size || (res && Array.isArray(res.texts) && res.texts.length)) {
        item.dataset.answerState = "answered";
      } else if (res) {
        item.dataset.answerState = "failed";
      } else {
        delete item.dataset.answerState;
      }
    }

    // 把一份结果渲染到卡片上（答案 + 解析 + 思考）并标记已答。
    // 与 answerOne 的后半段同源，避免两处渲染规则漂移。
    function renderResultToCard(item, res) {
      if (!item || !res || (!res.answer && !res.texts)) return false;
      const box = item.answerBox;
      if (box) {
        box.style.display = "block";
        box.textContent = answerToText(res) + (res.score && res.score < 1 ? `（相似度 ${Math.round(res.score * 100)}%）` : "");
        box.style.color = res.how === "题库·模糊" ? "var(--c-warn)" : "var(--c-ink-2)";
      }
      renderExplain(item, res);
      renderThink(item, res);
      markOptionAnswer(item, res);
      item.answered = true;
      item.result = res;
      return true;
    }
    // 把"这题没答出来"的原因写到卡片上（run() 用）
    function paintErrorToCard(stemText, num, why) {
      const item = findItemByStem(stemText, num);
      if (!item || !item.answerBox) return false;
      item.answerBox.style.display = "block";
      item.answerBox.textContent = "❌ " + why;
      item.answerBox.style.color = "var(--c-danger)";
      markOptionAnswer(item, null);
      item.dataset.answerState = "failed";
      return true;
    }
    // 交给 run() 用的入口（按题干文本找卡，见上）。
    // 面板每次重建都会重新挂一遍，指向新的 qaItems 闭包。
    scanPanelApi.paintByStem = (stemText, num, res) => renderResultToCard(findItemByStem(stemText, num), res);
    // 收尾 toast 的「点这里看清单」要用它刷新列表。fillList 只活在这个闭包里，
    // 外层直接调用会抛 ReferenceError 并被 catch 吞掉 —— 那条提示就成了死链。
    scanPanelApi.fillList = () => fillList();
    scanPanelApi.paintError = paintErrorToCard;

    // ===== 面板路径的「取答案 / 写卡片」拆分（与 run() 同一套思路）=====
    //
    // 面板原本也是一题一题串着来（取答案 → 写卡片 → 歇 interval → 下一题），
    // 于是「开始答题」已经能并发，面板上的「⚡ 出答案 / ✍ 填涂」却还是老速度 ——
    // 同一个设置项两套行为。这里把面板也改成"取答案并发、写卡片严格按题序"。
    //
    // 为什么写卡片也必须保序：用户是**按题号从上往下看**的，卡片乱序跳着更新
    // 会让人以为串题了；而且这是长期约定（与填涂顺序一致）。
    async function fetchOneForPanel(item) {
      const nq = normalizePanelQuestion(item.q);
      // 已经算过的（点过「答」或上一轮「出答案」）直接复用，不重复问 AI
      if (nq.fillText && item.fillTexts && item.fillTexts.length) {
        return { texts: item.fillTexts, how: "面板已算出的答案" };
      }
      if (!nq.fillText && item.answerIdx && item.answerIdx.length) {
        return { answer: item.answerIdx, how: "面板已算出的答案" };
      }
      const settings = await loadFillSettings();
      return resolveAnswer(nq, settings);
    }

    // 把取到的答案写到卡片上（不碰页面）。只做展示与暂存，供「填涂」复用。
    function paintPanelResult(item, res) {
      const { q, answerBox } = item;
      const nq = normalizePanelQuestion(q);
      if (!res || (!res.answer && !res.texts)) {
        answerBox.style.display = "block";
        answerBox.textContent = "❌ " + ((res && res.error) || "没取到答案");
        answerBox.style.color = "var(--c-danger)";
        markOptionAnswer(item, res);
        if (!res) item.dataset.answerState = "failed";
        return false;
      }
      answerBox.style.display = "block";
      answerBox.textContent = answerToText(res) + (res.score && res.score < 1 ? `（相似度 ${Math.round(res.score * 100)}%）` : "");
      answerBox.style.color = res.how === "题库·模糊" ? "var(--c-warn)" : "var(--c-ink-2)";
      renderExplain(item, res);
      renderThink(item, res);
      markOptionAnswer(item, res);
      // 暂存起来：之后点「填涂」就不用再问一遍 AI
      if (nq.fillText) item.fillTexts = res.texts;
      else item.answerIdx = res.answer;
      item.how = res.how;
      item.answered = true;
      return true;
    }

    // 面板「⚡ 出答案」取答案。**必须与「开始答题」「填涂」走同一份 resolveAnswer**：
    // 直接发 TEXT_CHAT（只问 AI）的话，选了「题库匹配（推荐）」的用户点这个按钮，
    // 会拿到一排「未配置 API Key」——明明题库里就有答案，却一次都不查。
    // 题库优先 → 未命中且模式允许才走 AI。
    // settings 由调用方传入（整轮只读一次 storage，不按题重复读）。
    async function answerOne(item, settings) {
      const { q, btn, answerBox } = item;   // item 就是卡片对象（字段由 fillList 挂上）
      const nq = normalizePanelQuestion(q);

      answerBox.style.display = "block";
      answerBox.textContent = "⏳ 取答案中…";
      answerBox.style.color = "var(--c-ink-4)";
      markOptionAnswer(item, null);
      btn.disabled = true;

      let res;
      try {
        res = await resolveAnswer(nq, settings);
      } catch (e) {
        res = { answer: null, error: e.message };
      }
      btn.disabled = false;

      if (!res || (!res.answer && !res.texts)) {
        answerBox.textContent = "❌ " + ((res && res.error) || "没取到答案");
        answerBox.style.color = "var(--c-danger)";
        markOptionAnswer(item, res);
        if (!res) item.dataset.answerState = "failed";
        return false;
      }

      answerBox.textContent = answerToText(res) + (res.score && res.score < 1 ? `（相似度 ${Math.round(res.score * 100)}%）` : "");
      answerBox.style.color = res.how === "题库·模糊" ? "var(--c-warn)" : "var(--c-ink-2)";
      renderExplain(item, res);      // 「答案 + 解析」/「完整功能」模式下把解析显示出来
      renderThink(item, res);        // 「完整功能」模式下把思考过程显示出来
      markOptionAnswer(item, res);
      // 顺手把答案存下来，之后点「填涂」就不用再问一遍
      if (nq.fillText) {
        item.fillTexts = res.texts;                                                  // 填空题：存文本数组
      } else {
        item.answerIdx = res.answer;                                                 // 选择题：存选项下标
      }
      item.how = res.how;
      item.answered = true;
      return true;
    }

    // 暂停 / 恢复「出答案」与「填涂」。
    // 两者的等待都走 waitOrStopPanel：暂停时它把自己 park 进对应数组、**不返回**，
    // 于是在途的循环就停在那处 await 上；恢复时唤醒即可接着跑。
    function pauseAnswerAll() {
      if (!answeringAll || answerPaused) return;
      answerPaused = true;
      setFillMsg("已暂停「出答案」（点「▶ 继续」接着出，已出的不会重来）", "var(--c-warn)");
      scanPanelApi.setRunState("paused");
    }
    function resumeAnswerAll() {
      if (!answeringAll || !answerPaused) return;
      answerPaused = false;
      // ⚠ 必须**原地清空**，不能 answerResolvers = []：
      // 这个数组对象是**引用传递**给 waitOrStopPanel 的（循环里一直拿着它 park），
      // 换成新数组会让已挂起的等待者成为孤儿，永远等不到唤醒 —— 面板就卡死在暂停。
      const rs = answerResolvers.splice(0);
      rs.forEach(f => { try { f(); } catch (_) {} });
      setFillMsg("已继续「出答案」", "var(--c-sky)");
      scanPanelApi.setRunState("running");
    }
    function pauseFillFromPanel() {
      if (!filling || fillPaused) return;
      fillPaused = true;
      setFillMsg("已暂停「填涂」（点「▶ 继续」接着填涂）", "var(--c-warn)");
      scanPanelApi.setRunState("paused");
    }
    function resumeFillFromPanel() {
      if (!filling || !fillPaused) return;
      fillPaused = false;
      // 同 resumeAnswerAll：必须原地 splice，保住数组引用（详见那里的说明）
      const rs = fillResolvers.splice(0);
      rs.forEach(f => { try { f(); } catch (_) {} });
      setFillMsg("已继续「填涂」", "var(--c-sky)");
      scanPanelApi.setRunState("running");
    }

    async function answerAll() {
      // 作答中再点一次 = 停止；重新点会跳过已答的题继续
      if (answeringAll) { stopFlag = true; abortPanelAI(); return; }
      if (!qaItems.length) return;
      // 自动答题（「开始答题」）正在跑时，这是两套流水线同时在改页面 —— 明确告诉用户，
      // 而不是让两边各点各的。按钮不再置灰，所以这里必须有个出口说明。
      if (running) { setFillMsg("正在自动答题中，请先点「■ 停止答题」，或在插件弹窗里点「停止」", "var(--c-warn)"); return; }
      answeringAll = true;
      stopFlag = false;
      answerAllBtn.className = "aa-btn aa-btn-danger";

      const settings = await loadFillSettings();
      // 题库优先：先把题库准备好，否则每题都会退化成「未命中」
      if (settings.mode !== "ai" && !bankIndex) {
        bankThreshold = thresholdFraction(settings.fuzzyThreshold);
        try {
          await loadBank(settings);
        } catch (_) { /* 题库不可用：交给 resolveAnswer 报错或走 AI */ }
      }

      let done = 0;
      // 进入循环前先把状态置为运行中，让面板的「暂停 / 停止」可用
      scanPanelApi.setRunState("running");
      // 并发度读用户设置（与「开始答题」共用同一份 resolveConcurrency）：
      // 无条件串行的话，用户把并发开到 5 也没用 —— 同一设置项两套行为。
      const conc = resolveConcurrency(settings);
      setFillMsg(conc > 1
        ? `正在出答案（${conc} 路并发，答案按题序显示）…（可用「⏸ 暂停」随时停一下）`
        : "正在出答案…（可用「⏸ 暂停」随时停一下）", "var(--c-accent)");

      // 待办清单：跳过已经出过答案的卡片
      const pending = qaItems.filter(it => !it.answered);
      // 信号灯：results[i] 对应 pending[i]，消费者严格按 i 递增地等，保证"边就绪边按序显示"
      const results = new Array(pending.length);
      const slots = pending.map(() => { let go; const p = new Promise(r => { go = r; }); return { p, go }; });
      const workersN = Math.min(conc, pending.length);

      const producers = (async () => {
        let cursor = 0;
        try {
          await Promise.all(Array.from({ length: workersN }, async () => {
            while (!stopFlag && scanPanel) {
              const i = cursor++;
              if (i >= pending.length) break;
              // 暂停/停止闸门（与 run 的语义一致）：停下后不再发新请求
              await waitOrStopPanel(0, () => stopFlag || !scanPanel, () => answerPaused, answerResolvers);
              if (stopFlag || !scanPanel) break;
              try {
                // 只取答案，不碰页面 —— 页面由下面按序写
                results[i] = await fetchOneForPanel(pending[i]);
              } catch (e) {
                results[i] = { answer: null, error: e && e.message ? e.message : String(e) };
              }
              slots[i].go();
              await waitOrStopPanel(panelGap(settings), () => stopFlag || !scanPanel,
                () => answerPaused, answerResolvers);
            }
          }));
        } finally {
          // 放行剩余信号灯必须在"全部生产者结束之后"，否则会提前放行还没取到的题
          for (let j = 0; j < slots.length; j++) { try { slots[j].go(); } catch (_) {} }
        }
      })();

      // 消费者：严格按题序把答案写到卡片上（卡片更新也必须有序，否则用户看到顺序错乱）
      for (let i = 0; i < pending.length; i++) {
        if (!scanPanel || stopFlag) break;
        await waitOrStopPanel(0, () => stopFlag || !scanPanel, () => answerPaused, answerResolvers);
        if (stopFlag || !scanPanel) break;
        await slots[i].p;
        if (stopFlag || !scanPanel) break;
        const item = pending[i];
        const res = results[i] || { answer: null, error: "未取得答案" };
        paintPanelResult(item, res);
        if (item.answered) done++;
        answerAllBtn.textContent = `■ 停止 ${done}/${qaItems.length}`;
      }
      await producers;
      // 先把"是否被手动停止"记下来再用：如果 `stopFlag = false` 之后才读 stopFlag，
      // 那个"被停止就不显示汇总"的分支永远走不到 —— 中途停下也报绿色「出答案结束」，
      // 而同一个面板上的按钮却显示「▶ 继续」，两处自相矛盾。
      const stopped = stopFlag;
      answerAllBtn.className = "aa-btn aa-btn-soft";
      answerAllBtn.textContent = stopped ? `▶ 继续（已出 ${done}）` : "⚡ 出答案";
      answeringAll = false;
      stopFlag = false;
      answerPaused = false;
      scanPanelApi.setRunState("idle");
      if (stopped) setFillMsg(`已停止「出答案」：已出 ${done} 道，剩下的没出。`, "var(--c-warn)");
      else if (!done) setFillMsg("出答案结束：一道都没出（可能都没识别到题目，或模式/密钥没配好）。", "var(--c-warn)");
      else setFillMsg(`出答案结束：共 ${done} 道`, "var(--c-sky)");
    }

    // 面板里的「✍ 填涂」：对当前列出的题目取答案并自动勾选。
    // 与「开始答题」共用 resolveAnswer / 点击逻辑，差别只是结果写回卡片而不是运行日志面板。
    async function fillFromPanel() {
      if (filling) { fillStop = true; abortPanelAI(); return; }        // 再点一次 = 停止
      // 同 answerAll：自动答题进行中不并行填涂，给一句明确提示
      if (running) { setFillMsg("正在自动答题中，请先点「■ 停止答题」，或在插件弹窗里点「停止」", "var(--c-warn)"); return; }

      const targets = qaItems.filter(it => canFill(it.q));
      if (!targets.length) {
        const total = qaItems.length;
        setFillMsg(total
          ? `${total} 道题都没有可填的东西（选项可能是纯文本，或是下拉/矩阵题），只能用「⚡ 出答案」看答案后手动填。`
          : "还没有识别到题目，先点「↻ 重新扫描」。", "var(--c-warn)");
        return;
      }

      const settings = await loadFillSettings();
      // 写页面之前过白名单。面板可以由 popup 的「识别页面题目」直接打开，
      // 那条路不经过 run()，拿不到 run() 的判定 —— 所以这里必须单独查。
      if (!(await fillAllowedOk(settings))) {
        setFillMsg(fillNotAllowedText(), "var(--c-warn)");
        return;
      }

      filling = true;
      fillStop = false;
      fillBtn.className = "aa-btn aa-btn-danger";

      if (settings.mode !== "ai") {
        bankThreshold = thresholdFraction(settings.fuzzyThreshold);
        try {
          await loadBank(settings);
        } catch (e) {
          setFillMsg("题库不可用，本次只走 AI 兜底：" + e.message, "var(--c-warn)");
        }
      }
      scanPanelApi.setRunState("running");
      setFillMsg(`正在填涂 ${targets.length} 道题（模式：${settings.mode}）…（可用「⏸ 暂停」随时停一下）`);

      let done = 0, miss = 0, noOpt = 0, alr = 0, unsure = 0, half = 0;

      // ① 先筛掉"已经填过"的（便宜、纯 DOM 判断），保持计数与日志顺序不变
      const todo2 = [];
      for (const item of targets) {
        if (!scanPanel || fillStop) break;
        const q = normalizePanelQuestion(item.q);
        const blanks = q.blankInputs || [];
        const inputs = q.inputs || [];
        const opts = q.optEls || [];
        // "动过"要分两种：回读确认过的（真填上了）与只是点过/写过的（页面没接住）。
        // 只有前者算「已经填过」；后者必须如实说"这一题请手动填"。
        // 一律用 filledEls 判的话，一次被 type=number 吞掉的写入会把这道题
        // 永久锁成"跳过"，用户连重试的机会都没有。
        const filledForSure =
          (blanks.length > 0 && blanks.every(el => writtenOk.has(el))) ||
          (settings.overwriteSelected !== true && inputs.some(i => i && i.checked)) ||
          (settings.overwriteSelected !== true && opts.some(el => looksSelected(el))) ||
          opts.some(el => writtenOk.has(el));
        const triedButUnverified =
          (blanks.length > 0 && blanks.every(el => filledEls.has(el))) ||
          opts.some(el => filledEls.has(el));
        if (filledForSure) {
          alr++;
          item.answerBox.style.display = "block";
          item.answerBox.textContent = "↷ 已经填过，跳过";
          item.answerBox.style.color = "var(--c-ink-4)";
          if (item.answerIdx) markOptionAnswer(item, { answer: item.answerIdx });
          continue;
        }
        if (triedButUnverified) {
          alr++;
          item.answerBox.style.display = "block";
          item.answerBox.textContent = "⚠ 上一轮写过，但页面没接住 —— 这一题请手动填（不再重复请求）";
          item.answerBox.style.color = "var(--c-warn)";
          if (item.answerIdx) markOptionAnswer(item, { answer: item.answerIdx });
          continue;
        }
        todo2.push(item);
      }

      // ② 并发取答案（同样读用户设置），③ 再严格按题序填进页面。
      //    填涂是**不可逆**的，所以"写页面"这一段绝不能并发。
      const conc2 = resolveConcurrency(settings);
      const results2 = new Array(todo2.length);
      const slots2 = todo2.map(() => { let go; const p = new Promise(r => { go = r; }); return { p, go }; });
      const workers2 = Math.min(conc2, todo2.length);

      const producers2 = (async () => {
        let cursor = 0;
        try {
          await Promise.all(Array.from({ length: workers2 }, async () => {
            while (!fillStop && scanPanel) {
              const i = cursor++;
              if (i >= todo2.length) break;
              await waitOrStopPanel(0, () => fillStop || !scanPanel, () => fillPaused, fillResolvers);
              if (fillStop || !scanPanel) break;
              try {
                results2[i] = await fetchOneForPanel(todo2[i]);
              } catch (e) {
                results2[i] = { answer: null, error: e && e.message ? e.message : String(e) };
              }
              slots2[i].go();
              // 间隔跟随 popup 的「每题间隔」设置，不能硬编码，否则同一设置项两套行为
              await waitOrStopPanel(panelGap(settings), () => fillStop || !scanPanel,
                () => fillPaused, fillResolvers);
            }
          }));
        } finally {
          for (let j = 0; j < slots2.length; j++) { try { slots2[j].go(); } catch (_) {} }
        }
      })();

      for (let i = 0; i < todo2.length; i++) {
        if (!scanPanel || fillStop) break;
        await waitOrStopPanel(0, () => fillStop || !scanPanel, () => fillPaused, fillResolvers);
        if (fillStop || !scanPanel) break;
        await slots2[i].p;
        if (fillStop || !scanPanel) break;
        const item = todo2[i];
        const q = normalizePanelQuestion(item.q);
        const res = results2[i] || { answer: null, error: "未取得答案" };
        markOptionAnswer(item, res);

        if (!res.answer && !res.texts) {
          miss++;
          item.answerBox.style.display = "block";
          item.answerBox.textContent = "✗ " + (res.error || "题库里没有这道题，且当前模式不允许 AI 兜底");
          item.answerBox.style.color = "var(--c-danger)";
          continue;
        }

        const n = applyAnswer(q, res, true);
        renderExplain(item, res);
        renderThink(item, res);
        item.answerBox.style.display = "block";
        if (!n) {
          noOpt++;
          item.answerBox.textContent = "⚠ 没能写进页面，请手动填这道题";
          item.answerBox.style.color = "var(--c-warn)";
          continue;
        }
        // 半题不算答完（同 run() 里的处理）：写进去的留着，但要说清楚还差几个空
        if (res.incomplete) {
          half++;
          item.answerBox.textContent = `⚠ 只填上 ${n} 个空，还差 ${res.incomplete} 个，请手动补`;
          item.answerBox.style.color = "var(--c-warn)";
          continue;
        }
        done++;
        // 没有 input 的选项列表点不出可回读的选中态时，不能说"✓ 已填涂"——
        // 那样一次什么都没发生的点击也会被读成成功。
        if (q.optionClickUnverified) unsure++;
        item.answerBox.textContent = q.optionClickUnverified
          ? `⚠ 已点击 ${answerToText(res)}（${res.how}）—— 页面选中态读不到，请核对这一题`
          : `✓ 已填涂 ${answerToText(res)}（${res.how}）`;
        item.answerBox.style.color = q.optionClickUnverified ? "var(--c-warn)" : "var(--c-sky)";
        fillBtn.textContent = `■ 停止 ${done}/${targets.length}`;
      }
      await producers2;

      filling = false;
      fillPaused = false;
      scanPanelApi.setRunState("idle");
      fillBtn.className = "aa-btn aa-btn-green";
      fillBtn.textContent = "✍ 填涂";
      const parts = [`成功 ${done}`];
      if (alr) parts.push(`已跳过 ${alr}`);
      if (miss) parts.push(`未命中 ${miss}`);
      if (noOpt) parts.push(`点击无效 ${noOpt}`);
      if (half) parts.push(`半题 ${half}（有空没填上）`);
      if (unsure) parts.push(`其中 ${unsure} 题点不出选中态、请人工核对`);
      const skippedOther = qaItems.length - targets.length;
      if (skippedOther) parts.push(`无选项 ${skippedOther}`);
      // 一题都没落地时不能用绿色 —— 面板一片绿但页面没动，用户只会以为已经答完
      const bad = !done || !!noOpt || !!miss || !!half;
      setFillMsg(`填涂结束：${parts.join("，")}${fillStop ? "（你手动停了）" : ""}。`
        + `下拉/矩阵题请手动补答，是否交卷由你手动决定。`, bad ? "var(--c-warn)" : "var(--c-sky)");
    }

    // 缩小成悬浮球：球可拖到任意位置，单击还原
    function minimizeToBall() {
      if (!scanPanel) return;
      const rect = scanPanel.getBoundingClientRect();
      const px = Math.max(0, Math.min(rect.left, window.innerWidth - 50));
      const py = Math.max(0, Math.min(rect.top, window.innerHeight - 50));
      scanPanel.style.display = "none";
      // 悬浮球先清掉：否则最小化两次会攒出两个球，各自都能点开面板
      document.querySelectorAll(".aa-ball").forEach(b => b.remove());

      const ball = document.createElement("div");
      ball.className = "aa-ball";
      ball.style.left = px + "px";
      ball.style.top = py + "px";
      ball.title = "点击展开题目面板，可拖动到任意位置";
      ball.innerHTML = `<img class="aa-ball-logo" src="${LOGO_MARK_URL}" alt=""><span class="aa-badge">${qaItems.length}</span>`;
      document.documentElement.appendChild(ball);
      // ⚠ 球的坐标**不能**存进 scanPanelPos：那是"面板下次开在哪儿"的依据，
      // 球只有 46px，存进去会让下一次打开的面板跑到角落，还被
      // Math.min(pos.x, innerWidth-100) 推到贴边 —— 用户以为是面板布局坏了。
      // 还原时面板就摆在球当前位置（restoreFromBall），不需要额外持久化。
      makeDraggable(ball, ball, null, () => restoreFromBall(ball));
    }

    function restoreFromBall(ball) {
      const r = ball.getBoundingClientRect();
      ball.remove();
      if (!scanPanel) return;
      scanPanel.style.display = "flex";
      scanPanel.style.right = "auto";
      scanPanel.style.left = Math.max(0, Math.min(r.left, window.innerWidth - 120)) + "px";
      scanPanel.style.top = Math.max(0, Math.min(r.top, window.innerHeight - 80)) + "px";
    }

    function fillList() {
      list.innerHTML = "";
      qaItems = [];
      const count = scanPanel.querySelector(".aa-count");
      // 顶层 + 同源 iframe 各扫一遍；先按旧顺序去重，再按 DOM 位置排序。
      // 顺序反了会让"纯文本副本"先占位、把带可点元素的同一题吞掉（填空题会变成不可填）。
      const perDoc = scanEachDoc(() => {
        const merged = dedupeQuestions([
          ...scanChaoxing(), ...scanFormGroups(), ...scanTextInputs(),
          ...scanOptionLists(), ...scanBlanks(), ...scanTextQuestions()
        ]);
        return sortByDomPosition(merged);
      });
      const blockedFrames = scanBlockedFrames;
      const qs = dedupeQuestions(perDoc.flat());
      if (count) {
        count.style.display = qs.length ? "" : "none";
        count.textContent = qs.length + " 题";
      }
      if (!qs.length) {
        const empty = document.createElement("div");
        empty.className = "aa-empty";
        empty.innerHTML =
          `<div class="aa-empty-icon">🔍</div>` +
          `<div class="aa-empty-title">没有识别到题目</div>`;
        const sub = document.createElement("div");
        sub.className = "aa-empty-sub";
        sub.textContent = blockedFrames
          ? `检测到 ${blockedFrames} 个跨域 iframe，插件读不到里面的题目。` +
            `可在这个区域右键 →「此框架」→「在新标签页中打开」，再重新扫描。`
          : "当前页面可能不含选择题，或页面尚未加载完";
        empty.appendChild(sub);
        empty.appendChild(mkScanBtn("↻ 重新扫描", "aa-btn-primary", () => fillList()));
        list.appendChild(empty);
        return;
      }
      const info = document.createElement("div");
      info.className = "aa-info";
      info.textContent = `识别到 ${qs.length} 道题，点右上角「⚡ 出答案」一次性算答案（题库优先，可 AI 兜底）`
        + (blockedFrames ? `（另有 ${blockedFrames} 个跨域 iframe 未扫描）` : "");
      list.appendChild(info);

      // 阅读题组统一挂材料：同组题共享前置材料，不要求每题题干都有提示词。
      // 单题/完形仍由下面的 attachPassage 兜底。
      attachPassages(qs);

      qs.forEach((q, i) => {
        // 清理题干里的指令尾巴（如 "选择ABCDEFGHIJKL"）
        q.stem = q.stem.replace(/\s*选择\s*[A-N]{2,}\s*/g, " ").trim();

        // 附加阅读材料：普通题找前置文本块；
        // 空格类题目（选词填空/文中完形）材料就是文章本身 → 取"3000 字以内最大的祖先容器"，
        // 避免只抓到文章中一个段落碎片。规则与自动填涂路径共用（attachPassage）
        attachPassage(q);

        // 挂接共享选项池 / 词库：段落匹配题的长句选项池、选词填空的短词词库
        let fromPool = false;
        if (q.options.length === 0 && q.el) {
          if (q.clozeNum) {
            const bank = findWordBankNear(q.el);
            if (bank) { q.options = bank; fromPool = true; }
          }
          if (!fromPool) {
            const pool = findOptionPoolNear(q.el);
            if (pool) { q.options = pool; fromPool = true; }
          }
        }

        // 卡片对象：DOM 元素 + 这道题的答案/解析/思考容器，qaItems 里存的就是它。
        const item = document.createElement("div");
        item.className = "aa-card";
        item.q = q;

        const top = document.createElement("div");
        top.className = "aa-card-top";
        const num = document.createElement("span");
        num.className = "aa-num aa-card-num";
        num.textContent = String(i + 1).padStart(2, "0");
        const cardState = document.createElement("span");
        cardState.className = "aa-card-state";

        const row = document.createElement("div");
        row.className = "aa-row";

        const stem = document.createElement("div");
        stem.className = "aa-stem";
        const imageCount = q.imageCount != null ? q.imageCount : countQuestionImages(q.el);
        stem.innerHTML = escapeHtml(q.stem.slice(0, 80)) + (q.stem.length > 80 ? "…" : "");

        // 类型/警告/材料标签单独一行，普通选择题不再挂「N 个选项」这类冗余标签。
        const tags = document.createElement("div");
        tags.className = "aa-card-tags";
        if (imageCount) {
          tags.insertAdjacentHTML("beforeend",
            `<span class="aa-chip-warn" title="图片内容不会被文字识别读取，AI 可能缺少材料。建议用右上角「📷 截图解题」看答案；自动填涂可能因缺材料答错">⚠ 含图片材料${imageCount > 1 ? " " + imageCount + " 张" : ""}</span>`);
        }
        if (q.passageMissing) {
          tags.insertAdjacentHTML("beforeend",
            `<span class="aa-chip-warn" title="题干像阅读题，但没找到前置材料；AI 可能只按题干作答，建议核对原文">⚠ 未挂上材料</span>`);
        }
        const addTypeChip = text => {
          if (!text) return;
          const chip = document.createElement("span");
          chip.className = "aa-chip";
          chip.textContent = text;
          tags.appendChild(chip);
        };
        if (q.clozeNum) addTypeChip("完形填空");
        if (q.fillText) {
          if (q.freeText) addTypeChip(q.freeTextKind === "correct" ? "改错" : q.freeTextKind === "rewrite" ? "改写" : "简答");
          else addTypeChip((q.blankInputs || []).length > 1 ? (q.blankInputs.length + " 空") : "填空");
        }

        // 材料字数只给长材料显示；短材料按普通题样式展示。
        let passageDiv = null;
        if (q.passage && q.passage.length >= PASSAGE_CHIP_MIN_CHARS) {
          const chip = document.createElement("span");
          chip.className = "aa-chip-passage";
          const words = q.passage.length;
          chip.textContent = `📄 材料 ${words} 字`;
          chip.title = "点击展开/收起原文预览";
          passageDiv = document.createElement("div");
          passageDiv.className = "aa-passage";
          passageDiv.textContent = q.passage;
          chip.addEventListener("click", () => {
            passageDiv.style.display = passageDiv.style.display === "block" ? "none" : "block";
          });
          tags.appendChild(chip);
        }

        // 选项：A/B/C/D 圆标 + 文本；答案项后续用现有琥珀色填充。
        let optionWrap = null;
        if (q.options.length) {
          optionWrap = document.createElement("div");
          optionWrap.className = "aa-options";
          optionWrap.setAttribute("role", "list");
          const texts = q.options.map(o => String(o == null ? "" : o));
          if (texts.some(t => t.trim().length > 24)) optionWrap.classList.add("aa-options--long");
          texts.forEach((raw, idx) => {
            const label = String.fromCharCode(65 + idx);
            const opt = document.createElement("div");
            opt.className = "aa-opt";
            opt.setAttribute("role", "listitem");
            const mark = document.createElement("span");
            mark.className = "aa-opt-mark";
            mark.textContent = label;
            const text = document.createElement("span");
            text.className = "aa-opt-text";
            let shown = raw.replace(/\s+/g, " ").trim();
            const stripped = shown.replace(/^[A-H]\s*[.、．):：]\s*/i, "").trim();
            if (stripped) shown = stripped;
            text.textContent = shown.toUpperCase() === label ? "" : shown;
            opt.append(mark, text);
            optionWrap.appendChild(opt);
          });
        }

        // 注意：item 这个对象稍后才入 qaItems，这里**必须**原样传进去。
        // 若写成 answerOne({ q, btn, answerBox })——新建一个只有三个字段的对象，
        // 单题作答路径就拿不到 item.explainBox / item.fillTexts / item.answered，
        // 解析框永远不显示，而且「答」完再点「填涂」会把同一题重问一遍 AI。
        const btn = mkScanBtn("答", "aa-btn-muted", async () => {
          // 批量任务在跑时不让单题并发 —— 但直接 `return` 的话，卡片一动不动、
          // 也不禁用按钮，用户只会以为"这按钮坏了"。这里给一句准话。
          if (answeringAll) { setFillMsg("「⚡ 出答案」正在批量作答，等它跑完（或先点「■ 停止」）再点单题「答」。", "var(--c-warn)"); return; }
          // 填涂进行中更要挡：answerOne 和填涂循环会写**同一张卡**的 answerBox，
          // 结果是卡片显示「✓ C」而页面上那一题其实还没被写 —— 用户以为答完了。
          if (filling) { setFillMsg("「✍ 填涂」正在写页面，先点它变成「■ 停止」停下手，再点单题「答」。", "var(--c-warn)"); return; }
          await answerOne(item, await loadFillSettings());
        });
        top.append(num, cardState);
        row.append(stem);

        const answerBox = document.createElement("div");
        answerBox.className = "aa-answer";
        // 无障碍：答案区内容变化时让屏幕阅读器播报。
        // 这些卡片是异步逐张刷新的（并发流水线按序落地），没有 aria-live 的话
        // 读屏用户完全感知不到"答案出来了"。
        answerBox.setAttribute("role", "status");
        answerBox.setAttribute("aria-live", "polite");
        // 解析容器：输出模式为「答案 + 解析」/「完整功能」时才有内容，
        // 「只输出答案」模式下模型不会回解析，这里就一直 display:none。
        const explainBox = document.createElement("div");
        explainBox.className = "aa-explain";
        // 思考过程容器：「完整功能」模式才有内容（后台 reasoning_content）
        const thinkBox = document.createElement("div");
        thinkBox.className = "aa-think";

        // 各块挂到 item 上：qaItems 里存的就是这个对象本身，
        // answerOne(item) / fillFromPanel(item) 都靠这些字段读写卡片；
        // 另建 {q,btn,answerBox} 纯对象入队的话，两边字段名对不上就会炸。
        item.btn = btn;
        item.answerBox = answerBox;
        item.explainBox = explainBox;
        item.thinkBox = thinkBox;
        item.optionWrap = optionWrap;

        item.append(top, row);
        if (tags.childElementCount) item.appendChild(tags);
        if (optionWrap) item.appendChild(optionWrap);
        const foot = document.createElement("div");
        foot.className = "aa-card-foot";
        foot.append(answerBox, btn);
        item.append(explainBox, thinkBox);
        if (passageDiv) item.appendChild(passageDiv);
        item.appendChild(foot);
        list.appendChild(item);
        // 先 push 再交给按钮闭包使用（闭包读的是这个已入队的对象）
        qaItems.push(item);
      });
    }

    fillList();
  }

  function mkScanBtn(label, cls, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "aa-btn " + cls;
    b.addEventListener("click", onClick);
    return b;
  }

  // 拖动：按住 handle 移动 target；onClick 在"点击未拖动"时触发（用于悬浮球还原）
  function makeDraggable(handle, target, onSave, onClick) {
    handle.addEventListener("mousedown", e => {
      if (e.target.closest("button")) return;
      let moved = false;
      const rect = target.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      target.style.right = "auto";
      const move = ev => {
        const dx = ev.clientX - (rect.left + ox), dy = ev.clientY - (rect.top + oy);
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        const x = Math.max(0, Math.min(ev.clientX - ox, window.innerWidth - 50));
        const y = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - 40));
        target.style.left = x + "px";
        target.style.top = y + "px";
      };
      const stop = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.removeEventListener("pointercancel", stop);
        try { window.removeEventListener("blur", stop); } catch (_) {}
      };
      const up = () => {
        stop();
        if (moved && onSave) onSave(target);
        if (!moved && onClick) onClick();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      // 在窗口外松手（浏览器工具栏、另一块显示器、Alt+Tab 切走）时收不到 mouseup，
      // 这两个全局监听必须能摘掉 —— 否则面板会跟着**没有按住**的光标一路跑，
      // 直到用户下次在页面里随便点一下才停。pointercancel + 窗口 blur 兜住这两条路。
      document.addEventListener("pointercancel", stop);
      try { window.addEventListener("blur", stop); } catch (_) {}
      e.preventDefault();
    });
  }

  function saveScanPos(target) {
    if (!target.style.left) return;
    chrome.storage.local.set({
      scanPanelPos: { x: parseFloat(target.style.left), y: parseFloat(target.style.top) }
    }).catch(() => {});
  }

  function saveScanSize(target) {
    chrome.storage.local.set({
      scanPanelSize: { w: target.offsetWidth, h: target.offsetHeight }
    }).catch(() => {});
  }

  // Windows 式缩放：右下角把手拖拽调整宽高。
  // mousemove 只记录最新尺寸，每帧最多写一次 style，避免高题量页面重排跟不上光标。
  function makeResizable(target, onSave) {
    const grip = document.createElement("div");
    grip.className = "aa-resize";
    grip.title = "拖拽调整窗口大小";
    target.appendChild(grip);
    grip.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = target.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, sw = rect.width, sh = rect.height;
      let pending = null;
      let raf = 0;
      let lastW = Math.round(sw);
      let lastH = Math.round(sh);
      const apply = () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (!pending) return;
        const { w, h } = pending;
        pending = null;
        if (w !== lastW) { target.style.width = w + "px"; lastW = w; }
        if (h !== lastH) { target.style.height = h + "px"; lastH = h; }
      };
      const move = ev => {
        const w = Math.max(320, Math.min(ev.clientX - sx + sw, window.innerWidth - 20));
        const h = Math.max(220, Math.min(ev.clientY - sy + sh, window.innerHeight - 20));
        pending = { w: Math.round(w), h: Math.round(h) };
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const stop = () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        pending = null;
        target.classList.remove("aa-resizing");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.removeEventListener("pointercancel", stop);
        try { window.removeEventListener("blur", stop); } catch (_) {}
      };
      const up = () => {
        apply();
        stop();
        if (onSave) onSave(target);
      };
      target.classList.add("aa-resizing");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      // 窗口外松手收不到 mouseup，监听摘不掉，面板尺寸会跟着没按键的光标变。
      document.addEventListener("pointercancel", stop);
      try { window.addEventListener("blur", stop); } catch (_) {}
    });
  }

  // ---------- 共享选项池识别（段落匹配/信息判断题：A-K 是一组分散在页面别处的长句） ----------
  function parseOptionPool(el) {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (normText(text).length < 120) return null;
    const re = /(?:^|\s)([A-P])\s*[).、．]\s*/g;
    let m;
    const marks = [];
    while ((m = re.exec(text))) marks.push({ letter: m[1], start: m.index, end: re.lastIndex });
    if (marks.length < 4) return null;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].letter.charCodeAt(0) !== 65 + i) return null; // A 起连续编号
    }
    const opts = marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      return mk.letter + ". " + text.slice(mk.end, end).trim();
    }).filter(o => o.length > 12);
    if (opts.length < 4) return null;
    const avg = opts.reduce((s, o) => s + o.length, 0) / opts.length;
    if (avg < 25) return null; // 选项必须是句子级，排除普通短选项
    return opts;
  }

  function findOptionPoolNear(el) {
    let node = el;
    for (let level = 0; level < 5 && node && !isDocRoot(node); level++) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib === node || sib.contains(node) || node.contains(sib)) continue;
        if (!visibleEl(sib)) continue;
        const pool = parseOptionPool(sib);
        if (pool) return pool;
      }
      node = parent;
    }
    return null;
  }

  // 这个元素本身是不是一组竖排选项（<li>A. …</li><li>B. …</li>…）？
  // 找题干时用来识别"上一题的选项列表"——那是题干搜索的边界：
  // 越过它继续往前找，只会把上一题的题干配到这一题的选项上。
  function looksLikeOptionList(el) {
    const kids = [...el.children].filter(c => visibleEl(c));
    if (kids.length < 3) return false;
    let letter = 65, n = 0;
    for (const k of kids) {
      const t = k.textContent.replace(/\s+/g, " ").trim();
      const re = new RegExp("^" + String.fromCharCode(letter) + "(?![A-Za-z0-9])\\s*[.、．)]?\\s*\\S");
      if (!re.test(t)) break;
      n++; letter++;
    }
    return n >= 3;
  }

  // 策略3：竖排选项列表 —— 每个选项是独立元素（<li>A. however</li><li>B. while</li>…），
  // 常见于完形填空/选项与题干分离渲染的页面
  function scanOptionLists() {
    const out = [];
    const seen = new Set();
    // 扫描容器类型必须够宽：题目块不一定长在 <div> 上。
    // 一类常见页面是「一页 50 道题，每道题一个 <li>，外面套一个 <ul>」——
    // <ul> 有 50 个子元素（超过上限直接跳过），<li> 又不在选择器里，
    // 于是整页一组选项都找不到，面板能列出 50 题却一道都填不了。
    rootDoc().querySelectorAll("ul,ol,div,tbody,li,tr,section,article").forEach(el => {
      if (!visibleEl(el) || scanPanel?.contains(el)) return;
      // 导航/页眉/页脚里的列表永远不是题目选项
      if (el.closest("nav,header,footer,aside")) return;
      const kids = [...el.children].filter(c => visibleEl(c));
      if (kids.length > 26) return;
      const textOf = k => k.textContent.replace(/\s+/g, " ").trim();
      // 「上一题的整块」的特征：文本里自带一组 A/B/C 选项字母
      const hasOptionLetters = t => {
        const marks = t.match(/(?<![A-Za-z0-9])([A-H])\s*[.、．)]\s*\S/g) || [];
        return new Set(marks.map(m => m[0])).size >= 2;
      };
      // 选项块未必从第一个子元素开始：真实站点常把「题号 + 题干 + 选项」放在同一个容器里
      // （<div class="q"><div>1、…</div><div>A、正确</div><div>B、错误</div></div>）。
      // 硬要求选项从第 0 个子元素开始的话，这类页面整页一道题都识别不出来。
      // 所以先找「以 A 开头」的起跳点，起跳点之前的同级元素就是题干候选。
      const kidOpts = [], kidEls = [];
      let start = -1;
      for (let i = 0; i < kids.length; i++) {
        if (/^A(?![A-Za-z0-9])\s*[.、．)]?\s*\S/.test(textOf(kids[i]))) { start = i; break; }
      }
      if (start >= 0) {
        let letter = 65;
        for (let i = start; i < kids.length; i++) {
          const t = textOf(kids[i]);
          // 字母后面必须紧跟分隔符/空白/中文，不能直接接拉丁字母或数字。
          // 否则 "Authentication …" / "Brute force …" 这种英文术语表会被当成选项 A、B、C
          // （标点不能做成可选项，否则会误判）
          const m = t.match(new RegExp("^" + String.fromCharCode(letter) + "(?![A-Za-z0-9])\\s*[.、．)]?\\s*(.+)$"));
          if (!m) break;
          kidOpts.push(String.fromCharCode(letter) + ". " + m[1].trim());
          kidEls.push(kids[i]);
          letter++;
        }
      }
      // 选项不是 el 的直接子元素时，往后代里找：
      //   <div class="q"><div>1、题干</div><div class="opts"><span>A、正确</span><span>B、错误</span></div></div>
      // 这里 .opts 是 <div>，本身会被扫到；但选项若是 <li>/<label>/<a> 这类，
      // 只有靠"每个选项各自是某个父元素的最内层元素"才能认出来。
      const findInline = root => {
        const groups = new Map();
        for (const node of root.querySelectorAll("*")) {
          if (!visibleEl(node)) continue;
          const t = textOf(node);
          if (!t || t.length > 200) continue;
          const m = t.match(/^([A-P])(?![A-Za-z0-9])\s*[.、．)]?\s*(\S.*)$/);
          if (!m) continue;
          const p = node.parentElement;
          if (!p) continue;
          if (!groups.has(p)) groups.set(p, []);
          groups.get(p).push({ el: node, letter: m[1], text: m[2].trim() });
        }
        for (const arr of groups.values()) {
          const picked = [];
          let expect = 65;
          for (const it of arr) {
            if (it.letter.charCodeAt(0) !== expect) continue;
            // 子元素也以同一字母开头 → 还能往下钻，点内层才有效
            const re = new RegExp("^" + it.letter + "(?![A-Za-z0-9])\\s*[.、．)]?\\s*\\S");
            if ([...it.el.children].some(c => visibleEl(c) && re.test(textOf(c)))) continue;
            picked.push(it);
            expect++;
          }
          if (picked.length >= 2) {
            return { els: picked.map(x => x.el), texts: picked.map(x => x.letter + ". " + x.text) };
          }
        }
        return null;
      };

      let opts = kidOpts, optEls = kidEls;
      if (opts.length < 2) {
        const inline = findInline(el);
        if (inline) { opts = inline.texts; optEls = inline.els; }
      }
      // 判断题只有 A/B 两个选项，而且「正确/错误」这种两字选项必然过不了平均长度门槛，
      // 所以判断词单独放行；其余仍要求 ≥3 个选项 + 句子级长度 ——
      // 随便一组两项文字列表被当成题目、点下去就不可逆了。
      const judgment = isJudgmentOptions(opts);
      if (opts.length < 2) return;
      if (!judgment && opts.length < 3) return;
      if (!judgment) {
        // 短选项列表（如 A-O 单词词库）不是独立题目，交给词库检测处理
        const avgLen = opts.reduce((s, o) => s + o.length, 0) / opts.length;
        if (avgLen < 15) return;
      }
      // 向前找题干。两条硬规矩，都是为了让题干真正属于这组选项：
      //   ① 遇到「另一组选项列表」就停 —— 那是上一题的地盘，越过它只会把
      //      上一题的题干配到这一题的选项上（张冠李戴）；
      //   ② 窗口里同时出现多段像题干的文字时，归属无法判定 → 整组放弃。
      //      页面结构上「容器里先摆几道题的题干、末尾才放一组选项」与
      //      「题干与选项之间夹了几个广告位」完全同构，只有内容能区分：
      //      夹广告位时像题干的只有 1 段（真题干），摆多道题干时有好几段。
      //      宁可漏（只读面板里照样看得到答案），绝不硬配一个点下去（点错不可逆）。
      const cands = [];
      const pushCand = node => {
        const t = node.textContent.replace(/\s+/g, " ").trim();
        const len = normText(t).length;
        if (len < 4 || len > 300 || parseOptionPool(node)) return;
        // 同一段文字可能被两个来源各收一次（题干元素本身 + 它的父容器），
        // 重复计数会被下面「多段像题干 → 整组放弃」误判成归属不明
        if (cands.some(c => c.t === t)) return;
        cands.push({ t, el: node });
      };
      // ⓪ 题干可能根本不是元素，而是容器里的一段裸文本：
      //    <div class="q">1、<span>【判断】</span>雪天行车……<div>A、正确</div><div>B、错误</div></div>
      //    这时第一个选项元素之前没有任何"题干元素"，同级扫描只会捞到「【判断】」这种
      //    几个字的标签（过不了"像一道题"的闸门）→ 整页一道题都认不出来。
      //    所以把「第一个选项元素之前的全部内容」（裸文本 + 行内标签）也拼成候选。
      //    拼全还有个好处：与文本路径认出来的题干逐字一致，去重时能干净地并成一道。
      //    但**只在"选项之前的那些节点全是行内内容"时才认**：裸文本题干的形状是
      //    `1、<span>【判断】</span>雪天行车……`，前面只有文本节点和行内标签。
      //    如果前面出现块级元素（材料块、广告位、另一道题的题干），那就不是"裸文本题干"，
      //    而是"题干在别的元素里"——这时拼起来会把材料、广告、别题的题干一起吞进题干
      //    （会让阅读材料不再挂 passage、两道题被并成一道、甚至把 3 道题的题干
      //    拼成一段配给一组选项），必须让位给下面按元素逐个收集的候选。
      const INLINE_TAGS = new Set(["A", "SPAN", "B", "I", "EM", "STRONG", "LABEL", "SMALL",
        "SUB", "SUP", "U", "S", "CODE", "FONT", "MARK", "ABBR", "TIME", "CITE", "Q",
        "VAR", "KBD", "SAMP", "DEL", "INS", "BIG", "TT", "BDI", "BDO", "BR", "WBR", "IMG", "SVG"]);
      const pushLead = node => {
        const parent = node.parentElement;
        if (!parent) return;
        let lead = "";
        for (const n of parent.childNodes) {
          if (n === node) break;
          if (n.nodeType !== 3 && !(n.nodeType === 1 && INLINE_TAGS.has(n.tagName))) return;
          lead += n.textContent;
        }
        lead = lead.replace(/\s+/g, " ").trim();
        const len = normText(lead).length;
        if (len < 4 || len > 300) return;
        // 已经收到过同样文字的候选（多半是题干元素本身）→ 保留先收到的那个元素，它更精确
        if (cands.some(c => c.t === lead)) return;
        // 比它更短、且整段包含在它里面的候选（如行内那个「【判断】」标签）只是这段文字的
        // 一个片段，不能当成第二段题干 —— 否则会被「多段像题干」判成归属不明而整组放弃
        for (let i = cands.length - 1; i >= 0; i--) {
          const c = cands[i];
          if (c.t.length < lead.length && lead.indexOf(c.t) >= 0) cands.splice(i, 1);
        }
        cands.push({ t: lead, el: parent });
      };
      // ① 第一个选项之前的同级元素，必要时沿祖先链逐层往外爬：
      //    <div class="q"><div>1、题干</div><div>A、正确</div>…</div>
      //    里题干和选项是兄弟；但选项若被包了一层
      //    （<div class="q"><div>1、题干</div><div class="opts"><span>A、正确</span>…</div></div>），
      //    第一个选项的兄弟里没有题干，得往上爬到 .q 才拿得到。
      {
        let node = optEls[0];
        for (let level = 0; node && node !== el && level < 4; level++) {
          let sib = node.previousElementSibling;
          for (let hop = 0; hop < 8 && sib; hop++) {
            if (looksLikeOptionList(sib) || hasOptionLetters(textOf(sib))) break;
            if (visibleEl(sib)) pushCand(sib);
            sib = sib.previousElementSibling;
          }
          // ⓪ 同级元素扫完再看"第一个选项元素之前的全部内容"：它能把裸文本拼进来，
          //    也能把上面误收的片段（如行内那个「【判断】」标签）并成一段完整题干
          pushLead(node);
          node = node.parentElement;
        }
      }
      // ② 再往外找：选项列表的兄弟、隔几层的中性块
      //    但「上一题的整块」（题干 + 它自己的选项）也是选项列表的兄弟，越过它就会把
      //    上一题的题干配到这一题上。整页判断题（每题一个容器、容器互为兄弟）时，
      //    因为候选里同时有本题题干和上一题整块，会被判成"归属不明"整组放弃。
      //    整块的特征是文本里自带一组 A/B/C 选项字母 —— 见到就停。
      let prev = el.previousElementSibling;
      for (let hop = 0; hop < 8 && prev; hop++) {
        if (looksLikeOptionList(prev)) break;
        if (prev.closest("nav,header,footer,aside")) break;
        if (hasOptionLetters(textOf(prev))) break;
        pushCand(prev);
        prev = prev.previousElementSibling;
      }
      const hard = cands.filter(c => hasHardStemMark(c.t));
      if (hard.length > 1) return;
      // 没有硬标记时退回"像题干"的软判据。这里单独再判一次多段，是因为
      // 「以下/下列」在说明文字、使用条款里也常见，软判据会误放；
      // 硬标记（问号、题号、空括号）才是真正的分水岭。
      const strong = hard.length ? hard : cands.filter(c => looksLikeQuestionStem(c.t));
      if (strong.length > 1) return;
      // 唯一一段像题干的就取它（哪怕隔了几个中性块），否则退回最近的那一段
      const chosen = strong.length === 1 ? strong[0] : cands[0];
      if (!chosen) return;
      const stem = chosen.t, stemEl = chosen.el;
      // 只有两个选项（判断题）时再收一道闸：选项短成这样，页面上任何一组两项列表
      // （「A、首页 B、登录」）都长得一样，得靠内容自己证明这是道题。
      // 「A、正确 / B、错误」本身就是最强的信号 —— 除了判断题没有别的列表长这样。
      const stemOk = looksLikeQuestionStem(stem) || (judgment && normText(stem).length >= 6);
      if (opts.length < 3 && !stemOk) return;
      // 去重按「题干 + 选项」而不是只按选项：判断题每道题的选项文本都一模一样
      // （A. 正确 / B. 错误），只按选项去重的话一页 50 道判断题只会剩下一道。
      const key = normText(stem + "||" + opts.join("|"));
      if (seen.has(key)) return;
      seen.add(key);
      const numM = stem.match(/^\s*第?\s*(\d{1,3})\s*(?:空)?\s*[.、．)]?/);
      // optEls：第 i 个选项对应的 DOM 元素。识别时已经逐个比对过字母前缀，直接留引用，
      // 填涂阶段照索引点，不用再按文本去满页面找（那样容易点到无关元素）
      const q = { stem, options: opts, el: stemEl || el, optEls: optEls };
      if (numM && normText(stem).length <= 8) {
        // 纯编号题干 → 完形填空
        q.clozeNum = parseInt(numM[1]);
        q.stem = `第 ${q.clozeNum} 空（完形填空）`;
      } else if (numM) {
        q.num = parseInt(numM[1]);
      }
      out.push(q);
    });
    return out;
  }

  // 学习通（超星）随堂练习/作业/章节测验的专用适配。
  //
  // 结构（2026 新版）：
  //   <div class="singleQuesId" data="...">
  //     <div class="font-cxsecret">1.[单选题] 题干…</div>
  //     <div class="stem_answer">
  //       <div class="answerBg"><span class="num_option" data="A">A</span>
  //         <span class="answer_p">选项文字</span></div>…
  //
  // 选项不是 radio；选中态由点击 .answerBg 后的 .checkanswer/.checkanswerdx 维护。
  // 通用规则要求「字母和文字在同一个元素的 textContent 里」，而这里字母与文字
  // 分处两个 span，且选项文字常以英文开头（select… / ORDER BY…），通用规则配不上。
  // 学习通简答题的正文在 UEditor 的同源 iframe 里（body[contenteditable]），
  // 旁边的 textarea 是 display:none，提交时才由 UEditor 回写。
  // 页面上常残留 0×0 的重复 editor 实例，必须按实际尺寸挑可见的那个。
  function findUeditorIn(box) {
    for (const frame of box.querySelectorAll('iframe[id^="ueditor_"], .edui-editor iframe')) {
      if (!visibleEl(frame)) continue;
      const r = frame.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      let doc = null;
      try { doc = frame.contentDocument; } catch (_) { continue; }
      if (!doc) continue;
      const body = doc.querySelector('body[contenteditable="true"], [contenteditable="true"]');
      if (!body) continue;
      const textarea = box.querySelector('textarea[id^="answer"], textarea[name^="answer"]');
      return { frame, body, textarea };
    }
    return null;
  }

  // 老版 .questionLi + .Zy_ulTop li 也一并收，原生 radio 仍交给 inputs 路径。
  function scanChaoxing() {
    const out = [];
    const boxes = [...rootDoc().querySelectorAll(
      "div.singleQuesId, div.questionLi, div.TiMu, div.question-item, div.top-question")];
    for (const box of boxes) {
      if (!visibleEl(box) || scanPanel?.contains(box)) continue;
      // 只认"单题容器"。外层套着多道题的 .question-item/.top-question 直接跳过，
      // 否则会把整页题干拼成一道题、再配给第一组选项（点错不可逆）。
      if (box.querySelector(".singleQuesId, .questionLi, .TiMu, .question-item, .top-question")) continue;
      const stemEl = box.querySelector(".font-cxsecret, .mark_name, .mark_title, .question-name, .Zy_TItle .clearfix, .Zy_TItle");
      const cxOptions = !!box.querySelector(
        ".answerBg, .num_option, .numoption, .num_optiondx, .numoptiondx, .Zy_ulTop, .option-list");
      // .question-item/.top-question 是很常见的通用类名：没有学习通专属选项结构时不接，
      // 交给通用扫描器，避免在普通问卷/文章页上误判。
      const knownCx = /(^|\s)(singleQuesId|questionLi|TiMu)(\s|$)/.test(String(box.className || ""));
      const ueditor = !!box.querySelector('iframe[id^="ueditor_"]');
      if (!knownCx && !cxOptions && !ueditor) continue;
      let stem = stemEl ? stemEl.textContent : "";
      if (!normText(stem)) {
        // 新随堂练习没有单独题干元素：从容器文本里排除选项/输入框后取剩余部分
        const exclude = [...box.querySelectorAll(
          ".answerBg, .stem_answer, .Zy_ulTop li, .num_option, .numoption, input, textarea, button")];
        stem = extractStemText(box, exclude);
      }
      stem = stem.replace(/\s+/g, " ").trim();
      if (!stem || normText(stem).length < 4) continue;

      let rows = [...box.querySelectorAll(".answerBg")]
        .filter(r => r.querySelector(".num_option, .numoption, .num_optiondx, .numoptiondx"));
      if (!rows.length) {
        const direct = [...box.querySelectorAll(".Zy_ulTop > li")];
        rows = (direct.length ? direct : [...box.querySelectorAll(".Zy_ulTop li")])
          .filter(li => visibleEl(li));
      }
      if (!rows.length) {
        // 2026 新版考试：选项是 ul.option-list > li，字母/文字在 .option-letter/.option-result。
        rows = [...box.querySelectorAll(".option-list > li")].filter(li => visibleEl(li));
      }
      if (!rows.length) {
        // 新版考试：选项行没有 .answerBg/.Zy_ulTop 外壳，字母仍在 span.num_option，
        // 可点的就是它的父元素（LangHY/chaoxing-exam 的 click span.parentElement）。
        // 每个父元素只能含一个字母，避免把整块选项容器当成一行。
        const numSel = ".num_option, .numoption, .num_optiondx, .numoptiondx";
        const parents = [];
        for (const num of box.querySelectorAll(numSel)) {
          if (!visibleEl(num)) continue;
          const p = num.parentElement;
          if (!p || p === box) continue;
          if (p.querySelectorAll(numSel).length !== 1) continue;
          if (!parents.includes(p)) parents.push(p);
        }
        if (parents.length >= 2) rows = parents;
      }

      const options = [], optEls = [], inputs = [];
      let ok = rows.length >= 2;
      for (let i = 0; ok && i < rows.length; i++) {
        const row = rows[i];
        if (!visibleEl(row)) { ok = false; break; }
        const num = row.querySelector(".num_option, .numoption, .num_optiondx, .numoptiondx, .option-letter");
        let labelEl = num || null;
        let letter = num ? String(num.textContent || num.getAttribute("data") || "").trim() : "";
        if (!letter) {
          // 老版把字母放在独立的 <i>/<em> 里（<li><i>A</i><a>ORDER BY …</a></li>）
          labelEl = [...row.querySelectorAll("i, em, b")].find(n => /^[A-H]$/.test(n.textContent.trim())) || null;
          if (labelEl) letter = labelEl.textContent.trim();
        }
        letter = letter.replace(/[.、．)]/g, "").toUpperCase();
        if (!/^[A-H]$/.test(letter)) letter = String.fromCharCode(65 + i);
        const textEl = row.querySelector(".answer_p, .answer_content, .answerCon, .answerText, .option-result");
        let text = (textEl ? textEl.textContent : row.textContent).replace(/\s+/g, " ").trim();
        // .answer_p 只装选项正文，不含 A/B/C 标签，不能剥首字母（"ASC…" / "Apple…" 会被剥坏）。
        // 只有取整行 textContent（标签 + 正文拼在一起）时才剥。没有独立标签元素时
        // 必须见到分隔符（"A. Apple"）才剥 —— 否则 "Apple" 会被剥成 "pple"。
        if (!textEl) {
          const sep = labelEl ? "[.、．)]?" : "[.、．)]";
          text = text.replace(new RegExp("^\\s*" + letter + "\\s*" + sep + "\\s*"), "").trim();
        }
        if (!text || text.length > 500) { ok = false; break; }
        options.push(letter + ". " + text);
        const input = row.querySelector("input[type=radio],input[type=checkbox]");
        inputs.push(input || null);
        // 有原生 input 且整组都有 → 走 inputs；否则（新版无 input / 结构混杂）
        // 点击选项容器本身（.answerBg 或 li），不能留 null 让那一项被跳过。
        optEls.push(row.closest(".answerBg") || row);
      }
      if (!ok) rows = [];

      const numM = stem.match(/^\s*第?\s*(\d{1,3})\s*(?:题)?\s*[.、．)]/);
      const multi = /\b(multiple|checkbox)\b/i.test(String(box.className || "")) || /\[多选题\]/.test(stem);
      const base = {
        generic: true,
        stemText: stem,
        stem,
        el: box,
        imageCount: countQuestionImages(box),
        ...(multi ? { multi: true } : {}),
        ...(numM ? { num: parseInt(numM[1]) } : {})
      };

      if (rows.length >= 2 && options.length === rows.length) {
        const hasInputs = inputs.every(Boolean);
        out.push({
          ...base,
          byOptionList: !hasInputs,
          stemIsQuestion: stemOkForClick(stem, options),
          inputs: hasInputs ? inputs : [],
          options,
          optionTexts: options,
          ...(hasInputs ? {} : { optEls })
        });
        continue;
      }

      // 填空/简答：容器里的文本框（排除 radio/checkbox/hidden 等）
      const blanks = [...box.querySelectorAll("textarea, input")].filter(el => {
        if (!visibleEl(el) || el.disabled || el.readOnly) return false;
        const t = String(el.getAttribute("type") || "text").toLowerCase();
        return t === "text" || t === "number" || t === "search" || t === "tel" || t === "email";
      });
      if (blanks.length) {
        out.push({
          ...base,
          fillText: true,
          inputs: [],
          options: [],
          optionTexts: [],
          blankInputs: blanks
        });
        continue;
      }

      // UEditor 简答：可见 iframe 的 contenteditable body 才是真正的作答区。
      const ue = findUeditorIn(box);
      if (ue) {
        out.push({
          ...base,
          fillText: true,
          freeText: true,
          freeTextKind: "essay",
          inputs: [],
          options: [],
          optionTexts: [],
          blankInputs: [ue.body],
          blankSyncTargets: ue.textarea ? [ue.textarea] : []
        });
      }
    }
    return out;
  }

  // 空格类题目的材料 = 所在文章全文：
  // 沿祖先向上，取"300~3000 字范围内最大"的容器（文章整体而非单个段落碎片）
  function findClozeMaterial(el) {
    let node = el;
    let best = null;
    for (let i = 0; i < 10 && node; i++) {
      node = node.parentElement;
      if (!node || isDocRoot(node)) break;
      const n = normText(node.textContent).length;
      if (n >= 300 && n <= 3000) best = node;   // 不断更新为更大的合格容器
      else if (n > 3000) break;                 // 碰到页面级大容器就停
    }
    if (!best) return null;
    const t = best.textContent.replace(/\s+/g, " ").trim();
    const n = normText(t);
    return n.length > 3000 ? t.slice(0, 3000) + "…(材料已截断)" : t;
  }

  // 词库检测：四六级选词填空的 A-O 单词库（连续字母标记 + 每项是短词）
  function parseWordBank(el) {
    // 优先按子元素逐个解析：JS 渲染的网格 textContent 无空白分隔，整段解析会粘在一起
    const kids = [...el.children]
      .map(c => c.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (kids.length >= 8 && kids.length <= 26) {
      let ok = true;
      const opts = kids.map((t, i) => {
        const m = t.match(new RegExp("^" + String.fromCharCode(65 + i) + "\\s*[).、．]\\s*(.+)$"));
        if (!m) { ok = false; return ""; }
        return String.fromCharCode(65 + i) + ". " + m[1].trim();
      });
      if (ok && !opts.some(o => o.length < 4 || o.length > 40)) return opts;
    }
    // 回退：整段文本解析（字母前只要不是英文字母即可，应对 textContent 粘连）
    const text = el.textContent.replace(/\s+/g, " ").trim();
    const re = /(?<![A-Za-z])([A-P])\s*[).、．]\s*/g;
    let m;
    const marks = [];
    while ((m = re.exec(text))) marks.push({ letter: m[1], start: m.index, end: re.lastIndex });
    if (marks.length < 8) return null;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].letter.charCodeAt(0) !== 65 + i) return null;
    }
    const opts = marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      return mk.letter + ". " + text.slice(mk.end, end).trim();
    });
    if (opts.some(o => o.length < 4 || o.length > 40)) return null;
    return opts;
  }

  function findWordBankNear(el) {
    let node = el;
    for (let level = 0; level < 8 && node && !isDocRoot(node); level++) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib === node || sib.contains(node) || node.contains(sib)) continue;
        if (!visibleEl(sib)) continue;
        const bank = parseWordBank(sib);
        if (bank) return bank;
      }
      node = parent;
    }
    // 就近找不到 → 全页兜底（词库网格常和文章分处不同容器）。
    // 用元素自己文档的 querySelectorAll：元素可能在同源 iframe 里。
    let found = null;
    (el.ownerDocument || document).querySelectorAll("div,ul,section,td").forEach(el2 => {
      if (found || !visibleEl(el2) || scanPanel?.contains(el2)) return;
      if (el2.children.length > 40) return;
      const bank = parseWordBank(el2);
      if (bank) found = bank;
    });
    return found;
  }

  // 策略4：文中空格位 —— "__26__"、"（26）" 这类元素本身就是一道题（选词填空/完形填空）
  function scanBlanks() {
    const out = [];
    const seen = new Set();
    rootDoc().querySelectorAll("span,div,p,b,em,i,input").forEach(el => {
      if (!visibleEl(el) || scanPanel?.contains(el)) return;
      let t = (el.tagName === "INPUT" ? (el.value || el.placeholder || "") : el.textContent).trim();
      if (!t || t.length > 12) return;
      let m = t.match(/^_{2,}\s*(\d{1,3})\s*_{2,}$/) || t.match(/^[（(]\s*(\d{1,3})\s*[)）]$/);
      if (!m && el.tagName === "INPUT" && /^(text)?$/i.test(el.type || "")) {
        m = (el.name || el.id || "").match(/^(\d{1,3})$/);
      }
      if (!m) return;
      const num = parseInt(m[1]);
      if (num < 1 || num > 200) return;
      if (seen.has(num)) return;
      seen.add(num);
      out.push({ stem: `第 ${num} 空（选词填空）`, options: [], clozeNum: num, el });
    });
    return out;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ================= 截图解题：框选区域 → 截图 → 多模态 AI =================
  let selOverlay = null, selBox = null, resultPanel = null, lastRect = null, selStart = null;
  let resultToken = 0;
  // 每次框选一个自增号；后台的每条进度/结果都原样带回，页面只认**当前这一次**的号。
  // 没有它的话：连点两次 📷，两次回复会互相盖在同一个窗里（读起来像当前题的答案，
  // 其实是上一张图的），而关掉窗口后迟到的回复还能把窗重新建出来。
  let shotSeq = 0, activeShot = 0;
  // 截屏期间把插件自己的界面藏起来，收到第一条回复再恢复（见 hideOwnUIForShot）
  let shotRestore = null;
  // 截图解题的"看门狗"：不是"总共 30 秒"，而是"30 秒没动静"。
  //
  // 后台给视觉模型的预算是 60 秒（普通）/ 120 秒（background.js 的 postChat timeoutMs），
  // 如果用一个固定的 30 秒总闸门，模型 30~60 秒之间正常返回时，
  // 用户会先看到「⏰ 超时（30 秒）」，几秒后答案才姗姗来迟地盖上去。
  // 进度消息的 ok 是 null，而 resultToken 只在 ok===true||false 时自增，
  // 所以**持续推进度也拦不住总闸门**。
  //
  // 每收到一条进度/结果就重置计时；只有"整整 30 秒毫无音讯"才算真超时。
  // 这样既不会误报慢模型，又能在后台真的卡死时给出提示。
  const VISION_IDLE_MS = 30000;
  let visionWatchdog = null;
  let resultTitle = null, resultBody = null, resultCopyBtn = null, currentResultText = "";

  // 截屏前把**插件自己的界面**藏起来：扫描面板里列着上一批答案、结果窗里写着上一次的
  // 答案与解析。框选只要盖到它们，captureVisibleTab 截到的就是我们自己列出的答案，
  // 模型照着抄一遍再"答对"给你看 —— 用户完全看不出这条链路已经废了。
  // 返回一个 restore；收到第一条后台回复时调用，另有兜底定时器，绝不会一直藏着。
  function hideOwnUIForShot() {
    const nodes = [...document.querySelectorAll(
      ".aa-panel,.aa-ball,.aa-result,.aa-toast,.aa-consent")].filter(n => n && n.style);
    const saved = nodes.map(n => ({ n, v: n.style.visibility }));
    nodes.forEach(n => { n.style.visibility = "hidden"; });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      saved.forEach(s => { try { s.n.style.visibility = s.v; } catch (_) {} });
    };
  }

  function startSelectMode() {
    cleanupSelect();
    selOverlay = document.createElement("div");
    selOverlay.className = "aa-overlay";
    const tip = document.createElement("div");
    tip.className = "aa-tip";
    tip.textContent = "拖拽框选题目区域  |  ESC 取消";
    selOverlay.appendChild(tip);
    selBox = document.createElement("div");
    selBox.className = "aa-selbox";
    selOverlay.appendChild(selBox);

    selOverlay.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      selStart = { x: e.clientX, y: e.clientY };
      Object.assign(selBox.style, {
        display: "block", left: e.clientX + "px", top: e.clientY + "px", width: "0", height: "0"
      });
    });
    selOverlay.addEventListener("mousemove", e => {
      if (!selStart) return;
      Object.assign(selBox.style, {
        left: Math.min(selStart.x, e.clientX) + "px",
        top: Math.min(selStart.y, e.clientY) + "px",
        width: Math.abs(e.clientX - selStart.x) + "px",
        height: Math.abs(e.clientY - selStart.y) + "px"
      });
    });
    selOverlay.addEventListener("mouseup", e => {
      if (!selStart) return;
      const rect = {
        left: Math.min(selStart.x, e.clientX), top: Math.min(selStart.y, e.clientY),
        width: Math.abs(e.clientX - selStart.x), height: Math.abs(e.clientY - selStart.y)
      };
      const hadSel = rect.width >= 15 && rect.height >= 15;
      cleanupSelect();
      if (!hadSel) return;
      lastRect = rect;
      showAnswerResult({ ok: null, text: "⏳ 识别中，请稍候…" });

      // 发送失败直接可见；"30 秒没有任何动静"才提示超时。
      // 注意是**空闲**超时不是**总时长**超时：后台每推一条进度（已截屏/已裁剪/请求中）
      // 就会重置这个计时器，所以慢模型不会误报，只有后台真卡住时才会弹。
      const token = ++resultToken;
      armVisionWatchdog(token, VISION_IDLE_MS);
      const shotId = ++shotSeq;          // 这次框选的编号（后台回复会原样带回）
      activeShot = shotId;
      // 先把自家界面藏起来再让后台截屏（后台是收到消息后才 captureVisibleTab 的）
      if (shotRestore) { try { shotRestore(); } catch (_) {} }
      shotRestore = hideOwnUIForShot();
      setTimeout(() => {                        // 兜底：万一一条回复都没到，也不能一直藏着
        if (shotRestore) { const r = shotRestore; shotRestore = null; r(); }
      }, 15000);
      chrome.runtime.sendMessage({ type: "REGION_SELECTED", rect, vw: window.innerWidth, shotId })
        .catch(e => {
          if (shotRestore) { const r = shotRestore; shotRestore = null; r(); }
          showAnswerResult({ shotId, ok: false, text: "❌ 消息发送失败：" + e.message + "\n请到 edge://extensions 刷新插件后重试。" });
        });
    });
    document.documentElement.appendChild(selOverlay);
  }

  function cleanupSelect() {
    selOverlay?.remove();
    selOverlay = null; selBox = null; selStart = null;
  }

  // ESC 兜底清理：框选遮罩 / 扫描面板 / 答案浮窗 / 悬浮球 / 自动作答日志面板
  // （ESC 分支会调用它；缺了会直接抛 ReferenceError，面板关不掉）
  function cleanupAll() {
    cleanupSelect();
    // 关掉浮窗时要一并撤掉看门狗，否则 30 秒后会在一个已经关闭的浮窗上弹超时
    if (visionWatchdog) { clearTimeout(visionWatchdog); visionWatchdog = null; }
    // 只写 `running = false` 是**假停**：run() 还卡在 waitOrStop(间隔)
    // 或一个在飞的 AI 请求上（后台超时 60/120 秒），用户以为 ESC 之后它停了，
    // 其实还要等接口慢慢返回，期间白占一个请求。stopRun 才会唤醒等待者 + 通知后台掐断。
    if (running || paused) stopRun("已按 ESC 关闭面板");
    // 面板自己的「出答案 / 填涂」是另一套停止标志，同样要收掉
    if (scanPanelApi.stopPanelTasks) { try { scanPanelApi.stopPanelTasks(); } catch (_) {} }
    if (scanPanel) { scanPanel.remove(); scanPanel = null; }
    if (resultPanel) { resultPanel.remove(); resultPanel = null; }
    activeShot = 0;   // 一并作废这次框选：否则 ESC 关掉之后迟到的回复还能把窗建回来
    document.querySelectorAll(".aa-ball").forEach(b => b.remove());
    runLogBox = null;
  }

  // 重置"没有动静"的看门狗。每收到一条后台消息（进度或最终结果）都要调一次：
  // 进度消息说明后台还活着、还在干活，不能因为"总耗时超过 30 秒"就判它超时。
  function armVisionWatchdog(token, ms) {
    if (visionWatchdog) { clearTimeout(visionWatchdog); visionWatchdog = null; }
    visionWatchdog = setTimeout(() => {
      visionWatchdog = null;
      if (token !== resultToken) return;   // 已有更新的请求或已出结果，作废
      showAnswerResult({
        ok: false,
        text: "⏰ 超时（30 秒没有任何响应）未收到结果。\n\n" +
              "后台一直在等接口返回，但期间没有收到任何进度。请检查：\n" +
              "1) 插件弹窗里的 API 配置是否保存；\n" +
              "2) 视觉模型名是否正确（纯文本模型看不了图）；\n" +
              "3) 网络能否访问该 Base URL。\n" +
              "若反复出现，请刷新页面或重新加载扩展后再试。"
      });
    }, ms);
  }

  function showAnswerResult(msg) {
    // 只渲染**当前这次框选**的回复：带 shotId 的（后台每一条都带）若与当前编号不符，
    // 说明是上一次框选的迟到回复、或窗口已被用户关掉（activeShot 归零）→ 整个丢掉，
    // 既不覆盖新答案，也不会把刚关掉的窗重新建出来。本地自己调用的不带 shotId，放行。
    if (msg && msg.shotId !== undefined && msg.shotId !== activeShot) return;
    // 后台一来有回复（进度或结果），说明截屏早就完成了 → 立刻把自家界面放回来
    if (shotRestore) { const r = shotRestore; shotRestore = null; r(); }
    // 收到最终结果：作废看门狗（用自增 token 让在飞的定时器失效）
    if (msg.ok === true || msg.ok === false) {
      resultToken++;
      if (visionWatchdog) { clearTimeout(visionWatchdog); visionWatchdog = null; }
    } else if (visionWatchdog) {
      // 进度消息：后台还活着，把"没有动静"的计时重新起算
      armVisionWatchdog(resultToken, VISION_IDLE_MS);
    }
    ensureResultPanel();
    currentResultText = msg.text || "";
    if (msg.ok === null || msg.ok === undefined) {
      resultTitle.textContent = "⏳ 识别中";
      resultTitle.style.color = "var(--c-accent)";
    } else if (msg.ok) {
      resultTitle.textContent = "📖 AI 答案";
      resultTitle.style.color = "var(--c-sky)";
    } else {
      resultTitle.textContent = "❌ 出错了";
      resultTitle.style.color = "var(--c-danger)";
    }
    resultBody.textContent = currentResultText;
    resultCopyBtn.style.display = msg.ok === true ? "" : "none";
  }

  // 结果浮窗只创建一次，之后只更新内容——这样用户拖动/缩放的位置在进度刷新时不会丢
  function ensureResultPanel() {
    if (resultPanel) return;
    ensurePanelStyles();
    resultPanel = document.createElement("div");
    resultPanel.className = "aa-result";
    if (lastRect) {
      resultPanel.style.left = Math.max(8, Math.min(lastRect.left + lastRect.width + 12, window.innerWidth - 336)) + "px";
      resultPanel.style.top = Math.max(8, Math.min(lastRect.top, window.innerHeight - 180)) + "px";
    } else {
      resultPanel.style.right = "16px";
      resultPanel.style.top = "16px";
    }

    resultTitle = document.createElement("div");
    resultTitle.className = "aa-result-title";
    resultTitle.textContent = "📖 AI 答案";
    resultBody = document.createElement("div");
    resultBody.className = "aa-result-body";

    const btns = document.createElement("div");
    btns.style.cssText = "margin-top:8px;display:flex;gap:6px";
    resultCopyBtn = mkScanBtn("复制", "aa-btn-soft", async () => {
      // 不 await 也不 catch 的话：窗口没聚焦时 writeText 的 promise 会被拒，
      // 标签照样翻成"已复制"；而 http://（非 localhost）页面上 navigator.clipboard
      // 干脆是 undefined，点一下只抛异常，看着像按钮坏了。
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(currentResultText);
          ok = true;
        }
      } catch (_) { ok = false; }
      try {
        resultCopyBtn.textContent = ok ? "已复制" : "复制失败，请手动选中文字";
        setTimeout(() => { try { resultCopyBtn.textContent = "复制"; } catch (_) {} }, ok ? 1200 : 5000);
      } catch (_) {}
    });
    btns.append(resultCopyBtn, mkScanBtn("关闭", "aa-btn-muted", () => {
      // 关闭要一并**作废这次框选**：只 remove DOM 的话，后台迟到的进度/结果
      // 或那个空闲看门狗会调 showAnswerResult → ensureResultPanel 把窗重新建回来，
      // 用户刚关掉的东西过一会儿带着旧答案又盖在页面上。
      activeShot = 0;
      resultToken++;
      if (visionWatchdog) { clearTimeout(visionWatchdog); visionWatchdog = null; }
      resultPanel.remove();
      resultPanel = null;
    }));

    resultPanel.append(resultTitle, resultBody, btns);
    document.documentElement.appendChild(resultPanel);

    // 标题栏拖动 + 右下角缩放
    makeDraggable(resultTitle, resultPanel);
    makeResizable(resultPanel);
  }

  // ESC：正在框选时只取消框选，否则关闭面板。
  //
  // 焦点在页面可编辑控件里时**不抢**这个键：在搜索框/富文本里按 ESC 取消下拉、
  // 退出全屏是用户的正常操作，抢这个键会把正在跑的自动作答连同面板一起掐掉
  // （面板没了、日志也看不见了，页面却还在被填，用户完全不知道发生了什么）。
  // 只有"焦点不在输入处"或"按的是插件自己面板里的元素"时才当作全局关闭。
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const tg = e.target;
    if (tg && typeof tg.closest === "function" && !tg.closest(".aa-panel") && !tg.closest(".aa-result") &&
        tg.closest("input, textarea, select, [contenteditable], [role=textbox]")) {
      return;
    }
    if (selOverlay) cleanupSelect();
    else cleanupAll();
  });
})();
