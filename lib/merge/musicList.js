/**
 * 曲目列表（源 core/merge/music_list.py MusicList 直译，设计 §5.3）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * ⚠️ filter 语义逐分支照搬：标题/曲师子串匹配（lower）、其余全等/区间，
 * all_diff=false 时裁剪 difficulties；by_level_list 排除 "?" 等级与定数 < 7。
 */
import { Difficulties, Song } from './models.js'

export class MusicList {
  /** @param {Array} root Song[] */
  constructor(root = []) {
    this.root = root
  }

  /** 从缓存 JSON（merge_music_data.json）载入 */
  static fromJSON(data) {
    return new MusicList((data ?? []).map(Song))
  }

  byId(songId) {
    return this.root.find(s => s.song_id === songId) ?? null
  }

  byName(songName) {
    return this.root.find(s => s.song_name === songName) ?? null
  }

  byIdList(songIdList) {
    const set = new Set(songIdList)
    return this.root.filter(s => set.has(s.song_id))
  }

  /** 按等级字面（如 "14+"）归组：song_id → 该等级难度列表 */
  byPlan(level) {
    const result = new Map()
    for (const song of this.root) {
      for (const diff of song.difficulties) {
        if (diff.level === level) {
          if (!result.has(song.song_id)) result.set(song.song_id, [])
          result.get(song.song_id).push(diff)
        }
      }
    }
    return result
  }

  /** 等级 → 定数字符串 → SimpleSong 列表（定数表数据源） */
  byLevelList() {
    const temp = new Map()
    for (const song of this.root) {
      for (const diff of song.difficulties) {
        if (diff.level.includes('?') || diff.level_value < 7) continue
        const key = diff.level_value.toFixed(1)
        if (!temp.has(diff.level)) temp.set(diff.level, new Map())
        const bucket = temp.get(diff.level)
        if (!bucket.has(key)) bucket.set(key, [])
        bucket.get(key).push({
          song_id: song.song_id,
          version_str: song.version_str,
          version_int: song.version_int,
          type: song.type,
          difficulties: diff,
        })
      }
    }
    const lvSort = (lv) => {
      const v = parseFloat(lv.replace(/\+$/, ''))
      return lv.includes('+') ? [v, 1] : [v, 0]
    }
    const result = {}
    for (const lv of [...temp.keys()].sort((a, b) => {
      const [va, oa] = lvSort(a)
      const [vb, ob] = lvSort(b)
      return vb - va || ob - oa
    })) {
      const keys = [...temp.get(lv).keys()].sort((a, b) => parseFloat(b) - parseFloat(a))
      result[lv] = {}
      for (const k of keys) result[lv][k] = temp.get(lv).get(k)
    }
    return result
  }

  random() {
    return this.root[Math.floor(Math.random() * this.root.length)]
  }

  /**
   * 曲目过滤（源 MusicList.filter 直译）
   * @param {object} opts 见源签名；level_value/bpm 可为 [min,max] 二元组
   * @param {boolean} opts.all_diff 默认 true：命中任一难度即整曲收录
   */
  filter(opts = {}) {
    const toList = v => (v == null ? null : Array.isArray(v) ? v : [v])
    const level = toList(opts.level)
    const type = toList(opts.type)
    const genre = toList(opts.genre)
    const versionInt = toList(opts.version_int)
    const versionStr = toList(opts.version_str)
    const { title, artist, charter, all_diff = true } = opts
    let { level_value, bpm } = opts

    const result = []
    for (const song of this.root) {
      if (title && !song.song_name.toLowerCase().includes(title.toLowerCase())) continue
      if (artist && (!song.artist || !song.artist.toLowerCase().includes(artist.toLowerCase()))) continue
      if (type && !type.includes(song.type)) continue

      const newDiffs = []
      for (const diff of song.difficulties) {
        if (level && !level.includes(diff.level)) continue
        if (genre && !genre.includes(song.genre)) continue
        if (versionInt && !versionInt.includes(song.version_int)) continue
        if (versionStr && !versionStr.includes(song.version_str)) continue

        if (level_value != null) {
          if (Array.isArray(level_value)) {
            if (!(level_value[0] <= diff.level_value && diff.level_value <= level_value[1])) continue
          } else if (diff.level_value !== level_value) continue
        }

        if (bpm != null) {
          if (Array.isArray(bpm)) {
            if (!(bpm[0] <= song.bpm && song.bpm <= bpm[1])) continue
          } else if (song.bpm !== bpm) continue
        }

        if (charter && (!diff.note_designer || !diff.note_designer.toLowerCase().includes(charter.toLowerCase()))) continue

        newDiffs.push(diff)
      }

      if (newDiffs.length) {
        // 源 deepcopy 后按需裁剪 difficulties；此处浅拷贝 song（diff 对象只读共享）
        result.push(all_diff ? { ...song } : { ...song, difficulties: newDiffs.map(Difficulties) })
      }
    }
    return result
  }
}
