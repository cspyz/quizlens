# -*- coding: utf-8 -*-
"""
C-Eval -> AutoAnswer 题库包导入器

产出独立题库包（默认 _release/bank-ceval/），不碰 extension/bank/，
也不碰已有的 _release/bank-package/ —— 许可不同的数据分开打包，
将来某个源被投诉时只下架一个包。

选科规则（全部可解释、可复核，不靠人工列名单）：
  1. 只取 test split。实测 val 每科仅 19~37 题、dev 无答案，test 才是可用主体。
  2. 排除「选项含 LaTeX 比例 > 阈值」的学科：这些题在网页上是渲染后的式子，
     而 normalize() 只删标点、会留下 frac/sqrt 等命令名，匹配必然失败。
     官方 README 自己把这批学科叫 "C-Eval Hard"，理由是"含复杂 LaTeX 公式"。
  3. 排除与现有题库重复的学科：CS 四门课现有库题量已高于 C-Eval；
     医学/公务员/会计/教资/医师等也已有同类。重复导入只会制造跨库重题。
  4. 排除初中层（可选开关）：产品面向大学生。

用法：
  python tools/ceval-import/import_ceval.py                 # 默认：高中+大学+专业，自动排除
  python tools/ceval-import/import_ceval.py --with-middle    # 连初中一起导
  python tools/ceval-import/import_ceval.py --latex-cap 0.30 # 收紧 LaTeX 排除阈值
"""
import argparse
import io
import json
import os
import subprocess
import sys
import urllib.request

import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MIRROR = "https://hf-mirror.com/datasets/ceval/ceval-exam"
RAW = os.path.join(HERE, "raw")
LETTERS = "ABCD"

# 与现有 extension/bank/ 重叠的学科。判据：现有题量 >= C-Eval 的 80% 才算重复，
# 否则 C-Eval 属净增、应当导入（初版把「方向重复」当理由，误排了税务师 443 与教资 399）。
# value = (现有题量, 现有类别名)
OVERLAP = {
    "operating_system": (601, "大学·操作系统"),
    "computer_network": (365, "大学·计算机网络"),
    "computer_architecture": (328, "大学·计算机组成原理"),
    "civil_servant": (234, "公务员考试"),
    "accountant": (1575, "中级会计"),
    "mao_zedong_thought": (327, "考研政治·毛中特"),
    "ideological_and_moral_cultivation": (416, "考研政治·思修"),
    "marxism": (739, "考研政治·马原"),
    "modern_chinese_history": (674, "考研政治·史纲"),
    "chinese_language_and_literature": (500, "中文理解"),
    "logic": (72378, "逻辑推理"),
    "sports_science": (1890, "体育·体育理论"),
    "physician": (23934, "医学考试 346 学科"),
    "basic_medicine": (23934, "医学考试 346 学科"),
    "clinical_medicine": (23934, "医学考试 346 学科"),
    "veterinary_medicine": (23934, "医学考试 346 学科"),
    "plant_protection": (23934, "医学/农学类已覆盖部分"),
}

LATEX_CMDS = ("\\frac", "\\sqrt", "\\alpha", "\\beta", "\\pi", "\\sum", "\\int",
              "\\left", "\\right", "\\begin", "\\leq", "\\geq", "\\times", "\\ln", "\\log")


def is_latex(text):
    """只认反斜杠命令或成对 $...$。裸 $ 不算 ——
    操作系统课的正确答案就是 $? $$ $* 这类 Shell 变量，
    用「含 $ 即 LaTeX」会把整科误判成不可用（实测踩过）。"""
    s = text or ""
    if any(c in s for c in LATEX_CMDS):
        return True
    return s.count("$") >= 2 and ("\\" in s or "{" in s)


def subject_list():
    cache = os.path.join(HERE, "_subjects.json")
    if os.path.exists(cache):
        return json.load(io.open(cache, encoding="utf-8"))
    req = urllib.request.Request(MIRROR.replace("/resolve/main", "") + "/-/raw/main/README.md")
    url = "https://hf-mirror.com/api/datasets/ceval/ceval-exam"
    r = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    d = json.loads(urllib.request.urlopen(r, timeout=40).read().decode("utf-8"))
    subs = [c["config_name"] for c in (d.get("cardData") or {}).get("configs") or []]
    json.dump(subs, io.open(cache, "w", encoding="utf-8"))
    return subs


def test_parquet(subject):
    os.makedirs(RAW, exist_ok=True)
    p = os.path.join(RAW, "%s-test.parquet" % subject)
    if not os.path.exists(p):
        u = "%s/%s/test-00000-of-00001.parquet" % (MIRROR, subject)
        subprocess.run(["curl", "-sL", "--max-time", "90", "-o", p, u], check=True)
    return p


def level_of(subject):
    if subject.startswith("middle_school"):
        return "初中"
    if subject.startswith("high_school"):
        return "高中"
    return None


ZH = {
    "advanced_mathematics": "高等数学", "art_studies": "艺术学", "business_administration": "工商管理",
    "college_biology": "大学生物学", "college_chemistry": "大学化学", "college_economics": "大学经济学",
    "college_physics": "大学物理", "college_programming": "大学编程", "computer_science": "计算机科学",
    "discrete_mathematics": "离散数学", "education_science": "教育学", "electrical_engineer": "电气工程师",
    "environmental_impact_assessment_engineer": "环境影响评价工程师", "fire_engineer": "消防工程师",
    "high_school_biology": "高中生物", "high_school_chemistry": "高中化学", "high_school_chinese": "高中语文",
    "high_school_geography": "高中地理", "high_school_history": "高中历史",
    "high_school_mathematics": "高中数学", "high_school_physics": "高中物理", "high_school_politics": "高中政治",
    "ideological_and_moral_cultivation": "思想道德修养", "legal_professional": "法律职业",
    "metrology_engineer": "计量工程师", "operating_system": "操作系统", "probability_and_statistics": "概率论与数理统计",
    "professional_tour_guide": "导游资格", "sports_science": "体育学", "urban_and_rural_planner": "注册城乡规划师",
    "law": "法学", "tax_accountant": "税务师", "accountant": "注册会计师",
    "civil_servant": "公务员考试", "teacher_qualification": "教师资格",
    "physician": "医师", "advanced_mathematics": "高等数学",
    "probability_and_statistics": "概率论与数理统计", "discrete_mathematics": "离散数学",
    "computer_science": "计算机科学",
}



LICENSE_NOTE = """# C-Eval 题库包 · 许可与来源

本包由 C-Eval 数据集转换而来，**许可与主程序不同，不得随代码一并标注 MIT**。

## 来源

- 数据集：C-Eval — *A Multi-Level Multi-Discipline Chinese Evaluation Suite for Foundation Models*
- 仓库：https://github.com/SJTU-LIT/ceval
- 数据下载：https://huggingface.co/datasets/ceval/ceval-exam （国内可用镜像 https://hf-mirror.com/datasets/ceval/ceval-exam ）
- 论文：https://arxiv.org/abs/2305.08322 （NeurIPS 2023）

## 许可

| 部分 | 许可 | 出处 |
|---|---|---|
| **题目数据（本包 `.json`）** | **CC BY-NC-SA 4.0** | C-Eval 仓库 README「Licenses」一节；HF 数据集卡片元数据 `license: cc-by-nc-sa-4.0` |
| C-Eval 评测代码 | MIT | 同上 README |

CC BY-NC-SA 4.0 的三项约束：

- **NC（非商业）**：不得将本题库用于商业目的或对外收费服务。
- **BY（署名）**：再分发时须注明来自 C-Eval，并建议引用上述论文。
- **SA（相同方式共享）**：基于本题库修改或衍生出的数据集，须沿用 CC BY-NC-SA 4.0 发布。

本包只是把 C-Eval 的 `test` split 从 parquet 转成 AutoAnswer 的 JSON 结构，未改动题目文字与答案。

## 收录范围与筛选依据

- 只取 `test` split。实测 `val` 每科仅 19~37 题、`dev` 无答案，`test` 才是可用主体（官方于 2025-07-27 公开完整 test 集并附答案）。
- **排除了「选项含 LaTeX 公式」比例过高的学科**。这些题在网页上是渲染后的式子，而题库匹配会把 `$\\frac{A+1}{A-1}$` 归一化成 `fracA1A1`，与页面的 `A1A1` 对不上，必然判未命中。被排除的学科正是 C-Eval 官方自己称为 "C-Eval Hard"、并注明"含复杂 LaTeX 公式"的那一批。
- **排除了与主包重复的学科**（判据：主包现有题量不低于本包），重复导入只会制造跨库重题。
- 未收录初中层学科（产品面向大学生），如需可用 `--with-middle` 重新生成。

完整逐科取舍理由见生成仓库内的 `tools/ceval-import/_import_report.md`。

## 已知数据质量问题

- `explanation` 字段在 `test` split 中实测全为空串，因此**本题库无解析可用**；面板选择「答案 + 解析」时，这些题的解析栏会是空的。
- 极少数题目存在选项文本重复（源数据问题，例如上标丢失使 `2508×10⁴` 变成 `2508×104`）。题库的选项校验会按文本定位，答案仍正确，但等价选项之间的下标选择是任意的。

## 重新生成本包

```
python tools/ceval-import/import_ceval.py
```

本文件由该脚本自动写出，请勿手工编辑后丢失。

## 引用

```bibtex
@inproceedings{huang2023ceval,
  title={C-Eval: A Multi-Level Multi-Discipline Chinese Evaluation Suite for Foundation Models},
  author={Huang, Yuzhen and Bai, Yuzhuo and Zhu, Zhihao and Zhang, Junlei and Zhang, Jinghan and
          Su, Tangjun and Liu, Junteng and Lv, Chuancheng and Zhang, Yikai and Lei, Jiayi and
          Fu, Yao and Sun, Maosong and He, Junxian},
  booktitle={Advances in Neural Information Processing Systems},
  year={2023}
}
```
"""


def write_license_note(outdir, ncat, nq):
    p = os.path.join(outdir, "LICENSE-DATA.md")
    io.open(p, "w", encoding="utf-8").write(
        "<!-- 本包共 %d 类 / %d 题 -->\n\n%s" % (ncat, nq, LICENSE_NOTE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "_release", "bank-ceval"))
    ap.add_argument("--latex-cap", type=float, default=0.40,
                    help="选项含 LaTeX 比例超过该值的学科不导（默认 0.40）")
    ap.add_argument("--with-middle", action="store_true", help="连初中一起导（默认不导）")
    ap.add_argument("--prefix", default="5", help="类别文件编号前缀，避免与主包撞号")
    args = ap.parse_args()

    subs = subject_list()
    included, excluded = [], []
    for s in subs:
        rows = pq.read_table(test_parquet(s)).to_pylist()
        n = len(rows)
        latex_opts = sum(1 for r in rows
                         if any(is_latex(str(r.get(k) or "")) for k in LETTERS))
        ratio = latex_opts / n if n else 0
        lv = level_of(s)
        if s in OVERLAP:
            have, name = OVERLAP[s]
            if have >= 0.8 * n:
                excluded.append((s, n, ratio,
                                 "与现有库重复：「%s」%d 题 >= C-Eval %d 的 80%%" % (name, have, n)))
            else:
                included.append((s, n, ratio, lv or "大学/专业"))   # 现有更薄，算净增
        elif lv == "初中" and not args.with_middle:
            excluded.append((s, n, ratio, "初中层，产品面向大学生（--with-middle 可含）"))
        elif ratio > args.latex_cap:
            excluded.append((s, n, ratio,
                             "选项含 LaTeX %.0f%% > 上限 %.0f%%，题库匹配会失效" % (100 * ratio, 100 * args.latex_cap)))
        else:
            included.append((s, n, ratio, lv or "大学/专业"))

    os.makedirs(args.out, exist_ok=True)
    index, total = [], 0
    for i, (s, n, ratio, lv) in enumerate(sorted(included, key=lambda x: (-x[1], x[0])), 1):
        zh = ZH.get(s, s)
        fname = "%s%02d_ce_%s.json" % (args.prefix, i, s)
        qs = []
        for r in pq.read_table(test_parquet(s)).to_pylist():
            q = str(r.get("question") or "").strip()
            opts = [str(r.get(k) or "").strip() for k in LETTERS]
            ans = str(r.get("answer") or "").strip().upper()
            if not q or any(not o for o in opts) or len(ans) != 1 or ans not in LETTERS:
                continue
            qs.append({"question": q, "options": opts, "answer": [LETTERS.index(ans)], "type": "single"})
        json.dump({"category": "C-Eval · %s" % zh, "count": len(qs), "questions": qs},
                  io.open(os.path.join(args.out, fname), "w", encoding="utf-8"), ensure_ascii=False)
        index.append({"file": fname, "label": "C-Eval·%s" % zh, "count": len(qs)})
        total += len(qs)
    json.dump(index, io.open(os.path.join(args.out, "index.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    write_license_note(args.out, len(index), total)
    rep = io.open(os.path.join(HERE, "_import_report.md"), "w", encoding="utf-8")
    rep.write("# C-Eval 导入报告\n\n")
    try:
        out_label = os.path.relpath(os.path.abspath(args.out), ROOT).replace("\\", "/")
    except ValueError:
        out_label = args.out
    rep.write("- 输出目录：`%s`\n- 导入 **%d 科 / %d 题**；排除 %d 科\n" % (out_label, len(index), total, len(excluded)))
    rep.write("- LaTeX 排除阈值：%.0f%%；初中层%s\n\n" % (100 * args.latex_cap, "已含" if args.with_middle else "已排除"))
    rep.write("## 已导入\n\n| 文件 | 学科 | 层级 | 题数 | 选项含LaTeX |\n|---|---|---|---|---|\n")
    for (s, n, ratio, lv), e in zip(sorted(included, key=lambda x: (-x[1], x[0])), index):
        rep.write("| `%s` | %s | %s | %d | %.0f%% |\n" % (e["file"], ZH.get(s, s), lv, n, 100 * ratio))
    rep.write("\n## 已排除（含理由）\n\n| 学科 | 题数 | 选项含LaTeX | 理由 |\n|---|---|---|---|\n")
    for s, n, ratio, why in sorted(excluded, key=lambda x: x[0]):
        rep.write("| `%s` | %d | %.0f%% | %s |\n" % (s, n, 100 * ratio, why))
    rep.write("\n## 许可\n\nC-Eval 数据集为 **CC BY-NC-SA 4.0**（非商业、署名、相同方式共享），"
              "代码为 MIT。本包**不得**随代码一并标注 MIT。引用需按官方要求 cite "
              "Huang et al., NeurIPS 2023。\n")
    rep.close()

    print("导入 %d 科 / %d 题 → %s" % (len(index), total, args.out))
    print("排除 %d 科，理由见 tools/ceval-import/_import_report.md" % len(excluded))


if __name__ == "__main__":
    main()
