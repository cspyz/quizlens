"use strict";
/*
 * CSS 级联回归测试 —— 钉住"暂停/停止按钮被样式表藏掉"这个具体缺陷。
 *
 * 用户两轮截图反馈"没有暂停按钮"。真因是两条叠加：
 *   ① CSS 里写着 .aa-runlog-wrap{display:none}，而 JS 用 style.display="" 去"显示"它；
 *      空串只是清掉行内值，**不会**覆盖样式表 → 整行表头（含两个按钮）永远隐藏。
 *   ② 台架的 getComputedStyle 把空串当成有效覆盖值 → 测试误判为"可见"，全绿。
 * 这个测试同时盯住这两条。
 */
const fs = require("fs");
const path = require("path");
const dom = require("./dom.js");
const T = require("./env");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });
const EMPTY = String.fromCharCode(34) + String.fromCharCode(34);   // 两个字面双引号

// ---------- ① 台架必须像真实浏览器一样：空串不覆盖样式表 ----------
{
  const html = '<html><head><style>.x{display:none}</style></head><body>' +
    '<div class="x" id="w"><button id="b">暂停</button></div></body></html>';
  const doc = dom.parseDocument(html);
  const w = doc.getElementById("w");
  const b = doc.getElementById("b");
  t("台架：样式表 display:none 时元素不可见", dom.getComputedStyle(w).display === "none",
    dom.getComputedStyle(w).display);
  w.style.display = "";
  t("台架：行内空串不覆盖样式表（真实浏览器语义）",
    dom.getComputedStyle(w).display === "none", dom.getComputedStyle(w).display);
  t("台架：被祖先藏着时子元素 offsetParent 为 null", b.offsetParent === null, String(b.offsetParent));
  w.style.display = "block";
  t("台架：行内 block 能覆盖样式表", dom.getComputedStyle(w).display === "block",
    dom.getComputedStyle(w).display);
  t("台架：覆盖后子元素可见", !!b.offsetParent, String(b.offsetParent));
}

// ---------- ② 产品 CSS 里不能再对 .aa-runlog-wrap 写 display:none ----------
{
  const src = fs.readFileSync(path.join(T.ROOT, "extension", "content.js"), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");   // 去掉注释（注释里会提到历史写法）
  const m = stripped.match(/\.aa-runlog-wrap\s*\{([^}]*)\}/);
  t("产品 CSS：存在 .aa-runlog-wrap 规则", !!m, m ? m[1].slice(0, 60) : "(未找到)");
  t("产品 CSS：该规则里没有 display:none", !!m && !/display\s*:\s*none/.test(m[1]),
    m ? m[1].slice(0, 80) : "");
}

// ---------- ③ 代码里不能再用空串来"显示"表头 ----------
{
  const raw = fs.readFileSync(path.join(T.ROOT, "extension", "content.js"), "utf8");
  // 必须先去掉注释：文件里的注释正**记载**着这条历史写法，否则永远命中注释、假失败。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const re = new RegExp("aa-runlog-wrap[\\s\\S]{0,120}?style\\.display\\s*=\\s*" + EMPTY);
  const found = re.test(src);
  t("产品代码：不用空串显示表头", !found, found ? "发现空串赋值" : "未发现");
}

console.log("----- 断言 -----");
for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
const all = results.every(r => r.ok);
console.log("");
console.log("===== " + (all ? "ALL PASS OK" : "HAS FAILURES") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
process.exit(all ? 0 : 1);