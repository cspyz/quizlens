"use strict";
const T = require("./env");
const sleep = T.sleep;
const PAGE = [
  "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>",
  "<div class=\"question\"><div>2. 水的化学式是 ____ 。</div>",
  "<input class=\"blank-input\" type=\"text\"></div>",
  "</body></html>",
].join("");
(async () => {
  const env = T.makeEnv({ html: PAGE, storage: { mode: "ai", aiKey: "sk-test", interval: "0", showLog: true }, aiReply: { ok: true, text: "H2O" } });
  env.runInlineScripts();
  env.injectContent();
  env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
  await sleep(2500);
  const runlog = env.doc.querySelector(".aa-runlog");
  console.log("RUNLOG:", runlog ? runlog.textContent.slice(0, 600) : "(none)");
  console.log("PANEL:", env.panel() ? env.panel().textContent.slice(0, 500) : "(none)");
  console.log("AI_CALLS:", env.stats.aiCalls.length);
  console.log("BLANKS:", JSON.stringify(env.blanks()));
  console.log("QUESTION_COUNT:", env.doc.querySelectorAll(".question").length);
  console.log("BLANK_INPUT_COUNT:", env.doc.querySelectorAll("input.blank-input").length);
  console.log("ERRORS:", JSON.stringify(env.errors()).slice(0, 300));
})();
