/**
 * 随心配 b50 变体解析（设计《b50扩展实现设计.md》§3 / §4.3）
 *
 * 职责：**命令文本 → 变体规格**。纯函数、零 I/O（谱师别名表由调用方注入，见 designerAliasMap）：
 * 曲库/网络都不碰，故可离线单测。
 *
 * 本文件是变体的**唯一声明处**，三处消费同一份规格：
 *   ① `variantTokens()` → apps/score.js 的规则正则白名单；
 *   ② `resolveVariant()` → 解析；
 *   ③ `variantHelp()` → 随心配专题帮助图。
 * 三者的关系由 tests/variantSpec.test.js 锁定（白名单↔解析器双向一致）。
 *
 * ⚠️ 判定式的口径细节（寸/锁 的 0.05 边界、单刷/拼机的互补、FC 不含 AP…）见设计 §4.3，
 *    改动前请先回读那一节与 §0.1 的决策表。
 */
import {
  ACHIEVEMENT_LIST, CATEGORY, LEVEL_LIST, PLATE_CN, RANK_PLUS, RANK_SP, VERSION_CHARS, VERSION_MAP,
} from './constants.js'
import { computeRating } from './calc.js'
import designerAlias from '../resources/info/designer_alias.json' with { type: 'json' }

// =====================================================================
// 同步（拼机）族取值 —— 口径见设计 §4.3「Sync 家族的取值与划分」
// =====================================================================

/** Full Sync 族（fs / fs+） */
const SYNC_FS_ALL = ['fs', 'fsp']
/** Full Sync+（单独一档，与 FC+50 对称，不进帮助图） */
const SYNC_FS_PLUS = ['fsp']
/** Full Sync DX 族：后两个写法见 lib/tableData.js PLAN_CRITERIA 舞舞（上游判据里出现过） */
const SYNC_FSD_BASE = ['fsd', 'fdx', 'fsdpx']
const SYNC_FSD_PLUS = ['fsdp', 'fdxp', 'fsdp+']
const SYNC_FSD_ALL = [...SYNC_FSD_BASE, ...SYNC_FSD_PLUS]

// =====================================================================
// 评级（RANK_SP 键）—— 档位阈值与「寸/锁」边界
// =====================================================================

/** 社区中文叫法 → RANK_SP 键 */
const RANK_CN = { 鸟加: 'sssp', '鸟+': 'sssp', 鸟家: 'sssp', 鸟: 'sss' }

/**
 * 用户输入的评级字 → `RANK_SP` 键（'sss+'→'sssp'、'鸟'→'sss'）
 * @returns {string|null} 无法识别返回 null
 */
export function normalizeRank(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null
  if (RANK_CN[t]) return RANK_CN[t]
  const k = t.toLowerCase()
  if (RANK_SP.includes(k)) return k
  // RANK_PLUS 与 RANK_SP 下标对齐（'s+'→'sp'、'sss+'→'sssp'）
  const i = RANK_PLUS.indexOf(k)
  return i >= 0 ? RANK_SP[i] : null
}

/** 达成率 → 评级键（calc.js 返回展示名，lower 后即 RANK_SP 形态） */
const rankOf = ach => computeRating(0, ach, { onlyrate: true }).toLowerCase()

/** 该评级的起算线：d 档无起算线（记 0） */
const rankStart = key => {
  const i = RANK_SP.indexOf(key)
  return i <= 0 ? 0 : ACHIEVEMENT_LIST[i - 1]
}

/** 无评级形态：距**下一**档位（无下一档 → null） */
const nextThr = ach => ACHIEVEMENT_LIST.find(t => t > ach) ?? null
/** 无评级形态：距**上一**档位（低于首档 → null） */
const prevThr = ach => {
  let p = null
  for (const t of ACHIEVEMENT_LIST) if (t <= ach) p = t
  return p
}

/** 寸：距下一档 ≤0.05%（**含** 0.05，见 V11） */
const isCun = r => {
  const n = nextThr(r.achievements)
  return n != null && n - r.achievements <= 0.05
}
/** 锁：距上一档 ≤0.05%（**含** 0.05，见 V11） */
const isSuo = r => {
  const p = prevThr(r.achievements)
  return p != null && r.achievements - p <= 0.05
}

// =====================================================================
// 分类 / 类型 / 难度 / 版本
// =====================================================================

/** 分类别名 → `CATEGORY` 图标名（与出图图标同源，故归类口径不会与图面打架） */
export const CATEGORY_ALIAS = {
  舞萌: 'maimai', maimai: 'maimai',
  vocaloid: 'niconico', v家: 'niconico', 术力口: 'niconico', ボカロ: 'niconico', niconico: 'niconico',
  东方: 'touhou', 车万: 'touhou',
  流行: 'anime', 动漫: 'anime', 二次元: 'anime',
  音击中二: 'ongeki', 音击: 'ongeki', 中二: 'ongeki',
  其他游戏: 'game', variety: 'game',
}

/** 图标名 → 该分类下的 genre 集合（由 constants.CATEGORY 反查；宴会场排除） */
const GENRE_BY_ICON = (() => {
  const m = new Map()
  for (const [genre, icon] of Object.entries(CATEGORY)) {
    if (icon === '宴会场') continue
    if (!m.has(icon)) m.set(icon, new Set())
    m.get(icon).add(genre)
  }
  return m
})()

/** 分类图标名 → 帮助图里用的中文名（也是图上副标题的前缀） */
const ICON_LABEL = {
  maimai: '舞萌', niconico: 'v家', touhou: '东方', anime: '流行',
  ongeki: '音击中二', game: '其他游戏',
}

/** 类型别名 → 'SD' | 'DX' */
const TYPE_ALIAS = { dx: 'DX', sd: 'SD', 标准: 'SD', 旧框: 'SD' }

/** 难度色（顺序即 level_index：绿0 黄1 红2 紫3 白4） */
export const DIFF_COLORS = '绿黄红紫白'

/** 版本 token（可带「代」后缀）→ { key, label, versions }；versions 为 version_str 集合 */
export function resolveVersion(raw) {
  let t = String(raw ?? '').trim()
  if (t.endsWith('代')) t = t.slice(0, -1)
  if (t === '真超檄') {
    return {
      key: 'version-tri', label: '真超檄',
      versions: [...VERSION_MAP['真'][0], ...VERSION_MAP['超'][0], ...VERSION_MAP['檄'][0]],
    }
  }
  if (t.length !== 1 || !VERSION_CHARS.includes(t)) return null
  const k = PLATE_CN[t] ?? t
  const entry = VERSION_MAP[k]
  if (!entry) return null
  return { key: `version-${k}`, label: t, versions: entry[0] }
}

/** 时间词 → 迁移引导的目标命令（设计 §8.3：时间类已整族移出 b50） */
export const TIME_ALIAS = {
  新歌: '新歌', 新曲: '新歌', 旧版本: '旧版本', 旧歌: '旧版本', 老歌: '旧版本',
}

/** 该 token 是否是时间词（apps 层据此回迁移引导，而不是当作谱师名） */
export function isTimeKeyword(token) {
  return Object.prototype.hasOwnProperty.call(TIME_ALIAS, String(token ?? '').trim())
}

// =====================================================================
// 分数列表族的关键词（理论 / 新歌 / 旧版本）
// =====================================================================

/**
 * 列表关键词 → 列表预设键（apps/table.js 的命令规则与 apps/score.js 的迁移引导**共用这一份**）
 * 预设键对应 lib/handler.js 的 LIST_PRESETS。
 */
export const LIST_KEY_ALIAS = {
  理论: 'theory', 'ap+': 'theory', ap: 'theory',
  新歌: 'new', 新曲: 'new',
  旧版本: 'old', 旧歌: 'old', 老歌: 'old',
}

/** 列表关键词的正则交替串（含 ASCII 大小写折叠；数字仍归既有 REG_LIST，两者天然互斥） */
export function listKeyPattern() {
  return Object.keys(LIST_KEY_ALIAS)
    .sort((a, b) => b.length - a.length)
    .map(t => foldCase(escapeRe(t)))
    .join('|')
}

/** 关键词 → 预设键（大小写不敏感；无法识别返回 null） */
export function listPresetOf(token) {
  const t = String(token ?? '').trim()
  return LIST_KEY_ALIAS[t] ?? LIST_KEY_ALIAS[t.toLowerCase()] ?? null
}

// =====================================================================
// 变体表（唯一声明处）
// =====================================================================

/**
 * @typedef {object} VariantSpec
 * @property {string} key       内部键
 * @property {string} label     图上副标题行前缀（**须短**，渲染层还会按列宽兜底截断）
 * @property {Function} match   (r, song) => boolean；`song` 可能为 null（曲库未收录，早已被上游剔除）
 * @property {'rank'} mode      填池方式：过滤后按正常 B35/B15 排序取前 35/15
 * @property {boolean} [help]   是否进专题帮助图（默认 true）
 * @property {string} [usage]   帮助条目 title
 * @property {string} [desc]    帮助条目 desc
 * @property {string} group     帮助分组
 */

/** @type {VariantSpec[]} */
export const VARIANT_SPECS = [
  // ---- 达成条件族 ----
  {
    key: 'fc', label: 'FC', group: '达成条件', tokens: ['FC'], usage: 'FC50',
    desc: 'FC / FC+ 的成绩（不含 AP、AP+）',
    match: r => r.fc === 'fc' || r.fc === 'fcp',
  },
  {
    key: 'fcp', label: 'FC+', group: '达成条件', tokens: ['FC+'], usage: 'FC+50',
    desc: '只看 FC+（比 FC50 更紧）',
    match: r => r.fc === 'fcp',
  },
  {
    key: 'solo', label: '单刷', group: '达成条件', tokens: ['单刷'], usage: '单刷50',
    desc: '单人游玩（无 Sync / FS / FSD 等任何同步标识）',
    match: r => r.fs == null,
  },
  {
    key: 'multi', label: '拼机', group: '达成条件', tokens: ['拼机', 'SP'], usage: '拼机50（SP50）',
    desc: '拼机：任何同步标识（Sync / FS / FS+ / FSD / FSD+）',
    match: r => r.fs != null,
  },
  {
    key: 'fs', label: 'FS', group: '达成条件', tokens: ['FS'], usage: 'FS50',
    desc: 'Full Sync（FS / FS+）',
    match: r => SYNC_FS_ALL.includes(r.fs),
  },
  {
    key: 'fsp', label: 'FS+', group: '达成条件', tokens: ['FS+'], help: false,
    match: r => SYNC_FS_PLUS.includes(r.fs),
  },
  {
    key: 'fsd', label: 'FSD', group: '达成条件', tokens: ['FDX', 'FSD'], usage: 'FDX50 / FSD50',
    desc: 'Full Sync DX（FSD / FSD+；FDX 与 FSD 等价）',
    match: r => SYNC_FSD_ALL.includes(r.fs),
  },
  {
    key: 'fsdp', label: 'FSD+', group: '达成条件', tokens: ['FDX+', 'FSD+'], help: false,
    match: r => SYNC_FSD_PLUS.includes(r.fs),
  },
  {
    key: 'nb', label: 'nb', group: '达成条件', tokens: ['nb', '牛逼'], usage: 'nb50 / 牛逼50',
    desc: '达成率 ≥ 100.8%（接近理论值的「牛逼」成绩）',
    match: r => r.achievements >= 100.8,
  },
  {
    key: 'low', label: '越级', group: '达成条件', tokens: ['越级', '丢人'], usage: '越级50 / 丢人50',
    desc: '达成率 ≤ 95%（越级 / 丢人）',
    match: r => r.achievements <= 95,
  },

  // ---- 评级族（寸 / 锁 的无评级形态；带评级的形态由 resolveRankVariant 生成） ----
  {
    key: 'cun', label: '寸', group: '评级', tokens: ['寸'], usage: '寸50',
    desc: '距下一评级档位 ≤0.05%（不带评级即全部档位）',
    match: isCun,
  },
  {
    key: 'suo', label: '锁', group: '评级', tokens: ['锁'], usage: '锁50',
    desc: '距上一评级档位 ≤0.05%（不带评级即全部档位）',
    match: isSuo,
  },

  // ---- 筛选族：难度（绿/黄/红/紫/白，可加「谱」） ----
  ...Array.from(DIFF_COLORS, (color, idx) => ({
    key: `diff-${idx}`, label: `${color}谱`, group: '筛选', help: false,
    tokens: [color, `${color}谱`],
    match: r => r.level_index === idx,
  })),

  // ---- 筛选族：类型（两条合成一个帮助条目，见 HELP_ROWS） ----
  { key: 'type-dx', label: 'DX', group: '筛选', help: false, tokens: ['DX'], match: (_r, song) => song?.type === 'DX' },
  { key: 'type-sd', label: 'SD', group: '筛选', help: false, tokens: ['SD', '标准', '旧框'], match: (_r, song) => song?.type === 'SD' },

  // ---- 筛选族：分类（token 为别名，规格按图标组生成） ----
  ...Object.entries(CATEGORY_ALIAS).reduce((acc, [token, icon]) => {
    const hit = acc.find(s => s.key === `genre-${icon}`)
    if (hit) hit.tokens.push(token)
    else acc.push({
      key: `genre-${icon}`, label: ICON_LABEL[icon] ?? icon, group: '筛选', help: false, tokens: [token],
      match: (_r, song) => GENRE_BY_ICON.get(icon)?.has(song?.genre) === true,
    })
    return acc
  }, []),

  // ---- 筛选族：版本（token 为版本字，可带「代」） ----
  // ⚠️ 版本字里的「紫」「白」与难度色同名 —— 本表**难度在前**，故裸字命中难度（V3）；
  //    版本侧靠「代」后缀区分（紫代 / 白代），两者是不同 token，不冲突。
  // 简繁对（晓/暁、华/華…）经 PLATE_CN 归一后指向同一版本 ⇒ 合并成一个规格、两个 token。
  ...(() => {
    const byKey = new Map()
    for (const ch of VERSION_CHARS) {
      const key = `version-${PLATE_CN[ch] ?? ch}`
      if (byKey.has(key)) {
        byKey.get(key).tokens.push(ch, `${ch}代`)
        continue
      }
      const versions = resolveVersion(ch).versions          // 预先取好，勿在 match 里现算
      byKey.set(key, {
        key, label: ch, group: '筛选', help: false, tokens: [ch, `${ch}代`],
        // 简繁对（晓/暁、辉/輝…）合并成一个规格后，横幅要显示**用户输入的那个字**，
        // 而不是合并时先遇到的那个（否则 `#mai 辉50` 会显示成「輝」）
        labelOf: t => String(t).replace(/代$/, ''),
        match: (_r, song) => versions.includes(song?.version_str),
      })
    }
    return [...byKey.values()]
  })(),
  {
    key: 'version-tri', label: '真超檄', group: '筛选', help: false,
    tokens: ['真超檄', '真超檄代'],
    match: (_r, song) => resolveVersion('真超檄').versions.includes(song?.version_str),
  },
]

// =====================================================================
// 帮助图条目（聚合行：一条覆盖同族的多个规格）
// =====================================================================

/**
 * 帮助图专用聚合条目（把「一个 token 一行」收成「一族一行」，避免帮助图被 31 个版本字刷屏）
 *
 * `kind` 决定单测用哪个解析器校验 `tokens`（default `variant` = resolveVariant）：
 *   - `designer`：开放集合，走 resolveDesigner（只在「精确命中曲库/别名」时才算解析成功）
 *   - `time`：V26 的迁移引导（新歌/旧版本 已移出 b50）
 *   - `song50` / `all50`：由 apps 层单独规则的解析器处理（歌50 需查曲，全Xb50 见 resolveAllCondition）
 *
 * `eg` 是帮助图上展示的示例命令（`{head}` 占位符由渲染层替换为当前命令头；
 * 时间类给的是**迁移后**的命令，故与 tokens 不同形，这是刻意的）。
 */
const HELP_ROWS = [
  {
    group: '评级', usage: '仅[评级]50', eg: '#{head} 仅SS50', tokens: ['仅SS50', '仅sss+50', '仅鸟50'],
    desc: '只看某个评级（SSS+/SSS/SS+/SS/S+/S/AAA/AA/A/BBB/BB/B/C/D；鸟=SSS、鸟加/鸟+/鸟家=SSS+）',
  },
  {
    group: '评级', usage: '[评级]寸50', eg: '#{head} 鸟+寸50', tokens: ['鸟+寸50', 'SSS寸50'],
    desc: '差一点到某评级档位（≤0.05%，含）。例：鸟+寸50 = 100.45%~100.5%',
  },
  {
    group: '评级', usage: '[评级]锁50', eg: '#{head} 鸟+锁50', tokens: ['鸟+锁50', 'SS锁50'],
    desc: '差一点掉出某评级档位（≤0.05%，含）。例：鸟+锁50 = 100.5%~100.55%',
  },
  {
    group: '筛选', usage: '<分类>50', eg: '#{head} 东方50', tokens: ['东方50', '车万50', 'v家50', '术力口50', '音击中二50', '其他游戏50', '流行50', '舞萌50'],
    desc: '按乐曲分类：舞萌 / v家（vocaloid・niconico・术力口・ボカロ）/ 东方（车万）/ 流行（动漫・二次元）/ 音击中二（音击・中二）/ 其他游戏（variety）',
  },
  {
    group: '筛选', usage: '<版本>50', eg: '#{head} 辉50', tokens: ['辉50', '白代50', '真超檄50', '彩50'],
    desc: '按版本：真超檄橙晓桃樱紫堇白雪辉舞熊华爽煌宙星祭祝双宴镜彩（可加「代」，如 白代50）',
  },
  {
    group: '筛选', usage: '<类型>50', eg: '#{head} DX50', tokens: ['DX50', '标准50', '旧框50'],
    desc: '按谱面类型：DX50 / SD50（标准・旧框）',
  },
  {
    group: '筛选', usage: '<难度色>50', eg: '#{head} 红谱50', tokens: ['红谱50', '紫50', '白谱50', '绿50'],
    desc: '按难度色：绿/黄/红/紫/白（可加「谱」）。裸字 紫/白 一律指难度（版本请写 紫代50 / 白代50）',
  },
  {
    group: '筛选', kind: 'designer', usage: '<谱师>50', eg: '#{head} mai-Star50', tokens: ['mai-Star50', '哈皮50', '翠楼屋50'],
    desc: '按谱师（曲库原名 + 常见中文叫法，如 哈皮 → はっぴー）',
  },
  {
    group: '筛选', kind: 'time', usage: '新歌50 / 旧版本50（已迁移）', eg: '#{head} list 新歌', tokens: ['新歌50', '旧版本50'],
    desc: '按时间筛不参与 B50（分池会让人误读），已并入分数列表：用 #mai list 新歌 / #mai list 旧版本',
  },
  {
    group: '模拟', kind: 'all50', usage: '全<定数|难度色>b50', eg: '#{head} 全13b50', tokens: ['全13b50', '全红b50', '全13.5b50'],
    desc: '整张 B50 全部由符合条件的谱面构成（全红b50 ≡ 红谱50）',
  },
  {
    group: '模拟', kind: 'song50', usage: '歌50 [难度色]<曲名|id|别名>', eg: '#{head} 歌50 紫茄子', tokens: ['歌50 紫茄子', '歌50 799 红'],
    desc: '整张 B50 全是同一首歌（该谱重复填充 B35+B15，合计 = 50 × 该谱 Rating）',
  },
]

/** 帮助分组顺序（渲染层按此排列） */
export const HELP_GROUP_ORDER = ['达成条件', '评级', '筛选', '模拟']

/**
 * AP50 规格（水鱼侧由本地全量成绩算出，设计 §5）
 *
 * 它不是随心配命令（`#mai ap50` 是独立命令），但与变体共用同一条管线与 D17 护栏，
 * 故规格放这里——口径只有一处（`ap` 与 `app` 都算 AP，与 SYNC_MAP/COMBO_MAP 的既有叫法一致）。
 */
export const AP_SPEC = {
  key: 'ap', label: 'AP', mode: 'rank',
  match: r => r.fc === 'ap' || r.fc === 'app',
}

// =====================================================================
// token 白名单（apps/score.js 的规则正则由此生成）
// =====================================================================

/** 正则元字符转义 */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** ASCII 大小写折叠（宿主以 new RegExp(reg) 编译规则，传不了 'i' 标志 —— 见 apps/table.js:49 的坑） */
const foldCase = s => s.replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)

/** 全部可识别的评级 token（14 标准 + 14 加号形态 + 4 中文） */
function rankTokens() {
  return [...new Set([...RANK_SP, ...RANK_PLUS, ...Object.keys(RANK_CN)])]
}

/**
 * 全部可识别的变体 token（不含谱师 —— 那是开放集合，走单独的兜底规则）
 * @returns {string[]}
 */
export function variantTokens() {
  const out = []
  for (const s of VARIANT_SPECS) out.push(...s.tokens)
  for (const r of rankTokens()) out.push(`${r}寸`, `${r}锁`, `仅${r}`)
  return [...new Set(out)]
}

/**
 * 生成规则正则应使用的 token 交替串（长 token 在前，避免 'FC' 吃掉 'FC+'）
 * @returns {string}
 */
export function variantTokenPattern() {
  const tokens = variantTokens().slice().sort((a, b) => b.length - a.length)
  return tokens.map(t => foldCase(escapeRe(t))).join('|')
}

// =====================================================================
// 解析
// =====================================================================

/** 一个 token 对应的具体规格（不可识别返回 null） */
function specOfToken(token) {
  for (const s of VARIANT_SPECS) if (s.tokens.includes(token)) return s
  return null
}

/** 构造「仅/寸/锁」的规格（评级键 → 具体判定） */
function rankVariant(kind, rankKey) {
  const name = displayRank(rankKey)                       // 'sssp' → 'SSS+'
  const start = rankStart(rankKey)
  if (kind === '仅') {
    return {
      key: `only-${rankKey}`, label: `仅${name}`, mode: 'rank',
      match: r => rankOf(r.achievements) === rankKey,
    }
  }
  if (kind === '寸') {
    return {
      key: `cun-${rankKey}`, label: `${name}寸`, mode: 'rank',
      // 差一点到该档：落在 [起算线-0.05, 起算线)；d 档无起算线 ⇒ 恒空（设计 §4.3）
      match: r => r.achievements >= start - 0.05 && r.achievements < start,
    }
  }
  return {
    key: `suo-${rankKey}`, label: `${name}锁`, mode: 'rank',
    // 差一点掉出该档：落在 [起算线, 起算线+0.05]（V11：含 0.05）
    match: r => r.achievements >= start && r.achievements - start <= 0.05,
  }
}

/** 评级键 → 图上/帮助里的展示名（'sssp' → 'SSS+'） */
export function displayRank(key) {
  const i = RANK_SP.indexOf(key)
  return i >= 0 ? RANK_PLUS[i].toUpperCase() : String(key).toUpperCase()
}

/**
 * 解析一个变体 token（apps 层白名单正则捕获的部分）
 *
 * @param {string} raw 命令里 `<...>50` 的 `<...>` 部分（已去空白）
 * @returns {VariantSpec|null} null = 不可识别（调用方应放行 return false）
 */
export function resolveVariant(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null

  // ① 评级族：仅X / X寸 / X锁
  if (t.startsWith('仅') && t.length > 1) {
    const rank = normalizeRank(t.slice(1))
    return rank ? rankVariant('仅', rank) : null
  }
  if (t.endsWith('寸') && t.length > 1) {
    const rank = normalizeRank(t.slice(0, -1))
    return rank ? rankVariant('寸', rank) : null
  }
  if (t.endsWith('锁') && t.length > 1) {
    const rank = normalizeRank(t.slice(0, -1))
    return rank ? rankVariant('锁', rank) : null
  }

  // ② 表内 token（条件词/阈值族/无评级寸锁/难度/类型/分类/版本）
  const hit = specOfToken(t)
  if (hit) return { ...hit, label: hit.labelOf ? hit.labelOf(t) : hit.label, mode: hit.mode ?? 'rank' }

  // ③ ASCII 大小写折叠后再试一次（token 表里存的是规范写法，如 DX / FC / nb）
  const lower = t.toLowerCase()
  const folded = VARIANT_SPECS.find(s => s.tokens.some(x => x.toLowerCase() === lower))
  if (folded) return { ...folded, label: folded.labelOf ? folded.labelOf(t) : folded.label, mode: folded.mode ?? 'rank' }

  return null
}

/**
 * 解析「全<条件>b50」的条件部分（设计 §4.3 表末两行）
 * - 含 `.` → 按 `level_value` 数值匹配（与 #mai list 的二选一口径一致）
 * - 否则 → 按 `level` 字面匹配（含 `+`）；难度色则按 level_index
 *
 * @param {string} raw
 * @returns {VariantSpec|null}
 */
export function resolveAllCondition(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null

  // 难度色（可带「谱」）
  const color = t.endsWith('谱') ? t.slice(0, -1) : t
  const idx = DIFF_COLORS.indexOf(color)
  if (color.length === 1 && idx >= 0) {
    return {
      key: `all-diff-${idx}`, label: `全${color}谱`, mode: 'rank',
      match: r => r.level_index === idx,
    }
  }

  // 一位小数定数 → level_value 数值（限 lv1~15，避免 `全99.5b50` 这类静默空结果）
  if (/^\d{1,2}\.\d$/.test(t)) {
    const v = Math.round(parseFloat(t) * 10) / 10
    if (!(v >= 1 && v < 16)) return null
    return { key: `all-lv-${t}`, label: `全${t}`, mode: 'rank', match: r => r.level_value === v }
  }
  // 等级字面（含 +）—— 必须是 LEVEL_LIST 里的已知等级
  if (/^\d{1,2}\+?$/.test(t) && LEVEL_LIST.includes(t)) {
    return { key: `all-level-${t}`, label: `全${t}`, mode: 'rank', match: r => r.level === t }
  }
  return null
}

/**
 * 歌50 的规格：同一谱面重复填充（V1）
 * @param {{song_id:number, level_index:number}} chart
 * @param {string} label 图上副标题前缀（曲名，渲染层会截断）
 */
export function repeatSpec(chart, label) {
  return { key: 'song50', label: label || '歌', mode: 'repeat', songId: chart.song_id, levelIndex: chart.level_index }
}

/** 谱师名归一（全角 ASCII → 半角、折叠空白、lower） */
export function normalizeDesigner(v) {
  return String(v ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 解析谱师（开放集合：精确匹配曲库原名或别名表）
 *
 * ⚠️ **必须校验 `known`**：不校验的话任意文本都会「解析成谱师」，
 * 兜底规则就再也放行不了 `#mai song 1150` 这类消息（设计 §3.4 R1）。
 *
 * @param {string} raw
 * @param {{designers: Set<string>, alias?: Record<string,string>}} deps
 *        designers 需为**已归一**的名字集合（见 collectDesigners）；
 *        alias 默认取 resources/info/designer_alias.json（静态资源，import 期读入，非运行时 I/O）
 * @returns {VariantSpec|null}
 */
export function resolveDesigner(raw, { designers, alias = designerAlias } = {}) {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const mapped = alias[t] ?? t
  const name = normalizeDesigner(mapped)
  if (!name || name === '-' || !designers?.has(name)) return null
  return {
    key: `designer-${name}`, label: mapped, mode: 'rank', group: '筛选',
    match: (r, song) => normalizeDesigner(song?.difficulties?.[r.level_index]?.note_designer) === name,
  }
}

/**
 * 曲库里的全部谱师名（已归一为空集合；`-` 与空串不收）
 * @param {{root?: Array}} totalList
 * @returns {Set<string>}
 */
export function collectDesigners(totalList) {
  const set = new Set()
  for (const song of totalList?.root ?? []) {
    for (const d of song.difficulties ?? []) {
      const n = normalizeDesigner(d.note_designer)
      if (n && n !== '-') set.add(n)
    }
  }
  return set
}

// =====================================================================
// 帮助图数据
// =====================================================================

/**
 * 随心配专题帮助图的数据（分组条目）
 *
 * `eg` 里的 `{head}` 占位符由渲染层替换为当前命令头（与 resources/info/help.json 同约定）。
 * @returns {Array<{group:string, items:Array<{title:string, eg:string, desc:string}>}>}
 */
export function variantHelp() {
  const byGroup = new Map()
  const push = (group, item) => {
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group).push(item)
  }
  for (const s of VARIANT_SPECS) {
    if (s.help === false) continue
    push(s.group, {
      title: s.usage ?? `${s.label}50`,
      eg: `#{head} ${s.tokens[0]}50`,
      desc: s.desc ?? '',
    })
  }
  for (const row of HELP_ROWS) {
    push(row.group, { title: row.usage, eg: row.eg ?? '', desc: row.desc })
  }
  return HELP_GROUP_ORDER
    .filter(g => byGroup.has(g))
    .map(group => ({ group, items: byGroup.get(group) }))
}

/** 帮助条目的样例 token + kind（单测据此校验「帮助里写的命令真能解析」，见 §10） */
export function variantHelpTokens() {
  return HELP_ROWS.map(r => ({ usage: r.usage, kind: r.kind ?? 'variant', tokens: r.tokens }))
}
