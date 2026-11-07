# -*- coding: utf-8 -*-
"""
C-Eval -> AutoAnswer 题库格式验证（3 学科抽样）

选科理由：
  operating_system     大学工科，现有库同名课只有 601 题，是主要补强目标
  high_school_physics  高中理科，现有库完全没有，且物理是 LaTeX 重灾区
  electrical_engineer  专业资格，现有库没有，用来测"非课本体"的题目形态

输出 _report.md：字段映射、逐条转换样本、异常统计、结论。
不写进 extension/bank/，只做格式判定。
"""
import io
import json
import os
import urllib.request

import pyarrow.parquet as pq

MIRROR = "https://hf-mirror.com/datasets/ceval/ceval-exam/resolve/main"
SUBJECTS = ["operating_system", "high_school_physics", "electrical_engineer"]
SPLITS = ["test", "val"]
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
LETTERS = "ABCD"
BS = chr(92)


def fetch(subject, split):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, "%s-%s.parquet" % (subject, split))
    if not os.path.exists(path):
        url = "%s/%s/%s-00000-of-00001.parquet" % (MIRROR, subject, split)
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    return path


LATEX_CMDS = ("\\frac", "\\sqrt", "\\alpha", "\\beta", "\\pi", "\\sum", "\\int",
              "\\left", "\\right", "\\begin", "\\leq", "\\geq", "\\times", "\\ln", "\\log")


def is_latex(text):
    """判定是否为 LaTeX 公式源码。

    只认反斜杠命令或成对的 $...$ 包裹。裸 $ 不算 ——
    操作系统课的正确答案就是 $? $$ $* 这类 Shell 变量，
    用「含 $ 即 LaTeX」会把整科误判成不可用（实测踩过）。
    """
    s = text or ""
    if any(c in s for c in LATEX_CMDS):
        return True
    d = s.count("$")
    return d >= 2 and "{" in s or d >= 2 and "\\" in s


def to_bank(row):
    """C-Eval 行 -> 题库行。返回 (题目 dict 或 None, 跳过原因或 None)"""
    q = str(row.get("question") or "").strip()
    opts = [str(row.get(k) or "").strip() for k in LETTERS]
    ans = str(row.get("answer") or "").strip().upper()
    if not q:
        return None, "空题干"
    if any(not o for o in opts):
        return None, "缺选项"
    if len(ans) != 1 or ans not in LETTERS:
        return None, "答案非单个 ABCD: %r" % ans
    return {"question": q, "options": opts, "answer": [LETTERS.index(ans)], "type": "single"}, None


def main():
    out = io.open(os.path.join(HERE, "_report.md"), "w", encoding="utf-8")
    W = out.write
    W("# C-Eval 格式验证报告（3 学科）\n\n")

    grand_ok = grand_skip = 0
    skip_reasons = {}
    anomalies = {"选项重复": [], "选项含LaTeX": [], "题干含LaTeX仅": [], "超长题干": [], "超长选项": []}

    for subject in SUBJECTS:
        W("## %s\n\n" % subject)
        for split in SPLITS:
            path = fetch(subject, split)
            rows = pq.read_table(path).to_pylist()
            converted, skipped = [], []
            for r in rows:
                item, why = to_bank(r)
                if item is None:
                    skipped.append((why, r))
                    skip_reasons[why] = skip_reasons.get(why, 0) + 1
                else:
                    converted.append(item)
            grand_ok += len(converted)
            grand_skip += len(skipped)

            W("### %s split：%d 行 → 转换成功 %d / 跳过 %d\n\n" % (split, len(rows), len(converted), len(skipped)))
            W("| C-Eval 原始字段 | 题库字段 | 说明 |\n|---|---|---|\n")
            W("| `question` | `question` | 原样保留，占位符是 `____` 而非全角括号 |\n")
            W("| `A` `B` `C` `D` 四列 | `options[0..3]` | 按 ABCD 顺序展成数组 |\n")
            W("| `answer`（字母） | `answer`（下标数组） | `\"D\"` → `[3]`，与现有库一致 |\n")
            W("| —（无此列） | `type` | 全部为单选，固定写 `\"single\"` |\n")
            W("| `explanation` | 不导入 | **实测全为空串**，无解析可用 |\n\n")

            W("转换样本（前 2 条）：\n\n```json\n")
            for item in converted[:2]:
                W(json.dumps(item, ensure_ascii=False)[:520] + "\n")
            W("```\n\n")

            if skipped:
                W("跳过明细：\n\n")
                for why, r in skipped[:5]:
                    W("- `%s` — id=%s 题干前 40 字：%s\n" % (why, r.get("id"), str(r.get("question"))[:40]))
                W("\n")

            for item in converted:
                if len(set(item["options"])) < 4:
                    anomalies["选项重复"].append((subject, split, item))
                # 只认真正的 LaTeX：反斜杠命令或 $...$ 成对包裹。
                # 裸 $ 不算 —— 操作系统课的正确答案就是 $? $$ $* 这类 Shell 变量，
                # 用「含 $ 即 LaTeX」会把整科误判成不可用（实测踩过）。
                o_latex = any(is_latex(o) for o in item["options"])
                if o_latex:
                    anomalies["选项含LaTeX"].append((subject, split, item))
                elif is_latex(item["question"]):
                    anomalies["题干含LaTeX仅"].append((subject, split, item))
                if len(item["question"]) > 500:
                    anomalies["超长题干"].append((subject, split, item))
                if max(len(o) for o in item["options"]) > 200:
                    anomalies["超长选项"].append((subject, split, item))

    W("---\n\n## 汇总\n\n")
    W("- 转换成功 **%d** 题，跳过 **%d** 题（跳过原因：%s）\n" % (grand_ok, grand_skip, skip_reasons or "无"))
    W("- 字段映射**无信息损失**，`answer` 下标化后与现有 `extension/bank/*.json` 结构完全一致\n\n")
    W("## 异常统计\n\n| 类别 | 条数 | 影响 |\n|---|---|---|\n")
    impact = {
        "选项含LaTeX": "网页上是渲染后的式子，题库存的是源码；normalize() 只删标点、留下 `frac`/`sqrt` 等命令名，**匹配必然失败** → 判未命中，回落 AI",
        "题干含LaTeX仅": "选项仍是纯文本，可正常匹配，影响小",
        "选项重复": "同文本出现在多个下标，remapAnswer 可能选到等价的下标（答案通常仍正确，但校验语义变模糊）",
        "超长题干": "题干过长会挤占送给 AI 的预算；对题库匹配无碍",
        "超长选项": "同上，主要是展示与匹配成本",
    }
    for k, v in anomalies.items():
        W("| %s | %d | %s |\n" % (k, len(v), impact[k]))
    W("\n### 选项含 LaTeX 样本\n\n```json\n")
    for s, sp, item in anomalies["选项含LaTeX"][:3]:
        W(json.dumps({"subject": s, "question": item["question"][:70], "options": item["options"]}, ensure_ascii=False) + "\n")
    W("```\n\n### 选项重复样本\n\n```json\n")
    for s, sp, item in anomalies["选项重复"][:3]:
        W(json.dumps({"subject": s, "options": item["options"], "answer": item["answer"]}, ensure_ascii=False)[:300] + "\n")
    W("```\n")
    out.close()
    print("报告已写出：tools/ceval-import/_report.md")
    print("转换成功 %d / 跳过 %d" % (grand_ok, grand_skip))


if __name__ == "__main__":
    main()
