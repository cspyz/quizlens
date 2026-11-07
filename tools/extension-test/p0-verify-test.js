/**
 * P0 三项修复的回归测试。三个 bug 的共同点是「静默失败」——不报错、不降级，
 * 用户只看到"这插件没用"，所以必须用测试把行为钉住。
 *
 *  P0-1 从 AI 回复里取答案字母，绝不能全文扫描。
 *       模型很爱回「答案是 C。因为 A 选项错误，B 也不对」，全文扫描会把 A、B、C
 *       全当成答案 → 多选题三选全勾。而填涂是"点下去不可逆"的，必须宁少勿多。
 *       同时要认「AC」「A、C、D」「正确答案：A、C、D」这些正常写法，
 *       并且字母范围要跟着选项数走（问卷星常见 5 个选项，不能只认 A-D）。
 *
 *  P0-2 题库来源。旧代码是 fetch("./bank/index.json")，而 "./" 是相对**当前网页**
 *       解析的，不是相对扩展目录 → 在真实答题网站上必然是 404；默认模式又正好是
 *       「题库匹配」→ 一道题都答不出来，还只往 console 写一行。
 *       现在要求：多来源依次尝试 + 走后台代理（绕开页面 CORS）+ 失败时给出
 *       **能照着做**的提示 + 报错不能把"整个题库没拿到"说成"这道题没收录"。
 *
 *  P0-3 .question 空壳过滤。.question 是真实网站上极常见的类名（FAQ、帮助中心、
 *       考试系统都在用）。误命中时 extractQuestion 产出 {stemText:""} 的空壳题，
 *       而调用处用 `if (!questions.length)` 判断要不要走通用识别 ——
 *       空壳题 length > 0 就把通用识别整个跳过：既不报错也不降级，整页全废。
 *
 * 注：AI 回复是 stub 造的，答案字符串刻意构造来打解析规则的边界，不是"正确答案"。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8093;        // 页面 A/B/C：答案解析、空壳过滤、后台代理取题库
const PORT_ALT = 8094;    // 页面 D/E：题库来源优先级、三个来源全失败

// ---------- 页面 A：本地 .question 结构 + 2 个撞类名的空壳 ----------
const PAGE_ANSWER = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>答案解析</title></head><body>
<div class="question" id="decoy-plain">这是一段普通说明文字，只是恰好用了 .question 这个类名。</div>
<div class="question" id="decoy-faq"><h3>常见问题</h3><p>问：怎么用？答：看 README。</p></div>

<div class="question">
  <div class="q-stem">1. 下列哪些属于编程语言？</div>
  <div class="opt"><input type="checkbox" name="q1" value="0"><span class="opt-text">JavaScript</span></div>
  <div class="opt"><input type="checkbox" name="q1" value="1"><span class="opt-text">Python</span></div>
  <div class="opt"><input type="checkbox" name="q1" value="2"><span class="opt-text">HTML</span></div>
  <div class="opt"><input type="checkbox" name="q1" value="3"><span class="opt-text">CSS</span></div>
</div>

<div class="question">
  <div class="q-stem">2. 下列哪些属于前端技术？</div>
  <div class="opt"><input type="checkbox" name="q2" value="0"><span class="opt-text">React</span></div>
  <div class="opt"><input type="checkbox" name="q2" value="1"><span class="opt-text">Vue</span></div>
  <div class="opt"><input type="checkbox" name="q2" value="2"><span class="opt-text">Nginx</span></div>
  <div class="opt"><input type="checkbox" name="q2" value="3"><span class="opt-text">Redis</span></div>
</div>

<div class="question">
  <div class="q-stem">3. 下列哪些属于数据库？</div>
  <div class="opt"><input type="checkbox" name="q3" value="0"><span class="opt-text">MySQL</span></div>
  <div class="opt"><input type="checkbox" name="q3" value="1"><span class="opt-text">Nginx</span></div>
  <div class="opt"><input type="checkbox" name="q3" value="2"><span class="opt-text">Redis</span></div>
  <div class="opt"><input type="checkbox" name="q3" value="3"><span class="opt-text">SQLite</span></div>
</div>

<div class="question">
  <div class="q-stem">4. 下列哪些属于操作系统？</div>
  <div class="opt"><input type="checkbox" name="q4" value="0"><span class="opt-text">Linux</span></div>
  <div class="opt"><input type="checkbox" name="q4" value="1"><span class="opt-text">Windows</span></div>
  <div class="opt"><input type="checkbox" name="q4" value="2"><span class="opt-text">macOS</span></div>
  <div class="opt"><input type="checkbox" name="q4" value="3"><span class="opt-text">Chrome</span></div>
</div>

<div class="question">
  <div class="q-stem">5. 下列哪些属于编程语言？（五选项版）</div>
  <div class="opt"><input type="checkbox" name="q5" value="0"><span class="opt-text">Go</span></div>
  <div class="opt"><input type="checkbox" name="q5" value="1"><span class="opt-text">Rust</span></div>
  <div class="opt"><input type="checkbox" name="q5" value="2"><span class="opt-text">Java</span></div>
  <div class="opt"><input type="checkbox" name="q5" value="3"><span class="opt-text">PHP</span></div>
  <div class="opt"><input type="checkbox" name="q5" value="4"><span class="opt-text">Ruby</span></div>
</div>

<div class="question">
  <div class="q-stem">6. 下列哪些属于浏览器？</div>
  <div class="opt"><input type="checkbox" name="q6" value="0"><span class="opt-text">Chrome</span></div>
  <div class="opt"><input type="checkbox" name="q6" value="1"><span class="opt-text">Edge</span></div>
  <div class="opt"><input type="checkbox" name="q6" value="2"><span class="opt-text">Firefox</span></div>
  <div class="opt"><input type="checkbox" name="q6" value="3"><span class="opt-text">Safari</span></div>
</div>
</body></html>`;

// 刻意构造的 AI 回复：① 答案后面跟着提到 A/B 的解释（全文扫描会误勾 A、B）
// ② 连写字母串 ③ 顿号列表 ④ 第一行答案 + 第二行解释 ⑤ 5 选项答 E ⑥ 越界的 E（只有 4 选项）
const AI_REPLIES = [
  "答案是 C。因为 A 选项错误，B 也不对。",
  "AC",
  "正确答案：A、C、D",
  "第一行就是 C\n解释：A 和 B 都不对",
  "E",
  "答案是 E",
];
const EXPECT_CHECKED = [[2], [0, 2], [0, 2, 3], [2], [4], []];

// ---------- 页面 B：两个 .question 全是空壳，真题目是普通表单（走通用识别） ----------
const PAGE_SHELL = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>空壳页</title></head><body>
<div class="question">常见问题解答</div>
<div class="question"><h3>关于我们</h3><p>本页用于验证插件不会把撞类名的元素当成题目。</p></div>
<div class="q">1. 下列哪一个是编程语言？</div>
<div class="opts">
  <label><input type="radio" name="a1" value="0"><span>JavaScript</span></label>
  <label><input type="radio" name="a1" value="1"><span>HTML</span></label>
  <label><input type="radio" name="a1" value="2"><span>CSS</span></label>
</div>
</body></html>`;

// ---------- 页面 C/D：题卡结构 + 一道题库里也有的题 ----------
const PAGE_BANK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>题库页</title></head><body>
<div class="question">
  <div class="q-stem">1. 下列哪个是数据库？</div>
  <div class="opt"><input type="radio" name="b1" value="0"><span class="opt-text">MySQL</span></div>
  <div class="opt"><input type="radio" name="b1" value="1"><span class="opt-text">Nginx</span></div>
  <div class="opt"><input type="radio" name="b1" value="2"><span class="opt-text">Redis</span></div>
</div>
</body></html>`;

const BANK_INDEX = [{ file: "01_t.json", label: "测试库", count: 1 }];
// 同一道题在两份题库里答案不同，用来分辨"到底用了哪一份"
const BANK_T_CURRENT = { category: "t", count: 1, questions: [
  { question: "1. 下列哪个是数据库？", options: ["MySQL", "Nginx", "Redis"], answer: [0] },
]};
const BANK_T_CUSTOM = { category: "t", count: 1, questions: [
  { question: "1. 下列哪个是数据库？", options: ["MySQL", "Nginx", "Redis"], answer: [2] },
]};

const AI_ONLY = { mode: "ai", intervalMs: 20, aiKey: "x", fillHosts: "*" };

// 把 stub 的 sendMessage 换成"按顺序发答案"，并记录调用了哪些后台接口。
// wjx-mock.html 里也是这个套路（window.__aiQueue）。
async function installStub(page, { replies = [], bankFiles = null } = {}) {
  await page.evaluate(({ rs, files }) => {
    window.__aiQueue = rs.slice();
    window.__fetchBankCalls = [];
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async msg => {
      if (msg && msg.type === "AI_CHAT") {
        return { ok: true, text: window.__aiQueue.length ? window.__aiQueue.shift() : "A" };
      }
      // 模拟后台的 FETCH_BANK 代理：题库文本由 Node 侧备好塞进来。
      // 页面 C 故意不注册 /bank/* 路由，所以这里失败就没救 —— 代理路径必须真的通。
      if (msg && msg.type === "FETCH_BANK") {
        const url = (msg.payload && msg.payload.url) || "";
        window.__fetchBankCalls.push(url);
        if (files && Object.prototype.hasOwnProperty.call(files, url)) {
          return { ok: true, text: files[url] };
        }
        return { ok: false, error: "no such file (stub proxy)" };
      }
      return orig(msg);
    };
  }, { rs: replies, files: bankFiles });
}

const readChecked = page => page.evaluate(() => {
  const out = {};
  for (const q of document.querySelectorAll(".question")) {
    const stem = q.querySelector(".q-stem")?.textContent.trim();
    if (!stem) continue;   // 空壳（撞类名的元素）
    out[stem] = [...q.querySelectorAll(".opt input")]
      .map((inp, i) => (inp.checked ? i : -1)).filter(i => i >= 0);
  }
  return out;
});

H.run(async () => {
  const R = H.Reporter();
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const site = await H.serve({
    port: PORT,
    // 注意：8093 上**故意不注册** /bank/* —— 页面C 要验证题库只能靠后台代理拿到，
    // 页面E 要验证三个来源全失败时的提示。页面D 才用 8094 上的 /bank/ 与 /altbank/。
    routes: { "/answer.html": PAGE_ANSWER, "/shell.html": PAGE_SHELL, "/bank.html": PAGE_BANK, "/nobank.html": PAGE_BANK },
  });
  // 端口 8094 上同时存在 /bank/ 和 /altbank/ 两份题库（答案不同）：
  // 只有"自定义题库地址"优先于"当前页面"时，才会用上 /altbank/ 的答案
  const siteAlt = await H.serve({
    port: PORT_ALT,
    routes: {
      "/altbank.html": PAGE_BANK,
      "/bank/index.json": BANK_INDEX, "/bank/01_t.json": BANK_T_CURRENT,
      "/altbank/index.json": BANK_INDEX, "/altbank/01_t.json": BANK_T_CUSTOM,
    },
  });

  // ================= P0-1：AI 答案解析 =================
  const pA = await H.newPage(browser, site.url + "/answer.html", { waitFor: null });
  await installStub(pA, { replies: AI_REPLIES });
  await H.startAndWait(pA, AI_ONLY);
  const logA = await H.readLog(pA);
  const checkedA = await readChecked(pA);
  const rawQ = await pA.evaluate(() => document.querySelectorAll(".question").length);

  console.log("--- 页面A：AI 答案解析 + 空壳过滤 ---\n" + logA + "\n");
  console.log("勾选结果:", JSON.stringify(checkedA, null, 0));

  R.t("页面上有 8 个 .question（其中 2 个是撞类名的空壳）", rawQ === 8, rawQ);
  R.t("空壳被过滤：识别到 6 道题（不是 8）",
      /页面识别到 6 道题（题卡结构）/.test(logA),
      (logA.match(/页面识别到 \d+ 道题[^\n]*/) || [])[0]);
  R.t("「答案是 C。因为 A 选项错误，B 也不对」只勾 C，不勾 A/B（P0-1 核心）",
      JSON.stringify(checkedA["1. 下列哪些属于编程语言？"]) === JSON.stringify(EXPECT_CHECKED[0]),
      checkedA["1. 下列哪些属于编程语言？"]);
  R.t("连写字母串「AC」认出两个",
      JSON.stringify(checkedA["2. 下列哪些属于前端技术？"]) === JSON.stringify(EXPECT_CHECKED[1]),
      checkedA["2. 下列哪些属于前端技术？"]);
  R.t("「正确答案：A、C、D」认出三个",
      JSON.stringify(checkedA["3. 下列哪些属于数据库？"]) === JSON.stringify(EXPECT_CHECKED[2]),
      checkedA["3. 下列哪些属于数据库？"]);
  R.t("无标记时取第一行，第二行解释里的 A/B 不泄漏",
      JSON.stringify(checkedA["4. 下列哪些属于操作系统？"]) === JSON.stringify(EXPECT_CHECKED[3]),
      checkedA["4. 下列哪些属于操作系统？"]);
  R.t("5 选项的题能答到 E（字母范围跟随选项数）",
      JSON.stringify(checkedA["5. 下列哪些属于编程语言？（五选项版）"]) === JSON.stringify(EXPECT_CHECKED[4]),
      checkedA["5. 下列哪些属于编程语言？（五选项版）"]);
  R.t("4 选项却答 E → 越界丢弃，一个都不勾",
      JSON.stringify(checkedA["6. 下列哪些属于浏览器？"]) === JSON.stringify(EXPECT_CHECKED[5]),
      checkedA["6. 下列哪些属于浏览器？"]);
  R.t("越界那道记为未答 1", /未答 1/.test(logA), (logA.match(/完成：[^\n]*/) || [])[0]);
  R.t("页面A 无未捕获异常", pA.errors.length === 0, pA.errors.join(" | ") || "(无)");

  // ================= P0-3：全部 .question 都是空壳时不能跳过通用识别 =================
  const pB = await H.newPage(browser, site.url + "/shell.html", { waitFor: null });
  await installStub(pB, { replies: ["A"] });
  await H.startAndWait(pB, AI_ONLY);
  const logB = await H.readLog(pB);
  const checkedB = await pB.evaluate(() => [...document.querySelectorAll("input:checked")].map(i => i.name + ":" + i.value));

  console.log("\n--- 页面B：全是空壳 .question + 通用表单 ---\n" + logB + "\n");
  R.t("空壳全被过滤后走了通用识别（旧代码会跳过它，整页全废）",
      /页面识别到 1 道题（通用表单\/选项列表）/.test(logB),
      (logB.match(/页面识别到 \d+ 道题[^\n]*/) || [])[0]);
  R.t("通用表单的 radio 被填涂（a1:0）", checkedB.includes("a1:0"), checkedB);
  R.t("页面B 无未捕获异常", pB.errors.length === 0, pB.errors.join(" | ") || "(无)");

  // ================= P0-2：题库走后台代理（跨域的真实路径） =================
  const pC = await H.newPage(browser, site.url + "/bank.html", { waitFor: null });
  await installStub(pC, {
    replies: [],
    bankFiles: {
      [site.url + "/bank/index.json"]: JSON.stringify(BANK_INDEX),
      [site.url + "/bank/01_t.json"]: JSON.stringify(BANK_T_CURRENT),
    },
  });
  await H.startAndWait(pC, { mode: "bank", intervalMs: 20, fillHosts: "*" });
  const logC = await H.readLog(pC);
  const rC = await pC.evaluate(() => ({
    calls: window.__fetchBankCalls,
    checked: [...document.querySelectorAll("input:checked")].map(i => i.name + ":" + i.value),
  }));

  console.log("\n--- 页面C：题库经后台代理加载 ---\n" + logC + "\n");
  R.t("题库请求走了后台 FETCH_BANK 代理（不是页面自己的 fetch）",
      rC.calls.some(u => /\/bank\/index\.json$/.test(u)) && rC.calls.some(u => /\/bank\/01_t\.json$/.test(u)),
      rC.calls);
  R.t("日志前缀仍是「大题库：N/M」（cloud-test 依赖这个格式）",
      /大题库：1\/1 个类别加载成功/.test(logC),
      (logC.match(/大题库[^\n]*/) || [])[0]);
  R.t("来源标注为「当前页面」", /来源：当前页面/.test(logC), (logC.match(/来源：[^\n，)]*/) || [])[0]);
  R.t("题库命中 1 并勾选（MySQL）", /题库命中 1/.test(logC) && rC.checked.includes("b1:0"),
      { log: (logC.match(/完成：[^\n]*/) || [])[0], checked: rC.checked });
  R.t("命中标注为「题库·精确」", /题库·精确/.test(logC), (logC.match(/\[题库·[^\]]*\]/) || [])[0]);
  R.t("页面C 无未捕获异常", pC.errors.length === 0, pC.errors.join(" | ") || "(无)");

  // ================= P0-2：自定义题库地址优先于当前页面 =================
  const pD = await H.newPage(browser, siteAlt.url + "/altbank.html", { waitFor: null });
  await installStub(pD, { replies: [] });
  await H.startAndWait(pD, {
    mode: "bank", intervalMs: 20, fillHosts: "*",
    bankBaseUrl: siteAlt.url + "/altbank/",
  });
  const logD = await H.readLog(pD);
  const checkedD = await pD.evaluate(() => [...document.querySelectorAll("input:checked")].map(i => i.name + ":" + i.value));

  console.log("\n--- 页面D：自定义题库地址优先 ---\n" + logD + "\n");
  R.t("来源标注为「自定义题库地址」", /来源：自定义题库地址/.test(logD),
      (logD.match(/来源：[^\n，)]*/) || [])[0]);
  R.t("用的是自定义题库的答案（Redis/下标2），证明它优先于同站 /bank/（MySQL/下标0）",
      checkedD.includes("b1:2") && !checkedD.includes("b1:0"), checkedD);
  R.t("页面D 无未捕获异常", pD.errors.length === 0, pD.errors.join(" | ") || "(无)");

  // ================= P0-2：三个来源全失败时的提示与报错 =================
  const pE = await H.newPage(browser, site.url + "/nobank.html", { waitFor: null });
  await installStub(pE, { replies: [] });
  await H.startAndWait(pE, { mode: "bank", intervalMs: 20, fillHosts: "*" });
  const logE = await H.readLog(pE);
  const checkedE = await pE.evaluate(() => [...document.querySelectorAll("input:checked")].map(i => i.name + ":" + i.value));

  console.log("\n--- 页面E：题库三个来源全失败 ---\n" + logE + "\n");
  R.t("明确说「大题库没加载到」并列出试过哪些来源",
      /大题库没加载到。已尝试：/.test(logE), (logE.match(/大题库没加载到[^\n]*/) || [])[0]);
  R.t("给出能照着做的提示（填题库地址 / 换模式）",
      /题库地址/.test(logE) && /仅 AI/.test(logE),
      (logE.match(/→ [^\n]*/) || [])[0]);
  R.t("题库模式下点明「本次一道题也答不出来」", /题库模式没有可用题库/.test(logE), true);
  R.t("报错区分「题库没拿到」和「这道题没收录」",
      /题库没有加载成功/.test(logE) && !/\[未匹配\]/.test(logE),
      (logE.match(/\[(失败|未匹配)\][^\n]*/) || [])[0]);
  R.t("一道题都没填涂（没有瞎勾）", checkedE.length === 0, checkedE);
  R.t("页面E 无未捕获异常", pE.errors.length === 0, pE.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
  await siteAlt.close();
});
