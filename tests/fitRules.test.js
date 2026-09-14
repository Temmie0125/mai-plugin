/**
 * 拟合b50 / update 命令规则单测（设计《拟合b50实现设计.md》§7.1 / §9）
 *
 * 只覆盖不触网路径：正则命中与拒收、前置守卫文案。
 * ⚠️ 本文件刻意用**真实模块导出的 className.rule** 取正则（而非手抄一份），
 *    以免规则串与 fnc 内解析用的正则漂移 —— 手抄过的正则在本次实施中就曾
 *    因转义层数被吃掉反斜杠而静默失真。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

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
let MaiManage = null

const rulesOf = cls => new cls().rule
  .map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))

const regOf = (cls, fnc) => {
  const r = rulesOf(cls).find(x => x.fnc === fnc)
  assert.ok(r, `未找到规则 ${fnc}`)
  return r.reg
}

test('准备：载入 apps/score.js 与 apps/manage.js', async () => {
  // ⚠️ 必须带分号：以 `(` 开头的语句若上一行也是表达式语句，ASI 不生效
  ({ MaiScore } = await import('../apps/score.js'));
  ({ MaiManage } = await import('../apps/manage.js'));
})

test('拟合b50 规则：命中与参数捕获', () => {
  const reg = regOf(MaiScore, 'fitB50')
  // 命中：命令头↔子命令空格可选、尾随空格容忍
  for (const msg of ['#mai 拟合b50', '/mai 拟合b50', '#mai fixB50', '#mai fixb50',
    '#mai 拟合b50 ', '#mai   fixB50  ', '#mai拟合b50']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  // 无参时不应捕获到参数（否则会被误判为「用户名方式」而拒绝）
  for (const msg of ['#mai 拟合b50', '#mai fixB50', '#mai 拟合b50 ']) {
    assert.equal((msg.match(reg) || [])[1], undefined, `无参不应捕获参数：${msg}`)
  }
  // 带参捕获 —— D5 引导依赖它可达
  assert.equal('#mai 拟合b50 张三'.match(reg)?.[1], '张三')
  assert.equal('#mai fixB50 水鱼用户'.match(reg)?.[1], '水鱼用户')
})

test('拟合b50 规则：拒收样例', () => {
  const reg = regOf(MaiScore, 'fitB50')
  for (const msg of [
    '#phi 拟合b50',      // 命令头不符
    '#mai 拟合b50x',     // 子命令↔参数必须空格（勿用 (.*)$ —— 它会命中这里）
    '#mai fixb50x',
    '拟合b50',           // 无头
    '#mai 拟合 b50',     // 子命令被拆开
    '#mai fix B50',
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('update 规则：命中与拒收', () => {
  const reg = regOf(MaiScore, 'updateScore')
  for (const msg of ['#mai update', '/mai update', '#maiupdate', '#mai update ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '#mai sync', '#phi update',
    'mai update', '#mai update 1', '#mai updatex']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('与 manage.js 三条规则互不侵占（update 归属唯一）', () => {
  const manageRules = rulesOf(MaiManage)
  const scoreUpdate = regOf(MaiScore, 'updateScore')
  const scoreFit = regOf(MaiScore, 'fitB50')

  // #mai update 只归 score —— manage 侧已由 tests/manage.test.js:83 锁定拒收方向
  for (const r of manageRules) {
    assert.doesNotMatch('#mai update', r.reg, `manage 规则不应命中 #mai update（fnc=${r.fnc}）`)
    assert.doesNotMatch('#mai 拟合b50', r.reg, `manage 规则不应命中 拟合b50（fnc=${r.fnc}）`)
  }

  // 反向：score 的两条新规则不吞 manage 的既有命令
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '#mai download',
    '#mai sync', '#mai 更新曲库', '#mai 数据更新']) {
    assert.doesNotMatch(msg, scoreUpdate, `不应被 update 规则吞掉：${msg}`)
    assert.doesNotMatch(msg, scoreFit, `不应被拟合b50 规则吞掉：${msg}`)
  }

  // 既有查分命令不被两条新规则吞掉
  for (const msg of ['#mai b50', '#mai ap50', '#mai score 799', '#mai 单曲成绩 799']) {
    assert.doesNotMatch(msg, scoreUpdate)
    assert.doesNotMatch(msg, scoreFit)
  }
})

test('规则串与 fnc 内解析共用同一来源（防漂移）', () => {
  const src = rulesOf(MaiScore)
  // 规则表里不应出现手抄的 拟合b50 字面正则——必须是 REG_FIT().source
  const fitRule = src.find(r => r.fnc === 'fitB50').reg.source
  const updateRule = src.find(r => r.fnc === 'updateScore').reg.source
  assert.match(fitRule, /\\s\*/, '规则串应含真正的 \\s 转义（曾因转义层数被吃掉而失真）')
  assert.match(updateRule, /\\s\*/)
  assert.ok(fitRule.includes('拟合') && fitRule.includes('fix'), '规则串应含两种写法')
})

test('拟合b50 守卫：带参数命中 D5 引导，且不触网', async () => {
  const { mai } = await import('../lib/service.js')
  const database = await import('../lib/database.js')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  // user.json 落到临时目录，严禁碰真机 data/（lib/database.js 的既有测试纪律）
  database.setDataRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fitrules-')))
  await database.load()

  // ensureReady 只判 mai.ready；置真即可让流程走到守卫，无需曲库与网络
  const wasReady = mai.ready
  mai.ready = true
  try {
    const inst = new MaiScore()
    const replies = []
    inst.reply = async (msg) => { replies.push(String(msg)) }

    await inst.fitB50({ user_id: '114514', msg: '#mai 拟合b50 张三', message: [] })
    assert.deepEqual(replies, ['拟合b50 按绑定账号查询（可 @ 他人）；暂不支持用户名方式。'],
      '带参数应回 D5 引导（且绝不能走到会触网的 drawFitBest50）')

    // @他人场景：宿主 loader 从 e.message 重建 e.msg 时只拼 text 段（at 段只写 e.at），
    // 故 e.msg 里根本没有 at —— 参数捕获为空，不会被误判为「用户名方式」。
    // 这里只断言解析层（真正的 @查询会触网，由 tests/scoreWriteGuard.test.js 覆盖 handler 层）。
    const reg = regOf(MaiScore, 'fitB50')
    assert.equal((('#mai 拟合b50'.match(reg) || [])[1] || '').trim(), '',
      '@他人场景的 e.msg 等价形式应判为无参')
  } finally {
    mai.ready = wasReady
  }
})
