/**
 * 判断题（A、正确 / B、错误）识别 + 自动填涂 —— 回归测试。
 *
 * 背景：真实驾考站点的判断题只有 A/B 两个选项，而且题干和选项常常是同一个容器里的
 * 兄弟节点：
 *
 *     <div class="q">
 *       <div>1、【判断】雪天行车……</div>
 *       <div>A、正确</div>
 *       <div>B、错误</div>
 *     </div>
 *
 * 旧代码有三道门槛把它全部挡掉，表现是「面板能列出 50 题，但一道都填不了」：
 *   ① 选项必须从第 0 个子元素开始编号（A 不是第一个孩子 → opts.length = 0）；
 *   ② opts.length < 3 return + 平均长度 < 15 return ——「正确/错误」两字选项必然过不了；
 *   ③ 去重只按选项文本 —— 一页判断题选项全一样，只会剩下一道。
 *
 * 修复后仍要防住反向风险：页面上任何一组「A、首页 / B、登录」也是两个选项，
 * 不能因为放行判断题就顺手点掉。所以本测试两侧都钉：
 *
 *   1 真实站点式布局（题干+选项同容器、多道题互为兄弟）→ 全部识别、全部点对
 *   2 选项在 <ul> 里、题干是 <ul> 的前兄弟            → 也要认出来
 *   3 两项的非判断题列表（导航「A、首页 B、登录」）    → 一道都不许点，走只读降级
 *   4 判断题题干没有问号（「1、雪天行车……」）         → 仍要点
 *   5 判断题与四项选择题同页 → 各点各的，互不串
 *   6 照用户截图那一页的规模：50 道判断题同页，用真实题库跑 mode:"bank"，
 *     逐题断言「点的是自己那一个选项」（答案 A/B 混排，全点 A 蒙不过去）
 *   7 题干是「裸文本 + 行内标签」（`1、<span>【判断】</span>雪天行车……`）→ 也要认出来
 *
 * 全程另外钉两条：点击必须落在 A/B 选项元素上，绝不能落到题干那一段
 * （optEls 起点偏移 bug 的直接表现）；每道题都要发出自己的 prompt
 * （去重若只按选项文本，一页判断题只会剩一道）。
 *
 * 两个阶段各开一张新页面：自动填涂路径与面板「填涂」共用同一个 filledEls 集合，
 * 同页先跑自动再点面板会被判成「已经填过，跳过」，所以必须分开跑。
 *
 * 判定口径与 mis-pair-test 一致：捕获阶段全局 click 记 data-blk。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();
const fs = require("fs");
const path = require("path");

const PORT = 8103;

const CLICK_HOOK = `
  window.__clicked = [];
  document.addEventListener("click", e => {
    const t = e.target;
    // 面板自己的按钮（「填涂」等）不算填涂落点，过滤掉
    if (t.closest && t.closest(".aa-panel")) return;
    const blkEl = t.closest ? t.closest("[data-blk]") : null;
    window.__clicked.push({
      tag: t.tagName || "?",
      text: (t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      blk: blkEl ? blkEl.getAttribute("data-blk") : "(无区块)"
    });
  }, true);
`;

const page = body => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>judgment</title></head>
<body>${body}</body></html>`;

// 真实题库里的判断题（01_jiakao_car.json / 03_jiakao_truck.json，answer=[0] 即「正确」）
const STEMS = [
  "1、【判断】雪天行车，由于路面湿滑，车轮附着力减小，因此应当加大两车之间的安全距离。",
  "2、【判断】驾驶机动车在高速公路上违法占用应急车道行驶的一次记6分。",
  "3、【判断】机动车驾驶人补领机动车驾驶证后，原机动车驾驶证作废。",
  "4、【判断】对未取得驾驶证驾驶机动车的，追究其法律责任。",
  "5、【判断】造成交通事故后逃逸且构成犯罪的驾驶人，将吊销驾驶证且终生不得重新取得驾驶证。"
];

// 场景 1：真实站点式布局 —— 每题一个容器，容器互为兄弟
const REAL_LAYOUT = STEMS.map((s, i) => `
  <div class="q" data-blk="Q${i + 1}">
    <div class="qt" data-blk="Q${i + 1}-stem">${s}</div>
    <div class="opt" data-blk="Q${i + 1}-A">A、正确</div>
    <div class="opt" data-blk="Q${i + 1}-B">B、错误</div>
  </div>`).join("\n");

// ---- 场景 6：照用户截图那一页的规模（50 道判断题）来一遍，题目与答案都取真实题库 ----
// 用 mode:"bank" 走完整管线：识别 → 题库匹配 → 按答案点对应选项。
// 这样"每道题都点对了自己那一个选项"就是**逐题**断言 —— 去重若把选项相同的题并成一道，
// 只会剩 1 道被填，50 条断言立刻会红。
const BANK_SRC = path.join(__dirname, "..", "..", "extension", "bank", "01_jiakao_car.json");
const BANK_ALL = JSON.parse(fs.readFileSync(BANK_SRC, "utf8")).questions;
// 取 50 道判断题：按固定步长铺开，保证 A/B 两种答案都出现（否则"全点 A"也能蒙对）
const JUDGE_ALL = BANK_ALL.filter(q => q.type === "judge" && (q.options || []).length === 2);
const STEP = Math.floor(JUDGE_ALL.length / 50);
const PICK = [];
for (let i = 0; i < 50; i++) PICK.push(JUDGE_ALL[i * STEP]);
const BANK_MINI = { category: "测试·判断题", count: PICK.length, questions: PICK };
const BANK_INDEX = [{ file: "judge50.json", label: "测试·判断题", count: PICK.length }];
const ANSWER_MIX = { A: PICK.filter(q => q.answer[0] === 0).length, B: PICK.filter(q => q.answer[0] === 1).length };

const FIFTY_LAYOUT = PICK.map((q, i) => `
  <div class="q" data-blk="Q${i + 1}">
    <div class="qt" data-blk="Q${i + 1}-stem">${i + 1}、【判断】${q.question}</div>
    <div class="opt" data-blk="Q${i + 1}-A">A、正确</div>
    <div class="opt" data-blk="Q${i + 1}-B">B、错误</div>
  </div>`).join("\n");

// 每道题该点哪个选项 —— 由题库答案决定，不是"全都 A"
const FIFTY_EXPECT = PICK.map((q, i) => `Q${i + 1}-${q.answer[0] === 0 ? "A" : "B"}`);

// 场景 7：用户那一页的真实形状 —— 题干是「裸文本 + 行内标签」：
//   <div class="q">1、<span class="tag">【判断】</span>雪天行车……<div>A、正确</div><div>B、错误</div></div>
// 题干**不是元素**，第一个选项元素之前只有一个 4 个字的「【判断】」标签。
// 元素级题干搜索只会捞到这个标签（过不了"像一道题"的闸门）→ 整页一道都认不出来。
// 只有把"第一个选项之前的全部内容"拼起来当题干才认得出。
const BARE_TEXT_LAYOUT = STEMS.map((s, i) => {
  const m = s.match(/^(\d+、)(【判断】)([\s\S]*)$/);
  return `
  <div class="q" data-blk="Q${i + 1}">
    ${m[1]}<span class="tag">${m[2]}</span>${m[3]}
    <div class="opt" data-blk="Q${i + 1}-A">A、正确</div>
    <div class="opt" data-blk="Q${i + 1}-B">B、错误</div>
  </div>`;
}).join("\n");

const SPECS = [
  {
    path: "/1-real-layout.html",
    title: "1 真实站点布局（题干+选项同容器 × 5 道）→ 5 道全部识别并点对",
    expect: ["Q1-A", "Q2-A", "Q3-A", "Q4-A", "Q5-A"],
    mustFill: 5,
    stemRe: /雪天行车|应急车道|驾驶证|法律责任|交通事故/,
    html: page(`<div class="qlist" data-blk="list">${REAL_LAYOUT}</div>`),
    custom(ctx) {
      // 每道题都必须发出自己的 prompt —— 去重若只按选项，5 道会只剩 1 道
      const uniq = new Set(ctx.prompts.map(p => (p.match(/【判断】[^\n]*/) || [""])[0]));
      return [
        ["[1] 5 道判断题各发一次 prompt（去重没把选项相同的题吞掉）", ctx.prompts.length === 5, ctx.prompts.length],
        ["[1] 5 个 prompt 的题干互不相同", uniq.size === 5, [...uniq]],
      ];
    },
  },

  {
    path: "/2-ul-layout.html",
    title: "2 选项在 <ul> 里、题干是前兄弟 → 也要认出来",
    expect: ["Q1-A"],
    mustFill: 1,
    stemRe: /雪天行车/,
    html: page(`
      <div class="q" data-blk="Q1">
        <div class="qt" data-blk="Q1-stem">1、【判断】雪天行车，由于路面湿滑，车轮附着力减小，因此应当加大两车之间的安全距离。</div>
        <ul class="opts" data-blk="Q1-opts">
          <li data-blk="Q1-A">A、正确</li>
          <li data-blk="Q1-B">B、错误</li>
        </ul>
      </div>`),
  },

  {
    path: "/3-two-item-nav.html",
    title: "3 两项的非判断题列表（导航「A、首页 B、登录」）→ 一道都不许点",
    expect: [],
    mustFill: 0,
    readOnly: true,
    html: page(`
      <div class="topbar" data-blk="nav">
        <div data-blk="NAV-A">A、首页</div>
        <div data-blk="NAV-B">B、登录</div>
      </div>
      <div class="tips">请先登录后继续。</div>`),
  },

  {
    path: "/4-no-question-mark.html",
    title: "4 题干没有问号（判断题常见）→ 仍要点",
    expect: ["Q1-A"],
    mustFill: 1,
    stemRe: /雪天行车/,
    // 「1、雪天行车……」不含问号、不含「下列/以下」，靠 isJudgmentOptions 放行
    html: page(`
      <div class="q" data-blk="Q1">
        <div class="qt" data-blk="Q1-stem">1、雪天行车由于路面湿滑，车轮附着力减小，因此应当加大两车之间的安全距离。</div>
        <div class="opt" data-blk="Q1-A">A、正确</div>
        <div class="opt" data-blk="Q1-B">B、错误</div>
      </div>`),
  },

  {
    path: "/5-mixed.html",
    title: "5 判断题与四项选择题同页 → 各点各的，互不串",
    expect: ["Q1-A", "Q2-C"],
    mustFill: 2,
    stemRe: /雪天行车|编程语言/,
    rules: [["下列哪一个是编程语言", "C"], ["判断", "A"]],
    html: page(`
      <div class="qlist">
        <div class="q" data-blk="Q1">
          <div class="qt" data-blk="Q1-stem">1、【判断】雪天行车，由于路面湿滑，车轮附着力减小，因此应当加大两车之间的安全距离。</div>
          <div class="opt" data-blk="Q1-A">A、正确</div>
          <div class="opt" data-blk="Q1-B">B、错误</div>
        </div>
        <div class="q" data-blk="Q2">
          <div class="qt" data-blk="Q2-stem">2、下列哪一个是编程语言？</div>
          <div class="opt" data-blk="Q2-A">A、HTML 是一种用于描述网页结构的标记语言</div>
          <div class="opt" data-blk="Q2-B">B、Photoshop 是用于处理图像的软件</div>
          <div class="opt" data-blk="Q2-C">C、Python 是一门通用的高级编程语言</div>
          <div class="opt" data-blk="Q2-D">D、Windows 是微软公司出品的操作系统</div>
        </div>
      </div>`),
  },

  {
    path: "/6-fifty.html",
    title: "6 用户截图那一页的规模：50 道判断题同页 → 50 道全认出、全点对",
    expect: FIFTY_EXPECT,
    mustFill: 50,
    stemRe: /【判断】/,
    // 这条走题库模式：答案由题库决定（A/B 混着有），"每道题都点对自己那一个"才是逐题断言
    storage: { mode: "bank", intervalMs: 10, fuzzyThreshold: 75 },
    settings: { mode: "bank", intervalMs: 10, fuzzyThreshold: 75, fillHosts: "*", showLog: true },
    html: page(`<div class="qlist" data-blk="list">${FIFTY_LAYOUT}</div>`),
    custom(ctx) {
      const lowConf = ctx.log.split("\n").filter(l => /低置信/.test(l));
      const bankHit = Number((ctx.log.match(/题库命中\s*(\d+)/) || [])[1]);
      return [
        ["[6] 题库命中 50 道（没有因为选项相同被去重吞掉）", bankHit === 50, bankHit],
        ["[6] 一道都没走 AI 兜底", /AI 作答 0/.test(ctx.log), ctx.log.split("\n")[1]],
        ["[6] 没有一道被「低置信」跳过", lowConf.length === 0, lowConf],
        ["[6] 50 道点全了（不多不少）", ctx.blks.length === 50, ctx.blks.length],
      ];
    },
  },
  {
    path: "/7-bare-text-stem.html",
    title: "7 题干是裸文本 + 行内「【判断】」标签（用户那一页的形状）→ 5 道全认出",
    expect: ["Q1-A", "Q2-A", "Q3-A", "Q4-A", "Q5-A"],
    mustFill: 5,
    stemRe: /雪天行车|应急车道|驾驶证|法律责任|交通事故/,
    html: page(`<div class="qlist" data-blk="list">${BARE_TEXT_LAYOUT}</div>`),
    custom(ctx) {
      // 题干必须拼全（含【判断】），不能只剩那个 4 字标签
      const bad = ctx.prompts.filter(p => !/【判断】[\s\S]{10,}/.test(p));
      return [["[7] 5 个 prompt 的题干都是完整题干（不是「【判断】」标签）", bad.length === 0, bad]];
    },
  },
];

async function boot(browser, site, spec) {
  const page_ = await browser.newPage();
  const errors = [];
  page_.on("pageerror", e => errors.push(e.message));
  await page_.goto(site.url + spec.path);

  // showLog: true —— 本文件自建 chrome stub（不走 harness.newPage）。
  // 产品的运行日志面板默认**关**（不建 DOM、日志只进控制台），而本测试要读日志
  // （waitDone 查 .aa-runlog）并断言题库命中数，所以必须显式打开。
  const storage = Object.assign(
    { mode: "ai", aiKey: "x", intervalMs: 20, fuzzyThreshold: 75 },
    spec.storage || {},
    { showLog: true }
  );
  await page_.evaluate(({ hook, rules, st }) => {
    const decide = u => {
      for (const r of rules) if (u.includes(r[0])) return r[1];
      return "A";
    };
    window.__ai = [];
    window.chrome = {
      runtime: {
        onMessage: { addListener: fn => { window.__aaListener = fn; } },
        getManifest: () => ({ version: "test" }),
        getURL: p => "chrome-extension://test/" + p,
        sendMessage: async msg => {
          if (msg.type === "AI_CHAT") {
            const u = ((msg.payload.messages || []).find(m => m.role === "user") || {}).content || "";
            window.__ai.push(u);
            return { ok: true, text: decide(u) };
          }
          if (msg.type === "GET_WHITELIST") return { ok: true, hosts: ["*"] };
          if (msg.type === "FETCH_BANK") return { ok: false, error: "stub proxy" };
          return { ok: false, error: "stub" };
        }
      },
      storage: {
        local: {
          get: async () => st,
          set: async () => {}
        }
      },
    };
    eval(hook);
  }, { hook: CLICK_HOOK, rules: spec.rules || [], st: storage });

  await page_.addScriptTag({ path: H.EXT + "/content.js" });
  await page_.waitForFunction(() => typeof window.__aaListener === "function");
  return { page_, errors };
}

async function waitDone(page_) {
  for (let i = 0; i < 24; i++) {
    await H.sleep(500);
    const st = await page_.evaluate(() => ({
      log: (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "",
      warn: document.querySelector(".aa-panel .aa-warn")?.textContent || "",
    }));
    // 完成锚点要同时认「题库命中」与「AI 作答」：
    // 各用例模式不同（走题库的写「完成：题库命中 N，AI 作答 0」，
    // 纯 AI 的写「完成：题库命中 0，AI 作答 N」），只锚定前者会让 AI 模式用例
    // 永远等不到、超时后拿到空日志，断言就全成了假失败。
    if (/完成：题库命中\s*\d+/.test(st.log) || /本页没有可自动填涂的控件/.test(st.warn)) return st;
  }
  return await page_.evaluate(() => ({
    log: (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "",
    warn: document.querySelector(".aa-panel .aa-warn")?.textContent || "",
  }));
}

H.run(async () => {
  const routes = {};
  for (const s of SPECS) routes[s.path] = s.html;
  // 场景 6 用真实题库跑 mode:"bank"：题库从"当前页面"这一档取（见 bankBaseCandidates ③）
  routes["/bank/index.json"] = BANK_INDEX;
  routes["/bank/judge50.json"] = BANK_MINI;
  const site = await H.serve({ port: PORT, routes });
  const browser = await chromium.launch();
  const R = H.Reporter();

  console.log(`场景 6 题库：${PICK.length} 道判断题（答案 A=${ANSWER_MIX.A} / B=${ANSWER_MIX.B}）`);

  for (const spec of SPECS) {
    const tag = `[${spec.path}]`;
    const allErrors = [];
    // 非判断题场景（只读降级）不需要"题卡题干与预期一致"这条
    if (!spec.readOnly && !spec.stemRe) spec.stemRe = /./;

    // ---------- 阶段 1：自动填涂路径 ----------
    const a = await boot(browser, site, spec);
    allErrors.push(...a.errors);
    // showLog: true 必须带上：产品 run() 是按**这条 START 消息里的 settings.showLog**
    // 决定要不要建日志面板的（不是 storage）。不带就永远读不到日志、等不到"完成："。
    const autoSettings = Object.assign(
      { mode: "ai", intervalMs: 20, aiKey: "x", fillHosts: "*" },
      spec.settings || {},
      { showLog: true }
    );
    await a.page_.evaluate(s => window.__aaListener({ type: "START", settings: s }), autoSettings);
    const st = await waitDone(a.page_);
    const clicked = await a.page_.evaluate(() => window.__clicked);
    const prompts = await a.page_.evaluate(() => window.__ai);
    await a.page_.close();

    const blks = [...new Set(clicked.map(c => c.blk))];

    console.log(`\n### ${spec.title}`);
    console.log("被点区块:", JSON.stringify(blks));
    console.log("AI prompt:", JSON.stringify(prompts));
    console.log("日志:\n" + st.log);

    R.t(`${tag} 点击落点符合预期（期望 ${JSON.stringify(spec.expect)}）`,
      JSON.stringify(blks.slice().sort()) === JSON.stringify(spec.expect.slice().sort()), blks);
    // 点击绝不能落到题干 / 容器上（optEls 起点偏移 bug 的直接表现）
    R.t(`${tag} 没有点到题干或容器上`,
      !clicked.some(c => /stem$|^Q\d+$|^list$|^nav$/.test(c.blk)), clicked.map(c => c.blk));

    if (spec.readOnly) {
      R.t(`${tag} 未识别到可填涂控件 → 走只读降级`,
        /本页没有可自动填涂的控件/.test(st.warn), st.warn);
      R.t(`${tag} 一个选项都没被点`, clicked.length === 0, clicked);
    } else {
      // 只断言"总共有 mustFill 道拿到答案"，不锁死题库/AI 的拆分（场景 6 走题库）
      const bankN = Number((st.log.match(/题库命中\s*(\d+)/) || [])[1]) || 0;
      const aiN = Number((st.log.match(/AI 作答\s*(\d+)/) || [])[1]) || 0;
      R.t(`${tag} 自动填涂命中 ${spec.mustFill} 道（题库 ${bankN} + AI ${aiN}）`,
        bankN + aiN === spec.mustFill, st.log.split("\n").slice(0, 3));
    }
    if (spec.custom) {
      for (const [name, cond, got] of spec.custom({ prompts, blks, log: st.log })) R.t(name, cond, got);
    }

    // ---------- 阶段 2：面板路径（必须另开新页，filledEls 会跨路径去重） ----------
    if (!spec.readOnly) {
      const b = await boot(browser, site, spec);
      allErrors.push(...b.errors);
      await b.page_.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
      await H.sleep(1500);

      const scan = await b.page_.evaluate(() => {
        const panel = document.querySelector(".aa-panel");
        if (!panel) return { cards: 0, stems: [] };
        return {
          cards: panel.querySelectorAll(".aa-card").length,
          stems: [...panel.querySelectorAll(".aa-card .aa-stem")].map(e => e.textContent.replace(/\s+/g, " ").trim()),
        };
      });

      let fillMsg = "";
      const green = await b.page_.$$(".aa-panel button.aa-btn-green");
      let fillBtn = null;
      for (const btn of green) {
        if (/填涂/.test((await btn.textContent()) || "")) { fillBtn = btn; break; }
      }
      if (fillBtn) {
        await fillBtn.click();
        // 每题之间扩展会 sleep 400ms（content.js:1874），50 道就要 20s，轮询窗口必须留够
        const budget = 6000 + spec.mustFill * 700;
        for (let waited = 0; waited < budget; waited += 500) {
          await H.sleep(500);
          fillMsg = await b.page_.evaluate(() => document.querySelector(".aa-panel .aa-info")?.textContent || "");
          if (/填涂结束/.test(fillMsg)) break;
        }
      }
      const panelClicked = await b.page_.evaluate(() => window.__clicked);
      const panelBlks = [...new Set(panelClicked.map(c => c.blk))];
      await b.page_.close();

      console.log("面板题卡:", scan.cards, "| 落点:", JSON.stringify(panelBlks), "| 填涂:", fillMsg || "(没找到填涂按钮)");

      R.t(`${tag} 面板题卡数 = ${spec.mustFill}`, scan.cards === spec.mustFill, scan.stems);
      R.t(`${tag} 面板题卡题干与预期一致`,
        scan.stems.every(s => spec.stemRe.test(s)) && scan.stems.length === spec.mustFill, scan.stems);
      R.t(`${tag} 面板「填涂」成功 ${spec.mustFill} 道`,
        new RegExp(`成功\\s*${spec.mustFill}\\b`).test(fillMsg), fillMsg);
      R.t(`${tag} 面板落点与自动路径一致`,
        JSON.stringify(panelBlks.slice().sort()) === JSON.stringify(spec.expect.slice().sort()), panelBlks);
    }

    R.t(`${tag} 无未捕获异常`, allErrors.length === 0, allErrors.join(" | ") || "(无)");
  }

  R.finish();
  await browser.close();
  await site.close();
});
