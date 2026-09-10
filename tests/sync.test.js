import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import { mai } from '../lib/service.js'
import { syncMusicData, isSyncing } from '../lib/sync.js'

test('writeJsonAtomic：先写 .tmp 再 rename，成功后不残留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-json-'))
  const file = path.join(dir, 'cache.json')

  writeJsonAtomic(file, { ok: 1 })
  assert.deepEqual(readJson(file), { ok: 1 })
  assert.equal(fs.existsSync(`${file}.tmp`), false, '落盘后不应残留 .tmp')

  writeJsonAtomic(file, { ok: 2 })
  assert.deepEqual(readJson(file), { ok: 2 }, '同卷 rename 应能覆盖已存在文件')
})

test('writeJsonAtomic：写入失败时目标文件原封不动（原子替换，不留半文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-json-'))
  const file = path.join(dir, 'cache.json')
  writeJsonAtomic(file, { ok: 'good' })
  const before = fs.readFileSync(file, 'utf8')

  // 把 <file>.tmp 占成一个目录 ⇒ 原子实现必然在「写临时文件」这一步失败。
  // 若哪天有人把它改回直接写目标文件，这里的目标文件会被覆盖/截断，断言随即失败——
  // 这正是 P3 §3.4-1 要防的「被宿主重启打断留下截断 JSON」。
  fs.mkdirSync(`${file}.tmp`)
  assert.throws(() => writeJsonAtomic(file, { ok: 'bad' }))
  assert.equal(fs.readFileSync(file, 'utf8'), before, '失败写入不得触碰目标文件')
})

test('readJson：缺失/空白/损坏文件回退 fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-json-'))
  assert.equal(readJson(path.join(dir, 'nope.json'), 'FB'), 'FB')

  const blank = path.join(dir, 'blank.json')
  fs.writeFileSync(blank, '   ')
  assert.equal(readJson(blank, 'FB'), 'FB', '空白文件应回退')

  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{"a":')
  assert.equal(readJson(broken, 'FB'), 'FB', '截断的 JSON 应回退而非抛出')
})

test('syncMusicData：并发第二次直接跳过，结束后释放锁', async () => {
  const original = mai.update
  let calls = 0
  let release
  mai.update = () => {
    calls++
    return new Promise(resolve => { release = resolve })
  }
  try {
    const first = syncMusicData()
    assert.equal(isSyncing(), true, '进行中应持锁')

    const second = await syncMusicData()
    assert.deepEqual(second, { busy: true }, '并发第二次应跳过')
    assert.equal(calls, 1, '第二次不得再触发实际同步')

    release()
    assert.deepEqual(await first, { busy: false })
    assert.equal(isSyncing(), false, '结束后应释放锁')

    mai.update = async () => { calls++ }
    assert.deepEqual(await syncMusicData(), { busy: false }, '释放后应可再次同步')
    assert.equal(calls, 2)
  } finally {
    mai.update = original
  }
})

test('syncMusicData：失败向上抛，且锁必须释放', async () => {
  const original = mai.update
  mai.update = async () => { throw new Error('网络不通') }
  try {
    await assert.rejects(() => syncMusicData(), /网络不通/)
    assert.equal(isSyncing(), false, '失败后若不释放锁，定时任务将永远跳过')
  } finally {
    mai.update = original
  }
})
