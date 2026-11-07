# -*- coding: utf-8 -*-
"""
第二轮扩充 quiz-app/questions.json：题目更多、每题的"空"和"选项"更多、难度更高。

针对用户诉求：
  · "填空题包含很多个标签"  → 一题 5~8 个空（原卷最多 2 个空）
  · "选择题也包含很多个标签" → 6~8 个选项（原卷最多 5 个）
  · "难度稍微难一点"        → 多步计算、词形变化、长篇名句默写、易混概念辨析

为什么要一次给这么多空/这么多选项：本地练习页是插件的"标尺"，
原卷最多 2 空 5 选项，压不出"空多了会不会串行、选项多了会不会漏勾"这类问题。
实测就靠这批新题抓出两个真 bug（连写答案串被截断、题干相近的题被误合并），
详见 README「本地练习页」一节。

原有 85 题**原样保留**（云端旧版本还指着它们），新题追加在后面。

用法：
  python tools/extend_questions2.py            # 直接写回 quiz-app/questions.json
  python tools/extend_questions2.py --stdout   # 只输出 JSON（沙箱下 Python 不能写盘时用这个）
"""
import json, os, sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")
PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "quiz-app", "questions.json")

# ---------- 填空题：一题多空（5~8 空）----------
BLANK_MANY = [
    # (题干, 答案数组, 学科)
    ("等差数列 3, 7, 11, 15, … ：公差是 ____，第 6 项是 ____，第 10 项是 ____，"
     "前 5 项之和是 ____，前 10 项之和是 ____",
     ["4", "23", "39", "55", "210"], "数学"),

    ("计算：1/2 + 1/3 = ____；1/2 - 1/3 = ____；1/2 × 1/3 = ____；"
     "1/2 ÷ 1/3 = ____；1/2 的倒数是 ____；1/2 的平方是 ____",
     ["5/6", "1/6", "1/6", "3/2", "2", "1/4"], "数学"),

    ("一个长方体的长、宽、高分别为 5、4、3：棱长总和是 ____，表面积是 ____，体积是 ____，"
     "它有 ____ 个顶点、____ 条棱、____ 个面",
     ["48", "94", "60", "8", "12", "6"], "数学"),

    ("解一元二次方程 x² - 5x + 6 = 0：判别式 Δ = ____，较小的根 x1 = ____，较大的根 x2 = ____，"
     "两根之和 = ____，两根之积 = ____",
     ["1", "2", "3", "5", "6"], "数学"),

    ("某商品原价 200 元：先涨价 10% 后是 ____ 元；再打八折后是 ____ 元；最后涨价 25% 后是 ____ 元。"
     "最终价格比原价上涨了 ____ 元，涨幅为 ____%",
     ["220", "176", "220", "20", "10"], "数学"),

    ("把 3/8 化成小数是 ____；把 0.45 化成最简分数是 ____/____；"
     "3/8 的百分数是 ____%；0.45 的百分数是 ____%",
     ["0.375", "9", "20", "37.5", "45"], "数学"),

    ("用动词的正确形式填空：She ____ (go) to school every day. Yesterday she ____ (go) there by bus. "
     "Tomorrow she ____ (go) there again. She has ____ (be) ill for three days. "
     "Look! She ____ (run) on the playground now. She ____ (finish) her homework already.",
     ["goes", "went", "will go", "been", "is running", "has finished"], "英语"),

    ("写出下列形容词的比较级和最高级：good → ____ / ____；bad → ____ / ____；many → ____ / ____",
     ["better", "best", "worse", "worst", "more", "most"], "英语"),

    ("用正确的介词填空：I was born ____ 1998. The class begins ____ 8 o'clock. She is good ____ math. "
     "He is interested ____ music. They arrived ____ Beijing yesterday. Thank you ____ your help.",
     ["in", "at", "at", "in", "in", "for"], "英语"),

    ("补写《陋室铭》：山不在高，____。水不在深，____。斯是陋室，____。苔痕上阶绿，____。"
     "谈笑有鸿儒，____。可以调素琴，____。无丝竹之乱耳，____。南阳诸葛庐，____。",
     ["有仙则名", "有龙则灵", "惟吾德馨", "草色入帘青",
      "往来无白丁", "阅金经", "无案牍之劳形", "西蜀子云亭"], "语文"),

    ("补写《岳阳楼记》名句：不以物喜，____；居庙堂之高则忧其民，____。"
     "是进亦忧，退亦忧。然则何时而乐耶？其必曰「____，____」乎！",
     ["不以己悲", "处江湖之远则忧其君", "先天下之忧而忧", "后天下之乐而乐"], "语文"),

    ("四大名著常识：《红楼梦》的作者是 ____；《西游记》的作者是 ____；《水浒传》的作者是 ____；"
     "《三国演义》的作者是 ____；这四部书合称 ____。",
     ["曹雪芹", "吴承恩", "施耐庵", "罗贯中", "四大名著"], "语文"),
]

# ---------- 选择题：多选项（6~8 个）----------
CHOICE_MANY = [
    # (类型, 题干, 选项, 答案, 学科)
    # 题干必须与卷内既有题**不重复**：id=70 已经有一道"下列各数中，是无理数的是哪一个？"（4 选项）。
    # 早先这里逐字复用了那句话，于是两道题题干完全相同 → 被 dedupe 合并，
    # 页面 106 题只出 105 张卡片（8 选项那道永远答不到）。
    # 换成措辞不同、但同样压测"8 选项 + 答案不在前几个"的版本。
    ("single", "在下列实数中，哪一个属于无理数？",
     ["22/7", "√9", "√2", "1/3", "-5", "3.14", "∛27", "0"], [2], "数学"),

    ("single", "下列各数中，数值最小的是哪一个？",
     ["2 的 -3 次方", "3 的 -2 次方", "4 的 -1 次方", "5 的 0 次方",
      "1/2 的平方", "2/7", "0.3", "1/3"], [1], "数学"),

    ("single", "下列哪种数据结构遵循「先进先出」原则？",
     ["栈", "队列", "树", "图", "堆", "哈希表"], [1], "计算机"),

    ("single", "在 Python 中，下列哪个运算符表示「整除」（向下取整的除法）？",
     ["/", "//", "%", "**", "++", "|"], [1], "计算机"),

    ("single", "下列哪位科学家因提出「测不准原理」而闻名？",
     ["爱因斯坦", "玻尔", "海森堡", "薛定谔", "狄拉克", "普朗克", "费曼"], [2], "常识"),

    ("multi", "下列哪些是中国的直辖市？（多选）",
     ["北京", "上海", "天津", "重庆", "广州", "深圳", "南京"], [0, 1, 2, 3], "常识"),

    ("multi", "下列哪些属于 HTTP 的请求方法？（多选）",
     ["GET", "POST", "PUSH", "DELETE", "PATCH", "FETCH", "HEAD", "SEND"],
     [0, 1, 3, 4, 6], "计算机"),

    ("multi", "下列哪些属于关系型数据库？（多选）",
     ["MySQL", "PostgreSQL", "Oracle", "SQL Server", "Redis", "MongoDB", "SQLite", "Neo4j"],
     [0, 1, 2, 3, 6], "计算机"),

    ("multi", "下列关于 TCP 与 UDP 的说法，哪些是正确的？（多选）",
     ["TCP 是面向连接的，UDP 是无连接的",
      "TCP 保证数据按序到达，UDP 不保证",
      "UDP 一定比 TCP 可靠",
      "TCP 建立连接需要三次握手",
      "UDP 的首部开销比 TCP 小",
      "TCP 不能用于实时音视频传输"],
     [0, 1, 3, 4], "计算机"),
]

# 幂等保护用的哨兵：这批题里最独特的题干片段
SENTINEL = "陋室铭"
# 第一轮扩充的哨兵（tools/extend_questions.py 加进去的题）。原卷 85 题到此为止。
BASE_LAST_ID = 85


def main():
    with open(PATH, encoding="utf-8") as f:
        data = json.load(f)
    qs = data["questions"]

    # 已经跑过这一轮时：把上次追加的题**摘掉**再重跑，而不是直接报错退出。
    # 这样"改一句题干重跑"不用手工还原文件（上一版只能手工回滚，实测很别扭）。
    # 只摘 id > BASE_LAST_ID 的题，原 85 题（云端旧版本还指着）永远不动。
    dropped = [q for q in qs if q["id"] > BASE_LAST_ID]
    if dropped:
        # 这条进度必须走 stderr：--stdout 模式下 stdout 是**纯 JSON**，
        # 混进一行提示会让调用方 json.load 直接炸（实测踩过）。
        print("检测到上一轮追加的 %d 题（id > %d），先摘掉再重新生成。" % (len(dropped), BASE_LAST_ID),
              file=sys.stderr)
        qs[:] = [q for q in qs if q["id"] <= BASE_LAST_ID]

    base = len(qs)
    nid = max(q["id"] for q in qs)

    # 卷内已有的题干（用于查重）：题干重复会让插件把它当成"同一道题被识别两次"而合并
    existing = {q.get("question", "").strip() for q in qs}

    for question, answers, subject in BLANK_MANY:
        # 自检：题干里的空格标记数必须等于答案数，否则页面上会出现"填了没处放/有处没得填"
        marks = question.count("____") + question.count("（　）")
        if marks != len(answers):
            sys.exit("题干空格数 %d 与答案数 %d 不符：%s" % (marks, len(answers), question[:40]))
        if question.strip() in existing:
            sys.exit("题干与卷内既有题重复（会被插件去重合并）：%s" % question[:50])
        existing.add(question.strip())
        nid += 1
        qs.append({"id": nid, "type": "blank", "subject": subject,
                   "question": question, "answers": answers})

    for t, question, options, answer, subject in CHOICE_MANY:
        # 自检：答案下标不能越界
        if any(i < 0 or i >= len(options) for i in answer):
            sys.exit("答案下标越界：%s" % question[:40])
        # 自检：题干不能与卷内任何一题重复。
        # 插件按"题干相近"去重，逐字重复的两道题必被合并成一道，
        # 用户看到的是"少了一道题"且那道题永远答不到 —— 实测踩过一次。
        if question.strip() in existing:
            sys.exit("题干与卷内既有题重复（会被插件去重合并）：%s" % question[:50])
        existing.add(question.strip())
        nid += 1
        qs.append({"id": nid, "type": t, "subject": subject,
                   "question": question, "options": options, "answer": answer})

    data["durationMinutes"] = max(10, round(len(qs) * 0.75))

    # --stdout：只把结果打到标准输出，不落盘。
    # 本机沙箱下 Python 写工作区会被拒（PermissionError），
    # 所以"生成"与"落盘"分开：脚本生成 JSON，再由外部写文件。
    if "--stdout" in sys.argv:
        json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        with open(PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")

    blanks = [q for q in qs if q["type"] == "blank"]
    choices = [q for q in qs if q["type"] != "blank"]
    # 统计信息一律走 stderr，保证 --stdout 的 stdout 是可直接解析的纯 JSON
    def note(*a):
        print(*a, file=sys.stderr)

    note("原题数 %d → 现题数 %d（新增 %d）" % (base, len(qs), len(qs) - base))
    note("时长设为 %d 分钟" % data["durationMinutes"])
    note("题型分布:", dict(Counter(q["type"] for q in qs)))
    note("填空题 %d 道，空数分布:" % len(blanks),
         dict(Counter(len(q["answers"]) for q in blanks)))
    note("选择题 %d 道，选项数分布:" % len(choices),
         dict(sorted(Counter(len(q["options"]) for q in choices).items())))


if __name__ == "__main__":
    main()
