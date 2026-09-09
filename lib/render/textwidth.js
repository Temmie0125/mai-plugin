/**
 * 半角宽度度量（源 core/image/base.py get_char_width/coloum_width/change_column_width 直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。用于标题/曲师截断点，与源逐字符一致。
 */

const WIDTHS = [
  [126, 1], [159, 0], [687, 1], [710, 0], [711, 1], [727, 0], [733, 1], [879, 0],
  [1154, 1], [1161, 0], [4347, 1], [4447, 2], [7467, 1], [7521, 0], [8369, 1],
  [8426, 0], [9000, 1], [9002, 2], [11021, 1], [12350, 2], [12351, 1], [12438, 2],
  [12442, 0], [19893, 2], [19967, 1], [55203, 2], [63743, 1], [64106, 2], [65039, 1],
  [65059, 0], [65131, 2], [65279, 1], [65376, 2], [65500, 1], [65510, 2],
  [120831, 1], [262141, 2], [1114109, 1],
]

export function getCharWidth(o) {
  if (o === 0x0e || o === 0x0f) return 0
  for (const [num, wid] of WIDTHS) {
    if (o <= num) return wid
  }
  return 1
}

export function coloumWidth(s) {
  let res = 0
  for (const ch of String(s)) res += getCharWidth(ch.codePointAt(0))
  return res
}

export function changeColumnWidth(s, len) {
  let res = 0
  const list = []
  for (const ch of String(s)) {
    res += getCharWidth(ch.codePointAt(0))
    if (res <= len) list.push(ch)
  }
  return list.join('')
}

/** Python str(float) 语义（13.0→"13.0"，13.5→"13.5"），定数/拟合值显示用 */
export function pyFloat(v) {
  const n = Number(v)
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n)
}

/** Python round(x, 2) + str 语义（12.3033→"12.3"，5.0→"5.0"） */
export function pyRound2(v) {
  const r = parseFloat((Number(v)).toFixed(2))
  return Number.isInteger(r) ? r.toFixed(1) : String(r)
}

/**
 * 数值显示：整值浮点不打印 .0（135.0→"135"，13.5→"13.5"）。
 * 仅供 BPM 展示用（P1 验收确认的观感优化）；定数等沿用 pyFloat 保持 Python 语义
 */
export function fmtNum(v) {
  const n = Number(v)
  if (Number.isFinite(n) && Math.abs(n) < 1e21) return String(n)
  return String(v)
}
