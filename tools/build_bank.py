# -*- coding: utf-8 -*-
"""
原始题库 -> 插件题库索引
用法：
  python tools/build_bank.py <原始题库目录>
把该目录下的各类 JSON 转换成插件可读的紧凑格式，输出到 <仓库根>/quiz-app/bank/ 。

只保留可自动填涂的题（有选项 + 答案可解析为选项下标）：
  填空题（成语/歇后语/安全微伴）和编程题（力扣）不参与。
格式与 quiz-app/questions.json 兼容：answer 为选项下标数组。

源目录之外，作者本地维护的补充题库放在 tools/bank-src/（每文件一个类别，
格式 {"category","questions":[{"question","options","answer","type"}]}），
会一并编成 10 号往后的类别文件，不依赖命令行给的 <原始题库目录>。
**该目录不随仓库分发**（见 .gitignore）；不存在时构建会打印提示并跳过这一步。
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bank_numbering

sys.stdout.reconfigure(encoding="utf-8")
# 相对脚本自身定位，换机器/换盘符都能用
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# DST 允许用环境变量覆盖：本机沙箱下 Python 写工作区会被拒（PermissionError），
# 这时先导到一个可写目录，再由外部把文件搬回 quiz-app/bank（与 extend_questions2.py 的 --stdout 同一套思路）。
DST = os.environ.get("BANK_DST") or os.path.join(ROOT, "quiz-app", "bank")

if len(sys.argv) < 2:
    sys.exit("请用命令行指定原始题库目录，例如：\n  python tools/build_bank.py /path/to/bank-src")
SRC = sys.argv[1]
if not os.path.isdir(SRC):
    sys.exit("题库源目录不存在：%s" % SRC)

os.makedirs(DST, exist_ok=True)

LETTER = "ABCDEFGH"

def parse_answer(ans, n_opts):
    """答案字符串 -> 选项下标数组；解析失败返回 None"""
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
    # 答案里出现选项范围之外的字母 → 这题选项/答案对不上，整题丢弃。
    # 不能"过滤掉越界字母后照收"：多选题会被截成少选，静默产出错误答案。
    if any(c not in LETTER[:n_opts] for c in s):
        return None
    return sorted({LETTER.index(c) for c in s})

STATS = {}

def emit(fname, category, qs, label=None):
    # 去重（题干归一化）
    seen, out = set(), []
    for q in qs:
        key = re.sub(r"[\s\W]+", "", q["question"])
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(q)
    obj = {"category": category, "count": len(out), "questions": out}
    path = os.path.join(DST, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path) / 1048576
    # label：给人看的中文名，写进 index.json 供练习页下拉使用（避免清单在多处硬编码）
    STATS[fname] = (len(out), round(size, 2), label or category)
    print("%-24s %7d 题  %6.2f MB" % (fname, len(out), size))

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

# ---------- 0. 扁平源目录（重生成模式）----------
# 当 <原始题库目录> 里直接是 01_xx.json ~ 09_xx.json 这种**已编好的**类别文件时，
# 按原样重新编一遍。用于"手上没有外部原始数据集，但要把题库整体重建一次"的场景
# （例如新增了 tools/bank-src/ 里的本地类别，需要重算 index.json）。
# 源结构与本脚本的输出一致：{"category","questions":[{"question","options","answer","type"}]}。
FLAT = sorted(f for f in os.listdir(SRC) if re.match(r"^\d\d_.*\.json$", f))
if FLAT:
    print("检测到扁平类别源目录，按原类别重建：")
    for fn in FLAT:
        d = load(os.path.join(SRC, fn))
        qs = []
        for q in d["questions"]:
            opts = [o for o in (q.get("options") or []) if o]
            idx = parse_answer(q.get("answer"), len(opts))
            if len(opts) < 2 or idx is None:
                sys.exit("%s 中有一题的选项或答案不合法：%s" % (fn, str(q.get("question"))[:50]))
            qs.append({"question": q["question"].strip(), "options": opts,
                       "answer": idx, "type": q.get("type") or "single"})
        emit(fn, d.get("category") or fn, qs, d.get("category") or fn)

# ---------- 1. 驾考 4 库（已带 judge/single/multiple 标记）----------
for fn, out_name, label in [("car_小车C1_C2_C3.json", "01_jiakao_car.json", "驾考·小车 C1/C2/C3"),
                            ("moto_摩托车D_E_F.json", "02_jiakao_moto.json", "驾考·摩托车 D/E/F"),
                            ("truck_货车A2_B2.json", "03_jiakao_truck.json", "驾考·货车 A2/B2"),
                            ("bus_客车A1_A3_B1.json", "04_jiakao_bus.json", "驾考·客车 A1/A3/B1")]:
    d = load(os.path.join(SRC, "驾考", fn))
    qs = []
    for q in d["questions"]:
        opts, ans = q.get("options") or [], q.get("answer")
        idx = parse_answer(ans, len(opts))
        if not opts or idx is None:
            continue
        if q.get("has_media"):
            continue  # 图片/视频题干不完整，纯文本插件答不准
        qs.append({"question": q["question"].strip(), "options": opts, "answer": idx,
                   "type": "judge" if q["type"] == "judge" else
                           ("multi" if q["type"] == "multiple_choice" else "single")})
    emit(out_name, d["category"], qs, label)

# ---------- 2. CMMLU（67 科合一）----------
qs = []
src = os.path.join(SRC, "CMMLU_综合学科")
for fn in sorted(os.listdir(src)):
    if not fn.endswith(".json"):
        continue
    d = load(os.path.join(src, fn))
    cn = d.get("category_cn", "")
    for q in d["questions"]:
        opts = [o for o in (q.get("options") or []) if o]
        idx = parse_answer(q.get("answer"), len(opts))
        if len(opts) < 2 or idx is None:
            continue
        qs.append({"question": q["question"].strip(), "options": opts, "answer": idx,
                   "type": "single", "cat": cn})
emit("05_cmmlu.json", "CMMLU 综合学科", qs, "CMMLU 综合 67 学科")

# ---------- 3. 医学（346 学科合一，去解析）----------
qs = []
src = os.path.join(SRC, "医学考试")
for fn in sorted(os.listdir(src)):
    if not fn.endswith(".json"):
        continue
    d = load(os.path.join(src, fn))
    for q in d["questions"]:
        opts = [o for o in (q.get("options") or []) if o]
        idx = parse_answer(q.get("answer"), len(opts))
        if len(opts) < 2 or idx is None:
            continue
        qs.append({"question": q["question"].strip(), "options": opts, "answer": idx,
                   "type": "single", "cat": d.get("category", "")})
emit("06_medical.json", "医学考试", qs, "医学考试 346 学科")

# ---------- 4. 业余无线电 ----------
qs = []
src = os.path.join(SRC, "业余无线电")
for fn in sorted(os.listdir(src)):
    if not fn.endswith(".json"):
        continue
    d = load(os.path.join(src, fn))
    for q in d["questions"]:
        opts = [o for o in (q.get("options") or []) if o]
        idx = parse_answer(q.get("answer"), len(opts))
        if len(opts) < 2 or idx is None:
            continue
        qs.append({"question": q["question"].strip(), "options": opts, "answer": idx,
                   "type": "multi" if q.get("type") == "multiple_choice" else "single",
                   "cat": d.get("category", "")})
emit("07_ham.json", "业余无线电", qs, "业余无线电 A/B/C")

# ---------- 5. 高考真题（选项混在题干里的先切分再解析）----------
qs = []
src = os.path.join(SRC, "高考真题")
for fn in sorted(os.listdir(src)):
    if not fn.endswith(".json"):
        continue
    d = load(os.path.join(src, fn))
    for q in d["questions"]:
        text = (q.get("question") or "").strip()
        if not text:
            continue
        opts = [o for o in (q.get("options") or []) if o]
        if not opts:
            # 从题干切 "A. xxx B. xxx C. xxx"
            marks = list(re.finditer(r"(?:^|\s)([A-H])\s*[).、．]\s*", text))
            if len(marks) < 2:
                continue
            if any(ord(m.group(1)) - 65 != i for i, m in enumerate(marks)):
                continue
            opts = []
            for i, m in enumerate(marks):
                end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
                opts.append(text[m.end():end].strip())
            text = text[:marks[0].start()].strip()
            if not text or any(not o for o in opts):
                continue
        idx = parse_answer(q.get("answer"), len(opts))
        if idx is None:
            continue
        qs.append({"question": text, "options": opts, "answer": idx,
                   "type": "single", "cat": q.get("paper", "")})
emit("08_gaokao.json", "高考真题", qs, "高考真题（客观题）")

# ---------- 6. 小学语数英 ----------
qs = []
src = os.path.join(SRC, "小学语数英")
for grade in sorted(os.listdir(src)):
    gdir = os.path.join(src, grade)
    if not os.path.isdir(gdir):
        continue
    for fn in sorted(os.listdir(gdir)):
        if not fn.endswith(".json"):
            continue
        d = load(os.path.join(gdir, fn))
        for q in d["questions"]:
            opts = [o for o in (q.get("options") or []) if o]
            idx = parse_answer(q.get("answer"), len(opts))
            if len(opts) < 2 or idx is None:
                continue
            qs.append({"question": q["question"].strip(), "options": opts, "answer": idx,
                       "type": "single", "cat": grade})
emit("09_primary.json", "小学语数英", qs, "小学语数英 1-6 年级")

# ---------- 7. 本地补充题库（tools/bank-src/，逐文件一个类别）----------
# 与上面 1~6 的区别：这些源文件由作者本地维护（不随仓库分发），
# 不是外部数据集，所以路径固定、不依赖命令行参数 SRC。
# 结构统一为 {"category": "...", "questions": [{"question","options","answer","type"}]}，
# answer 用字母（"B"/"AC"），由 parse_answer 转成下标数组——与外部题库格式完全一致，
# 因此新增类别只要往 tools/bank-src/ 丢一个 JSON，不用改脚本逻辑。
# 编号从 10 开始，给外部数据集的 01~09 让位（index.json 按文件名排序，练习页下拉的顺序靠它）。
LOCAL_SRC = os.path.join(ROOT, "tools", "bank-src")
if os.path.isdir(LOCAL_SRC):
    # 编号不再按"排序位置"分配（那样插一个类别就会把后面所有类别改名，见 bank_numbering.py 的说明）。
    # 改为：index.json 里已有的类别沿用原编号，新类别接在最大号之后追加。
    _local_files = sorted(f for f in os.listdir(LOCAL_SRC) if f.endswith(".json"))
    _local_cats = {}
    for _fn in _local_files:
        _d = load(os.path.join(LOCAL_SRC, _fn))
        _local_cats[_fn] = _d.get("category") or os.path.splitext(_fn)[0]
    _name_map = dict(bank_numbering.assign_names(
        _local_files, _local_cats, os.path.join(DST, "index.json")))
    for fn in _local_files:
        d = load(os.path.join(LOCAL_SRC, fn))
        cat = _local_cats[fn]
        qs = []
        for q in d["questions"]:
            opts = [o for o in (q.get("options") or []) if o]
            idx = parse_answer(q.get("answer"), len(opts))
            # 自检：选项不足 2 个或答案解析不出来，说明源文件写错了，直接报错而不是静默丢弃。
            # 本目录是手写数据，静默丢题等于"加了但没进去"，必须在构建时就看见。
            if len(opts) < 2 or idx is None:
                sys.exit("tools/bank-src/%s 中有一题的选项或答案不合法：%s" % (fn, str(q.get("question"))[:50]))
            if any(i >= len(opts) for i in idx):
                sys.exit("tools/bank-src/%s 中有一题答案下标越界：%s" % (fn, str(q.get("question"))[:50]))
            t = q.get("type") or "single"
            if t not in ("single", "multi", "judge"):
                sys.exit("tools/bank-src/%s 中有一题 type 非法（只允许 single/multi/judge）：%s" % (fn, t))
            qs.append({"question": q["question"].strip(), "options": opts, "answer": idx, "type": t})
        emit(_name_map[fn], cat, qs, cat)
else:
    print("（跳过本地补充题库：%s 不存在）" % LOCAL_SRC)

print("\n==== 汇总 ====")
total = sum(s[0] for s in STATS.values())
size = sum(s[1] for s in STATS.values())
print("类别文件:", len(STATS), " 总题量:", total, " 总体积: %.2f MB" % size)

# 生成 index.json：唯一的题库清单来源。
#   - content.js 读它来自动加载全部题库（兼容旧的"纯文件名数组"格式）
#   - quiz-app 读它来填"题库抽题"下拉，不再各自硬编码一份，避免新增题库后两边不同步
entries = [{"file": k, "label": v[2], "count": v[0]}
           for k, v in sorted(STATS.items())]
with open(os.path.join(DST, "index.json"), "w", encoding="utf-8") as f:
    json.dump(entries, f, ensure_ascii=False, indent=1)
print("index.json 已生成（%d 个文件，含中文名与题量）" % len(entries))
