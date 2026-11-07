
# -*- coding: utf-8 -*-
"""把重建后的类别文件逐个打到 stdout，供外部（write 工具）落盘。

为什么要有这一层：本机沙箱下 Python 对工作区**没有写权限**
（连 os.makedirs 都被拒），build_bank.py 的 emit() 必然会 PermissionError。
所以 build_bank.py 保持"直接写盘"的常规逻辑不变（换台机器就能用），
本脚本只负责在受限环境下把它算出来的内容取出来。

用法：
  python tools/emit_bank.py <文件编号>      # 只打某一个类别，如 10_地理
  python tools/emit_bank.py --list          # 只列清单（文件名 + 题量）
"""
import json, os, re, sys, unicodedata

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bank_numbering
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "_regen-src")
LOCAL = os.path.join(ROOT, "tools", "bank-src")
LETTER = "ABCDEFGH"


def parse_answer(ans, n_opts):
    if ans is None:
        return None
    if isinstance(ans, list):
        out = []
        for a in ans:
            idx = parse_answer(str(a), n_opts)
            if idx is None:
                return None
            out.extend(idx)
        return sorted(set(out)) or None
    s = str(ans).strip().upper().replace("、", "").replace(",", "").replace(" ", "")
    if not s or not re.fullmatch(r"[A-H]{1,8}", s):
        return None
    if any(c not in LETTER[:n_opts] for c in s):
        return None
    return sorted({LETTER.index(c) for c in s})


def _key(text):
    """归一化：去空白、去标点、去符号、转小写。

    与 content.js 的 normalize() 和 audit_bank.py 保持同一语义。
    Python 的 re 不支持 JS 的 \\p{P} / \\p{S}，所以用 unicodedata 按字符类别过滤
    （P* 标点、S* 符号、Z* 分隔符），比 \\W 精确 —— 后者会把下划线和部分符号漏掉。
    """
    out = []
    for ch in str(text or "").lower():
        if ch == "_" or ch.isspace():
            continue
        cat = unicodedata.category(ch)
        if cat[0] in ("P", "S", "Z"):
            continue
        out.append(ch)
    return "".join(out)


def dedupe(qs):
    """按"题干 + 选项集"去重，而不是只看题干。

    为什么不能只按题干去重（实测踩过）：
      考研英语里有 11 组题干重复但**题目完全不同**的题，例如
      「Which of the following would be the best title for the text?」出现 10 次，
      每篇阅读各一道、答案各不相同。只按题干去重会把后 9 道**静默丢掉**
      （880 题变 856 题，少 24 道真题）。

      而插件侧本来就能正确处理同题干多版本：content.js 的 matchInBank 在
      精确匹配命中多个版本时，会**逐个用 remapAnswer 按选项文本挑对得上的那一份**
      （对不上就判未匹配，宁缺勿错）。所以这些题应当保留。

    真正该丢的是"题干和选项都一模一样"的重复行 —— 那才是同一道题抄了两遍。
    """
    seen, out = set(), []
    for q in qs:
        stem = _key(q["question"])
        opts = "|".join(_key(o) for o in (q.get("options") or []))
        key = stem + "@@" + opts
        if not stem or key in seen:
            continue
        seen.add(key)
        out.append(q)
    return out


def labels():
    """01~09 的中文名以 index.json 为准（那是给人看的清单来源，category 字段是原始数据集名）"""
    p = os.path.join(ROOT, "quiz-app", "bank", "index.json")
    out = {}
    if os.path.isfile(p):
        for item in json.load(open(p, encoding="utf-8")):
            if isinstance(item, dict) and item.get("file"):
                out[item["file"]] = item.get("label") or item["file"]
    return out


def build():
    """返回 [(文件名, category, [题])]"""
    out = []
    lab = labels()
    if os.path.isdir(SRC):
        for fn in sorted(os.listdir(SRC)):
            if not re.match(r"^\d\d_.*\.json$", fn):
                continue
            d = json.load(open(os.path.join(SRC, fn), encoding="utf-8"))
            qs = []
            for q in d["questions"]:
                opts = [o for o in (q.get("options") or []) if o]
                idx = parse_answer(q.get("answer"), len(opts))
                if len(opts) < 2 or idx is None:
                    sys.exit("%s 中有一题的选项或答案不合法：%s" % (fn, str(q.get("question"))[:50]))
                qs.append({"question": q["question"].strip(), "options": opts,
                           "answer": idx, "type": q.get("type") or "single"})
            out.append((fn, lab.get(fn) or d.get("category") or fn, dedupe(qs)))
    if os.path.isdir(LOCAL):
        # 编号规则与 build_bank.py 完全一致：index.json 里有的类别沿用原编号，
        # 新类别接在最大号之后追加（不再按排序位置分配，否则插入类别会重命名老文件）。
        _files = sorted(f for f in os.listdir(LOCAL) if f.endswith(".json"))
        _cats = {}
        for _fn in _files:
            _d = json.load(open(os.path.join(LOCAL, _fn), encoding="utf-8"))
            _cats[_fn] = _d.get("category") or os.path.splitext(_fn)[0]
        _names = dict(bank_numbering.assign_names(
            _files, _cats, os.path.join(ROOT, "quiz-app", "bank", "index.json")))
        for fn in _files:
            d = json.load(open(os.path.join(LOCAL, fn), encoding="utf-8"))
            cat = _cats[fn]
            qs = []
            for q in d["questions"]:
                opts = [o for o in (q.get("options") or []) if o]
                t = q.get("type") or "single"
                # 填空题：没有 options，答案是一段文本（可能是多个空的数组）。
                # 单独一条分支，不走 parse_answer（那是把字母转下标，对文本答案没意义）。
                if t == "blank" or (not opts and (q.get("answers") or q.get("answer"))):
                    texts = [str(x).strip() for x in (q.get("answers") or q.get("answer") or [])]
                    texts = [x for x in texts if x]
                    if not texts:
                        sys.exit("tools/bank-src/%s 中有一道填空题没有答案：%s" % (fn, str(q.get("question"))[:50]))
                    qs.append({"question": q["question"].strip(), "answers": texts, "type": "blank"})
                    continue
                idx = parse_answer(q.get("answer"), len(opts))
                if len(opts) < 2 or idx is None:
                    sys.exit("tools/bank-src/%s 中有一题的选项或答案不合法：%s" % (fn, str(q.get("question"))[:50]))
                if t not in ("single", "multi", "judge"):
                    sys.exit("tools/bank-src/%s 中有一题 type 非法：%s" % (fn, t))
                qs.append({"question": q["question"].strip(), "options": opts, "answer": idx, "type": t})
            out.append((_names[fn], cat, dedupe(qs)))
    return out


def main():
    banks = build()
    if "--list" in sys.argv:
        for fn, cat, qs in banks:
            print("%s\t%s\t%d" % (fn, cat, len(qs)))
        return
    want = sys.argv[1] if len(sys.argv) > 1 else None
    for fn, cat, qs in banks:
        if want and fn != want:
            continue
        obj = {"category": cat, "count": len(qs), "questions": qs}
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        return
    sys.exit("没有这个类别：%s" % want)


if __name__ == "__main__":
    main()
