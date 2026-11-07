/**
 * 填空题题库匹配专项测试（新增能力）
 *
 * 验证四件事：
 *   ① 填空题题库能被 loadBank 索引（不再被 isIndexableBankQuestion 滤掉）
 *   ② 页面上的填空题能命中题库，直接拿到文本答案，不调用 AI
 *   ③ 多空题按空数对齐写入；空数不一致时不硬填
 *   ④ 题库里的选择题版本不会污染填空题匹配（同题干不同类型）
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8097;

// 页面：3 道填空题（1 空 / 3 空 / 1 空未收录）
const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>填空题库匹配</title></head><body>
<div class="question">
  <div class="q-stem">1. 计算：12 × 8 = ____</div>
  <div class="blanks"><span class="blank-item"><input class="blank-input" type="text" autocomplete="off"></span></div>
</div>

<div class="question">
  <div class="q-stem">2. 一个正方体有 ____ 条棱，有 ____ 个顶点，有 ____ 个面</div>
  <div class="blanks">
    <span class="blank-item"><input class="blank-input" type="text" autocomplete="off"><span class="blank-hint">第 1 空</span></span>
    <span class="blank-item"><input class="blank-input" type="text" autocomplete="off"><span class="blank-hint">第 2 空</span></span>
    <span class="blank-item"><input class="blank-input" type="text" autocomplete="off"><span class="blank-hint">第 3 空</span></span>
  </div>
</div>

<div class="question">
  <div class="q-stem">3. 这道题题库里没有，应该走 AI 或报未匹配 ____</div>
  <div class="blanks"><span class="blank-item"><input class="blank-input" type="text" autocomplete="off"></span></div>
</div>
</body></html>`;

// 题库：2 道填空题 + 1 道同题干的**选择题**（验证类型隔离）
const BANK_INDEX = [{ file: "01_blank.json", label: "填空测试库", count: 3 }];
const BANK = {
  category: "填空测试库",
  count: 3,
  questions: [
    { question: "1. 计算：12 × 8 = ____", answers: ["96"], type: "blank" },
    { question: "2. 一个正方体有 ____ 条棱，有 ____ 个顶点，有 ____ 个面", answers: ["12", "8", "6"], type: "blank" },
    // 同题干但是选择题版本 —— 必须不能被填空题路径选中
    { question: "3. 这道题题库里没有，应该走 AI 或报未匹配 ____", options: ["甲", "乙", "丙", "丁"], answer: [1], type: "single" },
  ],
};

const AI_ONLY_BANK = { mode: "bank", intervalMs: 10, fillHosts: "*" };

async function installStub(page, files) {
  await page.evaluate(({ fs }) => {
    window.__aiCalls = 0;
    window.__fetchBankCalls = [];
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async (msg) => {
      if (msg && msg.type === "AI_CHAT") {
        window.__aiCalls++;
        return { ok: true, text: "AI给的答案" };
      }
      if (msg && msg.type === "FETCH_BANK") {
        const url = (msg.payload && msg.payload.url) || "";
        window.__fetchBankCalls.push(url);
        if (fs && Object.prototype.hasOwnProperty.call(fs, url)) return { ok: true, text: fs[url] };
        return { ok: false, error: "no such file" };
      }
      return orig(msg);
    };
  }, { fs: files });
}

H.run(async () => {
  const R = H.Reporter();
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const site = await H.serve({
    port: PORT,
    routes: {
      "/blank.html": PAGE,
      "/bank/index.json": JSON.stringify(BANK_INDEX),
      "/bank/01_blank.json": JSON.stringify(BANK),
    },
  });

  const page = await H.newPage(browser, site.url + "/blank.html", { waitFor: null });
  await installStub(page, {
    [site.url + "/bank/index.json"]: JSON.stringify(BANK_INDEX),
    [site.url + "/bank/01_blank.json"]: JSON.stringify(BANK),
  });

  await H.startAndWait(page, AI_ONLY_BANK);
  const log = await H.readLog(page);
  const st = await page.evaluate(() => {
    const qs = [...document.querySelectorAll(".question")];
    return {
      values: qs.map((d) => [...d.querySelectorAll(".blank-input")].map((i) => i.value)),
      aiCalls: window.__aiCalls,
      fetchCalls: window.__fetchBankCalls,
    };
  });

  console.log("--- 日志 ---\n" + log + "\n");
  console.log("--- 写入值 ---\n" + JSON.stringify(st.values) + "\n");
  console.log("--- AI 调用次数: " + st.aiCalls + " ---\n");

  R.t("题库加载成功（含填空题类别）", /大题库：1\/1 个类别加载成功/.test(log), (log.match(/大题库[^\n]*/) || [])[0]);
  R.t("第 1 题（单空）从题库命中并写入 96", st.values[0] && st.values[0][0] === "96", st.values[0]);
  R.t("第 1 题标注为题库命中", /题库·精确/.test(log), (log.match(/\[题库·[^\]]*\]/) || [])[0]);
  R.t("第 2 题（三空）三个空全部写入 12/8/6",
    JSON.stringify(st.values[1]) === JSON.stringify(["12", "8", "6"]), st.values[1]);
  R.t("第 3 题：题库里只有选择题版本 → 不被填空题路径误用",
    !(st.values[2] && st.values[2][0] === "乙"), st.values[2]);
  R.t("全程没有调用 AI（纯题库模式）", st.aiCalls === 0, st.aiCalls);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
