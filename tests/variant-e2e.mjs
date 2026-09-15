/**
 * 随心配接线冒烟（**用真实曲库，不出图、不触网、不起浏览器**）
 *
 *   node plugins/mai-plugin/tests/variant-e2e.mjs
 *
 * 与 tests/*.test.js 的分工：单测用注入的假曲库锁判定式；本脚本用**真曲库**跑一遍
 * 「命令 token → 解析 → 候选 → 截断」的全链路，覆盖真数据里才会暴露的问题
 * （如 简繁版本字合并后的横幅显示、别名表是否真能命中曲库里的日文原名）。
 * 需要 data/music（或 resources/static/data）在位——与 render-*.mjs 同款前提。
 */
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get: (t, p) => (p in console ? console[p].bind(console) : (...a) => a.join(' ')),
  })
}

const { mai } = await import('../lib/service.js')
const { variantBest50 } = await import('../lib/variantB50.js')
const {
  collectDesigners, resolveAllCondition, resolveDesigner, resolveVariant, variantTokens,
} = await import('../lib/variantSpec.js')

await mai.init({ network: false })
if (!mai.ready) {
  console.error('曲库未就绪：resources/static/data 缺少 merge_music_data.json 或复制失败')
  process.exit(1)
}

// 造覆盖全曲库的确定性成绩（每曲取最高难度谱面，fc/fs/达成率按序轮转）
const ACH = [99.2, 99.6, 100.0, 100.05, 100.45, 100.5, 100.55, 100.9, 101.0, 97.5]
const FCS = [null, 'fc', 'fcp', 'ap', 'app']
const FSS = [null, null, 'sync', 'fs', 'fsp', 'fsd', 'fsdp', 'fdx']
const records = mai.totalList.root.filter(s => s.song_id < 100000).map((s, i) => {
  const li = s.difficulties.length - 1
  const d = s.difficulties[li]
  return {
    song_id: s.song_id, level_index: li, level: d.level, level_value: d.level_value, type: s.type,
    song_name: s.song_name, achievements: ACH[i % ACH.length], rating: 100 + (i % 400),
    rate: 'sss', fc: FCS[i % FCS.length], fs: FSS[i % FSS.length], dx_score: 1000,
  }
})
console.log(`曲库 ${mai.totalList.root.length} 曲 · 造确定性成绩 ${records.length} 条\n`)

let bad = 0
const line = (tag, msg, extra) => console.log(`ok ${tag.padEnd(6)} ${msg.padEnd(18)} ${extra}`)

/** 变体 token：解析 → 候选 → 截断上限 */
const VARIANTS = ['FC', 'FC+', '单刷', '拼机', 'SP', 'FS', 'FDX', 'FSD', 'nb', '越级',
  '寸', '锁', '仅SS', '仅sss+', '鸟+寸', '鸟+锁',
  '东方', '车万', 'v家', '术力口', '音击中二', '其他游戏', '流行', '舞萌',
  '辉', '白代', '紫代', '紫', '白谱', '红谱', 'DX', '标准', '真超檄', '镜', '晓', '暁', '华', '華']
for (const token of VARIANTS) {
  const spec = resolveVariant(token)
  if (!spec) { console.error(`✗ 解析失败：#mai ${token}50`); bad += 1; continue }
  const r = variantBest50(records, spec, { totalList: mai.totalList })
  line('variant', `#mai ${token}50`, `label=${String(spec.label).padEnd(8)} 候选=${String(r.candidates).padStart(4)} B35=${String(r.best50.sd.length).padStart(2)} B15=${String(r.best50.dx.length).padStart(2)} 合计=${r.total}`)
  if (r.best50.sd.length > 35 || r.best50.dx.length > 15) { console.error('   ✗ 截断越界'); bad += 1 }
}

/** 全<条件>b50 */
for (const cond of ['13', '13+', '13.5', '红', '紫谱']) {
  const spec = resolveAllCondition(cond)
  if (!spec) { console.error(`✗ 全${cond}b50 解析失败`); bad += 1; continue }
  const r = variantBest50(records, spec, { totalList: mai.totalList })
  line('all50', `#mai 全${cond}b50`, `候选=${String(r.candidates).padStart(4)} B35=${r.best50.sd.length} B15=${r.best50.dx.length}`)
}

/** 谱师：别名表必须真能命中曲库里的日文原名（这是 V5 的存在理由） */
const designers = collectDesigners(mai.totalList)
for (const name of ['mai-Star', '翠楼屋', '哈皮', '谱面-100号', 'はっぴー']) {
  const spec = resolveDesigner(name, { designers })
  if (!spec) { console.error(`✗ 谱师解析失败：${name}`); bad += 1; continue }
  const r = variantBest50(records, spec, { totalList: mai.totalList })
  line('designer', `#mai ${name}50`, `→ ${String(spec.label).padEnd(12)} 候选=${r.candidates}`)
}

/** 歌50：重复填充 */
const song = mai.totalList.root[0]
const r50 = variantBest50(records, {
  key: 'song50', label: '歌50', mode: 'repeat', songId: song.song_id, levelIndex: song.difficulties.length - 1,
}, { totalList: mai.totalList })
line('song50', `#mai 歌50 ${song.song_name}`, `B35=${r50.best50.sd.length} B15=${r50.best50.dx.length} 合计=${r50.total}（= 50 × ${r50.best50.sd[0]?.rating}）`)
if (r50.total !== r50.best50.sd[0]?.rating * 50) { console.error('   ✗ 歌50 合计 ≠ 50 × rating'); bad += 1 }

console.log(`\ntoken 总数 ${variantTokens().length} · ${bad === 0 ? '全部通过' : `${bad} 处失败`}`)
process.exit(bad === 0 ? 0 : 1)
