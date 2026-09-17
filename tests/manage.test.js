import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { MaiManage, loadSharedRestart, scheduleRestart } from '../apps/manage.js'
import Config from '../lib/config.js'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** file:// 形式的本地远端地址（--depth 只对非本地协议生效，故不能直接用路径） */
const fileUrl = p => `file:///${p.replace(/\\/g, '/')}`

/**
 * 造一个「远端」：裸库 + 工作库。裸库 HEAD 显式指向 main（等价 GitHub 默认分支），
 * 否则 clone 会落在不存在的 master 上、拿不到检出内容。commit() 提交并推送到 main。
 * （与 tests/resourcePack.test.js 同款：本仓测试文件各自自足，不自建共享模块）
 */
function makeRemote(root) {
  const remote = path.join(root, 'remote.git')
  const work = path.join(root, 'work')
  git(['init', '--bare', remote])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  git(['init', work])

  const commit = (message, files) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(work, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
    git(['add', '-A'], work)
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', message], work)
    git(['push', '-q', remote, 'HEAD:main'], work)
  }

  return { remote, work, commit }
}

/**
 * 临时覆盖若干配置项跑一段。只改 Config 的内存缓存，**不写用户 yaml**——
 * tests/*.test.js 由 node --test 多进程并行，各文件同写 config/config/config.yaml 会互相覆盖并留下残留。
 */
async function withCfg(patch, fn) {
  try {
    Config.config.config = { ...Config.getConfig('config'), ...patch }
    return await fn()
  } finally {
    delete Config.config.config // 丢弃缓存，下次读取回落到磁盘上的真实用户配置
  }
}

const withAssetsRepo = (value, fn) => withCfg({ assetsRepo: value }, fn)

function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ reg: new RegExp(r.reg), fnc: r.fnc }))
}

test('更新规则：命中样例（普通/强制/别名/双前缀）', () => {
  const rules = rulesOf(MaiManage)
  assert.equal(rules.length, 3, '插件更新 + 资源下载 + 曲库同步三条规则')
  const reg = rules[0].reg
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '#mai   强制   更新']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('更新规则：强制分组捕获（决定 reset/clean 分支）', () => {
  const reg = rulesOf(MaiManage)[0].reg
  const m = '#mai 强制更新'.match(reg)
  assert.equal(m?.[1], '强制')
  assert.equal('#mai 更新'.match(reg)?.[1], undefined)
})

test('更新规则：拒收样例', () => {
  const reg = rulesOf(MaiManage)[0].reg
  // update 已于 8131b02 有意移出 manage 的规则，为「成绩数据更新」腾出该词；
  // 该词现归 apps/score.js 的 updateScore（刷新本人 B50 + 全量成绩缓存）。
  // 此处的拒收断言仍是必须的：manage 若再吃回 update 就会抢走 score 的命令。
  for (const msg of ['#mai 强制', '#mai 更新曲绘', '#maix 更新', 'mai 更新', '#mai sync', '#phi 更新',
    '/mai update', '#mai update', '#mai download', '#mai 下载资源']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('资源规则：命中样例（英文/中文/不分大小写）', () => {
  const rules = rulesOf(MaiManage)
  assert.equal(rules[1].fnc, 'downRes')
  const reg = rules[1].reg
  for (const msg of ['#mai download', '/mai Download', '#mai downill', '#mai 下载资源', '#mai 下载',
    '#mai 更新资源', '#mai 更新曲绘', '#mai   download ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('资源规则：拒收样例（尤其不与插件更新互吃）', () => {
  const reg = rulesOf(MaiManage)[1].reg
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '#mai sync', '#maix download',
    'mai download', '#phi download', '#mai download 曲绘', '#mai 更新曲库']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('同步规则：命中样例（英文/中文别名/双前缀）', () => {
  const rules = rulesOf(MaiManage)
  assert.equal(rules[2].fnc, 'syncMusic')
  const reg = rules[2].reg
  for (const msg of ['#mai sync', '/mai sync', '#mai   sync ', '#mai 更新曲库', '#mai 数据更新']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('同步规则：拒收样例（刻意避开 update 一词，且三条规则互不吃）', () => {
  const reg = rulesOf(MaiManage)[2].reg
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '#mai update', '/mai update',
    '#mai download', '#mai 下载资源', '#mai 更新资源', '#mai 更新曲绘',
    '#maix sync', 'mai sync', '#phi sync', '#mai 同步曲库']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('三条规则两两互斥：每条样例只被一条命中', () => {
  const rules = rulesOf(MaiManage)
  const samples = {
    update: ['#mai 更新', '#mai 强制更新', '#mai gx'],
    downRes: ['#mai download', '#mai 下载资源', '#mai 更新资源'],
    syncMusic: ['#mai sync', '#mai 更新曲库', '#mai 数据更新'],
  }
  for (const [owner, msgs] of Object.entries(samples)) {
    for (const msg of msgs) {
      const hit = rules.filter(r => r.reg.test(msg)).map(r => r.fnc)
      assert.deepEqual(hit, [owner], `${msg} 应只被 ${owner} 命中，实际 ${JSON.stringify(hit)}`)
    }
  }
})

test('资源命令：非主人拒绝，且不触碰 git/资源目录', async () => {
  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  inst.syncResourcePack = async () => { throw new Error('非主人路径不应执行同步') }
  const e = {
    msg: '#mai download', message: [], user_id: 114514, isGroup: false,
    isMaster: false, reply: async () => {},
  }
  assert.equal(await inst.downRes(e), true)
  assert.match(replies.join(''), /仅主人可用/)
})

test('资源命令：主人执行走通「下载 → 已是最新 → 远端新增」三段回执', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-manage-res-'))
  const { remote, commit } = makeRemote(root)
  commit('init', { 'mai/cover/1.png': 'p' })

  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')

  await withAssetsRepo(fileUrl(remote), async () => {
    await inst.syncResourcePack(path.join(root, 'static'))
    assert.match(replies.join('\n'), /静态资源包下载完成：曲绘 0 → 1 张/)

    replies.length = 0
    await inst.syncResourcePack(path.join(root, 'static'))
    assert.match(replies.join('\n'), /已是最新（曲绘 1 张）/)

    commit('add cover 2', { 'mai/cover/2.png': 'p2' })
    replies.length = 0
    await inst.syncResourcePack(path.join(root, 'static'))
    assert.match(replies.join('\n'), /静态资源包更新完成：曲绘 1 → 2 张/)
  })
})

test('资源命令：失败走中文分流（不冒泡），且锁已释放可再次执行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-manage-err-'))
  const empty = path.join(root, 'empty.git')
  git(['init', '--bare', empty])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], empty)

  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  const target = path.join(root, 'static')

  // 先克隆空远端：走 empty 回执
  await withAssetsRepo(fileUrl(empty), async () => {
    await assert.doesNotReject(() => inst.syncResourcePack(target), '空远端不应冒泡')
    assert.match(replies.join('\n'), /还没有 main 分支（资源尚未推送）/)

    // 锁已释放：再次执行应立即进入（fetch 失败转中文分流），而不是回「已在执行中」
    replies.length = 0
    await assert.doesNotReject(() => inst.syncResourcePack(target))
    assert.match(replies.join('\n'), /资源包更新失败：远程仓库还没有 main 分支/)
    assert.doesNotMatch(replies.join('\n'), /已在执行中/)
  })
})

test('自动更新资源：配置关闭时不触发同步', async () => {
  const inst = new MaiManage()
  let called = false
  inst.syncResourcePack = async () => { called = true }
  await withCfg({ autoUpdateAssets: false }, async () => {
    await inst.autoSyncAssets()
    assert.equal(called, false, '关闭后不应同步')
  })
})

test('更新命令：非主人拒绝', async () => {
  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  const e = {
    msg: '#mai 更新', message: [], user_id: 114514, isGroup: false,
    isMaster: false, reply: async () => {},
  }
  const ret = await inst.update(e)
  assert.equal(ret, true)
  assert.match(replies.join(''), /仅主人可用/)
})

// ---- 自动重启（「重启成功，用时xxx」回执由宿主共享 Restart 类负责）----
test('自动重启：优先共享 Restart（带重启回执），无共享模块退回裸 Bot.restart', async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const e = { group_id: 987, user_id: 654, self_id: 321, reply: async () => {} }

  // ① 共享模块可用 → 走它，且当前事件要原样传进去（回执据此知道发群还是发好友）
  const seen = []
  class FakeRestart {
    constructor(ev) { seen.push(['ctor', ev]) }
    async restart() { seen.push(['restart']) }
  }
  assert.equal(await scheduleRestart(e, { load: async () => FakeRestart, bot: null, delay: 1 }), true)
  await wait(20)
  assert.deepEqual(seen.map(s => s[0]), ['ctor', 'restart'])
  assert.equal(seen[0][1], e, '事件要原样交给 Restart')

  // ② 无共享模块 → 退回裸 Bot.restart（仍能重启，只是没有回执）
  let botRestarts = 0
  const bot = { restart: () => { botRestarts++ } }
  assert.equal(await scheduleRestart(e, { load: async () => null, bot, delay: 1 }), true)
  await wait(20)
  assert.equal(botRestarts, 1)

  // ③ 两条路都没有 → false（调用方据此改回「请手动重启 Bot 生效」）
  assert.equal(await scheduleRestart(e, { load: async () => null, bot: undefined, delay: 1 }), false)

  // ④ 共享类失败（如 redis 写不进）→ 不冒泡（定时器里抛错会打死宿主进程），且回落裸重启
  let fallbackRestarts = 0
  class Boom { async restart() { throw new Error('restart failed') } }
  assert.equal(
    await scheduleRestart(e, { load: async () => Boom, bot: { restart: () => { fallbackRestarts++ } }, delay: 1 }),
    true,
  )
  await wait(20)
  assert.equal(fallbackRestarts, 1)

  // ⑤ 连回落也没有 → 静默吞掉（此时已无路可走，不能把宿主炸了）
  assert.equal(await scheduleRestart(e, { load: async () => Boom, bot: undefined, delay: 1 }), true)
  await wait(20)
})

test('loadSharedRestart：宿主没有该模块时不抛错（退回裸重启）', async () => {
  // 单测环境里 `plugins/other/restart.js` 依赖宿主全局与宿主 config，通常加载不起来；
  // 本用例只锁「不抛错」这一条契约——拿到类或 null 都算合格，抛错就是 bug
  const Restart = await loadSharedRestart()
  assert.ok(Restart === null || typeof Restart === 'function', `应为类或 null，实得 ${Restart}`)
})

test('gitErrText：中文分流（冲突/网络/未知）', () => {
  const inst = new MaiManage()
  assert.match(inst.gitErrText(new Error('CONFLICT content')), /本地改动冲突/)
  assert.match(inst.gitErrText(new Error('Failed to connect to github.com')), /连接远程仓库失败/)
  assert.match(inst.gitErrText(new Error('cannot pull without a remote')), /git 仓库\/远程异常/)
  assert.match(inst.gitErrText(new Error('some random error')), /some random error/)
})

test('gitErrText：空远端（资源推送前的首跑路径）给专门引导', () => {
  const inst = new MaiManage()
  // git 对空仓库的两种报法（fetch 与 clone --branch）
  for (const msg of ["fatal: couldn't find remote ref main",
    'fatal: Remote branch main not found in upstream origin',
    'warning: You appear to have cloned an empty repository.']) {
    assert.match(inst.gitErrText(new Error(msg)), /还没有 main 分支/, `应识别：${msg}`)
  }
})

test('gitErrText：主体不同则补救建议不同（插件可强制更新，资源包只能换源）', () => {
  const inst = new MaiManage()
  const netErr = new Error('Failed to connect to github.com')
  assert.match(inst.gitErrText(netErr), /插件更新失败/)
  assert.match(inst.gitErrText(netErr), /强制更新/)
  assert.match(inst.gitErrText(netErr, '资源包'), /资源包更新失败/)
  assert.match(inst.gitErrText(netErr, '资源包'), /assetsRepo 改填代理前缀地址/)
  assert.doesNotMatch(inst.gitErrText(netErr, '资源包'), /强制更新/)
})

/** 造一个带历史提交的插件仓库（模拟「更新后」的 HEAD 状态），返回首提交短 hash */
function seededRepo(root) {
  const repo = path.join(root, 'plugin')
  fs.mkdirSync(repo, { recursive: true })
  git(['init', repo], repo)
  const commit = message => {
    fs.writeFileSync(path.join(repo, 'f.txt'), String(Math.random()))
    git(['add', '-A'], repo)
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', message], repo)
  }
  commit('init')
  const first = git(['rev-parse', '--short', 'HEAD'], repo).trim()
  return { repo, first, commit }
}

test('commitLogs：新提交未带 √/✓ 标记 ⇒ 返回 true（需重启）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-manage-log-'))
  const { repo, first, commit } = seededRepo(root)
  commit('修复某命令逻辑')

  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  const e = { reply: async () => {} }

  assert.equal(await inst.commitLogs(first, e, repo), true, '存在未标记提交应要求重启')
  assert.match(replies.join('\n'), /更新日志，共 1 条/)
  assert.match(replies.join('\n'), /修复某命令逻辑/)
})

test('commitLogs：新提交全带 √ 标记 ⇒ 返回 false（热更即可）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-manage-log-'))
  const { repo, first, commit } = seededRepo(root)
  commit('更新曲库数据 √')

  const inst = new MaiManage()
  inst.reply = async () => {}
  assert.equal(await inst.commitLogs(first, { reply: async () => {} }, repo), false)
})

test('commitLogs：oldCommit 之后无新提交 ⇒ 不发日志、返回 false', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-manage-log-'))
  const { repo, first } = seededRepo(root)

  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  assert.equal(await inst.commitLogs(first, { reply: async () => {} }, repo), false)
  assert.equal(replies.length, 0, '无新提交不应发任何日志')
})
