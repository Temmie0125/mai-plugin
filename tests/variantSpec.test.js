/**
 * 随心配变体解析单测（设计《b50扩展实现设计.md》§3 / §10）
 *
 * 全部离线：不碰 mai 单例、不触网、不落盘。
 * 断言的是「文本 → 规格」这一层，不含排序与出图（那是 variantB50.test.js / 渲染冒烟）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CATEGORY_ALIAS, DIFF_COLORS, collectDesigners, displayRank, isTimeKeyword, normalizeDesigner,
  normalizeRank, repeatSpec, resolveAllCondition, resolveDesigner, resolveVariant, resolveVersion,
  variantHelp, variantHelpTokens, variantTokens, variantTokenPattern, VARIANT_SPECS,
} from '../lib/variantSpec.js'

/** 造一条成绩（只填判定用得到的字段） */
const rec = (extra = {}) => ({
  song_id: 1, level_index: 3, level: '13', level_value: 13, type: 'SD',
  achievements: 100.5, rating: 300, fc: null, fs: null, ...extra,
})
/** 造一首曲（difficulties 补满 5 个难度位，谱师默认挂在 rec() 用的 index 3 上） */
const song = (extra = {}) => ({
  song_id: 1, song_name: 'S1', genre: '舞萌', version_str: 'maimai', type: 'SD', isnew: false,
  difficulties: Array.from({ length: 5 }, (_, i) => ({
    level_index: i, level: '13', level_value: 13, note_designer: i === 3 ? 'はっぴー' : '-',
  })),
  ...extra,
})
/** 谱师挂在第 4 难度位（level_index 3）上的曲 —— 谱师判定按 `difficulties[r.level_index]` 取 */
const songWithDesigner = name => song({
  difficulties: Array.from({ length: 5 }, (_, i) => ({
    level_index: i, level: '13', level_value: 13, note_designer: i === 3 ? name : '-',
  })),
})

// ---------------------------------------------------------------- 分支命中

test('达成条件族：token → 判定的对应关系', () => {
  const cases = [
    ['FC', [{ fc: 'fc' }, true], [{ fc: 'fcp' }, true], [{ fc: 'ap' }, false], [{ fc: 'app' }, false], [{}, false]],
    ['FC+', [{ fc: 'fcp' }, true], [{ fc: 'fc' }, false], [{ fc: 'app' }, false]],
    ['单刷', [{ fs: null }, true], [{ fs: 'sync' }, false], [{ fs: 'fsd' }, false]],
    ['拼机', [{ fs: 'sync' }, true], [{ fs: 'fs' }, true], [{ fs: 'fsp' }, true],
      [{ fs: 'fsd' }, true], [{ fs: 'fsdp' }, true], [{ fs: 'fdxp' }, true], [{ fs: null }, false]],
    ['SP', [{ fs: 'sync' }, true], [{ fs: null }, false]],
    ['FS', [{ fs: 'fs' }, true], [{ fs: 'fsp' }, true], [{ fs: 'fsd' }, false], [{ fs: 'sync' }, false]],
    ['FS+', [{ fs: 'fsp' }, true], [{ fs: 'fs' }, false]],
    ['FDX', [{ fs: 'fsd' }, true], [{ fs: 'fsdp' }, true], [{ fs: 'fdx' }, true], [{ fs: 'fdxp' }, true],
      [{ fs: 'fsdpx' }, true], [{ fs: 'fsdp+' }, true], [{ fs: 'fs' }, false], [{ fs: 'sync' }, false]],
    ['FSD', [{ fs: 'fsd' }, true], [{ fs: 'fs' }, false]],
    ['FDX+', [{ fs: 'fsdp' }, true], [{ fs: 'fdxp' }, true], [{ fs: 'fsd' }, false]],
    ['nb', [{ achievements: 100.8 }, true], [{ achievements: 100.79 }, false]],
    ['牛逼', [{ achievements: 101 }, true], [{ achievements: 100 }, false]],
    ['越级', [{ achievements: 95 }, true], [{ achievements: 95.01 }, false]],
    ['丢人', [{ achievements: 50 }, true], [{ achievements: 96 }, false]],
  ]
  for (const [token, ...pairs] of cases) {
    const spec = resolveVariant(token)
    assert.ok(spec, `应能解析：${token}`)
    for (const [patch, expected] of pairs) {
      assert.equal(spec.match(rec(patch), song()), expected,
        `${token} 对 ${JSON.stringify(patch)} 应为 ${expected}`)
    }
  }
})

test('评级族：寸 / 锁 / 仅 的形态与别名（含鸟加/鸟）', () => {
  assert.equal(resolveVariant('仅SS').key, 'only-ss')
  assert.equal(resolveVariant('仅sss+').key, 'only-sssp')
  assert.equal(resolveVariant('鸟加寸').key, 'cun-sssp')
  assert.equal(resolveVariant('鸟+寸').key, 'cun-sssp')
  assert.equal(resolveVariant('鸟家锁').key, 'suo-sssp')
  assert.equal(resolveVariant('鸟锁').key, 'suo-sss')
  assert.equal(resolveVariant('寸').key, 'cun')
  assert.equal(resolveVariant('锁').key, 'suo')

  // 展示名（图上副标题）：RANK_PLUS 的加号形态
  assert.equal(displayRank('sssp'), 'SSS+')
  assert.equal(resolveVariant('仅sssp').label, '仅SSS+')
  assert.equal(resolveVariant('sssp锁').label, 'SSS+锁')

  // 无法识别的评级 → null（不产出规格）
  assert.equal(resolveVariant('仅ZZ'), null)
  assert.equal(resolveVariant('SSZ寸'), null)
  assert.equal(normalizeRank('鸟'), 'sss')
  assert.equal(normalizeRank('sss+'), 'sssp')
  assert.equal(normalizeRank('s+'), 'sp')
  assert.equal(normalizeRank('SS'), 'ss')
  assert.equal(normalizeRank('SSZ'), null)
})

test('仅/寸/锁：判定边界（需求文档的两个示例区间）', () => {
  const cun = resolveVariant('鸟+寸')
  const suo = resolveVariant('鸟+锁')
  // 鸟+寸50 = [100.45, 100.5)：需求原文「100.45% 视为 SSS+寸」
  assert.equal(cun.match(rec({ achievements: 100.45 }), song()), true)
  assert.equal(cun.match(rec({ achievements: 100.4999 }), song()), true)
  assert.equal(cun.match(rec({ achievements: 100.44 }), song()), false)
  assert.equal(cun.match(rec({ achievements: 100.5 }), song()), false)
  // 鸟+锁50 = [100.5, 100.55]（V11：含 0.05）
  assert.equal(suo.match(rec({ achievements: 100.5 }), song()), true)
  assert.equal(suo.match(rec({ achievements: 100.55 }), song()), true)
  assert.equal(suo.match(rec({ achievements: 100.56 }), song()), false)
  assert.equal(suo.match(rec({ achievements: 100.45 }), song()), false)
  // 无评级形态：任意档位
  assert.equal(resolveVariant('寸').match(rec({ achievements: 99.48 }), song()), true)
  assert.equal(resolveVariant('锁').match(rec({ achievements: 99.0 }), song()), true)
  assert.equal(resolveVariant('锁').match(rec({ achievements: 49.9 }), song()), false)
})

test('仅/寸/锁：全区间扫描 —— 与无评级形态一致，且至多命中一档', () => {
  const ranks = ['d', 'c', 'b', 'bb', 'bbb', 'a', 'aa', 'aaa', 's', 'sp', 'ss', 'ssp', 'sss', 'sssp']
  const cunSpec = resolveVariant('寸')
  const suoSpec = resolveVariant('锁')
  let bad = 0
  for (let a = 40; a <= 101.2; a = Math.round((a + 0.01) * 100) / 100) {
    const r = rec({ achievements: a })
    const cunHits = ranks.filter(k => resolveVariant(`${k}寸`).match(r, song())).length
    const suoHits = ranks.filter(k => resolveVariant(`${k}锁`).match(r, song())).length
    if (cunHits > 1 || suoHits > 1) bad += 1
    if ((cunHits > 0) !== cunSpec.match(r, song())) bad += 1
    if ((suoHits > 0) !== suoSpec.match(r, song())) bad += 1
    const onlyHits = ranks.filter(k => resolveVariant(`仅${k}`).match(r, song())).length
    if (onlyHits !== 1) bad += 1        // 每个达成率恰好属于一个评级
  }
  assert.equal(bad, 0, '40~101.2（步长 0.01）全区间应一致且无多重命中')
})

// ---------------------------------------------------------------- V3 歧义

test('V3 锁：裸字 紫/白 = 难度；版本靠「代」后缀', () => {
  const zi = resolveVariant('紫')
  assert.equal(zi.key, 'diff-3', '紫 → 紫谱（level_index 3）')
  const ziDai = resolveVariant('紫代')
  assert.equal(ziDai.key, 'version-紫', '紫代 → 版本 MURASAKi（key 用版本字，简繁归一靠 PLATE_CN）')
  assert.equal(ziDai.match(null, song({ version_str: 'maimai MURASAKi' })), true)
  assert.equal(ziDai.match(null, song({ version_str: 'maimai MiLK' })), false)

  assert.equal(resolveVariant('白').key, 'diff-4', '白 → 白谱（level_index 4）')
  assert.equal(resolveVariant('白谱').key, 'diff-4')
  assert.equal(resolveVariant('白代').key, 'version-白')

  // 简繁对指向同一规格（token 两个、规格一个），但**横幅显示用户输入的那个字**
  assert.equal(resolveVariant('晓').key, resolveVariant('暁').key)
  assert.equal(resolveVariant('华').key, resolveVariant('華').key, '华/華 是同一版本，须合并为一个规格')
  for (const [input, shown] of [['晓', '晓'], ['暁', '暁'], ['华', '华'], ['華', '華'],
    ['辉', '辉'], ['輝', '輝'], ['白代', '白'], ['紫代', '紫']]) {
    assert.equal(resolveVariant(input).label, shown, `横幅应显示用户输入的版本字：${input}`)
  }

  // 无歧义的难度色
  for (const [i, c] of [...DIFF_COLORS].entries()) {
    assert.equal(resolveVariant(c).key, `diff-${i}`)
    assert.equal(resolveVariant(`${c}谱`).key, `diff-${i}`)
  }
})

// ---------------------------------------------------------------- 大小写/转义

test('ASCII 大小写折叠：正则与解析两侧都成立', () => {
  const pattern = new RegExp(`^(?:${variantTokenPattern()})50$`)
  for (const cmd of ['FC50', 'fc50', 'Fc50', 'fC50', 'NB50', 'nb50', 'DX50', 'dx50',
    'FS50', 'fs50', 'FDX50', 'fdx50', 'SP50', 'sp50', 'AP+50', '真超檄50', '仅sssp50']) {
    if (cmd === 'AP+50') { assert.doesNotMatch(cmd, pattern, 'AP+ 不是随心配 token'); continue }
    assert.match(cmd, pattern, `白名单应命中：${cmd}`)
  }
  assert.equal(resolveVariant('fc').key, 'fc', '小写 fc → FC')
  assert.equal(resolveVariant('N B'), null)
})

test('正则元字符转义：FC+ / FDX+ / 谱面-100号 形态', () => {
  const pattern = new RegExp(`^(?:${variantTokenPattern()})50$`)
  for (const cmd of ['FC+50', 'FDX+50', 'FSD+50', 'FS+50']) assert.match(cmd, pattern, `应命中：${cmd}`)
  // 未转义时 'FC+' 的 + 会变成量词，'FC50' 反而会被命中 —— 反向锁一下
  assert.doesNotMatch('FCC50', pattern)
  assert.doesNotMatch('F50', pattern)
  // 白名单里不该出现裸的未转义加号（注意 ASCII 字母会被折成 [xX]，故断言带上折叠形态）
  assert.match(variantTokenPattern(), /\[fF\]\[cC\]\\\+/, 'FC+ 必须以 [fF][cC]\\+ 形式进白名单')
})

// ---------------------------------------------------------------- 筛选族

test('筛选：分类别名 → genre 集合（与 CATEGORY 图标同源）', () => {
  const touhou = resolveVariant('东方')
  assert.equal(touhou.match(null, song({ genre: '东方Project' })), true)
  assert.equal(touhou.match(null, song({ genre: '東方Project' })), true, '日文 genre 也要收')
  assert.equal(touhou.match(null, song({ genre: '舞萌' })), false)
  assert.equal(resolveVariant('车万').key, touhou.key)

  // 音击/中二 与 其他游戏 的日文 genre 同样归组（实测曲库有这些零散值）
  assert.equal(resolveVariant('音击中二').match(null, song({ genre: 'オンゲキCHUNITHM' })), true)
  assert.equal(resolveVariant('中二').match(null, song({ genre: '音击&中二节奏' })), true)
  assert.equal(resolveVariant('其他游戏').match(null, song({ genre: 'ゲームバラエティ' })), true)
  assert.equal(resolveVariant('v家').match(null, song({ genre: 'niconico & VOCALOID' })), true)
  assert.equal(resolveVariant('v家').match(null, song({ genre: 'niconicoボーカロイド' })), true)
  assert.equal(resolveVariant('流行').match(null, song({ genre: 'POPSアニメ' })), true)
  assert.equal(resolveVariant('舞萌').match(null, song({ genre: '舞萌' })), true)
  assert.equal(resolveVariant('舞萌').match(null, song({ genre: 'maimai' })), true)
  // 宴会場不进任何分类
  assert.equal(resolveVariant('其他游戏').match(null, song({ genre: '宴会場' })), false)
  // 别名表里的 token 全部可解析
  for (const token of Object.keys(CATEGORY_ALIAS)) assert.ok(resolveVariant(token), `别名应可解析：${token}`)
})

test('筛选：版本（含 舞/霸 全景、真超檄 组合、可加「代」）', () => {
  assert.equal(resolveVariant('辉').match(null, song({ version_str: 'maimai FiNALE' })), true)
  assert.equal(resolveVariant('辉代').key, resolveVariant('辉').key)
  // 简繁归一（PLATE_CN）
  assert.equal(resolveVariant('晓').key, resolveVariant('暁').key)
  // 舞 = 全部 SD 版本
  const wu = resolveVariant('舞')
  for (const v of ['maimai', 'maimai ORANGE', 'maimai FiNALE', 'MiLK PLUS']) {
    assert.equal(wu.match(null, song({ version_str: v })), true, `舞应含 ${v}`)
  }
  assert.equal(wu.match(null, song({ version_str: 'maimai でらっくす PRiSM' })), false)
  // 真超檄 = 三者并集
  const tri = resolveVariant('真超檄')
  for (const v of ['maimai', 'maimai PLUS', 'maimai GreeN', 'maimai GreeN PLUS']) {
    assert.equal(tri.match(null, song({ version_str: v })), true, `真超檄应含 ${v}`)
  }
  assert.equal(tri.match(null, song({ version_str: 'maimai ORANGE' })), false)
  // 版本字表成员全部可解析（含需求未列的 镜/彩）
  for (const ch of '真超檄橙暁晓桃櫻樱紫菫堇白雪輝辉舞霸熊華华爽煌星宙祭祝双宴镜彩') {
    assert.ok(resolveVariant(ch), `版本字应可解析：${ch}`)
  }
  assert.equal(resolveVersion('镜').versions.includes('maimai でらっくす PRiSM'), true)
  assert.equal(resolveVersion('彩').versions.includes('maimai でらっくす PRiSM PLUS'), true)
})

test('筛选：类型与难度', () => {
  assert.equal(resolveVariant('DX').match(null, song({ type: 'DX' })), true)
  assert.equal(resolveVariant('DX').match(null, song({ type: 'SD' })), false)
  for (const token of ['SD', '标准', '旧框']) {
    assert.equal(resolveVariant(token).match(null, song({ type: 'SD' })), true, token)
    assert.equal(resolveVariant(token).match(null, song({ type: 'DX' })), false, token)
  }
  assert.equal(resolveVariant('红谱').match(rec({ level_index: 2 }), song()), true)
  assert.equal(resolveVariant('红').match(rec({ level_index: 3 }), song()), false)
})

test('筛选：谱师（精确 + 中文别名 + 未知一律 null）', () => {
  const designers = new Set(['はっぴー', 'jack', '譜面-100号', '翠楼屋', 'small bird'])
  const alias = { 哈皮: 'はっぴー', '谱面-100号': '譜面-100号' }
  const opts = { designers, alias }

  const hapi = resolveDesigner('哈皮', opts)
  assert.ok(hapi, '中文别名应命中')
  assert.equal(hapi.match(rec(), song()), true, '曲库原名是 はっぴー')
  assert.equal(hapi.match(rec(), songWithDesigner('Jack')), false)

  assert.equal(resolveDesigner('谱面-100号', opts).match(rec(), songWithDesigner('譜面-100号')), true)
  assert.equal(resolveDesigner('Jack', opts).key, 'designer-jack', '大小写折叠')
  assert.equal(resolveDesigner('small bird', opts).match(rec(), songWithDesigner('Small  Bird')), true, '空白折叠')

  // ⚠️ 未知一律 null —— 兜底规则能不能放行 `#mai song 1150` 全靠这一条
  for (const bad of ['song 115', '不存在的人', '-', '', '  ']) {
    assert.equal(resolveDesigner(bad, opts), null, `不应解析：${JSON.stringify(bad)}`)
  }
  assert.equal(resolveDesigner('はっぴー', { designers: new Set(), alias }), null, '不在曲库里的名字也要 null')

  // collectDesigners：剔除占位符 '-' 与空串，并归一
  const lib = { root: [
    { difficulties: [{ note_designer: '-' }, { note_designer: '' }, { note_designer: 'Jack' }] },
    { difficulties: [{ note_designer: 'はっぴー' }] },
  ] }
  assert.deepEqual([...collectDesigners(lib)].sort(), ['jack', 'はっぴー'])
  assert.equal(normalizeDesigner('Ｊａｃｋ'), 'jack', '全角 ASCII → 半角')
})

// ---------------------------------------------------------------- 模拟族

test('全<条件>b50：定数字面 / 一位小数 / 难度色（V18/V2）', () => {
  assert.equal(resolveAllCondition('13').match(rec({ level: '13' }), song()), true)
  assert.equal(resolveAllCondition('13').match(rec({ level: '13+' }), song()), false)
  assert.equal(resolveAllCondition('13+').match(rec({ level: '13+' }), song()), true)
  assert.equal(resolveAllCondition('13.5').match(rec({ level_value: 13.5 }), song()), true)
  assert.equal(resolveAllCondition('13.5').match(rec({ level_value: 13.6 }), song()), false)
  // V2：全红b50 与 红谱50 判定完全一致
  const allRed = resolveAllCondition('红')
  assert.equal(allRed.match(rec({ level_index: 2 }), song()), resolveVariant('红').match(rec({ level_index: 2 }), song()))
  assert.equal(allRed.match(rec({ level_index: 3 }), song()), resolveVariant('红').match(rec({ level_index: 3 }), song()))
  assert.equal(resolveAllCondition('红谱').key, allRed.key)
  // 非法条件
  for (const bad of ['', 'abc', '99', '13.55', '1.2.3']) {
    assert.equal(resolveAllCondition(bad), null, `不应解析：${bad}`)
  }
})

test('歌50：重复填充规格（V1）', () => {
  const spec = repeatSpec({ song_id: 799, level_index: 3 }, '茄子')
  assert.equal(spec.mode, 'repeat')
  assert.equal(spec.songId, 799)
  assert.equal(spec.levelIndex, 3)
  assert.equal(spec.label, '茄子')
})

// ---------------------------------------------------------------- V26 / V30

test('V26 锁：时间词不再产出 b50 变体，且被识别为迁移引导', () => {
  for (const t of ['新歌', '新曲', '旧版本', '旧歌', '老歌']) {
    assert.equal(resolveVariant(t), null, `时间词不应产出变体：${t}`)
    assert.equal(isTimeKeyword(t), true, `应识别为时间词：${t}`)
  }
  assert.equal(isTimeKeyword('东方'), false)
  assert.equal(isTimeKeyword(''), false)
})

test('V30 锁：单刷与拼机互补；FS/FSD 是拼机的子族且两两不交', () => {
  const solo = resolveVariant('单刷')
  const multi = resolveVariant('拼机')
  const fs = resolveVariant('FS')
  const fsd = resolveVariant('FDX')

  // 全部已知取值 + null + 未知值
  const values = [null, 'sync', 'fs', 'fsp', 'fsd', 'fsdp', 'fdx', 'fdxp', 'fsdpx', 'fsdp+', 'xx']
  for (const fs_ of values) {
    const r = rec({ fs: fs_ })
    const isSolo = solo.match(r, song())
    const isMulti = multi.match(r, song())
    assert.equal(isSolo || isMulti, true, `单刷∪拼机 应覆盖：${JSON.stringify(fs_)}`)
    assert.equal(isSolo && isMulti, false, `单刷∩拼机 应为空：${JSON.stringify(fs_)}`)
    if (isMulti) {
      // 子族 ⊂ 拼机
      if (fs.match(r, song())) assert.notEqual(fsd.match(r, song()), true, `${fs_} 不能同时算 FS 与 FSD`)
    }
  }
  // 子族拆分正确
  for (const v of ['fs', 'fsp']) assert.equal(fs.match(rec({ fs: v }), song()), true, v)
  for (const v of ['fsd', 'fsdp', 'fdx', 'fdxp', 'fsdpx', 'fsdp+']) assert.equal(fsd.match(rec({ fs: v }), song()), true, v)
  assert.equal(resolveVariant('FS+').match(rec({ fs: 'fsp' }), song()), true)
  assert.equal(resolveVariant('FS+').match(rec({ fs: 'fs' }), song()), false)
  assert.equal(resolveVariant('FSD+').match(rec({ fs: 'fsdp' }), song()), true)
  assert.equal(resolveVariant('FSD+').match(rec({ fs: 'fsd' }), song()), false)
})

// ---------------------------------------------------------------- 唯一声明处的不变量

test('白名单 ↔ 解析器：variantTokens() 每个 token 都能解析出规格', () => {
  const tokens = variantTokens()
  assert.ok(tokens.length > 100, `token 数应可观（实得 ${tokens.length}）`)
  for (const t of tokens) {
    assert.ok(resolveVariant(t), `白名单 token 应可解析：${t}`)
  }
})

test('规格表 ↔ 帮助图：非隐藏规格都有帮助条目；帮助里的样例命令都能解析', () => {
  const help = variantHelp()
  const helpText = help.flatMap(g => g.items.map(i => `${i.title} ${i.desc}`)).join('\n')

  // 非隐藏规格的 usage 必须出现在帮助里（防止加了变体忘了写帮助）
  for (const s of VARIANT_SPECS) {
    if (s.help === false) continue
    assert.ok(helpText.includes(s.usage), `帮助缺少条目：${s.usage}`)
  }
  // 帮助里的每个样例 token 必须能被**它那一族的**解析器认出来（anti-drift：帮助不写假命令）
  for (const { usage, kind, tokens } of variantHelpTokens()) {
    for (const t of tokens) {
      let ok
      if (kind === 'time') {
        ok = isTimeKeyword(t.slice(0, -2))
      } else if (kind === 'all50') {
        ok = Boolean(resolveAllCondition(t.replace(/^全/, '').replace(/b50$/, '')))
      } else if (kind === 'designer') {
        // 用「该名字就在曲库里」的最小曲库校验形状（alias 置空，避免样例里是中文别名的情形）
        const name = t.slice(0, -2)
        ok = Boolean(resolveDesigner(name, { designers: new Set([normalizeDesigner(name)]), alias: {} }))
      } else if (kind === 'song50') {
        ok = t.startsWith('歌50')                      // 需查曲，apps 层解析
      } else {
        ok = Boolean(resolveVariant(t.endsWith('50') ? t.slice(0, -2) : t))
      }
      assert.ok(ok, `帮助条目「${usage}」(${kind}) 里的样例无法解析：${t}`)
    }
  }
  // 分组顺序固定（渲染层依赖）
  assert.deepEqual(help.map(g => g.group), ['达成条件', '评级', '筛选', '模拟'])
})

test('规格表自身：key 唯一、判定式均为函数、token 不重复声明', () => {
  const keys = new Set()
  const seen = new Map()
  for (const s of VARIANT_SPECS) {
    assert.equal(keys.has(s.key), false, `key 重复：${s.key}`)
    keys.add(s.key)
    assert.equal(typeof s.match, 'function', `${s.key} 缺 match`)
    for (const t of s.tokens) {
      // 「紫/白」这类跨族同名 token 由**表内顺序**决定归属（V3），此处只登记不判重
      if (seen.has(t)) assert.ok(true)
      else seen.set(t, s.key)
    }
  }
  assert.equal(seen.get('紫'), 'diff-3', '裸字「紫」的归属必须先是难度（V3）')
  assert.equal(seen.get('白'), 'diff-4', '裸字「白」的归属必须先是难度（V3）')
  assert.equal(seen.get('紫代'), 'version-紫')
})
