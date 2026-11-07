/**
 * 端到端命中测试：把 C-Eval 真实题目摆成网页，验证题库能匹配并勾对下标。
 * 「能加载」不等于「能匹配」—— 本文件专测后者。
 *
 * 用法：node tools/extension-test/ceval-hit-test.js
 */
const H = require("./harness");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");
const BANK = path.join(ROOT, "_release", "bank-ceval");
const PORT = 8102;
const { chromium } = H.ensurePlaywright();

// 从新包里取若干学科的真实题，覆盖不同形态：纯文本、含 Shell $、含中文标点、含百分号
const WANT = ["operating_system", "college_economics", "high_school_history",
              "electrical_engineer", "art_studies", "law"];

function pickQuestions() {
  const idx = JSON.parse(fs.readFileSync(path.join(BANK, "index.json"), "utf-8"));
  const out = [];
  for (const e of idx) {
    const subj = WANT.find(w => e.file.includes(w));
    if (subj === undefined) continue;
    const d = JSON.parse(fs.readFileSync(path.join(BANK, e.file), "utf-8"));
    for (const q of d.questions.slice(0, 4)) out.push({ ...q, subject: subj });
  }
  return out;
}

const QS = pickQuestions();

function pageFor(q) {
  return `<!doctype html><meta charset="utf-8"><title>ceval hit</title><body>
<div class="question"><div class="q-stem">${q.question}</div>
${q.options.map(o => `<div class="opt"><input type="radio" name="q1"><span class="opt-text">${o}</span></div>`).join("\n")}
</div></body>`;
}

const r = H.Reporter();

async function waitDone(page, tries = 14) {
  const read = () => page.evaluate(
    () => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
  for (let i = 0; i < tries; i++) {
    await H.sleep(2000);
    const t = await read();
    if (/完成：题库命中/.test(t)) return t;
  }
  return await read();
}

(async () => {
  r.t("新包题目已取到", QS.length > 0, `共 ${QS.length} 题，来自 ${[...new Set(QS.map(q => q.subject))].join(", ")}`);
  if (!QS.length) { r.finish(); return; }

  const routes = {};
  QS.forEach((q, i) => { routes[`/q${i}.html`] = pageFor(q); });
  const site = await H.serve({ port: PORT, staticDir: BANK, routes });
  const root = path.join(ROOT, ".ext-test-profiles");
  fs.mkdirSync(root, { recursive: true });
  const udd = fs.mkdtempSync(path.join(root, "aa-hit-"));
  let ctx = null;
  let hit = 0, wrong = 0, miss = 0;
  const failures = [];
  try {
    ctx = await chromium.launchPersistentContext(udd, {
      headless: false,
      args: ["--headless=new", `--disable-extensions-except=${H.EXT}`, `--load-extension=${H.EXT}`, "--no-sandbox"],
    });
    let sw = ctx.serviceWorkers()[0];
    for (let i = 0; i < 30 && !sw; i++) { await H.sleep(500); sw = ctx.serviceWorkers()[0]; }
    if (!sw) { r.t("扩展加载", false, "(no service worker)"); r.finish(); return; }

    for (let i = 0; i < QS.length; i++) {
      const q = QS[i];
      const url = `http://localhost:${PORT}/q${i}.html`;
      const p = await ctx.newPage();
      await p.goto(url);
      await p.waitForSelector(".question", { timeout: 10000 }).catch(() => {});
      await H.sleep(1200);
      await sw.evaluate(async ({ pattern, m }) => {
        const tabs = await chrome.tabs.query({ url: pattern });
        if (tabs.length) await chrome.tabs.sendMessage(tabs[0].id, m);
      }, { pattern: url, m: { type: "START", settings: { mode: "bank", intervalMs: 0, fillHosts: "*", showLog: true, bankBaseUrl: "http://localhost:" + PORT + "/" } } });
      const log = await waitDone(p);
      const checked = await p.evaluate(() => [...document.querySelectorAll(".opt input")].map(x => x.checked));
      const idx = checked.findIndex(x => x);
      const matched = /题库命中 1/.test(log);
      if (matched && idx === q.answer[0]) hit++;
      else if (matched && idx !== q.answer[0]) { wrong++; failures.push({ subject: q.subject, want: q.answer[0], got: idx, q: q.question.slice(0, 40) }); }
      else { miss++; failures.push({ subject: q.subject, want: q.answer[0], got: idx, miss: true, q: q.question.slice(0, 40), log: (log.match(/(未匹配|失败)[^\n]*/) || [""])[0].slice(0, 90) }); }
      await p.close();
    }
    r.t(`${QS.length} 道 C-Eval 真题：全部命中且勾对下标`, wrong === 0 && miss === 0,
      `命中 ${hit} / 勾错 ${wrong} / 未命中 ${miss}`);
    if (failures.length) console.log("明细：\n" + JSON.stringify(failures.slice(0, 8), null, 1));
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    await site.close().catch(() => {});
    fs.rmSync(udd, { recursive: true, force: true, maxRetries: 5 });
  }
  r.finish();
})();
