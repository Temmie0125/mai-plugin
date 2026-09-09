/**
 * merge 层单测（设计 §5.3/§十三-3：id 分段与 %10000 规则禁简化，用真实缓存样例锁 schema）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MusicList } from '../lib/merge/musicList.js'
import { AliasList } from '../lib/merge/aliasList.js'
import { mergeMusicData, mergeAliasData } from '../lib/merge/merge.js'
import { Song, PlayedResult } from '../lib/merge/models.js'
import { dfToPlayresult, lxnsFormatResult } from '../lib/merge/playResult.js'
import { dfToBest50, dfToPlayer, lxnsToBest50 } from '../lib/merge/player.js'

const STATIC_DATA = path.resolve('resources/static/data')

test('真实缓存 JSON 载入与索引（schema 强一致）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(STATIC_DATA, 'merge_music_data.json'), 'utf8'))
  const list = MusicList.fromJSON(raw)
  assert.ok(list.root.length > 1000, `曲库量异常：${list.root.length}`)

  // SD 曲（id<10000）与 DX 曲（10000≤id<100000）分段
  const sd = list.byId(8)
  assert.equal(sd.song_name, 'True Love Song')
  assert.equal(sd.type, 'SD')
  assert.equal(sd.difficulties.length, 4)

  const dx = list.root.find(s => s.song_id >= 10000 && s.song_id < 100000)
  assert.equal(dx.type, 'DX')

  // 宴谱（≥100000）特有字段
  const utage = list.root.find(s => s.song_id >= 100000)
  assert.equal(utage.genre, '宴会場')
  assert.ok(utage.difficulties.length >= 1)
  assert.ok('kanji' in utage && 'is_buddy' in utage)

  // 定数映射与 byName/byPlan/byLevelList
  const byName = list.byName(sd.song_name)
  assert.equal(byName.song_id, 8)
  const plan14 = list.byPlan('14')
  assert.ok(plan14.size > 10)
  const levelData = list.byLevelList()
  assert.ok(Object.keys(levelData).includes('14'))
})

test('filter：标题/定数区间/类型过滤（源语义）', () => {
  const list = MusicList.fromJSON(JSON.parse(fs.readFileSync(path.join(STATIC_DATA, 'merge_music_data.json'), 'utf8')))
  // 标题子串（lower）
  const title = list.filter({ title: 'true love' })
  assert.ok(title.some(s => s.song_id === 8))
  // 定数区间
  const ds = list.filter({ level_value: [13.9, 14.0] })
  assert.ok(ds.length > 10)
  for (const s of ds) {
    assert.ok(s.difficulties.some(d => d.level_value >= 13.9 && d.level_value <= 14.0))
  }
  // all_diff=false 裁剪 difficulties
  const trimmed = list.filter({ level_value: [14.9, 15.0], all_diff: false })
  assert.ok(trimmed.every(s => s.difficulties.every(d => d.level_value >= 14.9)))
  // 类型
  const dxOnly = list.filter({ type: 'DX', title: 'true love' })
  assert.equal(dxOnly.length, 0)
})

test('merge：DF id 直入 / LXNS id 分段（10000 内 SD+10000、UTAGE 保留）', () => {
  const dfList = [{
    id: '8',
    title: 'True Love Song',
    type: 'SD',
    ds: [5.0, 7.0],
    level: ['5', '7'],
    charts: [
      { notes: { tap: 63, hold: 23, slide: 8, brk: 2 }, charter: '-' },
      { notes: { tap: 60, hold: 20, slide: 10, brk: 2 }, charter: '-' },
    ],
    basic_info: { title: 'True Love Song', artist: 'Kai', genre: '舞萌', bpm: 150, version: 'maimai', is_new: false },
  }]
  const lxnsList = {
    songs: [{
      id: 8,
      title: 'True Love Song',
      artist: 'Kai',
      genre: '舞萌',
      bpm: 150,
      version: 10000,
      difficulties: {
        standard: [
          { type: 'standard', difficulty: 0, level: '5', level_value: 5.0, note_designer: '-', version: 10000, notes: { total: 96, tap: 63, hold: 23, slide: 8, touch: 0, brk: 2 } },
          { type: 'standard', difficulty: 1, level: '7', level_value: 7.0, note_designer: '-', version: 10000, notes: { total: 92, tap: 60, hold: 20, slide: 10, touch: 0, brk: 2 } },
        ],
        dx: [
          { type: 'dx', difficulty: 0, level: '7', level_value: 7.7, note_designer: '-', version: 10000, notes: { total: 100, tap: 70, hold: 20, slide: 6, touch: 0, brk: 4 } },
        ],
      },
    }],
    genres: [],
    versions: [{ id: 1, title: '舞萌DX', version: 10000 }],
  }
  const { list, levelValueMap } = mergeMusicData({ divingFishList: dfList, lxnsList, statsMap: {} })
  // DF 主记录 + LXNS DX 追加为 10008
  assert.ok(list.byId(8))
  const dxSong = list.byId(8 + 10000)
  assert.ok(dxSong, 'LXNS dx 分段未落位 id+10000')
  assert.equal(dxSong.type, 'DX')
  assert.equal(levelValueMap['8-0'], 5.0)
  assert.equal(dxSong.version_str, 'maimai でらっくす', 'DX_CN_VERSION 映射版本字符串')
})

test('merge：LXNS utage（≥100000，BuddyNotes 拆双难度）', () => {
  const lxnsList = {
    songs: [{
      id: 100001,
      title: '[協]Test',
      artist: 'X',
      genre: '宴会場',
      bpm: 120,
      version: 25000,
      difficulties: {
        utage: [{
          type: 'utage', difficulty: 0, level: '13?', level_value: 13.0, note_designer: '-',
          version: 25000, kanji: '宴', description: 'desc', is_buddy: true,
          notes: { left: { total: 10, tap: 5, hold: 5, slide: 0, touch: 0, brk: 0 }, right: { total: 12, tap: 6, hold: 6, slide: 0, touch: 0, brk: 0 } },
        }],
      },
    }],
    genres: [],
    versions: [{ id: 1, title: '舞萌DX 2025', version: 25000 }],
  }
  const { list } = mergeMusicData({ divingFishList: [], lxnsList, statsMap: {} })
  const song = list.byId(100001)
  assert.ok(song, 'utage 未入库')
  assert.equal(song.kanji, '宴')
  assert.equal(song.is_buddy, true)
  assert.equal(song.difficulties.length, 2, 'BuddyNotes 应拆为两个难度')
  assert.equal(song.type, 'DX')
  assert.equal(song.difficulties[0].dx_score, 30, 'dx_score = notes.total*3')
})

test('merge：DF 缺白谱由 LXNS 补挂（append_missing_difficulty 只补 Re:Master）', () => {
  const mkChart = lv => ({ notes: { tap: 10, hold: 0, slide: 0, brk: 0 }, charter: '-' })
  const dfList = [{
    id: '100', title: 'T', type: 'SD', ds: [3.0, 4.0, 5.0, 6.0], level: ['3', '4', '5', '6'],
    charts: [mkChart(), mkChart(), mkChart(), mkChart()],
    basic_info: { title: 'T', artist: 'A', genre: '舞萌', bpm: 100, version: 'maimai', is_new: false },
  }]
  const mkDiff = (difficulty, level, lv) => ({ type: 'standard', difficulty, level, level_value: lv, note_designer: '-', version: 10000, notes: { total: 10, tap: 10, hold: 0, slide: 0, touch: 0, brk: 0 } })
  const lxnsList = {
    songs: [{
      id: 100, title: 'T', artist: 'A', genre: '舞萌', bpm: 100, version: 10000,
      difficulties: {
        standard: [mkDiff(0, '3', 3.0), mkDiff(1, '4', 4.0), mkDiff(2, '5', 5.0), mkDiff(3, '6', 6.0), mkDiff(4, '9', 9.9)],
      },
    }],
    genres: [], versions: [{ id: 1, title: '舞萌DX', version: 10000 }],
  }
  const { list } = mergeMusicData({ divingFishList: dfList, lxnsList, statsMap: {} })
  // DF 4 难度 + LXNS 5 难度 → 补挂 LXNS 末位 Re:Master，共 5
  const song = list.byId(100)
  assert.equal(song.difficulties.length, 5)
  assert.equal(song.difficulties[4].level_index, 4)
  assert.equal(song.difficulties[4].level_value, 9.9)
})

test('别名合并（柚子 + LXNS >1000 加 10000 + 本地，去重保序）', () => {
  const merged = mergeAliasData({
    yuzuAliases: [{ song_id: 8, name: 'True Love Song', alias: ['真爱'] }],
    lxnsAliases: { aliases: [{ song_id: 8, aliases: ['tls'] }, { song_id: 1500, aliases: ['xx'] }] },
    localAliasData: { '8': ['真爱', 'tls2'] },
  })
  assert.ok(merged instanceof AliasList)
  const a8 = merged.byId(8)[0]
  assert.deepEqual(a8.alias, ['真爱', 'tls', 'tls2'])
  assert.equal(merged.byId(11500)[0].alias[0], 'xx', 'LXNS song_id>1000 → +10000')
  assert.equal(a8.song_name, 'True Love Song', '柚子名回填')
  // 排序
  assert.ok(merged.root.every((a, i) => i === 0 || merged.root[i - 1].song_id <= a.song_id))
})

test('成绩转换：DF/LXNS → PlayedResult / Best50', () => {
  // DF 单曲（dev/player/record 响应形态）
  const dfRecord = [{ song_id: 8, title: 'True Love Song', level: '7', level_index: 1, achievements: 99.1234, fc: 'ap', fs: 'fs', rate: 'sss', dxScore: 200, ra: 180, ds: 7.0, type: 'SD', level_label: '7' }]
  const song = Song({ song_id: 8, song_name: 'True Love Song', artist: '', genre: '', bpm: 0, version_str: 'maimai', type: 'SD', difficulties: [{ level_index: 0, level: '5', level_value: 5.0, note_designer: '', notes: {}, dx_score: 288 }, { level_index: 1, level: '7', level_value: 7.0, note_designer: '', notes: {}, dx_score: 276 }] })
  const r = dfToPlayresult(dfRecord, song)
  assert.equal(r.length, 2)
  assert.equal(r[0].notPlayed, true, '未游玩难度占位')
  assert.equal(r[1].rating, 180)
  assert.equal(r[1].dx_score, 200)

  // DF b50
  const userinfo = {
    nickname: 'test', rating: 15000, additional_rating: 5, plate: null,
    charts: {
      sd: [{ id: 8, title: 'x', level: '7', level_index: 1, achievements: 100, fc: '', fs: '', rate: 'sss', dxScore: 1, ra: 100, ds: 7, type: 'SD' }],
      dx: [],
    },
  }
  const [player, b50] = [dfToPlayer(userinfo), dfToBest50(userinfo)]
  assert.equal(player.name, 'test')
  assert.equal(player.course_rank, 5)
  assert.equal(b50.sd_total, 100)

  // LXNS score → song_id 映射
  const score = { id: 8, song_name: 'x', level: '7', level_index: 1, fc: '', fs: '', rate: 'sss', type: 'dx', achievements: 100, dx_score: 10, dx_star: 3, dx_rating: 123.0 }
  const pr = lxnsFormatResult(score, { '10008-1': 7.7 })
  assert.equal(pr.song_id, 10008, 'dx type → id+10000')
  assert.equal(pr.rating, 123)
  assert.equal(pr.level_value, 7.7)

  const lxB50 = lxnsToBest50({ standard_total: 10, dx_total: 5, standard: [score], dx: [] }, { '10008-1': 7.7 })
  assert.equal(lxB50.sd_total, 10)
  assert.equal(lxB50.sd[0].song_id, 10008)
})

test('PlayedResult 归一化（type/fc/fs/rate 空串）', () => {
  const pr = PlayedResult({ type: 'standard', fc: '', fs: '', rate: '', dx_score: 0 })
  assert.equal(pr.type, 'SD')
  assert.equal(pr.fc, null)
  assert.equal(pr.rate, null)
  const utg = PlayedResult({ type: 'utage' })
  assert.equal(utg.type, 'DX')
})
