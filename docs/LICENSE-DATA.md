# 题库数据许可清单（LICENSE-DATA）

**本文件是题库包的一部分，不是许可证。** 题库数据**不适用**本项目的 MIT 许可
（MIT 仅覆盖 `extension/` 下的代码与文档）。每一类题库的上游来源与许可状态如下，
请自行判断你的使用场景是否落在允许范围内。

- 总计：**45 类 / 113,878 题**
- 核实时间：2026-11-08；方法：GitHub `GET /repos/{owner}/{repo}/license`、ModelScope 数据集页
- 完整说明见仓库 `docs/题库来源与许可.md`

## 一、按可分发性汇总

| 状态 | 题量 | 占比 |
|---|---:|---:|
| ✅ 可再分发 | 30,395 | 26.7% |
| ⚠️ 仅非商业（CC BY-NC） | 11,389 | 10.0% |
| ⚠️ GPL-3.0（与 MIT 不兼容） | 2,801 | 2.5% |
| ⚠️ 部分可用（解析字段非商业） | 880 | 0.8% |
| ❌ 不可再分发 / 来源未记录 | 68,413 | 60.1% |

> **约 60% 的题目没有明确的可再分发授权。**
> 这些数据由上游公开发布、本项目仅做格式转换与规范化；但「上游公开」不等于「允许转授」。
> 如果你打算二次分发本包，建议先剔除标记为 ❌ 的类别，或自行联系上游取得授权。

## 二、逐类清单

| 文件 | 类别 | 题数 | 上游来源 | 上游许可 | 状态 |
|---|---|---:|---|---|---|
| `01_jiakao_car.json` | 驾考·小车 C1/C2/C3 | 4100 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `02_jiakao_moto.json` | 驾考·摩托车 D/E/F | 1489 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `03_jiakao_truck.json` | 驾考·货车 A2/B2 | 5251 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `04_jiakao_bus.json` | 驾考·客车 A1/A3/B1 | 4864 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `05_cmmlu.json` | CMMLU 综合 67 学科 | 11389 | haonan-li/cmmlu（HuggingFace） | CC BY-NC-SA 4.0 | ⚠️ 仅非商业 |
| `06_medical.json` | 医学考试 346 学科 | 23934 | lengfeng650-star/medical-exam-question-bank-json | Apache-2.0 | ✅ 可再分发 |
| `07_ham.json` | 业余无线电 A/B/C | 1321 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `08_gaokao.json` | 高考真题（客观题） | 1448 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `09_primary.json` | 小学语数英 1-6 年级 | 1295 | 来源未记录（C 组） | 未记录 | ❌ 不可再分发 |
| `10_中医.json` | 中医 | 31649 | ModelScope huangxp/hwtcm | 未标注 | ❌ 不可再分发 |
| `11_中文理解.json` | 中文理解 | 500 | ModelScope CUE | 待核实 | ❌ 不可再分发 |
| `12_体育·乒乓球.json` | 体育·乒乓球 | 696 | EulerZhao/QuestionBank | Apache-2.0 | ✅ 可再分发 |
| `13_体育·体育理论.json` | 体育·体育理论 | 1890 | EulerZhao/QuestionBank | Apache-2.0 | ✅ 可再分发 |
| `14_体育·健美操.json` | 体育·健美操 | 430 | EulerZhao/QuestionBank | Apache-2.0 | ✅ 可再分发 |
| `15_体育·太极拳.json` | 体育·太极拳 | 471 | EulerZhao/QuestionBank | Apache-2.0 | ✅ 可再分发 |
| `16_公务员考试.json` | 公务员考试 | 234 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `17_化学.json` | 化学 | 107 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `18_历史.json` | 历史 | 108 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `19_地理.json` | 地理 | 231 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `20_大学·操作系统.json` | 大学·操作系统 | 601 | xk271521-droid/kaoyan-miniapp | 无 LICENSE 文件 | ❌ 不可再分发 |
| `21_大学·数据结构.json` | 大学·数据结构 | 381 | xk271521-droid/kaoyan-miniapp | 无 LICENSE 文件 | ❌ 不可再分发 |
| `22_大学·计算机组成原理.json` | 大学·计算机组成原理 | 328 | xk271521-droid/kaoyan-miniapp | 无 LICENSE 文件 | ❌ 不可再分发 |
| `23_大学·计算机网络.json` | 大学·计算机网络 | 365 | xk271521-droid/kaoyan-miniapp | 无 LICENSE 文件 | ❌ 不可再分发 |
| `24_大学知识.json` | 大学知识 | 219 | xk271521-droid/kaoyan-miniapp | 无 LICENSE 文件 | ❌ 不可再分发 |
| `25_教师资格考试.json` | 教师资格考试 | 192 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `26_数学.json` | 数学 | 116 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `27_法律常识.json` | 法律常识 | 103 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `28_物理.json` | 物理 | 208 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `29_生物.json` | 生物 | 207 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `30_电工与安全生产.json` | 电工与安全生产 | 216 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `31_考研政治·习思想.json` | 考研政治·习思想 | 645 | chenyingxinghen/kaoyan_shuati | GPL-3.0 | ⚠️ GPL-3.0 |
| `32_考研政治·史纲.json` | 考研政治·史纲 | 674 | chenyingxinghen/kaoyan_shuati | GPL-3.0 | ⚠️ GPL-3.0 |
| `33_考研政治·思修.json` | 考研政治·思修 | 416 | chenyingxinghen/kaoyan_shuati | GPL-3.0 | ⚠️ GPL-3.0 |
| `34_考研政治·毛中特.json` | 考研政治·毛中特 | 327 | chenyingxinghen/kaoyan_shuati | GPL-3.0 | ⚠️ GPL-3.0 |
| `35_考研政治·马原.json` | 考研政治·马原 | 739 | chenyingxinghen/kaoyan_shuati | GPL-3.0 | ⚠️ GPL-3.0 |
| `36_考研英语.json` | 考研英语 | 880 | LIziak112/structured-kaoyan-english | 分层：试题自由 / 解析 CC BY-NC 4.0 | ⚠️ 部分（解析字段非商业） |
| `37_计算机等级·Photoshop.json` | 计算机等级·Photoshop | 320 | dengcao/ncre | 木兰 PSL v2 | ✅ 可再分发 |
| `38_计算机等级考试.json` | 计算机等级考试 | 178 | dengcao/ncre | 木兰 PSL v2 | ✅ 可再分发 |
| `39_财务与经济.json` | 财务与经济 | 110 | 本项目自编（extend_questions） | MIT | ✅ 可再分发 |
| `41_高考·综合.json` | 高考·综合 | 1115 | ModelScope damotest/gaokao-benchmark | 未说明 | ❌ 不可再分发 |
| `42_NCRE三级数据库技术.json` | 计算机等级·三级数据库 | 644 | dengcao/ncre | 木兰 PSL v2 | ✅ 可再分发 |
| `43_软考·系统架构设计师.json` | 软考·系统架构设计师 | 1520 | 作者本地 bank-src（未随仓库分发） | 未记录 | ❌ 不可再分发 |
| `44_二级建造师.json` | 二级建造师 | 3676 | 作者本地 bank-src（未随仓库分发） | 未记录 | ❌ 不可再分发 |
| `45_中级会计.json` | 中级会计 | 1575 | 作者本地 bank-src（未随仓库分发） | 未记录 | ❌ 不可再分发 |
| `46_填空题·英语与工科.json` | 填空题·英语与工科 | 6716 | 作者本地 bank-src（未随仓库分发） | 未记录 | ❌ 不可再分发 |

## 三、权利人通知

如你是上述内容的权利人，认为本包中的内容侵犯你的权利，请通过仓库 Issue 提交权属说明
（附许可证证明或作品归属证据）。核实后会在第一时间移除对应类别的 JSON 文件，无需额外流程。

## 四、免责

本项目对题库内容的准确性、时效性、完整性不作任何陈述。题库仅用于个人学习与研究，
不得用于正式考试、监考环境或以规避考核为目的的场景。
