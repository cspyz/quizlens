/**
 * 「阅读材料」（passage）回归测试 —— P1-4。
 *
 * 背景：自动填涂路径以前完全不挂材料，只有填空题那条路会带。
 * 于是「仅 AI / 题库 + AI 兜底」模式下遇到阅读理解题，发给模型的就是
 * 一道没头没脑的题干（"根据上述材料，作者认为……" 却看不到材料）。
 *
 * 但材料不能乱挂：页面顶部一段长说明会被挂到每一道题上（第 1 题的前兄弟就是它，
 * 第 2 题爬到父层还是它），白烧 token 还会让模型拿无关文字当依据。
 * 所以这里同时钉住「该挂的挂上」和「不该挂的绝不挂」两侧：
 *
 *   1 材料 + 有指示语的题干              → prompt 里必须有【阅读材料】，且点对
 *   2 长说明 + 没有指示语的题干          → 绝不能挂（否则等于每道题都塞一段无关文字）
 *   3 一份材料 + 两道题                  → 两道题都挂同一份材料，且题干不串（不张冠李戴）
 *   4 题干本身就比材料长（材料在题干里） → 不挂；同页短题干的题照挂
 *   5 练习页同构结构（.question/.q-stem）→ 也挂（这条走 getQuestionBlocks 路径）
 *   6 材料在祖先层的前兄弟（跨 wrapper） → 也挂（findPassage 要往上爬）
 *
 * 判定口径与 mis-pair-test 一致：捕获阶段全局 click 记 data-blk，
 * AI stub 按关键词给字母并把 prompt 原文留下来 —— 「扩展把哪段材料配给了哪道题」
 * 是可直接观察的。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8102;

const CLICK_HOOK = `
  window.__clicked = [];
  document.addEventListener("click", e => {
    const t = e.target;
    const blkEl = t.closest ? t.closest("[data-blk]") : null;
    window.__clicked.push({
      tag: t.tagName || "?",
      text: (t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      blk: blkEl ? blkEl.getAttribute("data-blk") : "(无区块)"
    });
  }, true);
`;

const page = body => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>passage</title></head>
<body>${body}</body></html>`;

// 材料：约 250 字。刻意不含"摆尾""日常"等只在题干里出现的词 ——
// 场景 3 要靠这些词区分"这道题的 prompt 里是不是混进了另一道题的题干"。
const MAT = `蜜蜂是高度社会化的昆虫，一个蜂群通常由一只蜂王、少量雄蜂和数万只工蜂组成。
工蜂的年龄决定了它的工种：刚羽化的幼蜂先在巢内清理巢房、饲喂幼虫，长大一些后转为分泌蜂蜡修筑巢脾，最后才出巢采集花蜜和花粉。
采集蜂在野外发现优质蜜源后，会回到巢脾上跳起舞蹈，用舞蹈的朝向告诉同伴蜜源相对于太阳的方位，用舞蹈持续的时间告诉同伴距离的远近。
蜂群依靠这种精确的交流方式，把分散的采集力量迅速集中到最有价值的花丛上，这也是它们能在短时间内找到大量食物的原因。`;

// 场景 2 用的长说明：本身够长（>=150 字，findPassage 会把它当候选），
// 但题干里没有"阅读/根据上述"这类指示语，所以不该被挂上去
const NOTICE = `欢迎使用本学习平台。请在使用前仔细阅读并同意以下使用条款：本平台提供的所有题目与解析仅供个人学习参考，
不构成任何形式的考试承诺；用户不得使用自动化脚本批量抓取题目内容，也不得将题库数据用于商业用途。
平台会记录必要的访问日志用于排查故障，不会向第三方出售个人信息。如对条款有异议，请停止使用并联系客服。`;

const OPTS = `
  <li data-blk="Q1-A">A. 通过翅膀振动发出不同频率的声音来指示方向</li>
  <li data-blk="Q1-B">B. 跳起舞蹈，用舞蹈的朝向和持续时间表示方位与距离</li>
  <li data-blk="Q1-C">C. 通过分泌信息素在巢脾上留下气味标记出行进路线</li>
  <li data-blk="Q1-D">D. 通过触角互相敲击，把距离编码成敲击的次数</li>`;

// 场景 3 的第二组选项（data-blk 前缀不同，便于断言点击落点）
const OPTS2 = `
  <li data-blk="Q2-A">A. 只负责在巢外采集花蜜和花粉并运回蜂巢</li>
  <li data-blk="Q2-B">B. 只负责守卫巢门，驱赶试图闯入蜂巢的入侵者</li>
  <li data-blk="Q2-C">C. 按年龄分工，从巢内清理饲喂逐步转为出巢采集</li>
  <li data-blk="Q2-D">D. 只负责分泌蜂蜡修筑巢脾，其余工作都由蜂王完成</li>`;

// 场景 4 的长题干：约 250 字，比材料还长 —— 内容既然已经在题干里，就不该再挂材料
const LONG_STEM = `1. 根据上述材料，请仔细阅读全文，结合材料中关于蜂群分工、舞蹈交流、蜜源选择以及巢脾修筑的全部描述，
综合分析蜜蜂在发现优质蜜源之后所采取的一系列行为，再对照材料里提到的方位、距离、持续时间等细节，
逐一比较下面四个选项的表述是否与原文一致，最后据此判断下列哪一项说法是正确的？
请务必只依据材料内容作答，不要使用你在其他地方了解到的知识，也不要凭常识进行推测，
因为有些说法虽然符合一般印象却并未在材料中出现。`;

const SPECS = [
  {
    path: "/1-reading.html",
    title: "1 材料 + 有指示语的题干 → 必须挂材料",
    rules: [["蜜蜂", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/【阅读材料】/, /蜜源相对于太阳的方位/, /根据上述材料/],
    promptMustNotHave: [/^A\. A\. /m],
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="material" data-blk="mat">${MAT}</div>
      <div class="stem" data-blk="Q1-stem">1. 根据上述材料，蜜蜂主要通过什么方式传递蜜源的位置？</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
    </div>`),
  },

  {
    path: "/2-no-hint.html",
    title: "2 长说明 + 题干没有指示语 → 绝不能挂",
    rules: [["编程语言", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/^1\. 下列哪一个是编程语言？$/m],
    promptMustNotHave: [/【阅读材料】/, /使用条款/],
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="notice" data-blk="notice">${NOTICE}</div>
      <div class="stem" data-blk="Q1-stem">1. 下列哪一个是编程语言？</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
    </div>`),
  },

  {
    path: "/3-two-questions.html",
    title: "3 一份材料 + 两道题 → 都挂同一份材料，题干不串",
    rules: [["摆尾", "B"], ["日常工作", "C"]],
    expect: ["Q1-B", "Q2-C"],
    promptMustHave: [],
    promptMustNotHave: [],
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="material" data-blk="mat">${MAT}</div>
      <div class="stem" data-blk="Q1-stem">1. 蜜蜂的摆尾舞主要传递什么信息？请依据上文回答。</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
      <div class="stem" data-blk="Q2-stem">2. 工蜂在蜂巢内部承担哪些日常工作？请依据上文回答。</div>
      <ul class="opts2" data-blk="Q2-opts">${OPTS2}
      </ul>
    </div>`),
    custom(ctx) {
      const has = re => ctx.prompts.filter(p => re.test(p)).length;
      const q1 = ctx.prompts.filter(p => /摆尾/.test(p));
      const q2 = ctx.prompts.filter(p => /日常工作/.test(p));
      return [
        ["[3] 两道题各发了一次 prompt", ctx.prompts.length === 2, ctx.prompts.length],
        ["[3] 两道题的 prompt 都带【阅读材料】", has(/【阅读材料】/) === 2, ctx.prompts],
        ["[3] 第 1 题的 prompt 是自己的题干 + 材料（没混进第 2 题）",
          q1.length === 1 && /【阅读材料】/.test(q1[0]) && !/日常工作/.test(q1[0]), q1],
        ["[3] 第 2 题的 prompt 是自己的题干 + 材料（没混进第 1 题）",
          q2.length === 1 && /【阅读材料】/.test(q2[0]) && !/摆尾/.test(q2[0]), q2],
      ];
    },
  },

  {
    path: "/4-long-stem.html",
    title: "4 题干比材料还长 → 不挂；同页短题干的题照挂",
    rules: [["只依据材料内容作答", "A"], ["日常工作", "C"]],
    expect: ["Q1-A", "Q2-C"],
    promptMustHave: [],
    promptMustNotHave: [],
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="material" data-blk="mat">${MAT}</div>
      <div class="stem" data-blk="Q1-stem">${LONG_STEM}</div>
      <ul class="opts" data-blk="Q1-opts">${OPTS}
      </ul>
      <div class="stem" data-blk="Q2-stem">2. 根据上述材料，工蜂在蜂巢内部承担哪些日常工作？</div>
      <ul class="opts2" data-blk="Q2-opts">${OPTS2}
      </ul>
    </div>`),
    custom(ctx) {
      const q1 = ctx.prompts.filter(p => /只依据材料内容作答/.test(p));
      const q2 = ctx.prompts.filter(p => /日常工作/.test(p));
      return [
        ["[4] 长题干的题不挂材料（内容已在题干里）",
          q1.length === 1 && !/【阅读材料】/.test(q1[0]), q1],
        ["[4] 同页短题干的题照常挂材料",
          q2.length === 1 && /【阅读材料】/.test(q2[0]), q2],
      ];
    },
  },

  {
    path: "/5-local-page.html",
    title: "5 练习页同构结构（.question/.q-stem/.opt-text）→ 也挂材料",
    // 题卡结构走的是"自建页"路径：pick() 直接改 input.checked + 派发 change，
    // 不产生真实 click（练习页就是监听 change 的）。所以这条按 checked 判落点。
    byChecked: true,
    rules: [["蜜蜂", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/【阅读材料】/, /蜜源相对于太阳的方位/, /^1\. 根据上述材料，蜜蜂主要通过什么方式传递蜜源的位置？$/m],
    promptMustNotHave: [/^A\. A\. /m],
    html: page(`
    <div class="material" data-blk="mat">${MAT}</div>
    <div class="question" data-blk="Q1">
      <span class="q-num">第 1 / 1 题</span>
      <div class="q-stem">1. 根据上述材料，蜜蜂主要通过什么方式传递蜜源的位置？</div>
      <label class="opt" data-blk="Q1-A"><input type="radio" name="q1" value="a"><span class="opt-text">A. 通过翅膀振动发出不同频率的声音来指示方向</span></label>
      <label class="opt" data-blk="Q1-B"><input type="radio" name="q1" value="b"><span class="opt-text">B. 跳起舞蹈，用舞蹈的朝向和持续时间表示方位与距离</span></label>
      <label class="opt" data-blk="Q1-C"><input type="radio" name="q1" value="c"><span class="opt-text">C. 通过分泌信息素在巢脾上留下气味标记出行进路线</span></label>
      <label class="opt" data-blk="Q1-D"><input type="radio" name="q1" value="d"><span class="opt-text">D. 通过触角互相敲击，把距离编码成敲击的次数</span></label>
    </div>`),
  },

  {
    path: "/6-nested.html",
    title: "6 材料在祖先层的前兄弟（跨 wrapper）→ 也挂",
    rules: [["蜜蜂", "B"]],
    expect: ["Q1-B"],
    promptMustHave: [/【阅读材料】/, /蜜源相对于太阳的方位/],
    promptMustNotHave: [/【阅读材料】[\s\S]*【阅读材料】/],   // 不能挂成两份
    html: page(`
    <div class="wrap" data-blk="wrap">
      <div class="material" data-blk="mat">${MAT}</div>
      <div class="qbox" data-blk="qbox">
        <div class="stem" data-blk="Q1-stem">1. 根据上述材料，蜜蜂主要通过什么方式传递蜜源的位置？</div>
        <ul class="opts" data-blk="Q1-opts">${OPTS}
        </ul>
      </div>
    </div>`),
  },
];

async function waitDone(page_) {
  for (let i = 0; i < 20; i++) {
    await H.sleep(500);
    const log = await page_.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
    if (/完成：题库命中\s*\d+/.test(log) || /本页没有可自动填涂的控件/.test(log)) return log;
  }
  return await page_.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
}

H.run(async () => {
  const routes = {};
  for (const s of SPECS) routes[s.path] = s.html;
  const site = await H.serve({ port: PORT, routes });
  const browser = await chromium.launch();
  const R = H.Reporter();

  for (const spec of SPECS) {
    const page_ = await browser.newPage();
    const errors = [];
    page_.on("pageerror", e => errors.push(e.message));
    await page_.goto(site.url + spec.path);

    await page_.evaluate(({ hook, rules }) => {
      const decide = u => {
        for (const r of rules) if (u.includes(r[0])) return r[1];
        return "A";
      };
      window.__ai = [];
      window.chrome = {
        runtime: {
          onMessage: { addListener: fn => { window.__aaListener = fn; } },
          getManifest: () => ({ version: "test" }),
          sendMessage: async msg => {
            if (msg.type === "AI_CHAT") {
              const u = ((msg.payload.messages || []).find(m => m.role === "user") || {}).content || "";
              window.__ai.push(u);
              return { ok: true, text: decide(u) };
            }
            return { ok: false, error: "stub" };
          }
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      };
      eval(hook);
    }, { hook: CLICK_HOOK, rules: spec.rules });

    await page_.addScriptTag({ path: H.EXT + "/content.js" });
    await page_.waitForFunction(() => typeof window.__aaListener === "function");

    await page_.evaluate(s => window.__aaListener({ type: "START", settings: s }),
      { mode: "ai", intervalMs: 20, aiKey: "x", fillHosts: "*" });
    const log = await waitDone(page_);

    const clicked = await page_.evaluate(() => window.__clicked);
    // 自建页路径直接改 input.checked（不产生 click），所以按"哪个选项被勾上"取落点：
    // 从被勾中的 input 往上找最近的一个 data-blk 元素，避免把外层容器也算进来
    const checked = await page_.evaluate(() =>
      [...document.querySelectorAll("input:checked")].map(inp => {
        const el = inp.closest("[data-blk]");
        return el ? el.getAttribute("data-blk") : "(无区块)";
      }));
    const prompts = await page_.evaluate(() => window.__ai);
    const blks = spec.byChecked ? checked : [...new Set(clicked.map(c => c.blk))];
    const tag = `[${spec.path}]`;

    console.log(`\n### ${spec.title}`);
    console.log("被点区块:", JSON.stringify(blks));
    console.log("AI prompt:", JSON.stringify(prompts));
    console.log("日志:\n" + log);

    R.t(`${tag} 点击落点符合预期（期望 ${JSON.stringify(spec.expect)}）`,
      JSON.stringify(blks.slice().sort()) === JSON.stringify(spec.expect.slice().sort()), blks);
    for (const re of spec.promptMustHave) {
      R.t(`${tag} prompt 里出现 ${re}`, prompts.some(p => re.test(p)), prompts);
    }
    for (const re of spec.promptMustNotHave) {
      R.t(`${tag} prompt 里不出现 ${re}`, !prompts.some(p => re.test(p)), prompts);
    }
    if (spec.custom) {
      for (const [name, cond, got] of spec.custom({ prompts, blks, log })) R.t(name, cond, got);
    }
    R.t(`${tag} 无未捕获异常`, errors.length === 0, errors.join(" | ") || "(无)");

    await page_.close();
  }

  R.finish();
  await browser.close();
  await site.close();
});
