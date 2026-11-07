/**
 * 学习通新版考试真实结构（2026-10-29 从用户浏览器读取）：
 *   <div class="question-item single-choice|multiple-choice">
 *     <p class="question-name">1. ...</p>
 *     <ul class="option-list">
 *       <li class="active"><span class="option-letter">A</span><p class="option-result">...</p></li>
 *     </ul>
 *   </div>
 *
 * 覆盖：
 *   ① 旧实现漏掉 .option-list，题干会把 A/B/C/D 并进去；
 *   ② 默认「保留已选」：单选/多选都跳过，不覆盖；
 *   ③ 打开「覆盖已选答案」：单选覆盖、多选按答案集合先清后勾；
 *   ④ 选中态 li.active 不能报「页面选中态读不到」。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8117;

const q = (n, stem, options, { multi = false, preselected = -1 } = {}) => `
<div class="question-item ${multi ? "multiple-choice" : "single-choice"}" data-q="${n}">
  <p class="question-name">${n}. <span class="grey-text">[${multi ? "多选题" : "单选题"}]</span><span class="html-content-box">${stem}</span></p>
  <div class="attach-img-list"></div>
  <ul class="option-list">
    ${options.map((text, i) => `<li${i === preselected ? ' class="active"' : ""}><span class="option-letter">${String.fromCharCode(65 + i)}</span> <p class="option-result"><span class="html-content-box">${text}</span></p> <div class="attach-img-list"></div> </li>`).join("")}
  </ul>
</div>`;

const CLICK_SCRIPT = `<script>
window.__clicks = [];
document.querySelectorAll(".question-item").forEach(box => {
  const multi = box.classList.contains("multiple-choice");
  box.querySelectorAll(".option-list li").forEach(li => {
    li.addEventListener("click", () => {
      if (multi) {
        li.classList.toggle("active");
      } else {
        box.querySelectorAll(".option-list li").forEach(x => x.classList.remove("active"));
        li.classList.add("active");
      }
      window.__clicks.push(li.textContent.replace(/\\s+/g, " ").trim().slice(0, 12));
    });
  });
});
</script>`;

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>学习通新版考试</title></head>
<body>
<div class="question-box"><div class="left-question-list">
${q(1, "通常所说的“大革命”或“国民革命”发生的时间是( )", ["1919—1923年", "1924—1927年", "1927—1937年", "1926—1928年"], { preselected: 2 })}
${q(2, "大革命失败留下的经验教训包括( )", ["必须保持党的独立性", "必须放弃对革命的领导权", "必须坚持武装斗争", "必须解决农民土地问题"], { multi: true, preselected: 1 })}
</div></div>${CLICK_SCRIPT}</body></html>`;

const PAGE_OVERWRITE_SINGLE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>覆盖单选</title></head>
<body><div class="question-box"><div class="left-question-list">
${q(1, "通常所说的“大革命”或“国民革命”发生的时间是( )", ["1919—1923年", "1924—1927年", "1927—1937年", "1926—1928年"], { preselected: 2 })}
</div></div>${CLICK_SCRIPT}</body></html>`;

const PAGE_OVERWRITE_MULTI = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>覆盖多选</title></head>
<body><div class="question-box"><div class="left-question-list">
${q(2, "大革命失败留下的经验教训包括( )", ["必须保持党的独立性", "必须放弃对革命的领导权", "必须坚持武装斗争", "必须解决农民土地问题"], { multi: true, preselected: 1 })}
</div></div>${CLICK_SCRIPT}</body></html>`;

const STORAGE = { mode: "ai", aiKey: "x", fuzzyThreshold: 75, interval: "0", fillHosts: "*" };

H.run(async () => {
  const site = await H.serve({
    port: PORT,
    routes: {
      "/": PAGE,
      "/overwrite-single": PAGE_OVERWRITE_SINGLE,
      "/overwrite-multi": PAGE_OVERWRITE_MULTI,
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const R = H.Reporter();

  async function scanAndFill(page) {
    await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
    await H.sleep(1200);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
      if (btn) btn.click();
    });
    let finished = false;
    for (let i = 0; i < 16 && !finished; i++) {
      await H.sleep(500);
      finished = await page.evaluate(() =>
        /填涂结束/.test(document.querySelector(".aa-panel .aa-info")?.textContent || ""));
    }
    return finished;
  }

  const page = await H.newPage(browser, site.url + "/", { aiAnswer: "A、C", storage: STORAGE, waitFor: ".question-item" });
  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1200);

  const scanned = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".aa-card")].map(c => ({
      stem: c.querySelector(".aa-stem")?.textContent || "",
      opts: [...c.querySelectorAll(".aa-opt")].map(o => o.textContent.replace(/\s+/g, " ").trim()),
    })),
  }));

  R.t("识别到 2 道题", scanned.cards.length === 2, scanned.cards.length);
  R.t("每题都拆出 4 个选项", scanned.cards.every(c => c.opts.length === 4),
    scanned.cards.map(c => c.opts.length));
  R.t("题干是完整题干，且没有把 A/B/C/D 并进去",
    scanned.cards.every(c =>
      (c.stem.includes("大革命") || c.stem.includes("国民革命")) &&
      !c.stem.includes("1919—1923年") && !c.stem.includes("必须保持党的独立性")),
    scanned.cards.map(c => c.stem));

  const resized = await page.evaluate(async () => {
    const panel = document.querySelector(".aa-panel");
    const grip = panel.querySelector(".aa-resize");
    const r = grip.getBoundingClientRect();
    const before = panel.offsetWidth;
    grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 62, clientY: r.top + 52 }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const during = panel.offsetWidth;
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { before, during, after: panel.offsetWidth };
  });
  R.t("拖动时面板实时变宽（rAF 路径）", resized.during > resized.before, resized);
  R.t("松手后保持新尺寸", resized.after >= resized.during && resized.after > resized.before, resized);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
    if (btn) btn.click();
  });
  let finished = false;
  for (let i = 0; i < 16 && !finished; i++) {
    await H.sleep(500);
    finished = await page.evaluate(() =>
      /填涂结束/.test(document.querySelector(".aa-panel .aa-info")?.textContent || ""));
  }

  const after = await page.evaluate(() => {
    const q1 = document.querySelector('[data-q="1"]');
    const q2 = document.querySelector('[data-q="2"]');
    const active = box => [...box.querySelectorAll(".option-list li.active")].map(li => li.querySelector(".option-letter").textContent);
    return {
      msg: document.querySelector(".aa-panel .aa-info")?.textContent || "",
      q1: active(q1),
      q2: active(q2),
      clicks: window.__clicks.length,
      states: [...document.querySelectorAll(".aa-card-state")].map(x => x.textContent),
    };
  });

  console.log("默认保留:", after.msg, "q1:", after.q1, "q2:", after.q2);
  R.t("填涂流程走到结束", finished, after.msg.slice(0, 60));
  R.t("单选已选的 C 被保留，没有被覆盖", after.q1.length === 1 && after.q1[0] === "C", after.q1);
  R.t("多选已选的 B 默认也被保留", after.q2.length === 1 && after.q2[0] === "B", after.q2);
  R.t("默认保留时两道题都不点、都跳过", after.clicks === 0, after.clicks);
  R.t("汇总报成功 0、已跳过 2", /成功 0/.test(after.msg) && /已跳过 2/.test(after.msg), after.msg);
  R.t("不再报「页面选中态读不到」", !/选中态读不到/.test(after.msg), after.msg);
  R.t("卡片状态：两道都跳过",
    after.states.length === 2 && after.states.every(s => s === "已跳过"),
    after.states);
  R.t("默认路径无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  // ---- 覆盖已选答案：单选已有 C，打开开关后应按 A 覆盖 ----
  const pageSingle = await H.newPage(browser, site.url + "/overwrite-single", {
    aiAnswer: "A", storage: { ...STORAGE, overwriteSelected: true }, waitFor: ".question-item",
  });
  R.t("覆盖单选：填涂流程走到结束", await scanAndFill(pageSingle), "scanAndFill");
  const single = await pageSingle.evaluate(() => ({
    msg: document.querySelector(".aa-panel .aa-info")?.textContent || "",
    active: [...document.querySelector('[data-q="1"]').querySelectorAll(".option-list li.active")].map(li => li.querySelector(".option-letter").textContent),
    clicks: window.__clicks.length,
    state: document.querySelector(".aa-card-state")?.textContent || "",
  }));
  R.t("覆盖开关打开后，单选 C 被 A 覆盖", single.active.length === 1 && single.active[0] === "A", single.active);
  R.t("覆盖单选只点了一次", single.clicks === 1, single.clicks);
  R.t("覆盖单选汇总成功 1", /成功 1/.test(single.msg), single.msg);
  R.t("覆盖单选卡片已填涂", single.state === "已填涂", single.state);
  R.t("覆盖单选无未捕获异常", pageSingle.errors.length === 0, pageSingle.errors.join(" | ") || "(无)");

  // ---- 覆盖已选答案：多选已有 B，答案 A、C → 先清 B，再补 A、C ----
  const pageMulti = await H.newPage(browser, site.url + "/overwrite-multi", {
    aiAnswer: "A、C", storage: { ...STORAGE, overwriteSelected: true }, waitFor: ".question-item",
  });
  R.t("覆盖多选：填涂流程走到结束", await scanAndFill(pageMulti), "scanAndFill");
  const multi = await pageMulti.evaluate(() => ({
    msg: document.querySelector(".aa-panel .aa-info")?.textContent || "",
    active: [...document.querySelector('[data-q="2"]').querySelectorAll(".option-list li.active")].map(li => li.querySelector(".option-letter").textContent),
    clicks: window.__clicks.length,
    state: document.querySelector(".aa-card-state")?.textContent || "",
  }));
  R.t("覆盖开关打开后，多选 B 被清掉，最终 A、C", multi.active.join(",") === "A,C", multi.active);
  R.t("覆盖多选点击次数 = 清 B + 加 A + 加 C", multi.clicks === 3, multi.clicks);
  R.t("覆盖多选汇总成功 1", /成功 1/.test(multi.msg), multi.msg);
  R.t("覆盖多选卡片已填涂", multi.state === "已填涂", multi.state);
  R.t("覆盖多选无未捕获异常", pageMulti.errors.length === 0, pageMulti.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
