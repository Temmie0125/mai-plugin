/**
 * 曲库全量同步（`#mai sync` 与每日定时任务共用，P3 实施文档 §3.4/§3.5）
 *
 * 同步过程必须崩溃安全：宿主更新器（`plugins/other/update.js`）可能在任何时刻重启进程，
 * 故落盘一律走原子写（见 lib/jsonFile.js），且同步期间不得并跑。
 */
import { mai } from './service.js'
import { rebuildGuessPool } from './guess.js'

/**
 * 同步互斥（文档 §3.4-3）：命令与定时任务共用同一把锁。
 * 必须是**模块级**而非插件实例字段 —— 宿主 loader 会把插件类 `new` 两次
 * （一次读 task、一次注册 handler），实例字段会变成两把互不相干的锁而失去意义。
 */
let syncing = false

/** 是否有同步在进行中（定时任务据此跳过本轮） */
export function isSyncing() {
  return syncing
}

/**
 * 全量重拉曲库/别名/牌子（`lib/service.js:update()` 已实现）
 * @returns {Promise<{busy: boolean}>} busy=true 表示已有同步在跑，本次直接跳过
 * @throws 同步失败时向上抛（调用方用 `handleErrors` 转文案 / 自己记日志）
 */
export async function syncMusicData() {
  if (syncing) return { busy: true }
  syncing = true
  try {
    await mai.update()
    // 同步后重建猜歌池（P3 实施文档 §3.4-4）：源只在启动时建过一次、`update()` 不重建，
    // 于是新曲永远进不了池子；属源缺陷，端口补上。
    rebuildGuessPool()
    return { busy: false }
  } finally {
    syncing = false
  }
}
