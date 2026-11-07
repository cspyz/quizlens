/**
 * 填空题支持测试。
 *
 * 覆盖四件事：
 *   ① 识别：带空格的题干 + 文本输入框 → 被认成一道填空题（卡片上有「填空」标记）
 *   ② 写入：答案真的进了输入框
 *   ③ 受控组件：模拟 React/Vue 那种"直接改 value 无效"的场景，必须走原生 setter + 事件才能生效
 *   ④ 不误伤：登录框、搜索框、密码框不能被当成填空题（往这种框里写东西后果很严重）
 *
 * mock 页里的 #f1 被改造成受控组件：
 *   - 实例上的 value setter 被替换成"什么都不做"（模拟框架忽略直接赋值）
 *   - 只有走原型原生 setter 改了内部值、再派发 input 事件，window.__state 才会更新
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8092;

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>填空题</title></head><body>

<div class="qbox">
  <div class="stem">1. 中国的首都是 ____。</div>
  <input id="f1" type="text" name="blank1" placeholder="请填写答案">
</div>

<div class="qbox2">
  <p>2. 水的化学式是（　）</p>
  <div><input id="f2" type="text" name="blank2" placeholder="填写"></div>
</div>

<form class="login">
  <label>请输入您的用户名</label>
  <input id="user" type="text" name="username" autocomplete="username" placeholder="用户名">
  <label>请输入密码</label>
  <input id="pwd" type="password" name="password" placeholder="密码">
</form>

<div class="searchbox">
  <input id="kw" type="search" name="keyword" placeholder="搜索内容">
</div>

</body></html>`;

// 把 #f1 变成受控组件：直接赋值无效，只有原生 setter + input 事件才生效
const MAKE_CONTROLLED = () => {
  window.__state = { f1: "", f2: "" };
  const el = document.getElementById("f1");
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let domValue = "";
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => domValue,
    set: () => { /* 框架忽略直接赋值 */ },
  });
  el.addEventListener("input", () => {
    domValue = proto.get.call(el);     // 读真实内部值
    window.__state.f1 = domValue;
  });
  const el2 = document.getElementById("f2");
  el2.addEventListener("input", () => { window.__state.f2 = el2.value; });
};

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": PAGE } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/", {
    aiAnswer: "北京", waitFor: null, storage: { mode: "ai", aiKey: "x" },
  });
  const R = H.Reporter();

  await page.evaluate(MAKE_CONTROLLED);

  // 先自检：受控组件确实忽略直接赋值（否则后面的断言没有意义）
  const sanity = await page.evaluate(() => {
    const el = document.getElementById("f1");
    el.value = "直接赋值";
    const afterDirect = window.__state.f1;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { afterDirect, afterEvent: window.__state.f1 };
  });
  R.t("自检：受控组件忽略直接赋值", sanity.afterDirect === "", sanity.afterDirect);

  // ---- ① 识别 ----
  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1500);
  const scanned = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".aa-card .aa-stem")].map(s => s.textContent),
    fillChips: [...document.querySelectorAll(".aa-card .aa-chip")].map(c => c.textContent).filter(t => t === "填空").length,
  }));
  console.log("识别到的卡片:\n  " + scanned.cards.join("\n  "));
  R.t("识别出 2 道填空题", scanned.cards.length === 2, scanned.cards.length);
  R.t("卡片标注了「填空」", scanned.fillChips === 2, scanned.fillChips);
  R.t("登录框/搜索框没被当成题目", !scanned.cards.some(t => /用户名|密码|搜索/.test(t)), scanned.cards);

  // ---- ②③ 填涂（走面板的「✍ 填涂」）----
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
    btn.click();
  });
  let finished = false;
  for (let i = 0; i < 12 && !finished; i++) {
    await H.sleep(1000);
    finished = await page.evaluate(() =>
      /填涂结束/.test(document.querySelector(".aa-panel .aa-info")?.textContent || ""));
  }
  const r = await page.evaluate(() => ({
    msg: document.querySelector(".aa-panel .aa-info")?.textContent || "",
    state: window.__state,
    directValue: document.getElementById("f1").value,   // 受控组件：getter 返回 domValue
    f2Value: document.getElementById("f2").value,
    cards: [...document.querySelectorAll(".aa-card .aa-answer")].map(a => a.textContent),
  }));
  console.log("\n面板状态行:", r.msg);
  console.log("卡片反馈:", JSON.stringify(r.cards));
  console.log("输入框状态:", JSON.stringify(r.state));

  R.t("填涂流程走到结束", finished, r.msg.slice(0, 30));
  R.t("③ 受控输入框被写进去了（走原生 setter 才可能）", r.state.f1 === "北京", r.state.f1);
  R.t("② 普通输入框被写进去了", r.state.f2 === "北京", r.state.f2);
  R.t("状态行汇报成功 2 道", /成功 2/.test(r.msg), r.msg);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
