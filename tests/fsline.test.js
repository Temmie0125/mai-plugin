/**
 * 单曲分数线单测，三组断言：
 * ① 四张表的单元用例（取整口径、除零守卫等）+ **样板对照值**（`tests/refs/fsline_ref.json`，
 *    由 `tests/refs/gen-fsline-ref.mjs` 真跑样板抓取，本测试逐格比对）；
 *    ⚠️ 不能抄样板 markup 里的数字：它与自身物量对不上（是上一次渲染的残留），**脚本才是规格**；
 * ② 命令层：`parseFslineArgs`（达成率**可选**）纯函数 + 命令路径（桩掉 sendFsline，不真渲染）；
 * ③ 附加文本 `fslineText`（给了达成率时图外补的那行）与帮助文案——沿用源 mai_score.py:139-167 口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeFsline, ceil5, fmtPct, S_TAP, S_BREAK, DX_TIERS, RATING_TIERS, EQUIV_LABELS,
} from '../lib/fsline.js'

// apps/global.js 会沿 import 链触达 Yunzai 宿主与 logger，动态导入前先垫（同 tests/scoreRules.test.js）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) { return p in console ? console[p].bind(console) : (...a) => a.join(' ') },
  })
}

let MaiGlobal = null
let parseFslineArgs = null
let fslineText = null
let FSLINE_HELP = null
let FSLINE_FORMAT_ERROR = null

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'refs', 'fsline_ref.json'), 'utf8'))

/** 样板 demo 的物量（就是曲 799 MASTER 的） */
const DEMO = { tap: 838, hold: 12, slide: 191, touch: 0, break: 64 }

test('取整口径：ceil5 与 fmtPct 逐字照搬样板', () => {
  assert.equal(ceil5(0.0113960227), 0.01140)
  assert.equal(ceil5(0.0569800569), 0.05699)
  // 整数结果不补零（`ceil(6637.0)/100000`）
  assert.equal(ceil5(0.06637), 0.06637)
  assert.equal(fmtPct(0.0114), '-0.01140%')
  assert.equal(fmtPct(0), '-0.00000%')
})

test('基础分与档位常量与样板一致', () => {
  assert.equal(S_TAP, 500)
  assert.equal(S_BREAK, 2500)
  assert.deepEqual(DX_TIERS.map(t => t.rate), [0.99, 0.98, 0.97, 0.95, 0.93, 0.90, 0.85])
  assert.deepEqual(DX_TIERS.map(t => t.label), ['99%', '98%', '5', '4', '3', '2', '1'])
  assert.deepEqual(RATING_TIERS, [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 21.0])
  assert.deepEqual(EQUIV_LABELS, ['p75', 'p50', 'great40', 'great30', 'great25', 'good', 'miss'])
})

test('demo 物量手算：TOTAL_S / 分数线 / BREAK / DX / 评级 / 等效', () => {
  const r = computeFsline(DEMO)
  // 838*500 + 12*1000 + 191*1500 + 0 + 64*2500
  assert.equal(r.totalS, 877500)
  assert.equal(r.totalExS, 6400)
  assert.equal(r.dxMax, 3 * 1105)

  assert.deepEqual(r.scoreRows[0], { name: 'TAP', great: '-0.01140%', good: '-0.02850%', miss: '-0.05699%' })
  assert.equal(r.scoreRows[1].great, '-0.02280%', 'HOLD 是 TAP 的 2 倍')
  assert.equal(r.scoreRows[2].great, '-0.03419%', 'SLIDE 是 TAP 的 3 倍')
  assert.equal(r.scoreRows[3].great, r.scoreRows[0].great, 'TOUCH 与 TAP 同基础分')

  // BREAK：BA + EA 两段（4.0 GREAT = 0.2 档 + 60 落）
  assert.equal(r.brk.g40, '-0.06637%')
  assert.equal(r.brk.good, '-0.18189%')
  assert.equal(r.brk.miss, '-0.30054%')
  assert.equal(r.brk.p75, '-0.00391%', '0.75 PERFECT 只有 EA(25)')
  assert.equal(r.brk.p50, '-0.00782%')

  assert.equal(r.dx[0].text, '3282 (-33)')
  assert.equal(r.dx[6].text, '2818 (-497)')
  assert.equal(r.rating[0].n, 43)
  assert.equal(r.rating[6].n, 1842)
  assert.equal(r.equiv[0].value, '0.3428')
  assert.equal(r.equiv[6].value, '26.3711')
})

test('除零守卫：break=0 时 EA 段退化为 0（样板同款），不得出 NaN/Infinity', () => {
  const r = computeFsline({ tap: 1000, hold: 0, slide: 0, touch: 0, break: 0 })
  assert.equal(r.totalExS, 0)
  // 只剩 BA 段
  assert.equal(r.brk.g40, '-0.10000%')
  assert.equal(r.brk.good, '-0.30000%')
  assert.equal(r.brk.miss, '-0.50000%')
  // 只有 EA 段 ⇒ 0
  assert.equal(r.brk.p75, '-0.00000%')
  assert.equal(r.brk.p50, '-0.00000%')
  for (const v of [r.brk.p75, r.brk.p50, ...r.equiv.map(e => e.value)]) {
    assert.ok(!/NaN|Infinity/.test(v), `不得出现 NaN/Infinity：${v}`)
  }
})

test('空物量：TOTAL_S=0 时不抛（这类谱面现实中不存在）', () => {
  // 样板同样没有为 TOTAL_S=0 设防：`base*rate/0*100` 会得到 NaN/Infinity。
  // 真实曲目至少有一个音符，故此处只保证**不抛**，不去规定那些无意义的数字长什么样。
  let r
  assert.doesNotThrow(() => { r = computeFsline({ tap: 0, hold: 0, slide: 0, touch: 0, break: 0 }) })
  assert.equal(r.totalS, 0)
  assert.equal(r.dxMax, 0)
  assert.equal(r.dx[0].text, '0 (-0)', 'DX 表与 TOTAL_S 无关，仍应正常')
  assert.equal(r.rating[0].n, 0)
  assert.equal(r.scoreRows.length, 4, '结构仍是四行，供模板渲染')
})

test('入参容错：缺项/非数/小数按 0 与截断处理', () => {
  const r = computeFsline({ tap: 100.9, hold: undefined, break: null })
  assert.equal(r.counts.tap, 100, '小数截断（样板 getCount 用 parseInt）')
  assert.equal(r.counts.hold, 0)
  assert.equal(r.counts.break, 0)
  assert.equal(r.counts.total, 100)
  const empty = computeFsline()
  assert.equal(empty.counts.total, 0, '不传参也不得抛')
})

test('对照样板：六组物量 × 四张表逐格一致', () => {
  assert.ok(REF.cases.length >= 4, '对照值样本过少')
  for (const { counts, expect } of REF.cases) {
    const r = computeFsline(counts)
    const tag = JSON.stringify(counts)

    // 分数线表（表头 + 四行）
    assert.deepEqual(
      ['分数线', 'GREAT', 'GOOD', 'MISS', ...r.scoreRows.flatMap(x => [x.name, x.great, x.good, x.miss])],
      expect.score, `${tag} 分数线表`,
    )
    // BREAK 子表
    assert.deepEqual(
      ['BREAK', '4.0', r.brk.g40, r.brk.good, r.brk.miss, '3.0', r.brk.g30,
        '2.5', r.brk.g25, '0.75', r.brk.p75, '0.5', r.brk.p50],
      expect.brk, `${tag} BREAK 子表`,
    )
    // DX 等级表：只比数值格（样板左侧 5..1 是星徽章图、无文本，那属于渲染层）
    assert.deepEqual(
      r.dx.map(x => x.text), [3, 5, 7, 9, 11, 13, 15].map(i => expect.dx[i]), `${tag} DX 等级表`,
    )
    // 评级表 / 等效数量表：数据在索引 9..15（前 8 格是表头）
    assert.deepEqual(r.rating.map(x => String(x.n)), expect.rating.slice(9, 16), `${tag} 评级表`)
    assert.deepEqual(r.equiv.map(x => x.value), expect.equiv.slice(9, 16), `${tag} 等效数量表`)
  }
})

// ---------------------------------------------------------------------------
// ② 命令层：达成率可选（parseFslineArgs）与命令路径
// ---------------------------------------------------------------------------

test('准备：载入 apps/global.js 与 lib/handler.js（命令层）', async () => {
  ({ MaiGlobal, parseFslineArgs } = await import('../apps/global.js'));
  ({ fslineText, FSLINE_HELP, FSLINE_FORMAT_ERROR } = await import('../lib/handler.js'))
})

test('参数解析（达成率给了）：末 token 是数字 → line 取该数', () => {
  assert.deepEqual(parseFslineArgs('紫799 100'), { levelIndex: 3, query: '799', line: 100 })
  assert.deepEqual(parseFslineArgs('紫799 99.5'), { levelIndex: 3, query: '799', line: 99.5 })
  // 颜色与曲名之间允许空格（源靠 `\s?`，此处同等宽）；曲名含空格时只吞末 token
  assert.deepEqual(parseFslineArgs('紫 799 100'), { levelIndex: 3, query: '799', line: 100 })
  assert.deepEqual(
    parseFslineArgs('紫 PANDORA PARADOX 100'),
    { levelIndex: 3, query: 'PANDORA PARADOX', line: 100 },
  )
  // 五色 → levelIndex 0..4（白 = Re:Master）
  for (const [color, levelIndex] of [['绿', 0], ['黄', 1], ['红', 2], ['紫', 3], ['白', 4]]) {
    assert.deepEqual(parseFslineArgs(`${color}测试曲 90`), { levelIndex, query: '测试曲', line: 90 }, color)
  }
})

test('参数解析（达成率可省）：末 token 非数 → line=null、token 并入曲名', () => {
  assert.deepEqual(parseFslineArgs('紫799'), { levelIndex: 3, query: '799', line: null }, '帮助示例的「只出图」形态')
  assert.deepEqual(parseFslineArgs('紫 freesia'), { levelIndex: 3, query: 'freesia', line: null })
  // 末 token 非数 ⇒ 整段当曲名查（下游回「未找到曲目」，不再报格式错误）
  assert.deepEqual(parseFslineArgs('紫799 abc'), { levelIndex: 3, query: '799 abc', line: null })
  // 颜色前缀使 parseFloat 失败：`紫99.5` 是曲名 99.5，不会被当成「无曲名的达成率」
  assert.deepEqual(parseFslineArgs('紫99.5'), { levelIndex: 3, query: '99.5', line: null })
})

test('参数解析（拒收）：缺难度色 / 只有色无曲名 / 空 → null（命令层回格式错误）', () => {
  assert.equal(parseFslineArgs('799 100'), null, '缺难度色')
  assert.equal(parseFslineArgs('紫'), null, '只有色、无曲名')
  for (const v of ['', '   ', undefined, null]) {
    assert.equal(parseFslineArgs(v), null, `raw=${JSON.stringify(v)}`)
  }
})

test('参数解析（口径锁定）：末 token 是数字就吞，曲名以数字结尾需改用 id/别名查询', () => {
  // JS parseFloat 比 Python float() 宽（吃前缀数字）：'100%' → 100——源会把 '100%' 当曲名
  assert.deepEqual(parseFslineArgs('紫799 100%'), { levelIndex: 3, query: '799', line: 100 })
  // 曲名末词为数字会被当成达成率：「末 token 是数即达成率」的既定取舍（源 float(args[-1]) 同位置）
  assert.deepEqual(parseFslineArgs('紫 loop 100'), { levelIndex: 3, query: 'loop', line: 100 })
})

test('命令路径（桩掉 sendFsline，不真渲染）：达成率可省/可给/非数并入曲名', async () => {
  const inst = new MaiGlobal()
  const replies = []
  inst.reply = async (msg) => { replies.push(String(msg)) }
  const calls = []
  inst.sendFsline = async (song, levelIndex, line) => { calls.push([song.song_id, levelIndex, line]) }

  // 无达成率：仍出图（四表由物量推出），且不再回格式错误
  await inst.fsline({ msg: '#mai fsline 紫799' })
  assert.deepEqual(calls, [[799, 3, null]])
  assert.deepEqual(replies, [])

  // 给了达成率：原样透传给 sendFsline（驱动图外附加文本）
  await inst.fsline({ msg: '#mai fsline 紫799 100.5' })
  assert.deepEqual(calls.at(-1), [799, 3, 100.5])
  assert.deepEqual(replies, [])

  // 末 token 非数 ⇒ 并入曲名查不到 → 「未找到曲目」，且不触达出图
  calls.length = 0
  replies.length = 0
  await inst.fsline({ msg: '#mai fsline 紫799 abc' })
  assert.deepEqual(calls, [])
  assert.deepEqual(replies, ['未找到曲目'])
})

// ---------------------------------------------------------------------------
// ③ 附加文本 fslineText（给了达成率时图外那行，源 mai_score.py:139-167）与帮助文案
// ---------------------------------------------------------------------------

/** 造一首谱面：notes 决定 total_score / break 容错 */
const songWith = (notes, name = '测试曲') => ({
  song_id: 1, song_name: name,
  difficulties: [{ level: '13', level_value: 13.0, notes }],
})

test('附加文本：文案逐字对齐源（含 py str(float) 的 "100.0%"）', () => {
  // tap=200 slide=50 hold=100 touch=20 brk=20
  // total = 200*500 + 50*1500 + 100*1000 + 20*500 + 20*2500 = 335000
  // reduce = 1 → total*reduce/10000 = 33.50 ; 10000/total = 0.0299% ; break_50 = 335000*0.0005/4 = 41.875 → /100 = 0.419
  const song = songWith({ tap: 200, slide: 50, hold: 100, touch: 20, brk: 20 })
  assert.equal(fslineText(song, 0, 100), [
    '测试曲「Basic」',
    '分数线「100.0%」',
    '允许的最多「TAP」「GREAT」数量为',
    '「33.50」(每个-0.0299%),',
    '「BREAK」50落(一共「20」个)',
    '等价于「0.419」个「TAP」「GREAT」(-0.0125%)',
  ].join('\n'))
})

test('附加文本：达成率 100.5 走原样展示（非整值不加 .0）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 10 })
  assert.match(fslineText(song, 0, 100.5), /分数线「100\.5%」/)
})

test('附加文本：达成率越界（<=0 或 >=101）→ 格式错误文案（源 reduce<=0 or reduce>=101）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 10 })
  for (const line of [0, -1, 101, 200]) {
    assert.equal(fslineText(song, 0, line), FSLINE_FORMAT_ERROR, `line=${line}`)
  }
  // 边界内（1 / 100.9）应正常
  assert.notEqual(fslineText(song, 0, 1), FSLINE_FORMAT_ERROR)
  assert.notEqual(fslineText(song, 0, 100.9), FSLINE_FORMAT_ERROR)
})

test('附加文本：难度不存在 / brk==0 → 格式错误文案（源 ZeroDivisionError 逃逸的缺陷已修）', () => {
  const song = songWith({ tap: 100, slide: 10, hold: 10, touch: 10, brk: 0 })
  assert.equal(fslineText(song, 4, 100), FSLINE_FORMAT_ERROR, '难度不存在')
  assert.equal(fslineText(song, 0, 100), FSLINE_FORMAT_ERROR, 'brk==0（源会 ZeroDivisionError 逃逸）')
  assert.doesNotMatch(fslineText(songWith({ tap: 1, brk: 1 }), 0, 100), /Infinity|NaN/)
})

test('帮助文本：达成率已标可选（只出图/附文本两形态），表体逐字保留源', () => {
  assert.match(FSLINE_HELP, /#mai fsline \[难度色\]<曲名\|id\|别名> \[目标达成率\]/)
  assert.match(FSLINE_HELP, /#mai fsline 紫799 +（只出图）/)
  assert.match(FSLINE_HELP, /#mai fsline 紫799 100 +（出图，并附一行该达成率下的容错文本）/)
  assert.match(FSLINE_HELP, /BREAK {7}5 \/ 12\.5 \/ 25 \(外加200落\)$/)
  assert.match(FSLINE_FORMAT_ERROR, /^格式错误，输入“分数线 帮助”以查看帮助信息$/)
})
