/**
 * 题干↔选项「张冠李戴」回归测试。
 *
 * 背景：有些页面上题目识别不全时，扩展会把页面上**别的东西**当成这道题 ——
 * 要么把别的题的题干配给这组选项，要么把题干与选项错配后照着错误的题干作答，
 * 最后把答案点到不相干的元素上。点错是不可逆的（漏了还能在只读面板里看答案），
 * 所以这里钉住四个场景：
 *
 *   A 对照组：题干是选项列表的前兄弟（正常页面）      → 必须点对 B，且 prompt 不出现 "A. A."
 *   B 题干与列表之间夹 5 个中性块（广告/推荐位）      → 仍要找回真题干并点对 B
 *   C 容器里先摆 3 道题的题干、末尾才是一个选项列表  → 归属无法判定，一次都不能点
 *   D 侧边栏价格筛选器（checkbox 组）+ 紧邻真题      → 筛选器不能被点，真题要按自己的题干作答
 *
 * 判定口径：
 *   - 用捕获阶段的全局 click 记录被点元素的 tag / 文本 / data-blk（所属区块），
 *     同一次作答可能产生 LABEL + INPUT 两个事件（同一区块），按区块去重；
 *   - AI stub 按题干关键词给字母，并把真正发给 AI 的 prompt 原文记下来 ——
 *     于是"扩展把哪段题干和哪组选项配在了一起"是可直接观察的。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8101;

// 捕获阶段记录点击：data-blk 标出被点元素属于哪个区块（哪个题的哪个选项）
const CLICK_HOOK = `
  window.__clicked = [];
  document.addEventListener("click", e => {
    const t = e.target;
    const blkEl = t.closest ? t.closest("[data-blk]") : null;
    window.__clicked.push({
      tag: t.tagName || "?",
      text: (t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      blk: blkEl ? blkEl.getAttribute("data-blk") : "(无区块)"
    });
  }, true);
`;

const page = body => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>mis-pair</title></head>
<body>${body}</body></html>`;

// 四个选项统一写成 "A. 长文案"：既能被 scanOptionLists 认成竖排选项列表
// （要求平均长度 >= 15），也顺带覆盖"选项文本自带字母前缀"这条路径。
const OPTS = `
  <li data-blk="Q1-A">A. HTML 超文本标记语言，用来描述网页的结构</li>
  <li data-blk="Q1-B">B. JavaScript 一种广泛用于网页交互的编程语言</li>
  <li data-blk="Q1-C">C. CSS 层叠样式表，用来描述网页的外观样式</li>
  <li data-blk="Q1-D">D. SQL 结构化查询语言，用来操作关系数据库</li>`;

const SPECS = [
  {
    path: "/a-adjacent.html",
    title: "A 对照组：题干是选项列表的前兄弟",
    rules: [["编程语言", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/^1\. 下列哪一个是编程语言？$/m],
    promptMustNotHave: [/^A\. A\. /m],
    html: page(`
    <div class="quiz" data-blk="quiz">
      <div class="stem" data-blk="Q1-stem">1. 下列哪一个是编程语言？</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
    </div>`),
  },

  {
    path: "/b-gap.html",
    title: "B 题干与列表之间夹 5 个中性块（广告/推荐位）",
    rules: [["编程语言", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/^1\. 下列哪一个是编程语言？$/m],
    promptMustNotHave: [/^A\. A\. /m],
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="stem" data-blk="Q1-stem">1. 下列哪一个是编程语言？</div>
      <div class="ad" data-blk="ad1">相关推荐 更多精彩内容等你发现</div>
      <div class="ad" data-blk="ad2">广告位 推广内容占位说明</div>
      <div class="ad" data-blk="ad3">热门标签 编程 前端 后端 数据库</div>
      <div class="ad" data-blk="ad4">学习路线 从入门到精通完整路径</div>
      <div class="ad" data-blk="ad5">猜你喜欢 为你精选的优质课程</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
    </div>`),
  },

  {
    path: "/c-foreign-stem.html",
    title: "C 容器里先摆 3 道题的题干、末尾才是选项列表",
    rules: [["1KB", "A"], ["编程语言", "B"]],
    expect: [],                       // 真答案 = Q1-B；但归属判不出来，正确行为是一次都不点
    promptMustHave: [],
    promptMustNotHave: [/1KB/],       // 绝不能拿"第 3 题的题干"去给第 1 题的选项作答
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="stem" data-blk="Q1-stem">1. 下列哪一个是编程语言？</div>
      <div class="other" data-blk="f1">相关推荐 更多精彩内容等你发现</div>
      <div class="other" data-blk="f2">广告位 推广内容占位说明</div>
      <div class="other" data-blk="f3">热门标签 编程 前端 后端 数据库</div>
      <div class="other" data-blk="f4">2. 光年是长度单位。</div>
      <div class="other" data-blk="f5">3. 计算机中 1KB 等于多少字节？</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
    </div>`),
  },

  {
    path: "/d-sidebar-filter.html",
    title: "D 侧边栏价格筛选器（checkbox 组）+ 紧邻真题",
    rules: [["编程语言", "B"]],
    expect: ["Q1-B"],                // 筛选器一个都不能点
    promptMustHave: [/^1\. 下列哪一个是编程语言？$/m],
    promptMustNotHave: [/按价格筛选/],
    html: page(`
    <div class="layout" data-blk="layout">
      <aside class="side" data-blk="sidebar">
        <div class="f-title" data-blk="filter-title">按价格筛选</div>
        <label data-blk="F-A"><input type="checkbox" name="price" value="1"> 0-100 元，适合入门级用户选择</label>
        <label data-blk="F-B"><input type="checkbox" name="price" value="2"> 100-500 元，主流价位段产品</label>
        <label data-blk="F-C"><input type="checkbox" name="price" value="3"> 500-1000 元，中高端产品线</label>
        <label data-blk="F-D"><input type="checkbox" name="price" value="4"> 1000 元以上，旗舰级产品</label>
      </aside>
      <main class="main" data-blk="main">
        <div class="q" data-blk="Q1">
          <div class="stem" data-blk="Q1-stem">1. 下列哪一个是编程语言？</div>
          <label data-blk="Q1-A"><input type="radio" name="q1" value="a"> HTML</label>
          <label data-blk="Q1-B"><input type="radio" name="q1" value="b"> JavaScript</label>
          <label data-blk="Q1-C"><input type="radio" name="q1" value="c"> CSS</label>
        </div>
      </main>
    </div>`),
  },
];

// 等作答结束：正常收尾是「完成：题库命中 N」，一道题都没有时是降级只读面板
async function waitDone(page_) {
  for (let i = 0; i < 20; i++) {
    await H.sleep(500);
    const log = await page_.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
    if (/完成：题库命中\s*\d+/.test(log) || /本页没有可自动填涂的控件/.test(log)) return log;
  }
  return await page_.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
}

H.run(async () => {
  const routes = {};
  for (const s of SPECS) routes[s.path] = s.html;
  const site = await H.serve({ port: PORT, routes });
  const browser = await chromium.launch();
  const R = H.Reporter();
  let idx = 0;

  for (const spec of SPECS) {
    idx++;
    const page_ = await browser.newPage();
    const errors = [];
    page_.on("pageerror", e => errors.push(e.message));
    await page_.goto(site.url + spec.path);

    await page_.evaluate(({ hook, rules }) => {
      const decide = u => {
        for (const r of rules) if (u.includes(r[0])) return r[1];
        return "A";
      };
      window.__ai = [];
      window.chrome = {
        runtime: {
          onMessage: { addListener: fn => { window.__aaListener = fn; } },
          getManifest: () => ({ version: "test" }),
          sendMessage: async msg => {
            if (msg.type === "AI_CHAT") {
              const u = ((msg.payload.messages || []).find(m => m.role === "user") || {}).content || "";
              window.__ai.push(u);
              return { ok: true, text: decide(u) };
            }
            return { ok: false, error: "stub" };
          }
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      };
      eval(hook);
    }, { hook: CLICK_HOOK, rules: spec.rules });

    await page_.addScriptTag({ path: H.EXT + "/content.js" });
    await page_.waitForFunction(() => typeof window.__aaListener === "function");

    await page_.evaluate(s => window.__aaListener({ type: "START", settings: s }),
      { mode: "ai", intervalMs: 20, aiKey: "x", fillHosts: "*" });
    const log = await waitDone(page_);

    const clicked = await page_.evaluate(() => window.__clicked);
    const prompts = await page_.evaluate(() => window.__ai);
    // 一次作答可能产生 LABEL + INPUT 两个事件（同一区块），按区块去重后再判定
    const blks = [...new Set(clicked.map(c => c.blk))];
    const tag = `[${spec.path}]`;

    console.log(`\n### ${spec.title}`);
    console.log("被点区块:", JSON.stringify(blks));
    console.log("AI prompt:", JSON.stringify(prompts));
    console.log("日志:\n" + log);

    R.t(`${tag} 点击落点符合预期（期望 ${JSON.stringify(spec.expect)}）`,
      JSON.stringify(blks.slice().sort()) === JSON.stringify(spec.expect.slice().sort()), blks);
    for (const re of spec.promptMustHave) {
      R.t(`${tag} prompt 里出现正确题干 ${re}`, prompts.some(p => re.test(p)), prompts);
    }
    for (const re of spec.promptMustNotHave) {
      R.t(`${tag} prompt 里不出现 ${re}`, !prompts.some(p => re.test(p)), prompts);
    }
    R.t(`${tag} 无未捕获异常`, errors.length === 0, errors.join(" | ") || "(无)");

    await page_.close();
  }

  R.finish();
  await browser.close();
  await site.close();
});
