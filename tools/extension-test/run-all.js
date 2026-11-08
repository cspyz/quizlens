/**
 * 一键跑全部扩展测试（顺序执行，避免端口冲突）。
 * 用法：node tools/extension-test/run-all.js
 * 依赖 playwright：可用 PLAYWRIGHT_NODE_PATH 指向其 node_modules。
 */
const { spawnSync } = require("child_process");
const path = require("path");

if (process.env.PLAYWRIGHT_NODE_PATH && !process.env.NODE_PATH) {
  process.env.NODE_PATH = process.env.PLAYWRIGHT_NODE_PATH;
  require("module").Module._initPaths();
}

const TESTS = [
  ["run-test.js", "问卷星 DOM 填涂 + 分页 + 不点提交"],
  ["order-test.js", "扫描面板题目顺序"],
  ["autofill-test.js", "任意网页自动填涂（* 通配符 / 无 input 选项列表 / 自动降级）"],
  ["panel-fill-test.js", "识别面板的「✍ 填涂」按钮"],
  ["iframe-chaoxing-test.js", "同源 iframe + 学习通随堂练习识别/填涂，跨域 frame 提示"],
  ["chaoxing-legacy-test.js", "学习通旧版作业/章节测验：.questionLi/.TiMu、多选、多空填空"],
  ["chaoxing-new-exam-test.js", "学习通新版：.option-list + 已选保留 / 覆盖开关 / 多选清勾"],
  ["chaoxing-new-blank-test.js", "学习通新版：填空 / textarea / contenteditable 简答 / 多空"],
  ["chaoxing-ueditor-test.js", "学习通作业简答（UEditor）：识别 / 文字作答 / 写 iframe body / 同步 textarea"],
  ["iframe-pagination-test.js", "同源 iframe 内自动翻页：iframe 里的「下一题」也能点"],
  ["fillblank-test.js", "填空题：识别 / 写入 / 受控组件 / 不误伤表单"],
  ["sentence-rewrite-test.js", "句子改写/改错：自由文本 AI 答案、写入输入框、自动答题也覆盖"],
  ["quizapp-blank-test.js", "练习页：填空渲染 / 归一化判分 / 插件写入多空"],
  ["false-positive-test.js", "复杂页面误判：导航/术语表/分点说明都不能乱点"],
  ["mis-pair-test.js", "题干与选项错配：夹广告位 / 多题干容器 / 侧栏筛选器都不能张冠李戴"],
  ["passage-test.js", "阅读材料（passage）：该挂的挂上、说明文字绝不误挂、题干不串"],
  ["reading-passage-test.js", "英语阅读题组：整篇/多段材料、无提示词共享、未挂上材料提示"],
  ["english-reading-test.js", "真实英语阅读页：4 段材料 + 6 题，全部挂上完整材料"],
  ["judgment-test.js", "判断题（A、正确 / B、错误）：题干与选项同容器也要认出来并点对，两项的非题列表不许点"],
  ["p0-fix-test.js", "重复注入守卫 + ESC 关闭面板"],
  ["p0-verify-test.js", "P0 三项修复：答案解析 / 题库多来源 / 空壳过滤"],
  ["option-verify-test.js", "题库选项校验（跨题库重题）"],
  ["fuzzy-test.js", "改字后的模糊匹配命中"],
  ["regression-test.js", "本地页带选项的题全部命中 + 白名单降级"],
  ["blank-bank-test.js", "填空题题库匹配：单空/多空写入、同题干选择题不串、不调 AI"],
  ["quizapp-fix-test.js", "练习页转义 + 限时 + 判分兜底"],
  // 放最后：它启动的是「真扩展 + 真 service worker」，比其他测试慢，也最吃环境。
  // 唯一一个不 stub chrome 的测试，覆盖 getURL / web_accessible_resources / FETCH_BANK 后台代理。
  ["real-ext-test.js", "真实扩展端到端：内置题库 / 自定义题库地址 / 后台代理"],
  ["real-fixes-test.js", "真实浏览器验证批 1-3 修复：解析不劫持 / 单选不滥勾 / number 回读 / 白名单收口 / 停止真的停"],
  ["boundary-ack-test.js", "一次性使用边界确认：常驻行 / 勾选门控 / 取消不写标志 / 重开不打扰（替代旧 20 秒门禁）"],
  ["release-split-verify.js", "发布副本：不含内置题库仍可加载，题库包 ASCII 改名后 46 类全量命中"],
];

let failed = 0;
let skipped = 0;
const started = Date.now();

for (const [file, desc] of TESTS) {
  console.log(`\n########## ${file} — ${desc} ##########`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: "inherit",
    env: process.env,
  });
  // 退出码 2 = 该测试自己声明"环境不具备，跳过"（如 real-ext-test 缺内置题库），不算失败
  if (r.status === 2) {
    skipped++;
    console.log(`>>> ${file} 跳过（环境不具备）`);
  } else if (r.status !== 0) {
    failed++;
    console.log(`>>> ${file} 失败（exit ${r.status}）`);
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
const done = TESTS.length - skipped;
console.log(`\n${"=".repeat(56)}`);
console.log(failed === 0
  ? `✅ 全部 ${done} 个测试通过（${secs}s）${skipped ? `，另有 ${skipped} 个跳过` : ""}`
  : `❌ ${failed}/${done} 个测试失败（${secs}s）${skipped ? `，另有 ${skipped} 个跳过` : ""}`);
console.log("=".repeat(56));
process.exitCode = failed === 0 ? 0 : 1;
