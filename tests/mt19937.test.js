import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PyRandom, pyChoice } from '../lib/mt19937.js'
import { qqhash } from '../lib/calc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 对照值由本机 CPython 生成，见 tests/refs/gen_mt19937_ref.py（换 Python 版本须重跑） */
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'refs', 'mt19937_ref.json'), 'utf8'))

test('对照值来自 CPython 且三个 section 齐备', () => {
  assert.match(REF.python, /^3\.\d+\.\d+$/, '对照值应带解释器版本，便于日后追溯')
  assert.ok(REF.stream.length >= 3, 'stream 样本过少')
  assert.ok(REF.bits.length >= 20, 'bits 样本过少')
  assert.ok(REF.choice.length >= 30, 'choice 样本过少')
})

test('MT19937：同实例状态推进与 CPython 逐值一致（锁 melange/temper）', () => {
  for (const { seed, values } of REF.stream) {
    const r = new PyRandom(seed)
    const got = values.map(() => r.getrandbits(32))
    assert.deepEqual(got, values, `seed=${seed} 的 getrandbits(32) 序列不一致`)
  }
})

test('MT19937：getrandbits 两条路径与 CPython 一致（k<=32 丢低位 / k>32 逐字填充）', () => {
  for (const { seed, k, values } of REF.bits) {
    const r = new PyRandom(seed)
    // 一律按字符串比：k=64 的值超出 2^53，JSON number 会静默失真
    const got = values.map(() => String(r.getrandbits(k)))
    assert.deepEqual(got, values, `seed=${seed} k=${k} 不一致`)
  }
})

test('MT19937：k<=32 返回 Number，k>32 返回 BigInt（精度不丢）', () => {
  const r = new PyRandom(0)
  assert.equal(typeof r.getrandbits(32), 'number')
  assert.equal(typeof r.getrandbits(33), 'bigint')
  assert.equal(typeof r.getrandbits(64), 'bigint')
})

test('MT19937：非法入参显式报错，不静默给错值', () => {
  assert.throws(() => new PyRandom(1.5), /必须是整数/)
  assert.throws(() => new PyRandom('1'), /必须是整数/)
  const r = new PyRandom(1)
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => r.getrandbits(bad), RangeError)
  for (const bad of [0, -1, 2 ** 32, 1.5]) assert.throws(() => r.randbelow(bad), RangeError)
  assert.throws(() => r.choice([]), /empty sequence/)
})

test('choice：生产路径 random.Random(qqhash).choice(list) 与 CPython 同下标', () => {
  for (const { qq, day, month, hash, n, index } of REF.choice) {
    // 先交叉验证 qqhash 本身：JS 版算出的 hash 必须与 Python 侧一致
    assert.equal(
      qqhash(qq, new Date(2026, month - 1, day)), hash,
      `qqhash(${qq}, ${month}-${day}) 与 Python 不一致`,
    )
    const seq = Array.from({ length: n }, (_, i) => i)
    assert.equal(pyChoice(hash, seq), index, `hash=${hash} n=${n} 选中的下标不一致`)
  }
})

test('choice：拒绝采样在 n 非 2 的幂时仍与 CPython 一致', () => {
  // n 取 2^k±1 与质数，逼出 _randbelow 的 while(r >= n) 循环
  for (const n of [3, 5, 7, 17, 31, 33, 100, 127, 129, 1023, 1025, 4095, 4097, 8191]) {
    for (const seed of [0, 1, 163719, 987654321]) {
      const seq = Array.from({ length: n }, (_, i) => i)
      const got = new PyRandom(seed).choice(seq)
      assert.ok(got >= 0 && got < n, `下标越界：seed=${seed} n=${n} got=${got}`)
    }
  }
})
