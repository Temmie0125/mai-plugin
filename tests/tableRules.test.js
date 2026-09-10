/**
 * 表格族规则矩阵与守卫文案（P2b）
 *
 * 只覆盖**不触发渲染**的路径：正则命中/拒收、各类前置守卫的错误文案。
 * 真正的出图由 tests/render-pages.mjs 冒烟 + tests/refs 数值比对负责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

let MaiTable = null
let rules = null

/** 宿主 loader.js:158 同款构造期编译（rules.test.js 同款） */
function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
}

/** 构造实例并把 reply 打桩，返回收集到的回复文本 */
function makeInst(cls) {
  const inst = new cls()
  const replies = []
  inst.reply = async (msg) => { replies.push(String(msg)) }
  return { inst, replies }
}

const hit = (cls, msg) => rulesOf(cls).find(r => r.reg.test(msg))

test('准备：载入 apps/table.js', async () => {
  ({ MaiTable } = await import('../apps/table.js'))
  rules = rulesOf(MaiTable)
})

test('定数表规则：命中样例', () => {
  const reg = rules.find(r => r.fnc === 'ratingTable').reg
  for (const msg of [
    '#mai table 13', '/mai table 13', '#mai 定数表 13', '#mai   table   13  ',
    '#mai table 13+', '#mai table 7', '#mai table 15',
    '#maitable 13', // 命令头↔子命令空格可选（既有约定）
  ]) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('定数表规则：拒收样例（不误吃他人命令 / 不粘连参数）', () => {
  const reg = rules.find(r => r.fnc === 'ratingTable').reg
  for (const msg of [
    '#mai table',        // 缺参数
    '#mai table13',      // 子命令↔参数必须空格（防 #maitablex 误吃）
    '#mai tablex 13',
    '#mai table 13 2',   // 多余参数
    '#mai tableinfo',    // 牌子条件走自己的规则
    '#mai plate 13',
    '#phi table 14',     // 其他插件命令
    '#mai 定数表',        // 缺参数
    'mai table 13',      // 无前缀（不保留纯口语形态）
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('定数表守卫：lv1-6 → 只支持查询lv7-15的定数表。', async () => {
  const { inst, replies } = makeInst(MaiTable)
  for (const lv of ['1', '5', '6']) {
    replies.length = 0
    await inst.ratingTable({ msg: `#mai table ${lv}` })
    assert.deepEqual(replies, ['只支持查询lv7-15的定数表。'], `lv${lv} 文案`)
  }
})

test('定数表守卫：无法识别的定数 → 无法识别的定数。', async () => {
  const { inst, replies } = makeInst(MaiTable)
  for (const lv of ['99', '16', '20+']) {
    replies.length = 0
    await inst.ratingTable({ msg: `#mai table ${lv}` })
    assert.deepEqual(replies, ['无法识别的定数。'], `${lv} 文案`)
  }
})

test('定数表守卫：无参数给出引导', async () => {
  const { inst, replies } = makeInst(MaiTable)
  await inst.ratingTable({ msg: '#mai table' })
  assert.match(replies[0], /请输入定数/)
})

test('规则表顺序：plateinfo → 定数表 → 定数完成表 → 版本完成表 → 等级进度 → 分数列表', () => {
  assert.deepEqual(rules.map(r => r.fnc),
    ['plateInfo', 'ratingTable', 'ratingPlate', 'versionPlate', 'levelProgress', 'levelScoreList'])
})

// =====================================================================
// 版本称号完成表 / 牌子条件 / 口语（P2b 后半）
// =====================================================================

let MaiTableSay = null

test('准备：载入口语类', async () => {
  ({ MaiTableSay } = await import('../apps/table.js'))
})

test('版本完成表规则：命中样例', () => {
  const reg = rules.find(r => r.fnc === 'versionPlate').reg
  for (const msg of [
    '#mai plate 真极', '#mai plate 真极完成表', '/mai plate 舞舞舞完成表',
    '#mai plate 双舞舞', '#mai plate 霸者完成表', '#mai plate 真极完成表 2',
    '#mai plate 晓将', '#mai plate 舞将', '#mai plate 真极 2', '#mai plate 舞舞舞 3',
    '#mai plate 真极舞', // 「舞」被当作分隔符吞掉，等价于「真极」；C1 起 真极舞进度 走进度支
  ]) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('版本完成表规则：拒收样例', () => {
  const reg = rules.find(r => r.fnc === 'versionPlate').reg
  for (const msg of [
    '#mai plate', '#mai plate 真', '#mai plate 极真',
    '#mai platex 真极', '#mai plateinfo', '#phi plate 真极', 'plate 真极',
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('版本完成表守卫：真将 → 真系没有真将哦。', async () => {
  const { inst, replies } = makeInst(MaiTable)
  replies.length = 0
  await inst.versionPlate({ msg: '#mai plate 真将' })
  assert.deepEqual(replies, ['真系没有真将哦。'])
})

test('版本完成表守卫：PLATE_CN 归一后再判真将（晓将 ≠ 真将）', async () => {
  const { parseVersionPlate } = await import('../apps/table.js')
  assert.deepEqual(parseVersionPlate('晓', '将', null, null), { ver: '暁', plan: '将', page: 1, isProgress: false })
  assert.deepEqual(parseVersionPlate('华', '神', null, '3'), { ver: '華', plan: '神', page: 3, isProgress: false })
  assert.equal(parseVersionPlate('真', '将', null, null).error, '真系没有真将哦。')
  assert.deepEqual(parseVersionPlate('真', '极', null, null), { ver: '真', plan: '极', page: 1, isProgress: false })
})

test('口语完成表规则：命中/拒收', () => {
  const reg = rulesOf(MaiTableSay).find(r => r.fnc === 'versionPlateSay').reg
  for (const msg of ['真极完成表', '舞舞舞完成表', '双舞舞完成表', '霸者完成表', '真极完成表2']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['今天天气不错', '真极', '真极完成表x', '真极舞']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('牌子条件规则：命中 plateinfo / 牌子条件', () => {
  const reg = rules.find(r => r.fnc === 'plateInfo').reg
  for (const msg of ['#mai plateinfo', '/mai plateinfo', '#mai 牌子条件', '#mai  牌子条件  ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai plateinfo 1', '#mai plate', '#mai plate 真极']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('牌子条件图为原样发送的 JPEG（源 image_to_base64 同款，不做缩放）', () => {
  const file = fileURLToPath(new URL('../resources/static/mai/pic/table_condition.jpg', import.meta.url))
  if (!fs.existsSync(file)) return
  const buf = fs.readFileSync(file)
  assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff', '应为合法 JPEG')
  // 源图 1440×6020（勿"顺手优化"缩小：源是原样直发）
  let i = 2
  let dim = null
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      dim = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
      break
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  assert.deepEqual(dim, [1440, 6020])
})

test('版本进度规则：命中（子命令「进度」+ 口语「真极舞进度」）', () => {
  const reg = rules.find(r => r.fnc === 'versionPlate').reg
  for (const msg of ['#mai plate 真极 进度', '#mai plate 真极进度', '#mai plate 真极舞进度', '#mai plate 舞将 进度']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  const say = rulesOf(MaiTableSay).find(r => r.fnc === 'versionPlateSay').reg
  for (const msg of ['真极舞进度', '真极进度', '舞将进度', '真极舞进度2']) {
    assert.match(msg, say, `口语应命中：${msg}`)
  }
})

test('versionPlate 解析：完成表/进度分流与页码', async () => {
  const { parseVersionPlate } = await import('../apps/table.js')
  assert.deepEqual(parseVersionPlate('真', '极', null, null),
    { ver: '真', plan: '极', page: 1, isProgress: false })
  assert.deepEqual(parseVersionPlate('真', '极', '进度', null),
    { ver: '真', plan: '极', page: 1, isProgress: true })
  assert.deepEqual(parseVersionPlate('舞', '将', '完成表', '2'),
    { ver: '舞', plan: '将', page: 2, isProgress: false })
  assert.equal(parseVersionPlate('真', '将', null, null).error, '真系没有真将哦。')
})


// =====================================================================
// 等级进度 / 分数列表（P2c）
// =====================================================================

test('等级进度规则：命中与拒收', () => {
  const reg = rules.find(r => r.fnc === 'levelProgress').reg
  for (const msg of [
    '#mai progress 13 ap', '#mai progress 13 fc 已完成', '#mai progress 13 s+ 2',
    '#mai progress 13 ap 未游玩 3', '#mai 进度查询 13 ap',
  ]) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  // 注意：`#mai progress` 本身**应当命中**（源同为「先匹配后校验」，缺参走 fnc 内文案），故不在拒收列
  for (const msg of ['#mai progressx 13 ap', '#phi progress 13 ap', 'progress 13 ap']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('等级进度守卫：无参 / 无此等级 / 无此评价等级 / 志向', async () => {
  const { inst, replies } = makeInst(MaiTable)
  const cases = [
    ['#mai progress', '输入错误，请重新输入难度等级。'],
    ['#mai progress 99 ap', '无此等级。'],
    // 'a+' 能过源正则的目标形状，但不在 RANK/COMBO/SYNC 任一清单 → 「无此评价等级。」
    ['#mai progress 13 a+', '无此评价等级。'],
    // 'bb' 在 RANK_PLUS 里（下标 3 < 8）→ 走「志向」而非「无此评价等级」，源同款
    ['#mai progress 13 bb', '兄啊，有点志向好不好。'],
    // 门槛是 index < 11：'9'(10) 拦、'9+'(11) 放行（源同款，9+ 已达标故继续走鉴权）
    ['#mai progress 9 ap', '兄啊，有点志向好不好。'],
    ['#mai progress 13 d', '兄啊，有点志向好不好。'],
    ['#mai progress 13 ap 随便', '无法指定查询「随便」。'],
  ]
  for (const [msg, want] of cases) {
    replies.length = 0
    await inst.levelProgress({ msg })
    assert.deepEqual(replies, [want], `${msg} 文案`)
  }
})

test('分数列表规则：命中与拒收', () => {
  const reg = rules.find(r => r.fnc === 'levelScoreList').reg
  for (const msg of ['#mai list 13', '#mai list 13 2', '#mai list 13.7', '#mai 分数列表 14+']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai listx 13', '#mai list 13 x', '#phi list 13']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('分数列表守卫：无参 / 多位小数 / 无此等级', async () => {
  const { inst, replies } = makeInst(MaiTable)
  const cases = [
    ['#mai list', '输入错误，请重新输入指定等级。'],
    ['#mai list 13.75', '输入有误，定数仅有一位小数。'],
    ['#mai list 99', '无此等级。'],
  ]
  for (const [msg, want] of cases) {
    replies.length = 0
    await inst.levelScoreList({ msg })
    assert.deepEqual(replies, [want], `${msg} 文案`)
  }
})

test('回归：COMBO_PLUS 必须是源的字面量清单（.replace("p","+") 会把 ap 变成 a+）', async () => {
  const { COMBO_PLUS, SYNC_PLUS, RANK_PLUS } = await import('../lib/constants.js')
  assert.deepEqual(COMBO_PLUS, ['fc', 'fc+', 'ap', 'ap+'])
  assert.ok(COMBO_PLUS.includes('ap') && COMBO_PLUS.includes('ap+'), 'ap/ap+ 不得丢失')
  // 派生写法确实会出错（此断言即回归说明）
  assert.notDeepEqual(['fc', 'fcp', 'ap', 'app'].map(k => k.replace('p', '+')), COMBO_PLUS)
  // 另两支由 replace 派生是安全的
  assert.deepEqual(SYNC_PLUS, ['fs', 'fs+', 'fdx', 'fdx+'])
  assert.deepEqual(RANK_PLUS.slice(-4), ['ss', 'ss+', 'sss', 'sss+'])
})

test('回归：PLAN_MAP 覆盖全部目标，且 d 档取 ACHIEVEMENT_LIST 末位（源负下标）', async () => {
  const { PLAN_MAP } = await import('../lib/handler.js')
  const { ACHIEVEMENT_LIST, COMBO_PLUS, RANK_PLUS, SYNC_PLUS } = await import('../lib/constants.js')
  for (const p of [...RANK_PLUS, ...COMBO_PLUS, ...SYNC_PLUS]) {
    assert.ok(PLAN_MAP[p], `PLAN_MAP 缺少目标 ${p}`)
  }
  assert.deepEqual(PLAN_MAP.d, [0, ACHIEVEMENT_LIST.at(-1)])
  assert.deepEqual(PLAN_MAP.s, [0, 97])
  assert.deepEqual(PLAN_MAP['sss+'], [0, 100.5])
  assert.deepEqual(PLAN_MAP.ap, [1, 2])
  assert.deepEqual(PLAN_MAP['ap+'], [1, 3])
  assert.deepEqual(PLAN_MAP.fdx, [2, 2])
})
