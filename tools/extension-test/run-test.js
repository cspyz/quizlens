/**
 * QuizLens 通用填涂 e2e 测试
 * mock 页面覆盖问卷星关键 DOM 特征：隐藏 input、容器绑定 click、自绘选中态、
 * 多选盲目 toggle、逐题分页（#ctlNext）、「提交答卷」陷阱按钮。
 * mock 页自己用 <script src="content.js"> 加载脚本，台架已把该路径指向扩展目录。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8081;

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: __dirname, defaultFile: "wjx-mock.html" });
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  });
  const page = await H.newPage(browser, site.url + "/wjx-mock.html", { inject: false, waitFor: null });
  page.on("console", m => console.log("[console]", m.text().slice(0, 200)));
  await H.sleep(800);   // 等 mock 页自己的 chrome stub 与 content.js 就绪

  await page.evaluate(() => window.__start());
  const finished = await H.waitForFinish(page);

  // 日志容器：产品早期用 id="aa-log"，后来把日志并进题卡面板改成 class="aa-runlog"。
  // 这里两种都认，避免测试因产品内部改名而假失败（详见 harness.js 的 LOG_SELECTOR 注释）。
  const logs = finished
    ? await page.evaluate(() => {
        const el = document.querySelector("#aa-log, .aa-runlog");
        return el ? (el.innerText || el.textContent || "") : "(找不到日志容器)";
      })
    : "(未检测到完成日志)";

  const st = await page.evaluate(() => {
    const sel = {};
    document.querySelectorAll(".field").forEach(f => {
      const nm = f.querySelector("input")?.name;
      if (nm) sel[nm] = [...f.querySelectorAll(".ui-radio")].map(r => r.classList.contains("checked"));
    });
    return {
      pageNo: document.querySelector("#pageNo")?.textContent,
      checked: window.__state.checked,
      uiSel: window.__state.uiSel || sel,
      jqCalls: window.__state.jqCalls,
      submitClicked: window.__state.submitClicked,
      aaPanel: !!document.querySelector("#aa-log, .aa-runlog"),
    };
  });

  console.log("\n----- 运行日志 -----");
  console.log(logs);
  console.log("----- 断言 -----\n");

  const R = H.Reporter();
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) console.log(`     want=${JSON.stringify(want)}`);
    R.t(name, ok, got);
  };

  eq("第1页完成，停在", st.pageNo, "第 2 页");
  eq("q1 单选→C（本科）", st.checked.q1, [false, false, true, false]);
  eq("q2 多选→A、C（盲目toggle handler）", st.checked.q2, [true, false, true, false]);
  eq("q3 判断→A（满意）", st.checked.q3, [true, false]);
  eq("q4 翻页后单选→B", st.checked.q4, [false, true, false]);
  eq("q4 自绘选中态（当前页）", st.uiSel.q4, [false, true, false]);
  eq("q5 翻页后判断→A", st.checked.q5, [true, false]);
  eq("问卷星内部逻辑每题都被触发",
     ["q1", "q2", "q3", "q4", "q5"].every(nm => st.jqCalls.some(c => c.startsWith(nm + ":"))), true);
  eq("绝不自动点「提交答卷」", st.submitClicked, 0);
  eq("运行日志面板存在", st.aaPanel, true);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
