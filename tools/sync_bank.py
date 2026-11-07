# -*- coding: utf-8 -*-
"""
题库同步：quiz-app/bank  ->  extension/bank

为什么需要这一步
----------------
content.js 原来写的是 fetch("./bank/index.json")，而 "./" 是相对**当前网页**解析的，
不是相对扩展目录。所以在真实网站上（问卷星、任何考试系统）这个请求必然 404，
"题库匹配（推荐）"这个默认模式等于空转，一道题也答不出。

修好之后 content.js 会按优先级尝试三个来源：
  ① 弹窗里手填的「题库地址」（本地 http 服务 / 云端站点）
  ② 随扩展打包的 extension/bank/     <- 本脚本负责把题库放进去
  ③ 当前网页自带的 ./bank/           （本地练习页的向后兼容路径）

想用 ② 就要跑一次本脚本。代价是扩展目录会从约 100 KB 涨到约 16 MB
（题库跟着插件走，换台机器、换浏览器都不用再配）。

用法
----
    python tools/sync_bank.py                 # 默认从 quiz-app/bank 同步
    python tools/sync_bank.py D:/别的/bank     # 指定源目录
    python tools/sync_bank.py --clean          # 删掉 extension/bank（换回轻量扩展）
    python tools/sync_bank.py --prune          # 同步并删掉目标目录里不在 index.json 的文件
    python tools/sync_bank.py --prune --dry-run # 只列出会被删的文件，不真删

为什么需要 --prune
------------------
本脚本原来是"只复制、从不清目标目录"。题库重编号（22 类 → 41 类）之后，
旧编号的文件就一直留在 extension/bank 里变成孤儿 —— 实测攒了 68 个、17.5MB，
其中还有 11.4MB 是某个大库的完整重复。它们既撑大仓库，又容易被误认为有效题库。

不带 --prune 时行为与以前完全一致（只增不减），需要清理时显式加这个开关。
"""
import json
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

# 相对脚本自身定位，换机器/换盘符都能用
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "quiz-app", "bank")
DST = os.path.join(ROOT, "extension", "bank")

ARGS = sys.argv[1:]
PRUNE = "--prune" in ARGS
DRY_RUN = "--dry-run" in ARGS

if "--clean" in ARGS:
    if os.path.isdir(DST):
        shutil.rmtree(DST)
        print("已删除 %s（扩展回到轻量状态，题库改用弹窗里的「题库地址」）" % DST)
    else:
        print("没有 %s，无需清理" % DST)
    sys.exit(0)

# 非开关参数视为源目录（--prune / --dry-run / --clean 之外的第一个）
for a in ARGS:
    if not a.startswith("--"):
        SRC = a
        break

if not os.path.isdir(SRC):
    sys.exit("题库源目录不存在：%s\n先跑 tools/build_bank.py 生成题库，或用命令行指定源目录" % SRC)

# index.json 是清单的唯一来源：content.js 按它遍历加载，不写死文件名
index_path = os.path.join(SRC, "index.json")
if not os.path.isfile(index_path):
    sys.exit("缺少 %s —— 题库目录里必须有 index.json 清单" % index_path)

with open(index_path, encoding="utf-8") as f:
    index = json.load(f)
if not isinstance(index, list) or not index:
    sys.exit("index.json 格式不对：应为非空数组")

os.makedirs(DST, exist_ok=True)

total_q = 0
copied = 0
for item in index:
    name = item if isinstance(item, str) else (item or {}).get("file")
    if not name:
        print("跳过：index.json 里有一项没有 file 字段")
        continue
    src_file = os.path.join(SRC, name)
    if not os.path.isfile(src_file):
        print("跳过：源文件不存在 %s" % name)
        continue
    shutil.copy2(src_file, os.path.join(DST, name))
    copied += 1
    if isinstance(item, dict):
        total_q += int(item.get("count") or 0)

# 清单也要一起复制，否则扩展内置题库这一档拿不到 index.json
shutil.copy2(index_path, os.path.join(DST, "index.json"))

# ---- --prune：删掉目标目录里"不在清单中"的 json ----
# 只动 .json，且只动清单里没有的；index.json 永远保留。
# 默认不删（保持与老版本一致），要清就显式加 --prune。
pruned = 0
pruned_bytes = 0
if PRUNE and os.path.isdir(DST):
    wanted = set()
    for item in index:
        name = item if isinstance(item, str) else (item or {}).get("file")
        if name:
            wanted.add(name)
    wanted.add("index.json")
    for fname in sorted(os.listdir(DST)):
        if not fname.endswith(".json") or fname in wanted:
            continue
        fpath = os.path.join(DST, fname)
        if not os.path.isfile(fpath):
            continue
        sz = os.path.getsize(fpath)
        if DRY_RUN:
            print("将删除（不在 index.json 中）：%s  %.2f MB" % (fname, sz / 1048576))
        else:
            os.remove(fpath)
            print("已删除（不在 index.json 中）：%s  %.2f MB" % (fname, sz / 1048576))
        pruned += 1
        pruned_bytes += sz
    if pruned == 0:
        print("--prune：没有需要清理的孤儿文件")
    elif DRY_RUN:
        print("--prune（dry-run）：共 %d 个 / %.2f MB 待删除" % (pruned, pruned_bytes / 1048576))
    else:
        print("--prune：共清理 %d 个 / %.2f MB" % (pruned, pruned_bytes / 1048576))

size_mb = sum(
    os.path.getsize(os.path.join(DST, f))
    for f in os.listdir(DST) if f.endswith(".json")
) / 1048576

print("已同步 %d/%d 个题库文件 -> %s" % (copied, len(index), DST))
print("题量约 %d 题，共 %.2f MB" % (total_q, size_mb))
print()
print("接着做：打开 chrome://extensions（或 edge://extensions），")
print("找到 AutoAnswer 练习助手，点一下「重新加载」，扩展内置题库才会生效。")
print("弹窗里的「题库地址」留空即可——留空才会走扩展内置这一档。")
