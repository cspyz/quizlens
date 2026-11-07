# -*- coding: utf-8 -*-
"""
题库审计：拿 quiz-app/bank/ 下的全部类别文件，检查"数据卫生"与"跨库冲突"。

和 audit_paper.py 的分工：
  audit_paper.py 查**练习卷**（quiz-app/questions.json）的格式覆盖够不够；
  audit_bank.py  查**大题库**（quiz-app/bank/*.json）的数据本身干不干净。

为什么要单独有这一份：驾考四库本质是同一套题（跨库重复 9369 行），
content.js 的注释里已经写明"同一题干在不同题库里可能是选项顺序不同、
甚至答案互相矛盾的题"，靠 remapAnswer 兜底。但"到底有多少自相矛盾的题"
一直没人量过——本脚本就是把它量出来。

用法：
  python tools/audit_bank.py              # 打印报告
  python tools/audit_bank.py --strict     # 有硬错误(ERROR)时退出码 1
"""
import json, os, re, sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANK = os.path.join(ROOT, "quiz-app", "bank")

# 与 content.js 的 normalize() 对齐：去空白、去标点、去符号、转小写
# （否则审计出来的"重复"和插件实际认的"重复"不是一回事）
NORM_RE = re.compile(r"[\s\W_]+", re.UNICODE)
TAG_RE = re.compile(r"<[a-zA-Z/!][^>]*>")


def normalize(text):
    return NORM_RE.sub("", (text or "").lower())


def opt_key(t):
    return normalize(re.sub(r"^\s*[A-Za-z]\s*[).、．,，:：]\s*", "", str(t or "")))


def load_bank():
    """返回 [(fname, label, [q, ...]), ...]，按 index.json 的顺序"""
    idx_path = os.path.join(BANK, "index.json")
    if not os.path.isfile(idx_path):
        sys.exit("缺少 %s（先跑 tools/build_bank.py）" % idx_path)
    with open(idx_path, encoding="utf-8") as f:
        index = json.load(f)
    out = []
    for item in index:
        name = item if isinstance(item, str) else (item or {}).get("file")
        if not name:
            continue
        path = os.path.join(BANK, name)
        if not os.path.isfile(path):
            print("警告：清单里的 %s 不存在，跳过" % name)
            continue
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        label = item.get("label", name) if isinstance(item, dict) else name
        out.append((name, label, d.get("questions", [])))
    return out


def main():
    strict = "--strict" in sys.argv
    banks = load_bank()

    n_error = n_warn = 0

    def err(msg):
        nonlocal n_error
        n_error += 1
        print("  ❌ %s" % msg)

    def warn(msg):
        nonlocal n_warn
        n_warn += 1
        print("  ⚠  %s" % msg)

    print("=" * 78)
    print("题库审计 —— quiz-app/bank/（%d 个类别）" % len(banks))
    print("=" * 78)

    # ---------- 逐库基础检查 ----------
    print("\n【一、逐库基础数据】")
    print("  %-24s %8s %8s %8s %8s %8s" % ("文件", "题量", "答案越界", "空选项", "重复选项", "题干重复"))
    all_rows = []
    for name, label, qs in banks:
        oob = empty_opt = dup_opt = dup_stem = 0
        seen_stem = set()
        for q in qs:
            opts = q.get("options") or []
            ans = q.get("answer") or []
            if any(not isinstance(i, int) or i < 0 or i >= len(opts) for i in ans):
                oob += 1
            if any(not str(o).strip() for o in opts):
                empty_opt += 1
            keys = [opt_key(o) for o in opts]
            keys = [k for k in keys if k]
            if len(keys) != len(set(keys)):
                dup_opt += 1
            nk = normalize(q.get("question", ""))
            if nk and nk in seen_stem:
                dup_stem += 1
            seen_stem.add(nk)
        all_rows.append((name, label, len(qs)))
        print("  %-24s %8d %8d %8d %8d %8d" % (name, len(qs), oob, empty_opt, dup_opt, dup_stem))
        if oob:
            err("%s：%d 题答案下标越界" % (name, oob))
        if empty_opt:
            warn("%s：%d 题存在空选项" % (name, empty_opt))
        if dup_opt:
            warn("%s：%d 题选项内容重复（remapAnswer 可能定位歧义）" % (name, dup_opt))

    total = sum(r[2] for r in all_rows)
    print("  %-24s %8d" % ("合计", total))

    # ---------- 跨库同题干冲突 ----------
    print("\n【二、跨库同题干（归一化后）冲突】")
    by_stem = defaultdict(list)
    for name, label, qs in banks:
        for q in qs:
            k = normalize(q.get("question", ""))
            if k:
                by_stem[k].append((name, q))

    shared = {k: v for k, v in by_stem.items() if len(v) > 1}
    cross = {k: v for k, v in shared.items() if len({n for n, _ in v}) > 1}
    print("  归一化后不同题干数：%d（原始 %d 行，重复 %d 行）"
          % (len(by_stem), total, total - len(by_stem)))
    print("  跨类别共享的题干：%d 条" % len(cross))

    def ans_sig(q):
        opts = [opt_key(o) for o in (q.get("options") or [])]
        ans = sorted(q.get("answer") or [])
        return tuple(opts[i] for i in ans if 0 <= i < len(opts))

    conflict = {}
    for k, v in cross.items():
        sigs = {ans_sig(q) for _, q in v}
        if len(sigs) > 1:
            conflict[k] = v
    if conflict:
        print("  其中**答案互相矛盾**的题干：%d 条（插件靠 remapAnswer 判未匹配兜底）" % len(conflict))
        for k, v in list(conflict.items())[:5]:
            names = ",".join(sorted({n for n, _ in v}))
            texts = {str(ans_sig(q)) for _, q in v}
            print("     · %s…  出现在 [%s]，答案 %d 种: %s"
                  % (v[0][1].get("question", "")[:34], names, len(texts),
                     " | ".join(t[:40] for t in list(texts)[:3])))
    else:
        print("  未发现答案矛盾的重复题干 ✅")

    # ---------- 题干形态 ----------
    print("\n【三、题干形态（影响真实站点的匹配率）】")
    html_n = short_n = tiny_n = 0
    html_example = ""
    for name, label, qs in banks:
        for q in qs:
            s = q.get("question", "")
            if TAG_RE.search(s):
                html_n += 1
                if not html_example:
                    html_example = s[:60]
            n = len(s.strip())
            if n < 15:
                short_n += 1
            if n < 6:
                tiny_n += 1
    print("  含 HTML 标签：%d 题（%.2f%%，content.js 的 stripHtml 会剥掉，但两边文本仍可能不一致）"
          % (html_n, html_n * 100.0 / max(total, 1)))
    if html_example:
        print("     例：%s…" % html_example)
    print("  题干 <15 字：%d 题（%.2f%%，短题干 LCS 分母小，模糊匹配易虚高）"
          % (short_n, short_n * 100.0 / max(total, 1)))
    print("  题干 <6 字：%d 题（这类基本无法可靠匹配）" % tiny_n)
    if tiny_n > total * 0.001:
        warn("过短题干占比偏高，建议在源题库里补充上下文")
    else:
        print("  ✅ 过短题干占比很低")

    # ---------- 题型/结构分布 ----------
    print("\n【四、题型与结构分布】")
    types = Counter()
    opt_dist = Counter()
    for name, label, qs in banks:
        for q in qs:
            types[q.get("type", "(缺失)")] += 1
            opt_dist[len(q.get("options") or [])] += 1
    for t, c in types.most_common():
        print("  %-10s %8d  (%.1f%%)" % (t, c, c * 100.0 / max(total, 1)))
    print("  选项个数分布:", dict(sorted(opt_dist.items())))

    # ---------- 结论 ----------
    print("\n" + "=" * 78)
    print("硬错误(ERROR)：%d    警告(WARN)：%d" % (n_error, n_warn))
    print("说明：跨库答案矛盾的题干不算错误——插件 remapAnswer 已按"
          "「选项文本对得上才用」处理，对不上会判未匹配而不是填错。")
    if n_error == 0:
        print("结论：题库数据卫生检查通过 ✅")
    else:
        print("结论：存在 %d 项硬错误，见上" % n_error)
    sys.exit(1 if (strict and n_error) else 0)


if __name__ == "__main__":
    main()
