"use strict";
/*
 * 输出模式（只输出答案 / 答案+解析 / 完整功能）的回归测试。
 *
 * 为什么单独一套：本仓库原有的 tools/extension-test/* 是 Playwright 套件，
 * 在当前机器上**一律以 "browserType.launch: spawn EPERM" 失败**（沙箱不允许拉起浏览器）。
 * 本次改动全都在"发给模型的 prompt / 请求字段 / 卡片渲染"这一层，
 * 正好是不依赖渲染、只依赖消息内容的可观测行为，用 tools/shim 的纯 Node 台架测最稳。
 *
 * 覆盖：
 *   ① 默认（不传 answerMode / 传非法值）必须是「答案 + 解析」且**不带思考**
 *   ② answer 模式：prompt 明确"不要解释"，且 think 字段不出现
 *   ③ full 模式：prompt 要求详细解析，think=true（后台据此加 reasoning_effort）
 *   ④ 解析显示：standard/full 显示解析，answer 不显示
 *   ⑤ 思考内容（独立字段 reasoning）只显示在 🧠 块里，**绝不参与取答案**
 *   ⑥ 填空题：解析不会被当成第 2 个空的答案
 *   ⑦ 后台：thinking 字段透传 + 平台 400 时自动降级重发 + 思考内容走独立字段
 *   ⑧ 自动填涂仍然只取答案字母（解析里的 "A 选项错误" 不能把 A 勾上）
 */
const T = require("./env");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });
const sleep = T.sleep;
// 断言失败时只打印 system 的开头，别把整段 prompt 刷进日志
const c0 = calls => (calls[0] ? calls[0].system.slice(0, 48) : "(无调用)");

// 一个"标准模式"该有的模型回复：第一行答案，空行后解析
const REPLY_STD = "答案：A\n\nMySQL 是关系型数据库，Nginx 是 Web 服务器，Redis 是缓存，故选 A。";
// 一个"只输出答案"该有的回复
const REPLY_BARE = "A";
// 完整功能：模型回复 + 后台另外回传的思考内容。
// 思考内容里**故意**埋了别的字母，用来验证它不会被当成答案。
const REPLY_FULL = "答案：A\n\n逐项分析：MySQL 是关系型数据库（正确）；Nginx 是反向代理；Redis 是内存缓存。故选 A。";
const REASONING = "先看四个选项。B 和 C 都是服务器/缓存软件，排除。答案是 A，因为 MySQL 才是数据库。";

function boot({ answerMode, aiReply = REPLY_STD, reasoning = "" } = {}) {
  const storage = { mode: "ai", aiKey: "sk-test", aiModel: "deepseek-chat", interval: "0" };
  if (answerMode !== undefined) storage.answerMode = answerMode;
  const env = T.makeEnv({ storage, aiReply: { ok: true, text: aiReply, reasoning } });
  env.injectContent();
  env.startScan();
  return env;
}

(async () => {
  // ---------- ① 默认模式 ----------
  {
    const env = boot({});                       // 完全没有 answerMode 这个 key
    await sleep(200);
    t("默认：识别到 4 道题", env.cards().length === 4, env.cards().length);
    await env.clickAllAnswers();
    const calls = env.stats.aiCalls;
    t("默认：全部走 AI", calls.length === 4, calls.length);
    t("默认：不带 think 字段（不开启思考模式）", calls.every(c => c.think === false), calls.map(c => c.think));
    // 前 3 张是选择题（走 askAI），第 4 张是填空题（走 askAIFill，另一套 prompt），
    // 所以针对选择题的 prompt 断言只看前三张卡片对应的调用
    const choice = calls.slice(0, 3);
    t("默认：prompt 要求「空一行后再写解析」", choice.every(c => /空一行后再写解析/.test(c.system)), c0(calls));
    t("默认：prompt 是简明解析（不超过 150 字）", choice.every(c => /不超过 150 字/.test(c.system)), "");
    t("默认：prompt 不要求逐项详细解析", choice.every(c => !/逐项说明/.test(c.system)), "");
    t("默认：填空题走另一套 prompt（要求解析另起一行）", /以「解析：」开头/.test(calls[3].system) && !/空一行后再写解析/.test(calls[3].system), c0(calls.slice(3)));
    const parts = env.cardParts();
    t("默认：卡片显示了解析", parts[0].explainShown && /MySQL 是关系型数据库/.test(parts[0].explain), parts[0].explain);
    t("默认：解析里不重复显示第一行的「答案：A」", !/^答案：A/.test(parts[0].explain), parts[0].explain);
    t("默认：没有思考块内容", parts.every(p => !p.thinkShown), "");
    t("默认：无异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 300));
  }

  // ---------- ② 只输出答案 ----------
  {
    const env = boot({ answerMode: "answer", aiReply: REPLY_BARE });
    await sleep(200);
    await env.clickAllAnswers();
    const calls = env.stats.aiCalls;
    t("answer：prompt 明确「不要输出任何解释」", calls.slice(0, 3).every(c => /不要输出任何解释/.test(c.system)), c0(calls));
    t("answer：prompt 不包含「空一行后再写解析」", calls.every(c => !/空一行后再写解析/.test(c.system)), "");
    t("answer：不带 think 字段", calls.every(c => c.think === false), calls.map(c => c.think));
    const parts = env.cardParts();
    t("answer：卡片只显示答案", parts[0].answer === "A" && !parts[0].explainShown, JSON.stringify(parts[0]));
    t("answer：无异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 300));
  }

  // ---------- ③ 完整功能（思考模式 + 详细解析） ----------
  {
    const env = boot({ answerMode: "full", aiReply: REPLY_FULL, reasoning: REASONING });
    await sleep(200);
    await env.clickAllAnswers();
    const calls = env.stats.aiCalls;
    t("full：带 think=true（后台据此加 reasoning_effort）", calls.every(c => c.think === true), calls.map(c => c.think));
    t("full：prompt 要求逐项详细解析", calls.slice(0, 3).every(c => /逐个选项说明为什么对、为什么错/.test(c.system)), c0(calls));
    const parts = env.cardParts();
    t("full：卡片显示详细解析", parts[0].explainShown && /逐项分析/.test(parts[0].explain), parts[0].explain.slice(0, 60));
    t("full：卡片单独显示思考过程", parts[0].thinkShown && /🧠 思考过程/.test(parts[0].think) && /先看四个选项/.test(parts[0].think), parts[0].think.slice(0, 40));
    t("full：思考内容不混进解析块", !/先看四个选项/.test(parts[0].explain), parts[0].explain.slice(0, 60));
    t("full：答案仍只取第一行（思考里的 B/C 没被算进去）", parts[0].answer === "A", parts[0].answer);
    t("full：无异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 300));
  }

  // ---------- ④ 非法值必须落回默认 ----------
  {
    const env = boot({ answerMode: "FULL_MODE_TYPO", aiReply: REPLY_STD });
    await sleep(200);
    await env.clickAllAnswers();
    const calls = env.stats.aiCalls;
    t("非法 answerMode：落回「答案 + 解析」而不是思考模式", calls.slice(0, 3).every(c => c.think === false && /空一行后再写解析/.test(c.system)), c0(calls));
  }

  // ---------- ⑤ 解析里的字母绝不能污染填涂 ----------
  {
    // 回复的第一行是 C，但解析里提到 "A 选项错误、B 也不对"。
    // 全文扫描字母的老 bug 会把 A、B、C 全勾上。
    const env = boot({
      answerMode: "standard",
      aiReply: "答案：C\n\nA 选项错误，B 也不对，只有 C 正确。",
    });
    await sleep(200);
    await env.clickAllAnswers();
    const parts = env.cardParts();
    t("取答案：只认第一行 C", parts[0].answer === "C", parts[0].answer);
    t("取答案：解析原样显示但不参与取字母", /A 选项错误/.test(parts[0].explain), parts[0].explain.slice(0, 40));

    // 再走一遍「开始答题」的自动填涂，确认落到页面上的只有 C
    const env2 = T.makeEnv({
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard", fuzzyThreshold: 75 },
      aiReply: { ok: true, text: "答案：C\n\nA 选项错误，B 也不对，只有 C 正确。" },
    });
    env2.injectContent();
    env2.start({ fillHosts: "*" });
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      if (/完成：题库命中/.test(env2.logText())) break;
    }
    const checked = env2.checked();
    t("自动填涂：第 1 题只勾了 C（下标 2）", JSON.stringify(checked[0].idx) === "[2]", JSON.stringify(checked[0].idx));
    t("自动填涂：三道选择题都勾了 C", checked.slice(0, 3).every(c => JSON.stringify(c.idx) === "[2]"), JSON.stringify(checked.slice(0, 3).map(c => c.idx)));
  }

  // ---------- ⑥ 填空题：解析不能被当成第 2 个空的答案 ----------
  {
    const html = T.pageHtml({ blanks: 2 });
    const env = T.makeEnv({
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
      html,
      aiReply: { ok: true, text: "1. 北京\n2. 上海\n\n解析：北京是政治中心，上海是经济中心。" },
    });
    env.injectContent();
    env.startScan();
    await sleep(200);
    await env.clickAllAnswers();
    const parts = env.cardParts();
    t("填空：答案取到两行", /北京/.test(parts[3].answer) && /上海/.test(parts[3].answer), parts[3].answer);
    t("填空：解析单独显示、没混进答案", !/解析：/.test(parts[3].answer) && /政治中心/.test(parts[3].explain), JSON.stringify(parts[3]).slice(0, 160));

    // 真填进去（走「✍ 填涂」），确认两个输入框拿到的是 北京 / 上海
    const fillBtn = [...env.panel().querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
    fillBtn.click();
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      if (/填涂结束/.test((env.panel().querySelector(".aa-info") || {}).textContent || "")) break;
    }
    const blanks = env.blanks();
    t("填空：两个空分别写入 北京 / 上海", blanks[0] === "北京" && blanks[1] === "上海", JSON.stringify(blanks));
    t("填空：解析文字没被写进任何输入框", blanks.every(v => !/解析|政治中心/.test(v)), JSON.stringify(blanks));
  }

  // ---------- ⑦ 后台：思考字段 + 400 降级 ----------
  {
    // 平台认识 reasoning_effort：原样发出去，思考内容走独立字段
    const okBody = JSON.stringify({ choices: [{ message: { content: "答案：A", reasoning_content: "思考……" } }] });
    const bg = T.makeBackground({
      storage: { aiKey: "k", aiBaseUrl: "https://api.example.com", aiModel: "deepseek-chat" },
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return okBody; } }),
    });
    const r1 = await bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.example.com", key: "k", model: "m", messages: [{ role: "user", content: "q" }], think: true } });
    t("后台：think=true 时请求体带 reasoning_effort", bg.calls[0].body.reasoning_effort === "medium", JSON.stringify(bg.calls[0].body.reasoning_effort));
    t("后台：思考内容走独立 reasoning 字段", r1.ok && r1.reasoning === "思考……", JSON.stringify(r1).slice(0, 120));
    t("后台：text 里不含思考内容（避免污染取字母）", r1.text === "答案：A", r1.text);

    // think=false：一个字段都不该多
    bg.calls.length = 0;
    await bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.example.com", key: "k", model: "m", messages: [], think: false } });
    t("后台：think=false 时请求体不带 reasoning_effort", !("reasoning_effort" in bg.calls[0].body), Object.keys(bg.calls[0].body).join(","));

    // 平台不认识 reasoning_effort：400 → 自动去掉字段重发一次
    const bg2 = T.makeBackground({
      storage: { aiKey: "k" },
      fetchImpl: async (url, init, n) => {
        const body = JSON.parse(init.body);
        if ("reasoning_effort" in body) {
          return { ok: false, status: 400, async text() { return '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}'; } };
        }
        return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：B" } }] }); } };
      },
    });
    const r2 = await bg2.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.example.com", key: "k", model: "m", messages: [], think: true } });
    t("后台降级：共发了两次请求", bg2.calls.length === 2, bg2.calls.length);
    t("后台降级：第二次去掉了 reasoning_effort", bg2.calls[1] && !("reasoning_effort" in bg2.calls[1].body), bg2.calls[1] && Object.keys(bg2.calls[1].body).join(","));
    t("后台降级：最终仍然拿到答案", r2.ok && r2.text === "答案：B", JSON.stringify(r2).slice(0, 100));

    // 不相关的 400（余额不足/模型名错）不该白重发一次
    const bg3 = T.makeBackground({
      storage: { aiKey: "k" },
      fetchImpl: async () => ({ ok: false, status: 400, async text() { return '{"error":{"message":"Insufficient Balance"}}'; } }),
    });
    const r3 = await bg3.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.example.com", key: "k", model: "m", messages: [], think: true } });
    t("后台：余额不足这类 400 不重发", bg3.calls.length === 1, bg3.calls.length);
    t("后台：错误原样报给页面", r3.ok === false && /400/.test(r3.error), r3.error);

    // 截图解题（REGION_SELECTED）：输出模式同样生效 ——
    // answerMode 从 storage 读，full 模式要带 reasoning_effort，结果推给页面
    const shotBody = JSON.stringify({ choices: [{ message: { content: "1. A", reasoning_content: "看图……" } }] });
    const bgShot = T.makeBackground({
      storage: { aiKey: "k", aiBaseUrl: "https://api.example.com", aiModel: "m", visionModel: "glm-4v-flash", answerMode: "full" },
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return shotBody; } }),
    });
    await bgShot.send({ type: "REGION_SELECTED", rect: { left: 0, top: 0, width: 10, height: 10 }, vw: 100 });
    t("后台：截图解题在 full 模式带 reasoning_effort", bgShot.calls.length === 1 && bgShot.calls[0].body.reasoning_effort === "medium", bgShot.calls.length ? Object.keys(bgShot.calls[0].body).join(",") : "(未发请求)");
    const shotFinal = bgShot.replies.filter(r => r.type === "ANSWER" && r.ok === true).pop();
    t("后台：截图结果里含思考内容", !!shotFinal && /思考过程/.test(shotFinal.text) && /看图/.test(shotFinal.text), shotFinal ? shotFinal.text.slice(0, 40) : "(无结果)");

    const bgShotStd = T.makeBackground({
      storage: { aiKey: "k", aiBaseUrl: "https://api.example.com", aiModel: "m", visionModel: "glm-4v-flash", answerMode: "standard" },
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return shotBody; } }),
    });
    await bgShotStd.send({ type: "REGION_SELECTED", rect: { left: 0, top: 0, width: 10, height: 10 }, vw: 100 });
    t("后台：截图解题在默认模式不带 reasoning_effort", bgShotStd.calls.length === 1 && !("reasoning_effort" in bgShotStd.calls[0].body), bgShotStd.calls.length ? Object.keys(bgShotStd.calls[0].body).join(",") : "(未发请求)");
    const shotStd = bgShotStd.replies.filter(r => r.type === "ANSWER" && r.ok === true).pop();
    t("后台：默认模式截图结果不含思考内容", !!shotStd && !/思考过程/.test(shotStd.text), shotStd ? shotStd.text.slice(0, 40) : "(无结果)");

    // TEXT_CHAT（老接口）：输出模式也要生效
    const bgText = T.makeBackground({
      storage: { aiKey: "k" },
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "1. A" } }] }); } }),
    });
    await bgText.send({ type: "TEXT_CHAT", payload: { question: "1. 下列哪个是数据库？", answerMode: "answer", think: false } });
    t("后台：TEXT_CHAT 的 answer 模式要求不解释", bgText.calls.length === 1 && /不要输出任何解释/.test(bgText.calls[0].body.messages[0].content), bgText.calls[0] ? bgText.calls[0].body.messages[0].content.slice(0, 40) : "(未发请求)");
    await bgText.send({ type: "TEXT_CHAT", payload: { question: "1. 下列哪个是数据库？", answerMode: "full", think: true } });
    t("后台：TEXT_CHAT 的 full 模式带 reasoning_effort", bgText.calls[1] && bgText.calls[1].body.reasoning_effort === "medium", bgText.calls[1] ? Object.keys(bgText.calls[1].body).join(",") : "(未发请求)");
    t("后台：TEXT_CHAT 的 full 模式要求详细解析", bgText.calls[1] && /解析要详细/.test(bgText.calls[1].body.messages[0].content), "");
  }

  // ---------- ⑧ 独立验证发现的边界（全部固化成回归） ----------
  {
    // 8.1 平台不支持思考字段时，必须让用户看得见（不能静默退化成普通模式）
    const bg = T.makeBackground({
      storage: { aiKey: "k" },
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if ("reasoning_effort" in body) {
          return { ok: false, status: 400, async text() { return '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}'; } };
        }
        return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：A" } }] }); } };
      },
    });
    const r = await bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://a.com", key: "k", model: "m", messages: [], think: true } });
    t("降级可见：应答里带 thinkDowngraded 标志", r.ok && r.thinkDowngraded === true, JSON.stringify(r).slice(0, 90));

    // 8.2 真实平台风格的 400 不能白重发（模型名写错 / 余额不足 / 上下文超长）
    const bad400 = [
      ["模型名写错", '{"error":{"message":"The model gpt-9 does not exist","type":"invalid_request_error"}}'],
      ["余额不足", '{"error":{"message":"Insufficient Balance","type":"invalid_request_error"}}'],
      ["上下文超长", '{"error":{"message":"maximum context length is 65536 tokens","type":"invalid_request_error"}}'],
      ["temperature 非法", '{"error":{"message":"Invalid value for temperature","type":"invalid_request_error"}}'],
    ];
    for (const [name, body] of bad400) {
      const b = T.makeBackground({ storage: { aiKey: "k" }, fetchImpl: async () => ({ ok: false, status: 400, async text() { return body; } }) });
      await b.send({ type: "AI_CHAT", payload: { baseUrl: "https://a.com", key: "k", model: "m", messages: [], think: true } });
      t(`无关 400 不重发（${name}）`, b.calls.length === 1, b.calls.length);
    }

    // 8.3 取答案：新增的解析模式会主动要解析，否定式/解释式措辞必须取对答案
    //     （这些句子只有写了才能出现，所以是本功能放大的风险面）
    const bgCase = async text => {
      const e = T.makeEnv({ storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" }, aiReply: { ok: true, text } });
      e.injectContent(); e.startScan();
      await sleep(200);
      await e.clickAllAnswers();
      return e.cardParts()[0].answer;
    };
    t("取答案：否定式「不是 A，是 C」→ C", await bgCase("正确答案不是 A，是 C。") === "C", "");
    t("取答案：解释式「因为 A、B 都不对，所以选 C」→ C", await bgCase("因为 A、B 都不对，所以选 C。") === "C", "");
    t("取答案：无标记但首行是解释 → 取到 C", await bgCase("因为 A、B 都不对，所以选 C") === "C", "");

    // 8.4 填空题：解析标记的 markdown 变体不能让解析漏进输入框
    const blankCase = async text => {
      const e = T.makeEnv({
        storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
        html: T.pageHtml({ blanks: 2 }), aiReply: { ok: true, text },
      });
      e.injectContent(); e.startScan();
      await sleep(200);
      await e.clickAllAnswers();
      const btn = [...e.panel().querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
      btn.click();
      for (let i = 0; i < 60; i++) { await sleep(50); if (/填涂结束/.test((e.panel().querySelector(".aa-info") || {}).textContent || "")) break; }
      return e.blanks();
    };
    for (const [name, reply] of [
      ["markdown 加粗", "北京\n\n**解析：**北京是政治中心。"],
      ["markdown 标题", "北京\n\n## 解析：北京是政治中心。"],
      ["列表项", "北京\n\n- 解析：北京是政治中心。"],
      ["引用", "北京\n\n> 解析：北京是政治中心。"],
      ["答案解析：", "北京\n\n答案解析：北京是政治中心。"],
      ["全角空格缩进", "北京\n\n　解析：北京是政治中心。"],
      ["解析无冒号", "北京\n\n解析 北京是政治中心。"],
      ["同行解析（空格分隔）", "北京 解析：北京是政治中心。"],
      ["同行解析（括号）", "北京（解析：北京是政治中心。"],
    ]) {
      const got = await blankCase(reply);
      t(`填空：${name} 的解析不漏进输入框`, got[0] === "北京" && !/解析|政治中心/.test(got[1] || ""), JSON.stringify(got));
    }
    // 反向：合规的多空答案仍然要两个都填上（不能为了防泄漏把真答案也丢了）
    const two = await blankCase("1. 北京\n2. 上海\n\n解析：都是直辖市。");
    t("填空：合规多空仍全部填上", two[0] === "北京" && two[1] === "上海", JSON.stringify(two));
  }

  // ---------- 汇总 ----------
  console.log("----- 断言 -----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  got=${JSON.stringify(r.got)}`);
  const all = results.every(r => r.ok);
  console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} (${results.filter(r => r.ok).length}/${results.length}) =====`);
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
