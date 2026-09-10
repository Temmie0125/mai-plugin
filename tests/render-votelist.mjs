/**
 * 别名投票列表页渲染冒烟（P3c）：真实曲库 + 真实返回样例 → voteListView → 宿主 puppeteer 截图
 * 运行：cd E:/bot/Yunzai && node plugins/mai-plugin/tests/render-votelist.mjs
 * 输出 plugins/mai-plugin/tests/out/votelist.jpg（目检）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, { get: (t, p) => (p in console ? console[p].bind(console) : (...a) => a.join(' ')) })
}
if (!global.segment) global.segment = { image: buf => ({ type: 'image', buffer: buf }) }
if (!global.redis) {
  const mem = new Map()
  global.redis = {
    async set(k, v) { mem.set(k, v); return 'OK' },
    async get(k) { return mem.get(k) ?? null },
    async del(...keys) { let n = 0; for (const k of keys) { mem.delete(k); n++ } return n },
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

const { mai } = await import('../lib/service.js')
const { sortVotes } = await import('../lib/handler.js')
const { voteListView } = await import('../lib/render/views.js')
const { renderVoteList } = await import('../lib/render/picmodle.js')

await mai.init({ network: false })
console.log('曲库:', mai.totalList.root.length, '曲')

// 用户提供的真实返回样例（含自带前导「- 」的 tag）
const RAW = [['J0LA1',399,'没毛'],['6NQ2D',375,'osa'],['E2JRV',10375,'就差一步'],['- XFDM4',11872,'无言'],
  ['WHL67',10699,'dx天狗落文'],['M4HAE',11613,'mp'],['- YKJXS',295,'血月'],['T60XQ',389,'花花'],
  ['2Y150',389,'服老二'],['- IOZV3',711,'拜谢'],['H4M03',11848,'火陈'],['G1IU9',836,'再见摸几'],
  ['- J1W42',203,'帮帮我'],['V83TC',255,'炎之天使'],['I7XLW',628,'光线调谐'],['- NGCYP',11061,'镜音铃能飞']]
  .map(([tag, song_id, apply_alias], i) => ({ tag, song_id, apply_alias, agree_votes: i % 3, votes: 5, name: '' }))

const view = voteListView({ votes: sortVotes(RAW).slice(0, 14), page: 1, totalPage: 2, botName: 'Hikari', startIndex: 0 })
console.log('视图:', view.width + '×' + view.height)
const buf = await renderVoteList(view)
if (typeof buf === 'string') { console.error('渲染失败:', buf); process.exit(1) }
if (!Buffer.isBuffer(buf)) { console.error('非 Buffer:', typeof buf); process.exit(1) }
const file = path.join(OUT, 'votelist.jpg')
fs.writeFileSync(file, buf)
console.log('已写出', file, buf.length, 'bytes | JPEG 魔数:', buf.slice(0, 3).toString('hex'))
process.exit(0)
