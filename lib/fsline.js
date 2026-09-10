/**
 * 单曲分数线四表（复用用户提供的样板 `分数线成图(prism_plus).html` 的计算代码）
 *
 * 样板里那四段 `<script>` 是**唯一规格**：它的 markup 数值与自身物量对不上
 * （按脚本公式 TAP GREAT 应为 `-0.01140%`，markup 却标着 `-0.01450%`——上一次渲染的残留），
 * 故端口不抄 markup，而是逐行移植脚本，并用**真跑样板抓到的输出**锁死
 * （见 `tests/refs/gen-fsline-ref.mjs` 与 `tests/refs/fsline_ref.json`）。
 *
 * ⚠️ 取整口径必须逐字照搬：`ceil5` 的 `Math.ceil(v*100000)/100000`、展示用的
 * `toFixed(5)` / `toFixed(4)`——差一位小数就对不上样板。
 *
 * 四张表全部**只由物量推出**，与「目标达成率」无关（后者在本仓只用于附加的那行文本）。
 */

/** 单音符基础分（样板 `T_B`/`MTP`） */
export const T_B = 500
export const MTP = { tap: 1, hold: 2, slide: 3, touch: 1, break: 5 }

export const S_TAP = T_B * MTP.tap // 500
export const S_HOLD = T_B * MTP.hold // 1000
export const S_SLIDE = T_B * MTP.slide // 1500
export const S_TOUCH = T_B * MTP.touch // 500
export const S_BREAK = T_B * MTP.break // 2500

/** 普通音符扣分率（样板 LOSS_NORMAL） */
export const LOSS_NORMAL = { perfect: 0, great: 0.2, good: 0.5, miss: 1.0 }
/** BREAK 扣分率（样板 LOSS_BREAK；按分数线档位分四档 GREAT） */
export const LOSS_BREAK = { perfect: 0, great_40: 0.2, great_30: 0.4, great_25: 0.5, good: 0.6, miss: 1.0 }

/** DX 等级七档（样板 tiers；label 用于左侧图标/文字） */
export const DX_TIERS = [
  { label: '99%', rate: 0.99 },
  { label: '98%', rate: 0.98 },
  { label: '5', rate: 0.97 },
  { label: '4', rate: 0.95 },
  { label: '3', rate: 0.93 },
  { label: '2', rate: 0.90 },
  { label: '1', rate: 0.85 },
]

/** 目标评级七档（样板 tiers，列序即徽章序 SSSp/SSS/SSp/SS/Sp/S/A） */
export const RATING_TIERS = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 21.0]

/** BREAK 等效数量表的列标签（样板列序） */
export const EQUIV_LABELS = ['p75', 'p50', 'great40', 'great30', 'great25', 'good', 'miss']

/** 样板 `ceil5`：向上取整到 5 位小数 */
export function ceil5(value) {
  return Math.ceil(value * 100000) / 100000
}

/** 样板 `fmt`：`-0.01140%` */
export function fmtPct(value) {
  return `-${value.toFixed(5)}%`
}

/**
 * 四张表的全部数值
 * @param {{tap:number, hold:number, slide:number, touch:number, break:number}} counts
 */
export function computeFsline(counts) {
  const c = {
    tap: Math.trunc(counts?.tap ?? 0),
    hold: Math.trunc(counts?.hold ?? 0),
    slide: Math.trunc(counts?.slide ?? 0),
    touch: Math.trunc(counts?.touch ?? 0),
    break: Math.trunc(counts?.break ?? 0),
  }
  const total = c.tap + c.hold + c.slide + c.touch + c.break

  const totalS = c.tap * S_TAP + c.hold * S_HOLD + c.slide * S_SLIDE + c.touch * S_TOUCH + c.break * S_BREAK
  const totalExS = c.break * 100
  // 样板 `DX_MAX = 3 * totalNotes`（totalNotes 即五项个数之和）
  const dxMax = 3 * total

  /** 单次扣分（%，向上取整到 5 位小数）——样板 lossPercent */
  const lossPercent = (baseScore, lossRate) => ceil5(baseScore * lossRate / totalS * 100)
  /** BREAK 的 BA 部分（与 lossPercent 同式，样板单列一份） */
  const lossBA = lossRate => ceil5(S_BREAK * lossRate / totalS * 100)
  /** BREAK 的额外扣分；**brk=0 时样板显式返回 0**（不会出 NaN/Infinity） */
  const lossEA = exLoss => (totalExS === 0 ? 0 : ceil5(exLoss / totalExS))
  const lossTotal = (baRate, exLoss) => ceil5(lossBA(baRate) + lossEA(exLoss))

  // ---- 表 1：分数线（TAP/HOLD/SLIDE/TOUCH × GREAT/GOOD/MISS） ----
  const scoreRows = [
    { name: 'TAP', base: S_TAP },
    { name: 'HOLD', base: S_HOLD },
    { name: 'SLIDE', base: S_SLIDE },
    { name: 'TOUCH', base: S_TOUCH },
  ].map(row => ({
    name: row.name,
    great: fmtPct(lossPercent(row.base, LOSS_NORMAL.great)),
    good: fmtPct(lossPercent(row.base, LOSS_NORMAL.good)),
    miss: fmtPct(lossPercent(row.base, LOSS_NORMAL.miss)),
  }))

  // ---- 表 1 的 BREAK 子表（BA + EA 合计） ----
  const brk = {
    g40: fmtPct(lossTotal(LOSS_BREAK.great_40, 60)),
    g30: fmtPct(lossTotal(LOSS_BREAK.great_30, 60)),
    g25: fmtPct(lossTotal(LOSS_BREAK.great_25, 60)),
    good: fmtPct(lossTotal(LOSS_BREAK.good, 70)),
    miss: fmtPct(lossTotal(LOSS_BREAK.miss, 100)),
    p75: fmtPct(lossEA(25)),
    p50: fmtPct(lossEA(50)),
  }

  // ---- 表 2：DX 等级（x = ceil(DX_MAX*rate)，y = DX_MAX - x） ----
  const dx = DX_TIERS.map(tier => {
    const x = Math.ceil(dxMax * tier.rate)
    const y = dxMax - x
    return { label: tier.label, x, y, text: `${x} (-${y})` }
  })

  // ---- 表 3：目标评级 → 允许最多的 GREAT TAP 数量 ----
  const lossTAPGreat = 10000 / totalS
  const rating = RATING_TIERS.map(rate => ({ rate, n: Math.floor(rate / lossTAPGreat) }))

  // ---- 表 4：BREAK 各判定相当于几个 GREAT TAP ----
  const breakLoss = {
    p75: totalExS > 0 ? 25 / totalExS : 0,
    p50: totalExS > 0 ? 50 / totalExS : 0,
    great40: S_BREAK * LOSS_BREAK.great_40 / totalS * 100 + (totalExS > 0 ? 60 / totalExS : 0),
    great30: S_BREAK * LOSS_BREAK.great_30 / totalS * 100 + (totalExS > 0 ? 60 / totalExS : 0),
    great25: S_BREAK * LOSS_BREAK.great_25 / totalS * 100 + (totalExS > 0 ? 60 / totalExS : 0),
    good: S_BREAK * LOSS_BREAK.good / totalS * 100 + (totalExS > 0 ? 70 / totalExS : 0),
    miss: S_BREAK * LOSS_BREAK.miss / totalS * 100 + (totalExS > 0 ? 100 / totalExS : 0),
  }
  // 样板 equivalent()：未取整的扣分相除、toFixed(4)
  const equiv = EQUIV_LABELS.map(key => ({
    key,
    value: (breakLoss[key] / lossTAPGreat).toFixed(4),
  }))

  return { counts: { ...c, total }, totalS, totalExS, dxMax, scoreRows, brk, dx, rating, equiv }
}
