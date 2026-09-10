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

# 定数表/完成表的**预生成整页底图**改写到本脚本的临时目录：
#  1) 不污染用户真实资源包目录（那是 NoneBot 实例的运行时产物）；
#  2) 关键——绝不读取本机那批写着旧 bot 名的陈旧缓存当基准，否则既产生页脚 hard 带，
#     又是「拿旧数据产物验证新数据重建」。此处用**源代码**以当前曲库重新生成底图，
#     于是参照侧与 Yunzai 侧同数据、同坐标，比对才有意义（ADR-7 的独立验证）。
BASES = os.path.join(OUT, 'bases')
os.makedirs(BASES, exist_ok=True)


def patch_table_dirs():
    """把各模块里 `from ...resources import xxx_dir` 绑定的 Path 重定向到 BASES"""
    import nonebot_plugin_maimaidx.core.image.update_table as _ut
    import nonebot_plugin_maimaidx.core.image.rating_table as _rt
    import nonebot_plugin_maimaidx.core.image.plate_table as _pt
    for mod in (_ut, _rt, _pt):
        if hasattr(mod, 'rating_table_dir'):
            mod.rating_table_dir = type(_ut.rating_table_dir)(BASES)
        if hasattr(mod, 'plate_table_dir'):
            mod.plate_table_dir = type(_ut.plate_table_dir)(BASES)


def build_bases(levels, plate_versions=None, wu=False):
    """以源代码重新生成所需底图（只做 fixture 用到的，避免全量重绘耗时）"""
    from nonebot_plugin_maimaidx.core.image.update_table import UpdateTable
    import nonebot_plugin_maimaidx.core.image.update_table as _ut
    patch_table_dirs()
    ut = UpdateTable()
    for lv in levels:
        if lv == '15':
            asyncio.run(ut.update_level_15_rating_table())
        else:
            # update_rating_table 迭代 self.level_list[:-1]（15 由独立方法负责），
            # 故补一个哨兵占位，只画所需等级
            ut.level_list = [lv, '__sentinel__']
            asyncio.run(ut.update_rating_table())
    if plate_versions is not None:
        ut.version_list = list(plate_versions)
        asyncio.run(ut.update_plate_table())
    if wu:
        asyncio.run(ut.update_wu_plate_table())
    print(f'[base] 底图重建完成 → {BASES}  {sorted(os.listdir(BASES))[:6]} …')


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

    # ---- 定数表（P2b）：底图由源代码按当前曲库重建，再叠 Level 标题 ----
    plate_json = os.path.join(STATIC, 'data', 'plate_data.json')
    mai.total_level_data = mai.total_list.by_level_list()
    with open(plate_json, encoding='utf8') as f:
        mai.total_plate_id_list = json.load(f)

    from nonebot_plugin_maimaidx.core.image.rating_table import DrawRatingTable

    lv_main = fixtures['table']['rating']
    lv15 = fixtures['table15']['rating']
    build_bases([lv_main, lv15])
    for tag, lv in (('table', lv_main), ('table15', lv15)):
        save(tag, DrawRatingTable(lv, level_text=True).draw())

    # ---- 定数完成表（×0.8）：同一份确定性成绩行驱动 ----
    for tag, key in (('plate', 'plate'), ('plate_full', 'plateFull'), ('plate_fc', 'plateFc')):
        spec = fixtures[key]
        play_result = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['rows']]
        save(tag, DrawRatingTable(
            spec['rating'],
            service=ServiceName.DIVINGFISH,
            play_result=play_result,
            plan=spec['plan'],
        ).draw())

    # ---- 版本称号完成表（底图按页重建；舞-1/舞-2 由 update_wu_plate_table 生成）----
    from nonebot_plugin_maimaidx.constants import VERSION_MAP as SRC_VERSION_MAP
    from nonebot_plugin_maimaidx.core.image.plate_table import DrawPlateTable

    if any(k in fixtures for k in ('plateZhenji', 'plateWu1', 'plateWu2')):
        build_bases([], plate_versions=['真'], wu=True)

    for tag, key in (('plate_zhenji', 'plateZhenji'),
                     ('plate_wu1', 'plateWu1'),
                     ('plate_wu2', 'plateWu2')):
        spec = fixtures[key]
        rows = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['rows']]
        _ver, version_name = SRC_VERSION_MAP[spec['version']]
        save(tag, DrawPlateTable(
            ServiceName.DIVINGFISH, rows,
            plan=spec['plan'], version=spec['version'],
            version_name=version_name, page=spec['page'],
        ).draw())

    # ---- 牌子进度（每难度未完成清单）----
    from nonebot_plugin_maimaidx.core.image.plate_table import DrawPlateProgress

    for tag, key in (('plateprogress_zhenji', 'plateProgressZhen'),
                     ('plateprogress_wu', 'plateProgressWu')):
        spec = fixtures[key]
        rows = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['rows']]
        _v, version_name = SRC_VERSION_MAP[spec['version']]
        save(tag, DrawPlateProgress(
            ServiceName.DIVINGFISH, rows,
            plan=spec['plan'], version=spec['version'],
            version_name=version_name, page=1,
        ).draw())

    # ---- 等级进度 / 分数列表 ----
    # 整段交回**源代码**产出：只把 get_player_result 打桩成 fixture 成绩，
    # 于是分组/排序/分页/高度全部由 draw_level_progress / draw_level_score_list 决定，
    # 参照侧不含任何本脚本自写的整形逻辑（避免"用自己的实现验自己的实现"）。
    from nonebot_plugin_maimaidx.core.merge.models.enum import Category
    from nonebot_plugin_maimaidx.core import handler as src_handler

    async def _fake_player_result(user, version=None):
        return _progress_rows
    _progress_rows = []
    src_handler.get_player_result = _fake_player_result

    from nonebot_plugin_maimaidx.core.image.score import DrawScore  # noqa: F401  (链路校验)

    CATEGORY_OF = {
        'default': Category.DEFAULT,
        'completed': Category.COMPLETED,
        'unfinished': Category.UNFINISHED,
        'notplayed': Category.NOTPLAYED,
    }

    def _msg_to_b64(seg):
        return seg.data['file']

    for tag, key in (('progress', 'progress'),
                     ('progress_unfinished', 'progressUnfinished'),
                     ('progress_notplayed', 'progressNotplayed')):
        spec = fixtures[key]
        _progress_rows = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['rows']]
        seg = asyncio.run(src_handler.draw_level_progress(
            User(qqid=114514), spec['level'], spec['plan'],
            CATEGORY_OF[spec['category']], spec['page'],
        ))
        save(tag, _msg_to_b64(seg))

    for tag, key in (('scorelist', 'scorelist'), ('scorelist_last', 'scorelistLast')):
        spec = fixtures[key]
        _progress_rows = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['rows']]
        seg = asyncio.run(src_handler.draw_level_score_list(
            User(qqid=114514), spec['rating'], spec['page'],
        ))
        save(tag, _msg_to_b64(seg))

    # ---- 上分推荐 ----
    # 源用 `random.sample` 抽样，两侧各自随机必然出不同图 → 把 random.sample 打成
    # 与 fixtures 侧注入的确定性采样器同一规则（取前 k 个），于是比对校验的是
    # 「算法 + 版式」，抽样随机性交给 tests/rise.test.js。
    import random as _random
    _random.sample = lambda pop, k: list(pop)[:k]

    spec = fixtures['rise']
    _progress_rows = [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['playResult']]
    best = Best50.model_validate({
        'sd': [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['best50']['sd']],
        'dx': [played_from_record(song_by_id(merged, r['song_id']), r) for r in spec['best50']['dx']],
        'sd_total': 0, 'dx_total': 0,
    })

    async def _fake_best50(user, **kwargs):
        return (None, best)
    src_handler.get_best50 = _fake_best50

    seg = asyncio.run(src_handler.draw_rise_score_list(User(qqid=114514), spec['level'], spec['score']))
    save('rise', _msg_to_b64(seg))

    print(f'\n参照图完成 → {OUT}')


if __name__ == '__main__':
    main()
