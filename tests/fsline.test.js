/**
 * 分数线单测（lib/handler.js fslineText，源 commands/mai_score.py:139-167）
 * 纯合成数据；数值已与源公式（Python 直算）逐字对齐。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FSLINE_FORMAT_ERROR, FSLINE_HELP, fslineText } from '../lib/handler.js'

/** 造一首谱面：notes 决定 total_score / break 容错 */
const songWith = (notes, name = '测试曲') => ({
  song_id: 1, song_name: name,
  difficulties: [{ level: '13', level_value: 13.0, notes }],
})

test('正常换算：文案逐字对齐源（含 py str(float) 的 "100.0%"）', () => {
  // tap=200 slide=50 hold=100 touch=20 brk=20
  // total = 200*500 + 50*1500 + 100*1000 + 20*500 + 20*2500 = 100000+75000+100000+10000+50000 = 335000
  // reduce = 1 → total*reduce/10000 = 33.50 ; 10000/total = 0.0299% ; break_50 = 335000*0.0005/4 = 41.875 → /100 = 0.419
  const song = songWith({ tap: 200, slide: 50, hold: 100, touch: 20, brk: 20 })
  const out = fslineText(song, 0, 100)
  assert.equal(out, [
    '测试曲「Basic」',
    '分数线「100.0%」',
    '允许的最多「TAP」「GREAT」数量为',
    '「33.50」(每个-0.0299%),',
    '「BREAK」50落(一共「20」个)',
    '等价于「0.419」个「TAP」「GREAT」(-0.0125%)',
  ].join('\n'))
})

test('达成率 100.5 走原样展示（非整值不加 .0）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 10 })
  assert.match(fslineText(song, 0, 100.5), /分数线「100\.5%」/)
})

test('达成率越界（<=0 或 >=101）→ 格式错误文案（源 reduce<=0 or reduce>=101）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 10 })
  for (const line of [0, -1, 101, 200]) {
    assert.equal(fslineText(song, 0, line), FSLINE_FORMAT_ERROR, `line=${line}`)
  }
  // 边界内（1 / 100.999）应正常
  assert.notEqual(fslineText(song, 0, 1), FSLINE_FORMAT_ERROR)
  assert.notEqual(fslineText(song, 0, 100.9), FSLINE_FORMAT_ERROR)
})

test('难度不存在 → 格式错误文案', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 10 })
  assert.equal(fslineText(song, 4, 100), FSLINE_FORMAT_ERROR)
})

test('brk==0：退化为格式错误（源会 ZeroDivisionError 逃逸且用户收不到回复）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 0 })
  assert.equal(fslineText(song, 0, 100), FSLINE_FORMAT_ERROR)
})

test('brk==0 但其它音符非零时同样退化（不产出 Infinity 文案）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 0 })
  assert.equal(fslineText(song, 0, 100), FSLINE_FORMAT_ERROR)
  assert.doesNotMatch(fslineText(songWith({ tap: 1, brk: 1 }), 0, 100), /Infinity|NaN/)
})

test('帮助文本：表体逐字保留源，命令示例已改本插件语法', () => {
  assert.match(FSLINE_HELP, /^此功能为查找某首歌分数线设计。/)
  assert.match(FSLINE_HELP, /#mai fsline \[难度色\]<曲名\|id\|别名> <目标达成率>/)
  assert.match(FSLINE_HELP, /BREAK       5 \/ 12\.5 \/ 25 \(外加200落\)$/)
  assert.match(FSLINE_FORMAT_ERROR, /^格式错误，输入“分数线 帮助”以查看帮助信息$/)
})
