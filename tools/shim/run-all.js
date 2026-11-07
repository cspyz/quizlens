"use strict";
/**
 * 一键跑全部 shim 单测。
 *
 * 特点：纯 Node 标准库，不依赖 playwright、不拉起浏览器、不联网。
 * 这是本仓库唯一可以在任何机器（含 CI）上稳定跑通的测试入口。
 *
 * 用法：node tools/shim/run-all.js
 * 单个用例：node tools/shim/<name>-test.js
 *
 * 与 tools/extension-test/run-all.js 的区别：
 *   extension-test 是 Playwright 真浏览器 e2e（覆盖真实 DOM 与扩展生命周期），
 *   需要 `npm i -D playwright && npx playwright install chromium`，且对环境敏感；
 *   shim 用 extension/content.js 未修改的源码 + 最小 DOM 桩，覆盖消息层与状态机。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const ROOT = path.join(DIR, "..", "..");
// 实测最慢的是 run-cards-test.js（约 134s，CI 机器更慢），留足余量
const PER_TEST_TIMEOUT_MS = 300000;

const files = fs.readdirSync(DIR)
  .filter(f => /-test\.js$/.test(f))
  .sort();

if (!files.length) {
  console.error("没有找到任何 *-test.js");
  process.exitCode = 1;
  return;
}

const failures = [];
const started = Date.now();

console.log("shim 单测：共 %d 个用例文件\n", files.length);

for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: PER_TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = (out.match(/=====[^\n]*=====/) || [""])[0].trim();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 判定顺序：显式 PASS 才是通过。只看退出码不够——部分用例脚本自身不设 exitCode。
  const ok = /ALL PASS/.test(summary) && !/HAS FAILURES/.test(summary) && r.status === 0;

  if (ok) {
    console.log("  ✅ %s  (%ss)", f.padEnd(34), elapsed);
  } else {
    console.log("  ❌ %s  (%ss)", f.padEnd(34), elapsed);
    const bad = out.split("\n").filter(l => /\bFAIL\b|Error|error:|timeout/i.test(l)).slice(0, 6);
    (bad.length ? bad : [summary || out.split("\n").slice(-4).join("\n")])
      .forEach(l => console.log("       " + l.trim().slice(0, 180)));
    failures.push(f);
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log("\n" + "-".repeat(52));
if (failures.length) {
  console.log("失败 %d / %d，用时 %ss", failures.length, files.length, total);
  console.log("失败文件：\n  " + failures.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("全部通过：%d / %d，用时 %ss", files.length, files.length, total);
}
