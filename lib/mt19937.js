/**
 * CPython `random.Random` 的 MT19937 复刻（P3 实施文档 §5.4，D2）
 *
 * 为什么必须逐位复刻：源插件用 `random.Random(fortune_hash).choice(mai.total_list.root)`
 * 选今日推荐曲。若改用 `Math.random()` 或 `hash % len`，同一个人在同一天会得到
 * **与源插件不同**的歌，"同人同日同签"的心智就断了。与 `lib/calc.js` 的 qqhash
 * 同一精神：逐位直译，勿改动否则同人不同签。
 *
 * ⚠️ 文档 §5.4 括注「seed 为单整数时走 init_genrand」**是错的**：CPython 对整数种子
 * 一律走 `init_by_array`（`_randommodule.c: random_seed` → 取 abs(seed) 的小端 32 位字数组）。
 * 已用 venv 里的 CPython 3.11.5 实测：init_genrand 的结果与 `random.Random(seed)` 全不符，
 * init_by_array 全符（见 tests/mt19937.test.js 的对照值表）。
 *
 * 对照值来源：`tests/refs/gen_mt19937_ref.py`（用本机 CPython 生成，勿手改）。
 */

const N = 624
const M = 397
const MATRIX_A = 0x9908b0df
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff

/** genrand 的 32 位输出上限内才走快路径（生产只用 choice(列表)，n 远小于此） */
const MAX_RANDBELOW = 0xffffffff

/** `lib/calc.js` 的 qqhash 可能超过 2^32，故整数种子用 BigInt 拆字 */
function keyFromInt(seed) {
  let n = BigInt(seed)
  if (n < 0n) n = -n
  const words = []
  while (n > 0n) {
    words.push(Number(n & 0xffffffffn))
    n >>= 32n
  }
  return words.length ? words : [0]
}

/** init_genrand：仅作 init_by_array 的初始状态使用（CPython 对整数种子不直接走它） */
function initGenrand(seed) {
  const mt = new Uint32Array(N)
  mt[0] = seed >>> 0
  for (let i = 1; i < N; i++) {
    mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0
  }
  return mt
}

/** init_by_array：CPython 整数种子的实际播种路径 */
function initByArray(key) {
  const mt = initGenrand(19650218)
  let i = 1
  let j = 0
  for (let k = Math.max(N, key.length); k > 0; k--) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0
    i++
    j++
    if (i >= N) { mt[0] = mt[N - 1]; i = 1 }
    if (j >= key.length) j = 0
  }
  for (let k = N - 1; k > 0; k--) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0
    i++
    if (i >= N) { mt[0] = mt[N - 1]; i = 1 }
  }
  mt[0] = 0x80000000
  return mt
}

/** 32 位整数的位长（Python `int.bit_length()` 的 n ≥ 1 版本） */
const bitLength = n => 32 - Math.clz32(n)

/**
 * 与 CPython `random.Random(int)` 行为一致的确定性随机源
 */
export class PyRandom {
  /** @param {number} seed 整数种子（CPython 口径：取绝对值拆小端 32 位字后 init_by_array） */
  constructor(seed) {
    if (!Number.isInteger(seed)) {
      throw new TypeError(`PyRandom 种子必须是整数（收到 ${typeof seed}）`)
    }
    this.mt = initByArray(keyFromInt(seed))
    this.index = N
  }

  /** genrand 一步（melange + temper），等价源 C 的 genrand_uint32 */
  genrandUint32() {
    if (this.index >= N) {
      for (let k = 0; k < N; k++) {
        const y = (this.mt[k] & UPPER_MASK) | (this.mt[(k + 1) % N] & LOWER_MASK)
        this.mt[k] = this.mt[(k + M) % N] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)
      }
      this.index = 0
    }
    let y = this.mt[this.index++]
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    return (y ^ (y >>> 18)) >>> 0
  }

  /**
   * `random.getrandbits(k)`：k ≤ 32 走 `genrand() >> (32-k)`（丢低位）；
   * k > 32 按 CPython 逐字填充（每字 k 递减，最后一字同样丢低位）。
   * @returns {number|bigint} k ≤ 32 返回 Number；k > 32 返回 BigInt（超过 2^53，Number 无法精确表示）
   */
  getrandbits(k) {
    if (!Number.isInteger(k) || k <= 0) throw new RangeError(`getrandbits 需要正整数 k（收到 ${k}）`)
    if (k <= 32) return this.genrandUint32() >>> (32 - k)

    const words = Math.floor((k - 1) / 32) + 1
    let result = 0n
    let remain = k
    for (let i = 0; i < words; i++) {
      let r = this.genrandUint32()
      if (remain < 32) r >>>= (32 - remain)
      result |= BigInt(r) << BigInt(32 * i)
      remain -= 32
    }
    return result
  }

  /**
   * `random.Random._randbelow`（getrandbits 版）：k = n.bit_length()，拒绝采样到 < n
   * @param {number} n 上界（独占），须 < 2^32
   */
  randbelow(n) {
    if (!Number.isInteger(n) || n <= 0 || n > MAX_RANDBELOW) {
      throw new RangeError(`randbelow 需要 1 ≤ n ≤ 2^32-1（收到 ${n}）`)
    }
    const k = bitLength(n)
    let r = this.getrandbits(k)
    while (r >= n) r = this.getrandbits(k)
    return r
  }

  /** `random.Random.choice(seq)` */
  choice(seq) {
    if (!seq || !seq.length) throw new RangeError('Cannot choose from an empty sequence')
    return seq[this.randbelow(seq.length)]
  }
}

/** 便捷入口：一次性的 `random.Random(seed).choice(seq)`（源侧今日推荐曲的调用形态） */
export function pyChoice(seed, seq) {
  return new PyRandom(seed).choice(seq)
}
