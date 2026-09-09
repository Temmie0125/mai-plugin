# -*- coding: utf-8 -*-
"""
NoneBot 源侧参照图生成（P1 渲染验收基准，设计 §12）
以 tests/out/fixtures.json（Yunzai 冒烟同一份 fixture 明细）驱动源插件 PIL 绘图代码，
产出同数据参照 PNG → tests/out/refs/<name>_ref.png，供 compare.py 逐页数值比对。

运行：E:\\bot\\Nonebot\\Hikari-Bot\\.venv\\Scripts\\python.exe -X utf8 tests/refs/make_refs.py
（脚本放置于插件 tests/refs/ 下，由 venv python 执行，不经 nonebot 驱动）
"""
import sys
import os
import json
import base64
import asyncio

import nonebot

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATIC = os.path.join(PLUGIN_ROOT, 'resources', 'static')
FIXTURES = os.path.join(PLUGIN_ROOT, 'tests', 'out', 'fixtures.json')
OUT = os.path.join(PLUGIN_ROOT, 'tests', 'out', 'refs')
MERGED = os.path.join(STATIC, 'data', 'merge_music_data.json')

nonebot.init(nickname=['MaiTest'], maimaidx_path=STATIC)
sys.path.insert(0, r'E:\bot\maimai')  # 迁移参照的源插件副本（与站点包同名，置前）
import nonebot_plugin_maimaidx  # noqa: F401  （初始化 driver 配置链）

from nonebot_plugin_maimaidx.core.merge.models.song import Song
from nonebot_plugin_maimaidx.core.merge.models.enum import Theme, ServiceName
from nonebot_plugin_maimaidx.core.merge.models.player import Player
from nonebot_plugin_maimaidx.core.merge.models.best50 import Best50
from nonebot_plugin_maimaidx.core.merge.models.score import PlayedResult, NotPlayedResult
from nonebot_plugin_maimaidx.core.database.qq import User
from nonebot_plugin_maimaidx.core.image.info import song_play_data
from nonebot_plugin_maimaidx.core.image.chart import song_chart_info, song_chart_banquet_info
from nonebot_plugin_maimaidx.core.image.song import song_list
from nonebot_plugin_maimaidx.core.image.best50 import PlayerBest50
from nonebot_plugin_maimaidx.core.image.base import AssetsImage
from nonebot_plugin_maimaidx.core.merge.music_list import MusicList

# 生产链路在插件 __init__.py 启动钩子里预热（save_in_memory=True 时不自动加载）；
# 离线参照脚本需手动触发一次素材内存化，否则 _diff_bg 等数组为空
AssetsImage._load_image()

os.makedirs(OUT, exist_ok=True)


def song_by_id(merged, sid):
    return Song.model_validate(merged[sid])


def save(name, b64):
    # 源 image_to_base64 返回 "base64://" 前缀串
    if b64.startswith('base64://'):
        b64 = b64[9:]
    png = base64.b64decode(b64)
    with open(os.path.join(OUT, f'{name}_ref.png'), 'wb') as f:
        f.write(png)
    print(f'[ref] {name} ok {len(png)}B')


def played_from_record(song, r):
    """fixtures.json 的 b50/score 行 → 源 PlayedResult（补默认展示字段）"""
    return PlayedResult.model_validate({
        **{k: r[k] for k in ('level_value', 'song_id', 'song_name', 'level_index',
                             'achievements', 'dx_score', 'rating')},
        'type': 'sd' if r['song_id'] < 10000 else 'dx',
        'rate': r['rate'],
        'level': song.difficulties[r['level_index']].level,
        'fc': r.get('fc'),
        'fs': r.get('fs'),
        'dx_star': 0,
        'upload_time': None,
    })


def main():
    with open(MERGED, encoding='utf8') as f:
        merged = {d['song_id']: d for d in json.load(f)}
    # 离线喂给源 service 单例（生产由启动 get_music() 联网合并填充）——
    # whiledraw 内 by_id 查 dx_score 需要 total_list；dx_score 变化会改变星星数显示
    from nonebot_plugin_maimaidx.core.service import mai
    rows = list(merged.values())
    mai.total_list = MusicList.model_validate(rows)
    mai.total_level_value_map = {
        f'{s.song_id}-{d.level_index}': d.level_value for s in mai.total_list.root for d in s.difficulties
    }
    fixtures = json.load(open(FIXTURES, encoding='utf8'))

    # ---- b50（is_username=True：无 QQ 头像/名牌，与服务端用户名流一致）----
    b50f = fixtures['b50']
    player = Player.model_validate(b50f['player'])
    best = Best50.model_validate({
        'sd': [played_from_record(song_by_id(merged, r['song_id']), r) for r in b50f['best50']['sd']],
        'dx': [played_from_record(song_by_id(merged, r['song_id']), r) for r in b50f['best50']['dx']],
        'sd_total': b50f['best50']['sd_total'],
        'dx_total': b50f['best50']['dx_total'],
    })
    user = User(qqid=114514)
    obj = PlayerBest50(user=user, player=player, best50=best, is_username=True)
    save('b50', asyncio.run(obj.draw()))

    # ---- 单曲成绩卡 ----
    sc = fixtures['score']
    song = song_by_id(merged, sc['song_id'])
    rows = []
    for r in sc['rows']:
        if r.get('notPlayed'):
            rows.append(NotPlayedResult.model_validate(
                {'level_value': r['level_value'], 'song_id': song.song_id, 'level_index': 2}))
        else:
            rows.append(played_from_record(song, r))
    save('score', song_play_data(ServiceName.DIVINGFISH, Theme.PRISM_PLUS, song=song, play_result=rows))

    # ---- 谱面信息卡：无用户 / B50 满（↑涨幅）/ 宴谱 / 宴谱 buddy ----
    for tag, key in [('song', 'song'), ('song_full', 'songFull')]:
        s = song_by_id(merged, fixtures[key]['song_id'])
        calc = fixtures[key].get('calc', False)
        is_full = fixtures[key].get('isFull', False)
        best_list = []
        if calc:
            for i in range(fixtures[key]['bestListLen']):
                best_list.append(played_from_record(s, {
                    'level_value': 0, 'song_id': 1, 'song_name': '', 'level_index': 3,
                    'achievements': 0, 'dx_score': 0, 'rating': 12000 + i, 'rate': 'sss',
                }))
        save(tag, song_chart_info(s, calc, is_full, best_list, Theme.PRISM_PLUS))

    for tag, key in [('song_utage', 'songUtage'), ('song_utage_buddy', 'songUtageBuddy')]:
        s = song_by_id(merged, fixtures[key]['song_id'])
        save(tag, song_chart_banquet_info(s))

    # ---- 曲目列表（第 1 页满 14 行）----
    list_ids = fixtures['songlist']['ids']
    songs = [song_by_id(merged, sid) for sid in list_ids]
    save('songlist', song_list(songs, 1))

    print(f'\n参照图完成 → {OUT}')


if __name__ == '__main__':
    main()
