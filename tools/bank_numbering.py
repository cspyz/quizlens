# -*- coding: utf-8 -*-
"""题库类别文件名的编号分配 —— build_bank.py 与 emit_bank.py 共用。

背景（这是一个真实踩过的坑）：
  原来两处都写 `enumerate(sorted(os.listdir(tools/bank-src)), start=10)`，
  编号 = **排序后的位置**。于是往 bank-src 里插一个新类别，从它往后所有类别的
  文件名都会整体后移一位：
      加 NCRE 之前   10_中医.json / 11_中文理解.json / ... / 40_逻辑推理.json
      加 NCRE 之后   10_NCRE.json / 11_中医.json   / ... / 41_逻辑推理.json
  重跑一次构建，quiz-app/bank 下 35 个文件改名、extension/bank 里旧的变成孤儿，
  而 index.json 又会跟着重写 —— 表面上"构建成功"，实际把整条链路搅乱了。

现在的规则（幂等）：
  1. 先读 quiz-app/bank/index.json，建立 「label → 已有文件名」 的映射。
     index.json 是题库清单的唯一来源（content.js 靠它加载、练习页靠它填下拉）。
  2. 源文件的 category 字段与 index 里的 label 对应得上 → **直接沿用已有编号**，
     不管它排在第几个。这样已有的 45 个文件名永远稳定。
  3. 只在 index 里找不到的新类别，才分配「当前最大编号 + 1」，按 category 排序依次给号。
     新类别追加在末尾，不会挤动任何一个老类别。

结果：build_bank.py 重跑多少次，产出的文件名都与现在逐字节相同。
"""
import json
import os


def load_index_names(index_path):
    """从 index.json 读出 {label: 文件名}，同时返回当前最大编号。"""
    by_label = {}
    max_no = 9  # 01~09 是外部数据集预留给的号段
    if not os.path.isfile(index_path):
        return by_label, max_no
    with open(index_path, encoding="utf-8") as f:
        items = json.load(f)
    for item in items:
        if not isinstance(item, dict):
            continue
        fn = item.get("file")
        label = item.get("label")
        if not fn:
            continue
        if label:
            by_label[label] = fn
        # 编号取文件名的数字前缀
        try:
            no = int(fn.split("_", 1)[0])
        except (ValueError, IndexError):
            continue
        max_no = max(max_no, no)
    return by_label, max_no


def assign_names(src_files, categories, index_path, start=10):
    """给源文件分配输出文件名，返回 [(源文件名, 输出文件名)]，顺序与 src_files 一致。

    src_files  : 源文件名列表（调用方已排序或按需排列）
    categories : {源文件名: category 字段} —— 用来和 index.json 的 label 对上号
    """
    by_label, max_no = load_index_names(index_path)

    used = {}          # 输出文件名 -> 源文件名，防同一轮里重名
    result = []
    pending = []       # index 里没有的新类别，第二轮统一编号

    for fn in src_files:
        cat = categories.get(fn) or os.path.splitext(fn)[0]
        name = by_label.get(cat)
        if name and name not in used:
            used[name] = fn
            result.append((fn, name))
        else:
            pending.append(fn)

    # 新类别按 category 排序，编号接在现有最大号之后
    pending.sort(key=lambda f: categories.get(f) or os.path.splitext(f)[0])
    for fn in pending:
        max_no += 1
        cat = categories.get(fn) or os.path.splitext(fn)[0]
        name = "%02d_%s.json" % (max_no, cat)
        while name in used:   # 极端情况：category 重名，继续往后挪
            max_no += 1
            name = "%02d_%s.json" % (max_no, cat)
        used[name] = fn
        result.append((fn, name))

    return result
