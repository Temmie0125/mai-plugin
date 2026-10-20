/**
 * 官方 QQBot 适配层单测（lib/qqbot.js）
 *
 * 手法：环境判定与载荷规整是纯函数直接断言；MaiPlugin.reply 用假 e（捕获 e.reply 入参）
 * 验证「引用开关 / 图文换行 / 快捷按钮」三条适配路径，配置经临时替换 Config.getUserCfg
 * 注入（不写真实配置文件）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

if (!global.logger) {
  global.logger = new Proxy(console.log.bind(console), {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const { isQQBot, hasImage, breakAroundImages, buttonSegment, stripBizHint, hasExactText, MaiPlugin } =
  await import('../lib/qqbot.js')
const { MESSAGE, DF_QQ_HINT } = await import('../lib/handler.js')
const Config = (await import('../lib/config.js')).default

// ===== 桩：segment 与配置 =====

const realSegment = globalThis.segment
after(() => {
  globalThis.segment = realSegment
})

const stubSegment = () => {
  globalThis.segment = {
    button(...rows) {
      return { type: 'button', data: rows }
    },
    image(file) {
      return { type: 'image', file }
    },
  }
}

/** 临时替换 getUserCfg 的读取（key 级覆盖，其余走真实配置）；返回恢复函数 */
function stubConfig(overrides) {
  const orig = Config.getUserCfg.bind(Config)
  Config.getUserCfg = (name, key) =>
    key in overrides ? overrides[key] : orig(name, key)
  return () => {
    Config.getUserCfg = orig
  }
}

// ===== isQQBot =====

test('isQQBot：adapter_name / bot.adapter.name / platform 三条判据', () => {
  assert.equal(isQQBot({ adapter_name: 'QQBot' }), true)
  assert.equal(isQQBot({ bot: { adapter: { name: 'QQBot' } } }), true)
  assert.equal(isQQBot({ platform: 'QQ-group' }), true)
  assert.equal(isQQBot({ platform: 'QQ-private' }), true)
})

test('isQQBot：OneBot / 无平台 / 空值 均为 false', () => {
  assert.equal(isQQBot({ adapter_name: 'OneBotv11' }), false)
  assert.equal(isQQBot({ bot: { adapter: { name: 'OneBotv11' } } }), false)
  assert.equal(isQQBot({}), false)
  assert.equal(isQQBot(null), false)
  assert.equal(isQQBot(undefined), false)
})

// ===== hasImage =====

test('hasImage：segment.image / 裸 Buffer / 数组与单值', () => {
  const img = { type: 'image', file: 'x' }
  assert.equal(hasImage(img), true)
  assert.equal(hasImage(Buffer.from('x')), true)
  assert.equal(hasImage([img]), true)
  assert.equal(hasImage(['纯文本', { type: 'text', text: 'x' }]), false)
})

// ===== breakAroundImages =====

test('breakAroundImages：图后文本加前缀、图前文本加后缀', () => {
  const img = { type: 'image', file: 'x' }
  assert.deepEqual(breakAroundImages([img, '附言']), [img, '\n附言'])
  assert.deepEqual(breakAroundImages(['前言', img]), ['前言\n', img])
  // text 段形态
  const out = breakAroundImages([img, { type: 'text', text: '附言' }])
  assert.deepEqual(out[1], { type: 'text', text: '\n附言' })
})

test('breakAroundImages：相邻图片之间插换行段', () => {
  const img1 = { type: 'image', file: '1' }
  const img2 = { type: 'image', file: '2' }
  const out = breakAroundImages([img1, img2])
  assert.equal(out.length, 3)
  assert.equal(out[1].type, 'text')
  assert.equal(out[1].text, '\n')
})

test('breakAroundImages：幂等——已带换行边界的不重复加', () => {
  const img = { type: 'image', file: 'x' }
  assert.deepEqual(breakAroundImages([img, '\n已换行']), [img, '\n已换行'])
  assert.deepEqual(breakAroundImages(['已换行\n', img]), ['已换行\n', img])
  const seg = { type: 'text', text: '\n已换行' }
  const out = breakAroundImages([{ type: 'image', file: 'x' }, seg])
  assert.deepEqual(out[1], seg)
})

test('breakAroundImages：不改动调用方原数组与原段对象', () => {
  const img = { type: 'image', file: 'x' }
  const text = { type: 'text', text: '附言' }
  const original = [img, text]
  const out = breakAroundImages(original)
  assert.equal(original.length, 2)
  assert.equal(original[1], text)              // 原 text 对象未被替换/修改
  assert.notEqual(out[1], text)
})

test('breakAroundImages：非数组与无图载荷原样返回', () => {
  assert.equal(breakAroundImages('纯文本'), '纯文本')
  const arr = ['a', 'b']
  assert.deepEqual(breakAroundImages(arr), arr)
  // Buffer 也算图
  assert.deepEqual(breakAroundImages([Buffer.from('x'), '附言'])[1], '\n附言')
})

// ===== buttonSegment =====

test('buttonSegment：生成按钮段并替换命令头，未知预设返回 null', () => {
  stubSegment()
  const btn = buttonSegment('b50')
  assert.equal(btn.type, 'button')
  assert.ok(Array.isArray(btn.data))
  const flat = btn.data.flat()
  assert.ok(flat.every(b => b.input && !b.input.includes('{h}')))
  assert.ok(flat.some(b => b.input.startsWith('#mai ')))
  // 刻意不设 send/callback：点击仅预填输入框，不自动发送
  assert.ok(flat.every(b => b.send === undefined && b.callback === undefined))
  assert.equal(buttonSegment('不存在的预设'), null)
})

test('buttonSegment：chart 场景 {id} 按歌曲 id 预填，无 id 时留空', () => {
  stubSegment()
  const withId = buttonSegment({ name: 'chart', songId: 1150 }).data.flat()
  assert.deepEqual(
    withId.map(b => b.input),
    ['#mai score 1150', '#mai fsline 1150'],
  )
  // 无 songId → {id} 留空，退化为只预填命令（保留尾随空格供续填曲名/参数）
  const noId = buttonSegment('chart').data.flat()
  assert.deepEqual(noId.map(b => b.input), ['#mai score ', '#mai fsline '])
  // 非法 songId 一并留空；其他场景不受 songId 影响
  assert.deepEqual(
    buttonSegment({ name: 'chart', songId: '<script>' }).data.flat().map(b => b.input),
    ['#mai score ', '#mai fsline '],
  )
  assert.ok(buttonSegment({ name: 'b50', songId: 1150 }).data.flat().every(b => !b.input.includes('1150')))
})

test('buttonSegment：bind 预设=绑定水鱼/绑定落雪，完整命令、仅预填不自动发送', () => {
  stubSegment()
  const flat = buttonSegment('bind').data.flat()
  assert.deepEqual(flat.map(b => b.text), ['绑定水鱼', '绑定落雪'])
  assert.deepEqual(flat.map(b => b.input), ['#mai bind df', '#mai bind lxns'])
  // 刻意不设 send/callback：与全部预设同口径，点击仅预填输入框
  assert.ok(flat.every(b => b.send === undefined && b.callback === undefined))
})

test('buttonSegment：宿主无 segment.button 时返回 null', () => {
  globalThis.segment = {}
  assert.equal(buttonSegment('image'), null)
})

// ===== stripBizHint =====

test('stripBizHint：只撤 MESSAGE() 提示附言，其他文本与统计文本不受影响', () => {
  const img = { type: 'image', file: 'x' }
  // [图, 提示] → 提示被撤
  assert.deepEqual(stripBizHint([img, MESSAGE()], MESSAGE()), [img])
  // 带前导换行的同款（图文换行后的形态）→ 仍识别
  assert.deepEqual(stripBizHint([img, `\n${MESSAGE()}`], MESSAGE()), [img])
  // text 段形态
  assert.deepEqual(stripBizHint([img, { type: 'text', text: MESSAGE() }], MESSAGE()), [img])
  // 全服统计等业务附言 ≠ MESSAGE() → 保留
  const stats = 'Master：12345 次（10.00%）'
  assert.deepEqual(stripBizHint([img, stats], MESSAGE()), [img, stats])
  // 普通前导文本保留
  assert.deepEqual(stripBizHint(['前言', img, MESSAGE()], MESSAGE()), ['前言', img])
  // 纯字符串载荷与「撤空防御」：全被撤时保持原样
  assert.equal(stripBizHint('纯文本', MESSAGE()), '纯文本')
  assert.deepEqual(stripBizHint([MESSAGE()], MESSAGE()), [MESSAGE()])
})

// ===== hasExactText / 未绑定引导换钮判定 =====

test('hasExactText：string / text 段 / 数组逐字匹配，容忍前导换行', () => {
  assert.equal(hasExactText(DF_QQ_HINT(), DF_QQ_HINT()), true)
  assert.equal(hasExactText([IMG, `\n${DF_QQ_HINT()}`], DF_QQ_HINT()), true)
  assert.equal(hasExactText([{ type: 'text', text: DF_QQ_HINT() }], DF_QQ_HINT()), true)
  assert.equal(hasExactText('其他错误文本', DF_QQ_HINT()), false)
  assert.equal(hasExactText(`${DF_QQ_HINT()}（多余后缀）`, DF_QQ_HINT()), false)
  assert.equal(hasExactText(Buffer.from('x'), DF_QQ_HINT()), false)
})

// ===== MaiPlugin.reply =====

/** 构造插件实例 + 捕获型假 e */
function makePlugin(platform) {
  const sent = []
  // 宿主 plugin 构造器解构 opts（loader 恒传对象），单测也传空对象
  const p = new MaiPlugin({})
  p.e = {
    // 平台特征由用例给（adapter_name / platform）
    ...(platform || {}),
    reply(...args) {
      sent.push(args)
      return Promise.resolve({ message_id: '1' })
    },
  }
  return { p, sent }
}

const IMG = { type: 'image', file: 'x' }

test('reply：QQBot 下图文混发补换行并附兜底按钮组', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG, '附言'], true)
    const [msg, quote] = sent[0]
    assert.equal(quote, true)
    assert.equal(msg[1], '\n附言')                     // 适配点 1：图文换行
    assert.equal(msg.at(-1).type, 'button')            // 适配点 3：含图兜底按钮
  } finally {
    restore()
  }
})

test('reply：quoteReply=false 时丢弃引用（QQBot 与 OneBot 一致）', async () => {
  stubSegment()
  for (const platform of [{ adapter_name: 'QQBot' }, { adapter_name: 'OneBotv11' }]) {
    const restore = stubConfig({ quoteReply: false, qqBotButtons: true })
    try {
      const { p, sent } = makePlugin(platform)
      await p.reply('hi', true)
      assert.equal(sent[0][1], false)
    } finally {
      restore()
    }
  }
})

test('reply：OneBot 环境零改动（不换行、不附按钮、引用透传）', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'OneBotv11' })
    const payload = [IMG, '附言']
    await p.reply(payload, true)
    const [msg, quote] = sent[0]
    assert.equal(quote, true)
    assert.equal(msg, payload)                         // 原数组原样透传
    assert.equal(msg[1], '附言')
    assert.ok(msg.every(i => i.type !== 'button'))
  } finally {
    restore()
  }
})

test('reply：qqBotButtons=false 不附按钮，换行仍生效', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: false })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG, '附言'], true)
    const [msg] = sent[0]
    assert.equal(msg[1], '\n附言')
    assert.ok(msg.every(i => i.type !== 'button'))
  } finally {
    restore()
  }
})

test('reply：按钮发出时撤提示附言；发不出时附言照旧', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    // 按钮 + MESSAGE() 提示并存 → 提示被撤
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG, MESSAGE()], true)
    const [msg] = sent[0]
    assert.ok(msg.every(v => (typeof v === 'string' ? v : v?.text) !== MESSAGE()), '附言应被撤掉')
    assert.equal(msg.at(-1).type, 'button')
    assert.equal(msg.filter(v => v?.type === 'image').length, 1, '图片保留')

    // 宿主缺 segment.button → 按钮发不出 → 附言照旧（用户仍有文字引导）
    globalThis.segment = {}
    const p2 = makePlugin({ adapter_name: 'QQBot' })
    await p2.p.reply([IMG, MESSAGE()], true)
    const [msg2] = p2.sent[0]
    assert.ok(msg2.some(v => (typeof v === 'string' ? v : v?.text)?.replace?.(/^\n+/, '') === MESSAGE()))
    assert.ok(msg2.every(v => v?.type !== 'button'))
  } finally {
    restore()
  }
})

test('reply：data.qqBtn=false 显式禁用按钮（含图也不落兜底组，弗一把等游戏回复用）', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG], true, { qqBtn: false })
    const [msg, quote] = sent[0]
    assert.equal(quote, true)
    assert.ok(msg.every(i => i?.type !== 'button'), '显式 false 不应附任何按钮')
  } finally {
    restore()
  }
})

test('reply：data.qqBtn 场景预设（纯文本载荷也按场景附按钮）', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply('查询失败：示例错误', true, { qqBtn: 'b50' })
    const [msg] = sent[0]
    assert.equal(msg.at(-1).type, 'button')
    const rows = msg.at(-1).data
    assert.ok(rows.flat().some(b => b.input.includes('拟合b50')))
  } finally {
    restore()
  }
})

test('reply：载荷为未绑定引导时一键换绑定指引按钮（覆盖显式 b50 场景与无场景纯文本）', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const inputs = ['#mai bind df', '#mai bind lxns']
    // b50 家族显式 qqBtn:'b50' → 引导文本命中，换成 bind 组
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply(DF_QQ_HINT(), true, { qqBtn: 'b50' })
    assert.deepEqual(sent[0][0].at(-1).data.flat().map(b => b.input), inputs)

    // bind 命令层直接回引导文本（无场景纯文本）→ 同样获得 bind 组
    const p2 = makePlugin({ adapter_name: 'QQBot' })
    await p2.p.reply(DF_QQ_HINT(), true)
    assert.deepEqual(p2.sent[0][0].at(-1).data.flat().map(b => b.input), inputs)

    // text 段形态（toSegment 包装等）→ 仍识别
    const p3 = makePlugin({ adapter_name: 'QQBot' })
    await p3.p.reply([{ type: 'text', text: DF_QQ_HINT() }], true, { qqBtn: 'b50' })
    assert.deepEqual(p3.sent[0][0].at(-1).data.flat().map(b => b.input), inputs)

    // 其他文本不受影响：显式 b50 场景保持 b50 组；无场景纯文本仍不附按钮
    const p4 = makePlugin({ adapter_name: 'QQBot' })
    await p4.p.reply('查询失败：示例错误', true, { qqBtn: 'b50' })
    assert.ok(p4.sent[0][0].at(-1).data.flat().some(b => b.input.includes('拟合b50')))
    const p5 = makePlugin({ adapter_name: 'QQBot' })
    await p5.p.reply('普通错误文本', true)
    assert.equal(typeof p5.sent[0][0], 'string', '无场景纯文本不附按钮')
  } finally {
    restore()
  }
})

test('reply：data.qqBtn 传 {name, songId} → 按钮 input 预填歌曲 id', async () => {
  stubSegment()
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG, MESSAGE()], true, { qqBtn: { name: 'chart', songId: 1150 } })
    const [msg] = sent[0]
    const flat = msg.at(-1).data.flat()
    assert.deepEqual(flat.map(b => b.input), ['#mai score 1150', '#mai fsline 1150'])
    assert.ok(msg.every(v => (typeof v === 'string' ? v : v?.text) !== MESSAGE()))
  } finally {
    restore()
  }
})

test('reply：宿主缺 segment 时适配静默降级，回复照常发出', async () => {
  globalThis.segment = {}
  const restore = stubConfig({ quoteReply: true, qqBotButtons: true })
  try {
    const { p, sent } = makePlugin({ adapter_name: 'QQBot' })
    await p.reply([IMG, '附言'], true)
    const [msg, quote] = sent[0]
    assert.equal(quote, true)
    assert.equal(msg[1], '\n附言')
    assert.ok(msg.every(i => i.type !== 'button'))
  } finally {
    restore()
  }
})
