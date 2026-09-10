# -*- coding: utf-8 -*-
"""
CPython MT19937 对照值生成（P3 实施文档 §5.4，D2 的锁值基准）

用本机 CPython 的 random 模块产出对照值，供 tests/mt19937.test.js 断言
lib/mt19937.js 的复刻逐值一致。**换 Python 版本后需重跑本脚本**——它锁的是
「CPython 当时的行为」，而源插件跑在同一台机器的同一个解释器上。

运行：E:\\bot\\Nonebot\\Hikari-Bot\\.venv\\Scripts\\python.exe -X utf8 tests/refs/gen_mt19937_ref.py
输出：tests/refs/mt19937_ref.json

三个 section 各自锁一件事：
- stream  ：同一实例连取 10 次 getrandbits(32) —— 锁状态机连续性（melange/temper 的推进）
- bits    ：每个 (seed, k) 用**全新实例**取 3 次 —— 锁 getrandbits 的两条路径
            （k<=32 走 genrand>>(32-k)；k>32 逐字填充、最后一字同样丢低位）
- choice  ：生产路径 random.Random(qqhash).choice(list) —— 锁 _randbelow 的拒绝采样
"""
import json
import os
import random
import sys

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(PLUGIN_ROOT, "tests", "refs", "mt19937_ref.json")

SEEDS = [0, 1, 12345, 987654321, 1099511627783]
KS = [1, 8, 31, 32, 33, 40, 64]

# 生产路径的输入：(qq, 日, 月)，hash 由下方的 qqhash 推出
CASES = [(114514, 10, 9), (10001, 10, 9), (2793812633, 1, 1), (7, 31, 12), (1919810, 15, 6)]
NS = [1, 2, 3, 7, 100, 624, 1024, 1379, 1408, 4096, 5000]


def qqhash(qq, day, month):
    """lib/calc.js 的同款公式：days = 日 + 31 * 月 + 77，hash = (days * qq) >> 8"""
    return ((day + 31 * month + 77) * qq) >> 8


def main():
    stream = []
    for s in SEEDS:
        r = random.Random(s)  # 一个实例连取 10 次，才锁得住状态推进
        stream.append({"seed": s, "values": [r.getrandbits(32) for _ in range(10)]})

    bits = []
    for s in SEEDS:
        for k in KS:
            # 每行一个全新实例：三值即该 (seed,k) 的前三次输出，与 JS 侧逐行对齐
            r = random.Random(s)
            # 一律转字符串：k>53 时 Python int 超出 JS Number 精度，走 JSON number 会静默失真
            bits.append({"seed": s, "k": k,
                         "values": [str(r.getrandbits(k)) for _ in range(3)]})

    choice = []
    for (qq, day, month) in CASES:
        h = qqhash(qq, day, month)
        for n in NS:
            choice.append({
                "qq": qq, "day": day, "month": month, "hash": h, "n": n,
                "index": random.Random(h).choice(range(n)),
            })

    payload = {
        "python": sys.version.split()[0],
        "seeds": SEEDS, "ks": KS, "ns": NS, "cases": CASES,
        "stream": stream, "bits": bits, "choice": choice,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"wrote {OUT}  python={payload['python']}  "
          f"stream={len(stream)} bits={len(bits)} choice={len(choice)}")


if __name__ == "__main__":
    main()
