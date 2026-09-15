/**
 * 随心配b50 命令规则单测（设计《b50扩展实现设计.md》§3.4 / §8 / §10）
 *
 * 只覆盖不触网路径：正则命中/拒收、放行语义、迁移引导文案。
 * ⚠️ 与 fitRules.test.js 同款纪律：正则一律取**真实模块导出的 `.source`**（不手抄），
 *    以免规则串与 fnc 内解析用的正则漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

let MaiScore = null
let MaiTable = null

const rulesOf = cls => new cls().rule
  .map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
const regOf = (cls, fnc) => {
  const r = rulesOf(cls).filter(x => x.fnc === fnc)
  assert.ok(r.length, `未找到规则 ${fnc}`)
  return r[0].reg
}

test('准备：载入命令类', async () => {
  // ⚠️ 必须带分号：以 `(` 开头的语句若上一行也是表达式语句，ASI 不生效
  ({ MaiScore } = await import('../apps/score.js'));
  ({ MaiTable } = await import('../apps/table.js'))
})

// ---------------------------------------------------------------- 白名单规则

test('随心配入口：命中与拒收', () => {
  const reg = regOf(MaiScore, 'variantHelp')
  for (const msg of ['#mai 随心配', '#mai 随心配b50', '#mai 随心配 帮助', '#mai 随心配b50 help',
    '#mai随心配', '/mai 随心配 help']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai 随心配x', '#mai 随 心配', '#phi 随心配']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('歌50 / 全Xb50：参数捕获', () => {
  const s50 = regOf(MaiScore, 'song50')
  assert.equal('#mai 歌50 紫茄子'.match(s50)?.[1], '紫茄子')
  assert.equal('#mai 歌50 799 红'.match(s50)?.[1], '799 红')
  assert.equal('#mai 歌50 QZKago Requiem'.match(s50)?.[1], 'QZKago Requiem')
  assert.equal('#mai 歌50'.match(s50)?.[1], undefined, '无参不捕获（fnc 回用法提示）')
  assert.doesNotMatch('#mai 歌500', s50)

  const all = regOf(MaiScore, 'all50')
  assert.equal('#mai 全13b50'.match(all)?.[1], '13')
  assert.equal('#mai 全红b50'.match(all)?.[1], '红')
  assert.equal('#mai 全13.5b50'.match(all)?.[1], '13.5')
  assert.doesNotMatch('#mai 全13', all)
  assert.doesNotMatch('#mai 全13b5', all)
})

test('变体白名单：命中常见形态，拒收非 token', () => {
  const reg = regOf(MaiScore, 'variant50')
  for (const msg of ['#mai FC50', '#mai fc50', '#mai FC+50', '#mai 单刷50', '#mai 拼机50',
    '#mai SP50', '#mai FS50', '#mai FDX50', '#mai FSD50', '#mai nb50', '#mai 牛逼50',
    '#mai 越级50', '#mai 丢人50', '#mai 寸50', '#mai 锁50', '#mai 鸟+寸50', '#mai 仅SS50',
    '#mai 东方50', '#mai 车万50', '#mai v家50', '#mai 辉50', '#mai 白代50', '#mai 真超檄50',
    '#mai DX50', '#mai 标准50', '#mai 红谱50', '#mai 紫50']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai 13b50', '#mai 全13b5', '#mai 紫的50', '#mai 东方之珠50x',
    '#mai 全13b50']) {   // 全Xb50 归 all50 规则，不属于本白名单
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('兜底规则（谱师）：形状宽松，但未命中必放行', () => {
  const reg = regOf(MaiScore, 'designer50')
  for (const msg of ['#mai mai-Star50', '#mai 翠楼屋50', '#mai maimai TEAM50', '#mai 哈皮50']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  // 这些也命中形状 —— 安全性靠 fnc 的 return false（见下一条用例）
  for (const msg of ['#mai song 1150', '#mai list 1350', '#mai search 定数50']) {
    assert.match(msg, reg, `形状上会命中：${msg}`)
  }
})

test('放行锁：兜底规则对既有命令一律 return false（R1 的核心）', async () => {
  const mai = (await import('../lib/service.js')).mai
  const database = await import('../lib/database.js')
  // user.json 落到临时目录，严禁碰真机 data/
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-variantrules-')))
  await database.load()

  const wasReady = mai.ready
  const inst = new MaiScore()
  const replies = []
  inst.reply = async msg => { replies.push(String(msg)) }
  try {
    // 曲库未就绪：任何消息都不得回复（静默放行，交给认领它的规则）
    mai.ready = false
    for (const msg of ['#mai song 1150', '#mai list 1350', '#mai search 定数50', '#mai mai-Star50']) {
      replies.length = 0
      assert.equal(await inst.designer50({ msg }), false, `未就绪应放行：${msg}`)
      assert.deepEqual(replies, [], `未就绪不得回复：${msg}`)
    }

    // 曲库就绪：谱师表为空 ⇒ 一律放行；时间词 ⇒ 回迁移引导
    mai.ready = true
    mai.totalList = { root: [] }
    for (const msg of ['#mai song 1150', '#mai list 1350', '#mai search 定数50', '#mai 不存在的人50']) {
      replies.length = 0
      assert.equal(await inst.designer50({ msg }), false, `应放行：${msg}`)
      assert.deepEqual(replies, [], `放行路径不得回复：${msg}`)
    }

    // 时间类迁移引导（V26）：消费该消息并给出新命令
    for (const msg of ['#mai 新歌50', '#mai 旧版本50', '#mai 旧歌50']) {
      replies.length = 0
      assert.equal(await inst.designer50({ msg }), true, `时间词应被消费：${msg}`)
      assert.equal(replies.length, 1)
      assert.match(replies[0], /list 新歌/, `应指向分数列表：${replies[0]}`)
    }

    // 曲库里有该谱师 → 认领该消息（不触网：无数字 QQ 的 df 用户走 dfHint 引导）
    mai.totalList = { root: [{ difficulties: [{ note_designer: 'ハヤシ' }] }] }
    replies.length = 0
    assert.equal(await inst.designer50({ msg: '#mai ハヤシ50', user_id: '114514' }), true,
      '识别到谱师应认领（返回 true 消费该消息）')
  } finally {
    mai.ready = wasReady
  }
})

// ---------------------------------------------------------------- 与既有命令的互不侵占

test('互不侵占：b50/ap50/score/拟合/update 与 manage 三词', () => {
  const scoreRules = rulesOf(MaiScore)
  const texts = ['#mai b50', '#mai ap50', '#mai score 799', '#mai 单曲成绩 799', '#mai 拟合b50',
    '#mai update']
  // 每个输入都必须由**更早声明的**规则认领（声明序即匹配序）
  for (const msg of texts) {
    const hit = scoreRules.find(r => r.reg.test(msg))
    assert.ok(hit, `应有规则认领：${msg}`)
    assert.ok(['best50', 'ap50', 'playData', 'fitB50', 'updateScore'].includes(hit.fnc),
      `${msg} 被 ${hit.fnc} 抢走了（应归前面几条既有规则）`)
  }
  // manage 的三个词本就不归 score 族（由 apps/manage.js 认领），这里只断言**新规则不侵占**
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai sync', '#mai 下载资源']) {
    for (const fnc of ['variantHelp', 'song50', 'all50', 'variant50', 'designer50']) {
      assert.doesNotMatch(msg, regOf(MaiScore, fnc), `${msg} 不应被 ${fnc} 侵占`)
    }
  }
})

test('列表族互不侵占：list 13 归既有规则，关键词归新规则', () => {
  const tableRules = rulesOf(MaiTable)
  const numeric = tableRules.find(r => r.fnc === 'levelScoreList').reg
  const keywordRegs = tableRules.filter(r => r.fnc === 'levelScoreListKey').map(r => r.reg)
  assert.equal(keywordRegs.length, 2, '关键词列表应有子命令形与口语形两条规则')
  const keyword = keywordRegs[0]
  for (const msg of ['#mai list 13', '#mai list 13.5', '#mai list 14 2', '#mai 分数列表 15']) {
    assert.match(msg, numeric, `数字形态应归 levelScoreList：${msg}`)
    assert.doesNotMatch(msg, keyword, `关键词规则不应命中：${msg}`)
  }
  for (const msg of ['#mai list 理论', '#mai list AP+', '#mai list 新歌', '#mai list 旧版本',
    '#mai list 旧歌', '#mai list ap+ 2', '#mai 理论分数列表', '#mai 新歌分数列表',
    '#mai 旧版本列表 2', '#mai AP+列表']) {
    assert.ok(keywordRegs.some(r => r.test(msg)), `关键词形态应归新规则：${msg}`)
  }
  for (const msg of ['#mai list 13 2', '#mai list', '#mai 新歌', '#mai 新歌50']) {
    for (const r of keywordRegs) assert.doesNotMatch(msg, r, `不应命中：${msg}`)
  }
})

test('大将：版本称号完成表参数位', () => {
  const tableRules = rulesOf(MaiTable)
  const verPlate = tableRules.find(r => r.fnc === 'versionPlate').reg
  for (const msg of ['#mai plate 堇大将', '#mai plate 堇大将完成表', '#mai plate 堇大将进度',
    '#mai plate 彩大将 2']) {
    assert.match(msg, verPlate, `应命中：${msg}`)
  }
  // 既有形态不受影响
  for (const msg of ['#mai plate 真极', '#mai plate 舞舞舞完成表', '#mai plate 霸者完成表']) {
    assert.match(msg, verPlate, `既有形态不应回归：${msg}`)
  }
  // score 族的兜底规则不该吞掉它（不以 50 结尾）
  assert.doesNotMatch('#mai 堇大将完成表', regOf(MaiScore, 'designer50'))
  assert.doesNotMatch('#mai 堇大将完成表', regOf(MaiScore, 'variant50'))
})

test('口语「堇大将完成表」：走 MaiTableSay 的同一参数位', async () => {
  const { MaiTableSay } = await import('../apps/table.js')
  const reg = rulesOf(MaiTableSay)[0].reg
  assert.match('堇大将完成表', reg)
  assert.match('彩大将进度', reg)
  assert.doesNotMatch('堇大将', reg, '口语形态「完成表/进度」为必需')
})

// ---------------------------------------------------------------- 解析纯函数

test('parseSong50Args：难度色可在前/在后/粘连，可与曲名连写', async () => {
  const { parseSong50Args } = await import('../apps/score.js')
  assert.deepEqual(parseSong50Args('紫茄子'), { color: '紫', query: '茄子' })
  assert.deepEqual(parseSong50Args('红799'), { color: '红', query: '799' })
  assert.deepEqual(parseSong50Args('799 红'), { color: '红', query: '799' })
  assert.deepEqual(parseSong50Args('红 QZKago Requiem'), { color: '红', query: 'QZKago Requiem' })
  assert.deepEqual(parseSong50Args('QZKago Requiem'), { color: null, query: 'QZKago Requiem' })
  assert.deepEqual(parseSong50Args(''), { color: null, query: '' })
  // 非色字的尾随词不当难度
  assert.deepEqual(parseSong50Args('茄子 紫薯'), { color: null, query: '茄子 紫薯' })
})
