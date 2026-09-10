import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import Config from '../lib/config.js'
import { planSync, syncAssets, assetsRepoUrl, DEFAULT_ASSETS_REPO } from '../lib/resourcePack.js'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mai-res-${tag}-`))
}

/** file:// 形式的本地远端地址（--depth 只对非本地协议生效，故不能直接用路径） */
const fileUrl = p => `file:///${p.replace(/\\/g, '/')}`

/**
 * 造一个「远端」：裸库 + 工作库。裸库 HEAD 显式指向 main（等价 GitHub 默认分支），
 * 否则 clone 会落在不存在的 master 上、拿不到检出内容。commit() 提交并推送到 main。
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
    // 提交身份用 -c 内联，不依赖机器上的 git 全局配置
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', message], work)
    git(['push', '-q', remote, 'HEAD:main'], work)
  }

  return { remote, work, commit }
}

/**
 * 临时把 assetsRepo 设为 value 跑一段。只覆盖 Config 的内存缓存，**不写用户 yaml**——
 * tests/*.test.js 由 node --test 多进程并行，各文件同写 config/config/config.yaml 会互相覆盖并留下残留。
 * fn 可为 async：必须 await 其返回值，否则 finally 会在首个 await 处就还原配置。
 */
async function withAssetsRepo(value, fn) {
  try {
    Config.config.config = { ...Config.getConfig('config'), assetsRepo: value }
    return await fn()
  } finally {
    delete Config.config.config // 丢弃缓存，下次读取回落到磁盘上的真实用户配置
  }
}

test('planSync：有 .git → update，非空无 .git → adopt，空/不存在 → clone', () => {
  const root = tmpdir('plan')

  assert.equal(planSync(path.join(root, 'nope')), 'clone', '目录不存在应克隆')

  const empty = path.join(root, 'empty')
  fs.mkdirSync(empty)
  assert.equal(planSync(empty), 'clone', '空目录应克隆')

  const legacy = path.join(root, 'legacy')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'echarts.min.js'), 'x')
  assert.equal(planSync(legacy), 'adopt', '手工复制来的资源包应就地收编')

  fs.mkdirSync(path.join(legacy, '.git'))
  assert.equal(planSync(legacy), 'update', '已是 git 仓库应走更新')
})

test('assetsRepoUrl：配置留空回退出厂默认，配置值优先且去空白', async () => {
  assert.equal(assetsRepoUrl(), DEFAULT_ASSETS_REPO, '默认即为出厂地址')

  await withAssetsRepo('', () => {
    assert.equal(assetsRepoUrl(), DEFAULT_ASSETS_REPO, '留空应回退')
  })
  await withAssetsRepo('   ', () => {
    assert.equal(assetsRepoUrl(), DEFAULT_ASSETS_REPO, '纯空白应回退')
  })
  await withAssetsRepo('  https://example.com/mirror.git  ', () => {
    assert.equal(assetsRepoUrl(), 'https://example.com/mirror.git', '自定义地址应生效并去空白')
  })

  assert.equal(assetsRepoUrl(), DEFAULT_ASSETS_REPO, '助手退出后应已还原')
})

test('syncAssets：clone → 幂等 → 远端追加提交后命中变更', async () => {
  const root = tmpdir('e2e')
  const { remote, commit } = makeRemote(root)
  commit('init', { 'mai/cover/1.png': 'png1', 'COPYRIGHT.txt': 'c' })

  const target = path.join(root, 'static')
  await withAssetsRepo(fileUrl(remote), async () => {
    const first = await syncAssets({ dir: target })
    assert.equal(first.action, 'clone')
    assert.equal(first.empty, false)
    assert.equal(first.changed, true)
    assert.equal(first.covers.after, 1, '应按目标目录（而非线上 static）统计曲绘')
    assert.ok(fs.existsSync(path.join(target, 'mai', 'cover', '1.png')))

    const again = await syncAssets({ dir: target })
    assert.equal(again.action, 'update')
    assert.equal(again.changed, false, '重复执行不应产生变更')

    commit('add cover 2', { 'mai/cover/2.png': 'png2' })
    const third = await syncAssets({ dir: target })
    assert.equal(third.changed, true)
    assert.equal(third.covers.before, 1)
    assert.equal(third.covers.after, 2)
    assert.ok(fs.existsSync(path.join(target, 'mai', 'cover', '2.png')))
  })
})

test('syncAssets：就地收编保留本地 data/（迁移用户 user.db 不被删）', async () => {
  const root = tmpdir('adopt')
  const { remote, commit } = makeRemote(root)
  commit('init', { 'mai/cover/1.png': 'remote' })

  // 模拟用户按 README 手工复制进来的 NoneBot 资源包
  const target = path.join(root, 'static')
  fs.mkdirSync(path.join(target, 'mai', 'cover'), { recursive: true })
  fs.writeFileSync(path.join(target, 'mai', 'cover', '1.png'), 'stale')
  fs.mkdirSync(path.join(target, 'data'), { recursive: true })
  fs.writeFileSync(path.join(target, 'data', 'user.db'), 'PRECIOUS')

  await withAssetsRepo(fileUrl(remote), async () => {
    const r = await syncAssets({ dir: target })
    assert.equal(r.action, 'adopt')
    assert.equal(r.changed, true)
    assert.equal(fs.readFileSync(path.join(target, 'mai', 'cover', '1.png'), 'utf8'), 'remote', '受管文件应对齐远端')
    assert.equal(fs.readFileSync(path.join(target, 'data', 'user.db'), 'utf8'), 'PRECIOUS', '未受管的本地数据不得被清')
  })
})

test('syncAssets：远端为空时 clone 不抛错而标记 empty，再次执行报无可拉分支', async () => {
  const root = tmpdir('empty')
  const remote = path.join(root, 'empty.git')
  git(['init', '--bare', remote])
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)

  const target = path.join(root, 'static')
  await withAssetsRepo(fileUrl(remote), async () => {
    const r = await syncAssets({ dir: target })
    assert.equal(r.action, 'clone')
    assert.equal(r.empty, true, '远端无内容应标记 empty 而非报错')
    assert.equal(r.changed, false)

    // 用户推送资源前若再次执行：走 update 分支，git 报 could not find remote ref
    await assert.rejects(
      () => syncAssets({ dir: target }),
      /couldn't find remote ref|not found/i,
      '空远端二次执行应抛出可被 gitErrText 识别为「还没有 main 分支」的错误',
    )
  })
})
