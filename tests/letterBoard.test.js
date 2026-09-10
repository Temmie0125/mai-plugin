/**
 * 开字母板面纯逻辑单测（零依赖：判定表由 resources/info/letterKeys.json 提供）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  HIDDEN, HIDDEN_MARK, resolveKeys, encrypt, initialOf, hasHidden,
  revealIn, containsLetter, isRowSolved, allSolved, boardText, openedText,
} from '../lib/letterBoard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KEYS = resolveKeys()
/** 表内有：今(j) 日(r) 楽(l) ジ(jz) ャ(y) ン(n) */
const mark = s => String(s).replaceAll(HIDDEN, HIDDEN_MARK)

test('判定表：已入库且汉字/假名都在（零依赖，运行时不需要 pinyin-pro）', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'info', 'letterKeys.json'), 'utf8'))
  assert.ok(Object.keys(raw.hanzi).length > 500, `汉字表偏小：${Object.keys(raw.hanzi).length}`)
  assert.ok(Object.keys(raw.kana).length > 100, `假名表偏小：${Object.keys(raw.kana).length}`)
  assert.equal(KEYS.hanzi['今'], 'j')
  assert.equal(KEYS.kana['ジ'], 'jz', 'じ/ジ 同时收 ji 与 zi')
  assert.equal(KEYS.kana['ャ'], 'y')
})

test('resolveKeys：缺表/表坏一律降级为空表（不抛错）', () => {
  // 注意：`undefined` 不算坏输入——那是「无参」语义，走默认参数取出厂表（见下一条断言）
  for (const bad of [null, {}, { hanzi: [] }, { hanzi: 'x', kana: 3 }]) {
    const k = resolveKeys(bad)
    assert.deepEqual(k.hanzi, {})
    assert.deepEqual(k.kana, {})
  }
  assert.deepEqual(resolveKeys(), KEYS, '无参 = 取出厂表')
  // 空表下仍能工作：只有字面匹配（revealIn 返回的是带哨兵的遮罩，故用 mark 比对）
  const empty = resolveKeys({})
  assert.equal(mark(revealIn('ABC', encrypt('ABC'), 'a', empty)), 'A**', '空表下拉丁仍按字面翻开')
  assert.equal(mark(revealIn('今日', encrypt('今日'), 'j', empty)), '**', '空表下汉字开不出来（降级）')
})

test('encrypt：非空格全遮，空格原样（曲名里的分隔要看得见）', () => {
  assert.equal(mark(encrypt('Turn around')), '**** ******')
  assert.equal(mark(encrypt('A B')), '* *')
  assert.equal(mark(encrypt('')), '')
  assert.equal(hasHidden(encrypt('x')), true)
  assert.equal(hasHidden('翻开'), false)
})

test('initialOf：汉字查拼音表、假名查罗马字表、拉丁返回 null（走字面）', () => {
  assert.equal(initialOf('今', KEYS), 'j')
  assert.equal(initialOf('楽', KEYS), 'l')
  assert.equal(initialOf('ジ', KEYS), 'jz')
  assert.equal(initialOf('A', KEYS), null)
  assert.equal(initialOf('5', KEYS), null)
  assert.equal(initialOf('，', KEYS), null)
})

test('revealIn：汉字按拼音首字母翻开', () => {
  // 「今日は晴れ」5 字：今(1)日(2)は(3)晴(4)れ(5)
  assert.equal(mark(revealIn('今日は晴れ', encrypt('今日は晴れ'), 'j', KEYS)), '今****')
  assert.equal(mark(revealIn('今日', encrypt('今日'), 'R', KEYS)), '*日', '大小写不敏感')
})

test('revealIn：假名按罗马字首字母翻开（phi 开不了，本端口的净增）', () => {
  // 「ジングルベル」6 字：ジ(1)ン(2)グ(3)ル(4)ベ(5)ル(6)
  assert.equal(mark(revealIn('ジングルベル', encrypt('ジングルベル'), 'j', KEYS)), 'ジ*****')
  assert.equal(mark(revealIn('ジングルベル', encrypt('ジングルベル'), 'n', KEYS)), '*ン****')
  // 多首字母：ち 收 chi(c) 与 ti(t)
  assert.equal(mark(revealIn('ち', encrypt('ち'), 'c', KEYS)), 'ち')
  assert.equal(mark(revealIn('ち', encrypt('ち'), 't', KEYS)), 'ち')
  assert.equal(mark(revealIn('ち', encrypt('ち'), 'x', KEYS)), '*')
})

test('revealIn：其余按字面（大小写不敏感）；促音不留字母、开不出来', () => {
  assert.equal(mark(revealIn('Reimei', encrypt('Reimei'), 'e', KEYS)), '*e**e*')
  assert.equal(mark(revealIn('Song 2', encrypt('Song 2'), '2', KEYS)), '**** 2', '空格保留，数字按字面翻开')
  // 「ロック」3 字：ロ(1)ッ(2)ク(3)
  assert.equal(mark(revealIn('ロック', encrypt('ロック'), 't', KEYS)), '***', 'っ 不给字母（它本身不发音）')
  assert.equal(mark(revealIn('ロック', encrypt('ロック'), 'k', KEYS)), '**ク', '按后一个假名的首字母开')
})

test('revealIn：已翻开的位不动；不命中的位保持遮罩', () => {
  const one = revealIn('今日', encrypt('今日'), 'j', KEYS)
  assert.equal(mark(one), '今*')
  const two = revealIn('今日', one, 'r', KEYS)
  assert.equal(mark(two), '今日', '二次翻开不应把已开的位盖回去')
  assert.equal(mark(revealIn('今日', two, 'z', KEYS)), '今日', '无命中时原样返回')
})

test('revealIn：表外字符（新曲引入的新字）开不出来，且不报错', () => {
  const src = '龘靐'
  const k = resolveKeys({ hanzi: { 龘: 'd' } }) // 只认识第一个
  assert.equal(mark(revealIn(src, encrypt(src), 'd', k)), '龘*')
  assert.equal(mark(revealIn(src, encrypt(src), 'b', k)), '**', '表外的 靐 永不翻开')
})

test('containsLetter：判「这几首曲目中不包含字母 X」', () => {
  assert.equal(containsLetter('ジングルベル', 'n', KEYS), true)
  assert.equal(containsLetter('今', 'j', KEYS), true)
  assert.equal(containsLetter('ABC', 'a', KEYS), true)
  assert.equal(containsLetter('ABC', 'z', KEYS), false)
})

test('boardText：未解出显示遮罩，已解出显示曲名与猜中者', () => {
  const mk = (name, blur, winner = null) => ({ song: { song_name: name }, blur, winner })
  const game = {
    rows: [
      mk('Today', encrypt('Today')),
      mk('Reimei', null, '小明'),
      mk('Song 2', encrypt('Song 2')),
    ],
  }
  assert.equal(
    boardText(game),
    ['1. *****', '2. Reimei ✅ @小明', '3. **** *'].join('\n'),
  )
  assert.equal(isRowSolved(game.rows[0]), false)
  assert.equal(isRowSolved(game.rows[1]), true)
  assert.equal(allSolved(game), false)
  assert.equal(allSolved({ rows: [mk('x', null)] }), true)
})

test('openedText：已翻开字母排序展示', () => {
  assert.equal(openedText({ opened: new Set(['J', 'A', 'K']) }), 'A J K')
  assert.equal(openedText({ opened: new Set() }), '')
})
