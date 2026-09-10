# -*- coding: utf-8 -*-
"""
Yunzai HTML 渲染 vs NoneBot 源 PIL 参照的数值比对（设计 §12，ADR-1 信息级还原）
比对思路：同 fixture 同素材，两张图「非文字区应几乎一致、文字区允许字形栅格化差异」——
  - 逐 8px 格均值绝对差分三级：ok(<18) / soft(18..60 文字抗锯齿带) / hard(≥60 结构差异)
  - 输出每页统计 + 最严重 hard 格坐标 TOP N（映射坐标表人工复核）+ 热力图 PNG
  - global 页无源参照（pyecharts 只产 HTML），改为自身数值探针（环形图存在性/色数/标题墨迹）

运行：venv python -X utf8 tests/refs/compare.py   （读 tests/out/*.jpg vs tests/out/refs/*_ref.png）
"""
import os
import json
import sys

import numpy as np
from PIL import Image

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(PLUGIN_ROOT, 'tests', 'out')
REFS = os.path.join(OUT, 'refs')
HEAT = os.path.join(OUT, 'heat')
os.makedirs(HEAT, exist_ok=True)

CELL = 8


PAGES = [
    ('b50', 'b50.jpg', 'b50_ref.png'),
    ('score', 'score.jpg', 'score_ref.png'),
    ('song', 'song.jpg', 'song_ref.png'),
    ('song_full', 'song-full.jpg', 'song_full_ref.png'),
    ('song_utage', 'song-utage.jpg', 'song_utage_ref.png'),
    ('song_utage_buddy', 'song-utage-buddy.jpg', 'song_utage_buddy_ref.png'),
    ('songlist', 'songlist.jpg', 'songlist_ref.png'),
    # P2b 表格族：参照底图由 make_refs.py 以**源代码**按当前曲库重建（不读旧缓存），见该脚本注释
    ('table', 'table.jpg', 'table_ref.png'),
    ('table15', 'table-15.jpg', 'table15_ref.png'),
    ('plate', 'plate.jpg', 'plate_ref.png'),
    ('plate_full', 'plate-full.jpg', 'plate_full_ref.png'),
    ('plate_fc', 'plate-fc.jpg', 'plate_fc_ref.png'),
    ('plate_zhenji', 'plate-zhenji.jpg', 'plate_zhenji_ref.png'),
    ('plate_wu1', 'plate-wu1.jpg', 'plate_wu1_ref.png'),
    ('plate_wu2', 'plate-wu2.jpg', 'plate_wu2_ref.png'),
    ('plateprogress_zhenji', 'plateprogress-zhenji.jpg', 'plateprogress_zhenji_ref.png'),
    ('plateprogress_wu', 'plateprogress-wu.jpg', 'plateprogress_wu_ref.png'),
    ('progress', 'progress.jpg', 'progress_ref.png'),
    ('progress_unfinished', 'progress-unfinished.jpg', 'progress_unfinished_ref.png'),
    ('progress_notplayed', 'progress-notplayed.jpg', 'progress_notplayed_ref.png'),
    ('scorelist', 'scorelist.jpg', 'scorelist_ref.png'),
    ('scorelist_last', 'scorelist-last.jpg', 'scorelist_last_ref.png'),
    ('rise', 'rise.jpg', 'rise_ref.png'),
]


def load_pair(js_name, ref_name):
    a = np.asarray(Image.open(os.path.join(OUT, js_name)).convert('RGB')).astype(np.int16)
    b = np.asarray(Image.open(os.path.join(REFS, ref_name)).convert('RGB')).astype(np.int16)
    if a.shape != b.shape:
        return a, b, f'尺寸不一致 JS{a.shape} REF{b.shape}'
    return a, b, None


def cell_grid(a, b):
    h, w, _ = a.shape
    ch, cw = h // CELL, w // CELL
    # 逐格平均（边缘不足一格丢弃）
    a = a[:ch * CELL, :cw * CELL]
    b = b[:ch * CELL, :cw * CELL]
    ga = a.reshape(ch, CELL, cw, CELL, 3).mean(axis=(1, 3))
    gb = b.reshape(ch, CELL, cw, CELL, 3).mean(axis=(1, 3))
    return np.abs(ga - gb).mean(axis=2), ch, cw


def analyze(name, js_name, ref_name):
    a, b, err = load_pair(js_name, ref_name)
    if err:
        print(f'== {name}: {err}')
        return
    diff, ch, cw = cell_grid(a, b)
    ok = (diff < 18).sum()
    soft = ((diff >= 18) & (diff < 60)).sum()
    hard = (diff >= 60).sum()
    total = ch * cw
    # hard 格定位
    idx = np.argwhere(diff >= 60)
    # 聚类到 x/y 扫描带（列出 hard 密度最高的 3 个 40px 纵带 + 横带）
    rowband = np.zeros((ch + 4) // 5)
    colband = np.zeros((cw + 4) // 5)
    for y, x in idx:
        rowband[y // 5] += 1
        colband[x // 5] += 1
    rb = np.argsort(rowband)[::-1][:3]
    cb = np.argsort(colband)[::-1][:3]
    bandinfo = (f'纵向最密带(px): ' +
                ', '.join(f'y≈{i * 5 * CELL}~{(i * 5 + 5) * CELL}×{int(rowband[i])}格' for i in rb if rowband[i]) +
                ' | 横向: ' +
                ', '.join(f'x≈{i * 5 * CELL}~{(i * 5 + 5) * CELL}×{int(colband[i])}格' for i in cb if colband[i]))
    maxcell = np.unravel_index(np.argmax(diff), diff.shape)
    print(f'== {name}（{a.shape[1]}×{a.shape[0]}）')
    print(f'   格占比 ok {ok / total:.1%} / soft {soft / total:.1%} / hard {hard / total:.1%}（{int(hard)} 格）')
    print(f'   maxΔ={diff[maxcell]:.0f} @ ({maxcell[1] * CELL},{maxcell[0] * CELL})px  {bandinfo}')
    # 热力图：灰阶放大
    hm = (np.clip(diff / 100, 0, 1) * 255).astype(np.uint8)
    hm = np.asarray(Image.fromarray(hm).resize((cw * CELL, ch * CELL), Image.NEAREST))
    Image.fromarray(np.dstack([np.zeros_like(hm), np.zeros_like(hm), hm])).save(os.path.join(HEAT, f'{name}.png'))


def probe_global():
    """无源参照：自身结构探针（环形双饼 + 标题墨迹 + 色数）"""
    g = np.asarray(Image.open(os.path.join(OUT, 'global.jpg')).convert('RGB')).astype(np.int16)
    h, w, _ = g.shape
    cx, cy, R = w / 2, h / 2, 330  # radius ['50%','70%'] → 外环在 0.5~0.7 * min/2? 按 1000×800 图 init 参数
    ys, xs = np.mgrid[0:h, 0:w]
    r = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    # 采样外环内缘/外缘圆带颜色多样（环带应有 >3 种主要色）
    ring = g[(r >= 230) & (r <= 300)]
    colors = (ring // 32).reshape(-1, 3)
    uniq = len(np.unique(colors, axis=0)) if len(colors) else 0
    inner = g[(r >= 0) & (r <= 210)]
    uniq_in = len(np.unique((inner // 32).reshape(-1, 3), axis=0)) if len(inner) else 0
    titlezone = g[10:50, w // 2 - 260:w // 2 + 260]
    ink = float((titlezone.mean(axis=2) < 140).mean())  # 标题深色像素占比
    print('== global（无源参照，自身探针）')
    print(f'   外环带色数≈{uniq} 内环色数≈{uniq_in}（≥3 即非空环） 标题区深色墨迹 {ink:.2%}')


def main():
    total_ok = total_soft = total_hard = 0
    total_cells = 0
    for name, js, ref in PAGES:
        analyze(name, js, ref)
    probe_global()
    print('\n验收判定留给人工按坐标表复核 hard 格；soft 带（文字/抗锯齿）属预期。')


if __name__ == '__main__':
    main()
