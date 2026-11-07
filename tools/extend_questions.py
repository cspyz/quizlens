# -*- coding: utf-8 -*-
"""
把填空题与"格式变体"选择题追加进 quiz-app/questions.json。
原 54 题原样保留（云端的旧版本还指着它），新题追加在后面。

新增的题刻意覆盖各种格式：
  填空题 —— 数学 / 英语 / 语文，各含「单空」与「一题多空」
  选择题 —— 2/3/4/5 选项、全选多选、句子级长选项、长题干阅读理解、
           含 < > & 特殊字符（验证转义）、英文大小写敏感
用法：python tools/extend_questions.py
"""
import json, os, sys

sys.stdout.reconfigure(encoding="utf-8")
PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "quiz-app", "questions.json")

# ---------- 填空题：数学 ----------
BLANK_MATH = [
    ("计算：12 × 8 = ____", ["96"]),
    ("三角形的内角和是 ____ 度", ["180"]),
    ("若 3x + 6 = 18，则 x = ____", ["4"]),
    ("等差数列 2, 5, 8, 11, … 的公差是 ____，第 5 项是 ____", ["3", "14"]),          # 一题两空
    ("一个正方体有 ____ 条棱，有 ____ 个顶点", ["12", "8"]),                          # 一题两空
]

# ---------- 填空题：英语 ----------
BLANK_EN = [
    ('The opposite of "hot" is ____.', ["cold"]),
    ("写出动词 go 的过去式：____", ["went"]),
    ("「苹果」的英文单词是 ____", ["apple"]),
    ("用 be 动词的正确形式填空：I ____ a student. She ____ a teacher.", ["am", "is"]),   # 一题两空
    ("Write the plural form: one box, two ____.", ["boxes"]),
]

# ---------- 填空题：语文 ----------
BLANK_CN = [
    ("成语「守株待兔」出自《____》。", ["韩非子"]),
    ("补写诗句：洛阳亲友如相问，____。", ["一片冰心在玉壶"]),
    ("补写名句：____，每逢佳节倍思亲。", ["独在异乡为异客"]),
    ("《岳阳楼记》的作者是 ____。", ["范仲淹"]),
    ("补写《九月九日忆山东兄弟》：____，每逢佳节倍思亲。____，遍插茱萸少一人。",
     ["独在异乡为异客", "遥知兄弟登高处"]),                                            # 一题两空
]

# ---------- 选择题：格式变体 ----------
CHOICE_EXTRA = [
    # (type, question, options, answer, subject)
    ("single", "下列各数中，是无理数的是哪一个？", ["0.5", "√2", "22/7", "-3"], [1], "数学"),
    ("single", "自然对数的底 e 约等于下面哪个数？", ["1.41", "1.73", "2.72", "3.14"], [2], "数学"),
    ("single", "一个正方体有几条棱？", ["6", "8", "12"], [2], "数学"),                    # 3 选项
    ("multi", "下列哪些是质数？（多选）", ["2", "3", "11", "15"], [0, 1, 2], "数学"),      # 3 个正确项
    ("multi", "下列哪些数能被 2 整除？（多选）", ["4", "8", "12", "20"], [0, 1, 2, 3], "数学"),  # 全选
    ("judge", "0 是最小的自然数。", ["正确", "错误"], [0], "数学"),

    ("single", 'Which word means "quick"?', ["slow", "fast", "heavy", "quiet"], [1], "英语"),
    ("single", "Which is the correct spelling of the third month of the year?",
     ["march", "March", "MARch", "marchh"], [1], "英语"),                                  # 大小写敏感
    ("multi", "Which of the following are colors?（多选）",
     ["red", "blue", "seven", "green"], [0, 1, 3], "英语"),
    ("judge", '"child" 的复数形式是 "childs"。', ["正确", "错误"], [1], "英语"),

    ("single", "「陈康肃公善射」中「善」的意思是？",
     ["善良", "擅长", "好的", "容易"], [1], "语文"),
    ("single", "「月亮悄悄爬上了树梢」使用了哪种修辞手法？",
     ["比喻", "拟人", "夸张", "排比"], [1], "语文"),

    # 长题干（阅读理解式：材料 + 提问）
    ("single",
     "阅读下面这段话，回答问题：「水在自然界中不断循环。阳光照射使水面蒸发，水汽上升到高空遇冷凝结成小水滴或小冰晶，形成云。当这些小水滴或小冰晶增大到空气托不住时，就会以雨或雪的形式降落回地面。」这段话主要说明了什么？",
     ["云的形成需要凝结核", "水在自然界中的循环过程", "降雨对人类生活的影响", "太阳辐射的强弱变化"],
     [1], "常识"),

    # 句子级长选项
    ("single", "下列关于「光年」的说法，哪一项是正确的？",
     ["光年是时间单位，表示光走一年所需要的时间",
      "光年是长度单位，表示光在一年中传播的距离",
      "光年是速度单位，表示光一年中的平均速度",
      "光年是天文学中用来表示恒星年龄的单位"],
     [1], "常识"),

    # 特殊字符 < > &（验证题库与页面的转义：不转义会被当标签解析）
    ("single", "在 HTML 中，<div> 这种写法的尖括号符号叫什么？",
     ["<", ">", "&", "#"], [0], "常识"),

    # 5 选项多选
    ("multi", "下列哪些属于中国古代四大发明？（多选）",
     ["造纸术", "指南针", "火药", "印刷术", "地动仪"], [0, 1, 2, 3], "常识"),
]


def main():
    with open(PATH, encoding="utf-8") as f:
        data = json.load(f)

    qs = data["questions"]
    # 幂等保护：这个脚本只该跑一次，重复跑会再追加一遍同样的题
    if any(q.get("type") == "blank" for q in qs):
        print("已经存在填空题，说明扩充过了。先 git/备份恢复 questions.json 再跑，或者直接改脚本。")
        print("（当前 %d 题，其中填空 %d 题）" % (len(qs), sum(1 for q in qs if q.get("type") == "blank")))
        sys.exit(1)

    base = len(qs)
    nid = max(q["id"] for q in qs)

    def add_blank(group, subject):
        nonlocal nid
        for question, answers in group:
            nid += 1
            qs.append({"id": nid, "type": "blank", "subject": subject,
                       "question": question, "answers": answers})

    for group, subject in ((BLANK_MATH, "数学"), (BLANK_EN, "英语"), (BLANK_CN, "语文")):
        add_blank(group, subject)

    for t, question, options, answer, subject in CHOICE_EXTRA:
        nid += 1
        qs.append({"id": nid, "type": t, "subject": subject,
                   "question": question, "options": options, "answer": answer})

    # 时长按每题 45 秒给，最少 10 分钟
    data["durationMinutes"] = max(10, round(len(qs) * 0.75))

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    blanks = [q for q in qs if q["type"] == "blank"]
    multi_blank = [q for q in blanks if len(q["answers"]) > 1]
    print("原题数 %d → 现题数 %d（新增 %d）" % (base, len(qs), len(qs) - base))
    print("填空题 %d（其中一题多空 %d）" % (len(blanks), len(multi_blank)))
    print("时长设为 %d 分钟" % data["durationMinutes"])
    from collections import Counter
    print("题型分布:", dict(Counter(q["type"] for q in qs)))
    print("学科分布:", dict(Counter(q.get("subject", "（原题未标）") for q in qs)))


if __name__ == "__main__":
    main()
