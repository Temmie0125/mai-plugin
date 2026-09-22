import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MaiBase } from '../apps/base.js'

// 宿主全局 logger 打桩（service 模块顶层捕获 global.logger；冒烟脚本同款）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

/** 构造期编译 rule 正则（宿主 loader.js:158 同款 new RegExp） */
function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
}

const rules = rulesOf(MaiBase)

test('help 规则：命中样例（裸命令/别名/双前缀）', () => {
  const reg = rules.find(r => r.fnc === 'help').reg
  for (const msg of ['#mai', '/mai', '#mai help', '/mai 帮助', '#mai 菜单', '#mai   help ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('help 规则：拒收样例（不误吃他人命令）', () => {
  const reg = rules.find(r => r.fnc === 'help').reg
  for (const msg of [
    '#maib50', // 无空格粘连
    '#mai help me', // 带多余参数
    '#maihelpx',
    '#phi b19', // 其他插件命令
    '#更新maimai数据',
    'mai help', // 无前缀（保留给口语正则，基命令不响应）
    '#帮助maimaiDX', // 原版触发词不保留（收编进 #mai）
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('默认 cmdhead 与规则一致', async () => {
  const { head } = await import('../lib/config.js')
  const reg = rules.find(r => r.fnc === 'help').reg
  assert.match(`#${head()}`, reg)
})

test('改 cmdhead 重启后规则跟随新命令头', async () => {
  const { default: Config, head } = await import('../lib/config.js')
  Config.modify('config', 'cmdhead', 'maimaidx')
  const inst = new MaiBase()
  const reg = new RegExp(inst.rule[0].reg)
  assert.match('#maimaidx help', reg)
  assert.doesNotMatch('#mai help', reg)
  Config.modify('config', 'cmdhead', 'mai')
})

// ---- song / search 规则（P2 语义拆分：song=详情直查，search=检索列表）----
test('song/search 规则：命中与拒收', async () => {
  const { MaiSong } = await import('../apps/song.js')
  const rules = rulesOf(MaiSong)
  const searchReg = rules.find(r => r.fnc === 'search').reg
  const queryReg = rules.find(r => r.fnc === 'query').reg

  for (const msg of ['#mai search 定数14', '/mai 检索 茄子', '#mai 搜索 bpm 200', '#mai search']) {
    assert.match(msg, searchReg, `search 应命中：${msg}`)
  }
  for (const msg of ['#mai searchx 1', 'mai search 1', '#mai 检索列表', '#phi search 1']) {
    assert.doesNotMatch(msg, searchReg, `search 不应命中：${msg}`)
  }
  // 两条规则互斥：search 文本不得被 song 规则吃掉
  assert.doesNotMatch('#mai search 定数14', queryReg)
  assert.doesNotMatch('#mai song 11365', searchReg)
  assert.match('#mai song 11365', queryReg)
})

// ---- parseSongQuery：粘连前缀（源「定数14查歌」习惯的收编形态）与来源标记 ----
test('parseSongQuery：粘连前缀 / 空格 / 来源标记 / 页码保留', async (t) => {
  const { parseSongQuery } = await import('../apps/song.js')
  // 纯解析路径（不依赖曲库）
  assert.ok(parseSongQuery('定数xx').error, '非法定数参数应报错')

  // 涉及曲库命中的断言需要离线曲库缓存；无缓存（CI）则跳过
  const { mai } = await import('../lib/service.js')
  if (!mai.ready) await mai.init({ network: false }).catch(() => false)
  if (!mai.ready) return t.skip('无 data/music 曲库缓存，跳过命中类断言')

  const a = parseSongQuery('定数14')
  const b = parseSongQuery('定数 14')
  assert.equal(a.source, 'filter')
  assert.equal(a.result.length, b.result.length)
  assert.ok(a.result.length > 10)
  assert.equal(parseSongQuery('bpm200').source, 'filter')
  // 区间必须显式连接符（- / ~ / 全角）；无连接符双数字 = 单值+页码
  assert.equal(parseSongQuery('定数 14-15').page, 1)
  assert.ok(parseSongQuery('定数 14-15').result.length > 0)
  assert.equal(parseSongQuery('定数14~15 2').page, 2)
  assert.ok(parseSongQuery('定数14～15').result.length === parseSongQuery('定数 14-15').result.length)
  assert.equal(parseSongQuery('定数14 4').page, 4)
  assert.ok(parseSongQuery('定数14 4').result.length > 10)
  assert.equal(parseSongQuery('定数 4 14').page, 14) // 无连接符：4 + 页码14（不再视为区间）
  assert.ok(parseSongQuery('定数 14 15 2').error)   // 三数字需连接符
  assert.ok(parseSongQuery('定数14-').error)
  // 定数+（游戏内 14+ 等级字面）
  const plus = parseSongQuery('定数14+')
  assert.equal(plus.source, 'filter')
  assert.ok(plus.result.length > 0, '14+ 应有命中')
  assert.notEqual(
    [...plus.result].map(s => s.song_id).sort().join(),
    [...parseSongQuery('定数14').result].map(s => s.song_id).sort().join(),
    '14+ 结果应与 14 不同',
  )
  assert.equal(parseSongQuery('定数14+ 2').page, 2)
  // bpm 同构
  assert.ok(parseSongQuery('bpm200-300').result.length > 0)
  assert.equal(parseSongQuery('bpm 200 3').page, 3)
  assert.ok(parseSongQuery('bpm200 x').error)
  // 物量（谱面 note 总数，整数；语法同 bpm）。单值/区间取自曲库真实物量，避免字面量绑死数据
  const notesVal = mai.totalList.root
    .flatMap(s => s.difficulties.map(d => d.notes?.total ?? 0))
    .find(n => n >= 200)
  assert.ok(notesVal >= 200, '曲库应含带物量数据的谱面')
  assert.ok(parseSongQuery(`物量${notesVal}`).result.length > 0, '物量单值应命中含该物量谱面的曲')
  assert.ok(parseSongQuery(`物量${notesVal - 100}-${notesVal + 100}`).result.length > 0, '物量区间应命中')
  assert.equal(
    parseSongQuery(`物量${notesVal - 100}～${notesVal + 100}`).result.length,
    parseSongQuery(`物量${notesVal - 100}-${notesVal + 100}`).result.length,
    '全角连接符等价',
  )
  assert.equal(parseSongQuery('物量 300 2').page, 2, '尾部数字为页码')
  // all_diff=false 对齐谱师过滤：difficulties 裁剪到命中项（列表彩标只点亮命中的难度格）
  const noteHits = parseSongQuery(`物量${notesVal - 100}-${notesVal + 100}`).result
  assert.ok(
    noteHits.every(s => s.difficulties.length > 0
      && s.difficulties.every(d => d.notes.total >= notesVal - 100 && d.notes.total <= notesVal + 100)),
    '物量结果的 difficulties 应只剩命中区间的谱面',
  )
  assert.ok(parseSongQuery('物量300 x').error)
  assert.ok(parseSongQuery('物量300.5').error, '物量只收整数')
  assert.ok(parseSongQuery('物量300-').error)
  // 命中别名表的曲名走别名通道（本库 'ネコ日和。' 自身即别名行）；非别名标题走 title
  assert.equal(parseSongQuery('アンビバレンス').source, 'alias')
  assert.equal(parseSongQuery('11365').source, 'id')
  const titleSong = mai.totalList.root.find(s =>
    mai.totalAliasList.byAlias(s.song_name).length === 0 &&
    mai.totalList.filter({ title: s.song_name }).length === 1)
  assert.ok(titleSong, '应能找到唯一标题样本')
  assert.equal(parseSongQuery(titleSong.song_name).source, 'title')
  // 谱师别名表接入查歌族（resources/info/designer_alias.json，与「<谱师>50」同源）
  const byDesigner = s => parseSongQuery(`谱师 ${s}`).result.length
  assert.ok(byDesigner('はっぴー') > 0, '曲库原名应命中')
  assert.equal(byDesigner('哈皮'), byDesigner('はっぴー'), '中文别名应等同原名')
  assert.ok(byDesigner('譜面-100号') > 0)
  assert.equal(byDesigner('谱面100号'), byDesigner('譜面-100号'), '别名表「谱面100号」应等同原名')
  assert.equal(byDesigner('Happy'), byDesigner('happy'), '别名表 latin 键大小写折叠')
  assert.ok(byDesigner('はっぴ') > 0, '原名片段仍走 contains（别名表未收录也照旧可用）')
  assert.equal(byDesigner('不存在的谱师'), 0, '未收录名字无命中、不报错')
  assert.equal(parseSongQuery('谱师 哈皮 2').page, 2, '别名路径同样吃页码')
})

// ---- 命令头↔子命令 空格可选（#maisong / #maihelp），子命令↔参数仍须空格 ----
test('粘连命令头：命中与边界拒收', async () => {
  const { MaiSong, MaiAlias } = await import('../apps/song.js')
  const { MaiScore } = await import('../apps/score.js')
  const { MaiBase } = await import('../apps/base.js')
  const rules = cls => rulesOf(cls)

  const songRegs = rules(MaiSong)
  const hitFnc = (regs, msg) => regs.filter(r => r.reg.test(msg)).map(r => r.fnc)

  // 头↔子命令空格可选
  assert.deepEqual(hitFnc(songRegs, '#maisong 消失'), ['query'])
  assert.deepEqual(hitFnc(songRegs, '#maisearch 定数14 4'), ['search'])
  assert.deepEqual(hitFnc(songRegs, '#maib50'), [])
  assert.ok(hitFnc(rules(MaiScore), '#maib50').includes('best50'))
  assert.ok(hitFnc(rules(MaiBase), '#maihelp').includes('help'))
  assert.ok(hitFnc(rules(MaiAlias), '#maialias 悲怆').includes('queryAlias'))
  // score 无参也命中（fnc 内给引导）
  assert.ok(hitFnc(rules(MaiScore), '#mai score').includes('playData'))

  // 边界：子命令↔参数必须空格（防误吃 #maisongx / #maisourcex 这类词）
  for (const msg of ['#maisongx', '#maisearchx 1', '#maihelpx']) {
    assert.equal(hitFnc(songRegs, msg).length, 0, `不应命中：${msg}`)
  }
  assert.equal(hitFnc(rules(MaiBase), '#maihelpx').length, 0)
})
