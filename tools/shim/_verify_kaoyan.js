
const fs = require("fs");
const path = require("path");

// 题库文件按**相对本脚本**定位，并从 index.json 里按 label 找 —— 不再写死
// "D:/111111/..."（换机器/换盘符必失败），也不再写死 "21_考研英语.json"
// （题库重编号后那个文件名已不在册，只能读到残留的孤儿文件）。
const BANK_DIR = path.join(__dirname, "..", "..", "quiz-app", "bank");
const BANK = (() => {
  const idx = JSON.parse(fs.readFileSync(path.join(BANK_DIR, "index.json"), "utf8"));
  const hit = idx.find(it => /考研英语/.test((it && it.label) || "")) || idx.find(it => /考研英语/.test((it && it.file) || ""));
  if (!hit) throw new Error("index.json 里找不到「考研英语」类别");
  return path.join(BANK_DIR, hit.file);
})();

function normalize(t){return (t||"").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"").trim();}
function optKey(t){return normalize(String(t==null?"":t).replace(/^\s*[A-Za-z]\s*[).、．,，:：]\s*/,""));}

(async () => {
  const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
  const exact = new Map();
  for (const q of bank.questions) {
    const k = normalize(q.question);
    (exact.get(k) || exact.set(k, []).get(k)).push(q);
  }
  let multi = null;
  for (const [k, v] of exact) if (v.length > 1) { multi = [k, v]; break; }
  console.log("重复题干示例:", multi[1][0].question);
  console.log("变体数:", multi[1].length);

  function remapAnswer(cand, pageOptions) {
    const ans = Array.isArray(cand.answer) ? cand.answer : [];
    if (!ans.length) return null;
    const bankOpts = cand.options || [];
    const pageKeys = pageOptions.map(optKey);
    const sameOrder = ans.every(i => { const k = optKey(bankOpts[i]); return k && pageKeys[i] === k; });
    if (sameOrder) return ans;
    const mapped = ans.map(i => { const k = optKey(bankOpts[i]); return k ? pageKeys.indexOf(k) : -1; });
    if (mapped.every(i => i >= 0)) return [...new Set(mapped)].sort((a,b)=>a-b);
    return null;
  }

  // Test EVERY duplicate-stem variant: page shows that variant's options -> must pick that variant
  let ok = 0, fail = 0;
  for (const [k, variants] of exact) {
    if (variants.length < 2) continue;
    for (const target of variants) {
      const pageOptions = target.options.slice();
      let picked = null;
      for (const cand of variants) { const a = remapAnswer(cand, pageOptions); if (a) { picked = { cand, a }; break; } }
      if (picked && JSON.stringify(picked.a) === JSON.stringify(target.answer)) ok++;
      else fail++;
    }
  }
  console.log("\n重复题干变体逐个验证：正确", ok, " 错误", fail);

  // Negative test: unrelated page options must yield NO match (not a wrong answer)
  let wrongMatch = 0;
  const wrongPage = ["完全无关的选项甲","完全无关的选项乙","完全无关的选项丙","完全无关的选项丁"];
  for (const [k, variants] of exact) {
    if (variants.length < 2) continue;
    for (const cand of variants) { const a = remapAnswer(cand, wrongPage); if (a) { wrongMatch++; break; } }
  }
  console.log("无关选项页被误判为命中的组数:", wrongMatch, wrongMatch === 0 ? "✅ 宁缺勿错" : "⚠");
})().catch(e=>console.log("ERR", e.message));
