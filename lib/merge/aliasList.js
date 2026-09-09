/**
 * 别名列表（源 core/merge/alias_list.py AliasList 直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 */
import { Alias } from './models.js'

export class AliasList {
  constructor(root = []) {
    this.root = root
  }

  static fromJSON(data) {
    return new AliasList((data ?? []).map(Alias))
  }

  byId(songId) {
    return this.root.filter(a => a.song_id === songId)
  }

  /** 别名精确命中（大小写不敏感：库内拉丁别名统一小写，查询方可能输入 CMW 等） */
  byAlias(musicAlias) {
    const lower = String(musicAlias).toLowerCase()
    return this.root.filter(a => a.alias.some(x => x.toLowerCase() === lower))
  }
}
