/**
 * 开字母板面（纯函数，参照 phi-plugin `apps/guessGame/letterGameUtils.js`）
 *
 * 判定表的来源见 `resources/info/letterKeys.json` 的 `_note`：开发期用 pinyin-pro 生成后入库，
 * **运行时零依赖**。表外字符不会报错，只是那个字开不出来（只能整题猜）。
 */
import letterKeys from '../resources/info/letterKeys.json' with { type: 'json' }

/**
 * 隐藏位哨兵（区分「尚未翻开」与标题里本来就存在的 `*`）
 * phi 用同款思路（U+E000 私用区）；板面渲染时再换成 `*`。
 */
export const HIDDEN = '\uE000'
/** 板面上隐藏位的显示字符 */
export const HIDDEN_MARK = '*'

const CJK = /[一-鿿]/
/** 半角与全角空格都不遮（曲名里的空格本就是分隔，遮了反而看不出结构） */
const SPACES = new Set([' ', '　'])

/**
 * 归一判定表（可注入，便于单测）
 * 缺表/表坏 ⇒ 空表 ⇒ 汉字与假名只能靠字面匹配（降级，不抛错）
 */
export function resolveKeys(raw = letterKeys) {
  const pick = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  return { hanzi: pick(raw?.hanzi), kana: pick(raw?.kana) }
}

/** 加密曲名：非空格字符全部换成隐藏哨兵 */
export function encrypt(name) {
  return Array.from(String(name ?? ''), ch => (SPACES.has(ch) ? ch : HIDDEN)).join('')
}

/** 该字符接受的罗马字首字母（多字母如 `jz` 表示 ji / zi 都收）；null = 表内无此字 */
export function initialOf(ch, keys) {
  const table = CJK.test(ch) ? keys.hanzi : keys.kana
  const v = table[ch]
  return v == null || v === '' ? null : String(v).toLowerCase()
}

/** 是否还有未翻开的位 */
export function hasHidden(blur) {
  return String(blur ?? '').includes(HIDDEN)
}

/**
 * 按字母翻开：逐位判定，命中则把该位从哨兵换成真字符
 *
 * 判定优先级（照 phi 的 `revealCharacter` + 假名扩展）：
 * ① 汉字 → 比拼音首字母；② 假名 → 比罗马字首字母；③ 其余 → 比字面（大小写不敏感）
 * @returns {string} 新的遮罩；与入参相同表示这一位都没命中
 */
export function revealIn(songName, blur, letter, keys) {
  const target = String(letter ?? '').toLowerCase()
  if (!target) return blur
  const song = Array.from(String(songName ?? ''))
  const mask = Array.from(String(blur ?? ''))
  return song.map((ch, i) => {
    const cur = mask[i] ?? HIDDEN
    if (cur !== HIDDEN) return cur // 已翻开/空格：原样保留
    const initials = initialOf(ch, keys)
    if (initials != null && initials.includes(target)) return ch
    return ch.toLowerCase() === target ? ch : cur
  }).join('')
}

/** 该曲名里是否存在可被 letter 翻开的字（用于判「这几首曲目中不包含字母 X」） */
export function containsLetter(songName, letter, keys) {
  const target = String(letter ?? '').toLowerCase()
  if (!target) return false
  return Array.from(String(songName ?? '')).some(ch => {
    const initials = initialOf(ch, keys)
    if (initials != null && initials.includes(target)) return true
    return ch.toLowerCase() === target
  })
}

/** 该行是否已完全揭开 */
export function isRowSolved(row) {
  return row.blur === null || !hasHidden(row.blur)
}

/**
 * 收集所有仍隐藏的**字符**（随机提示的候选池）
 *
 * 与 phi 的 `getRevealCandidates` 同口径：**重复保留**——每个隐藏位等概率，
 * 于是长曲名（隐藏位多）更容易被随机提示翻到，符合「谁难谁多给点提示」的直觉。
 * @returns {string[]} 隐藏位的真实字符
 */
export function revealCandidates(game) {
  const out = []
  for (const row of game.rows) {
    if (isRowSolved(row)) continue
    const song = Array.from(String(row.song.song_name ?? ''))
    const mask = Array.from(String(row.blur ?? ''))
    mask.forEach((ch, i) => {
      if (ch === HIDDEN && song[i] !== undefined) out.push(song[i])
    })
  }
  return out
}

/** 是否全部行都已揭开 */
export function allSolved(game) {
  return game.rows.every(isRowSolved)
}

/**
 * 渲染板面（纯文本；宿主无 markdown 段支持，故不用 phi 的可点击指令）
 * 未解出行显示遮罩，已解出行显示曲名 + 猜中者
 */
export function boardText(game) {
  return game.rows
    .map((row, i) => {
      const n = i + 1
      if (isRowSolved(row)) {
        return `${n}. ${row.song.song_name} ✅${row.winner ? ` @${row.winner}` : ''}`
      }
      return `${n}. ${row.blur.replaceAll(HIDDEN, HIDDEN_MARK)}`
    })
    .join('\n')
}

/** 已翻开字母的展示串（排序后空格分隔，如 `A J K`） */
export function openedText(game) {
  return [...game.opened].sort().join(' ')
}
