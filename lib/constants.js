/**
 * 常量表（源 constants.py 整表直译，设计 §5.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN），字段与数值逐项对照源文件。
 */

// 投票
export const VOTE_URL = 'https://www.yuzuchan.moe/maimaidx/aliases'

export const SONGS_PER_PAGE = 25

export const FORTUNE = [
  '拼机', '推分', '越级', '下埋', '夜勤', '练底力', '练手法',
  '打旧框', '干饭', '抓绝赞', '收歌', '打大歌', '推AP',
]

/** 评价小写枚举（顺序 = ACHIEVEMENT_LIST 阈值顺序） */
export const RANK_SP = [
  'd', 'c', 'b', 'bb', 'bbb', 'a', 'aa', 'aaa', 's', 'sp', 'ss', 'ssp', 'sss', 'sssp',
]

export const STATISTICS_KEYS = [
  'clear', 's', 'sp', 'ss', 'ssp', 'sss', 'sssp', 'sync',
  'fc', 'fcp', 'ap', 'app', 'fs', 'fsp', 'fsd', 'fsdp',
]

/** 评价大写形式（p → +） */
export const RANK_PLUS = RANK_SP.map(k => k.replace('p', '+'))

/** 小写评价 → 图标名（sp → Sp、sssp → SSSp） */
export const RANK_MAP = Object.fromEntries(
  RANK_SP.map(k => [k, k.endsWith('p') ? k.slice(0, -1).toUpperCase() + 'p' : k.toUpperCase()])
)

export const COMBO_SP = ['fc', 'fcp', 'ap', 'app']
export const COMBO_PLUS = COMBO_SP.map(k => k.replace('p', '+'))
/** fc 小写 → 图标名（FC/FCp/AP/APp） */
export const COMBO_MAP = Object.fromEntries(
  COMBO_SP.map(k => [k, k.length > 2 && k.endsWith('p') ? k.toUpperCase().slice(0, -1) + 'p' : k.toUpperCase()])
)

export const SYNC_D_SP = ['fs', 'fsp', 'fsd', 'fsdp']
export const SYNC_SP = ['fs', 'fsp', 'fdx', 'fdxp']
export const SYNC_PLUS = SYNC_SP.map(k => k.replace('p', '+'))
export const SYNC_MAP = {
  fs: 'FS', fsp: 'FSp', fsd: 'FSD', fdx: 'FSD',
  fsdp: 'FSDp', fdxp: 'FSDp', sync: 'Sync',
}

export const DIFFS = ['Basic', 'Advanced', 'Expert', 'Master', 'Re:Master']

export const LEVEL_LIST = [
  '1', '2', '3', '4', '5', '6', '7', '7+', '8', '8+', '9', '9+',
  '10', '10+', '11', '11+', '12', '12+', '13', '13+', '14', '14+', '15',
]

export const LEVEL_INDEX_MAP = Object.fromEntries(LEVEL_LIST.map((lv, i) => [lv, i]))

export const ACHIEVEMENT_LIST = [
  50.0, 60.0, 70.0, 75.0, 80.0, 90.0, 94.0, 97.0, 98.0,
  99.0, 99.5, 100.0, 100.5,
]

export const BASE_RA_SPP = [
  7.0, 8.0, 9.6, 11.2, 12.0, 13.6, 15.2, 16.8, 20.0,
  20.3, 20.8, 21.1, 21.6, 22.4,
]

export const SD_VERSION = {
  '初': 'maimai',
  '真': 'maimai PLUS',
  '超': 'maimai GreeN',
  '檄': 'maimai GreeN PLUS',
  '橙': 'maimai ORANGE',
  '暁': 'maimai ORANGE PLUS',
  '晓': 'maimai ORANGE PLUS',
  '桃': 'maimai PiNK',
  '櫻': 'maimai PiNK PLUS',
  '樱': 'maimai PiNK PLUS',
  '紫': 'maimai MURASAKi',
  '菫': 'maimai MURASAKi PLUS',
  '堇': 'maimai MURASAKi PLUS',
  '白': 'maimai MiLK',
  '雪': 'MiLK PLUS',
  '輝': 'maimai FiNALE',
  '辉': 'maimai FiNALE',
}

export const DX_VERSION = {
  ...SD_VERSION,
  '熊': 'maimai でらっくす',
  '華': 'maimai でらっくす PLUS',
  '华': 'maimai でらっくす PLUS',
  '爽': 'maimai でらっくす Splash',
  '煌': 'maimai でらっくす Splash PLUS',
  '宙': 'maimai でらっくす UNiVERSE',
  '星': 'maimai でらっくす UNiVERSE PLUS',
  '祭': 'maimai でらっくす FESTiVAL',
  '祝': 'maimai でらっくす FESTiVAL PLUS',
  '双': 'maimai でらっくす BUDDiES',
  '宴': 'maimai でらっくす BUDDiES PLUS',
  '镜': 'maimai でらっくす PRiSM',
  '彩': 'maimai でらっくす PRiSM PLUS',
}

export const DX_CN_VERSION = {
  '舞萌DX': ['熊&华', 'maimai でらっくす'],
  '舞萌DX 2021': ['爽&煌', 'maimai でらっくす Splash'],
  '舞萌DX 2022': ['宙&星', 'maimai でらっくす UNiVERSE'],
  '舞萌DX 2023': ['祭&祝', 'maimai でらっくす FESTiVAL'],
  '舞萌DX 2024': ['双&宴', 'maimai でらっくす BUDDiES'],
  '舞萌DX 2025': ['镜', 'maimai でらっくす PRiSM'],
  '舞萌DX 2026': ['彩', 'maimai でらっくす PRiSM PLUS'],
}

/** 全版本英文名去重列表（保持插入序） */
export const ALL_VERSION = [...new Set(Object.values(DX_VERSION))]

export const VERSION_MAP = {
  '真': [[SD_VERSION['真'], SD_VERSION['初']], '真'],
  '超': [[SD_VERSION['超']], '超'],
  '檄': [[SD_VERSION['檄']], '檄'],
  '橙': [[SD_VERSION['橙']], '橙'],
  '暁': [[SD_VERSION['暁']], '暁'],
  '桃': [[SD_VERSION['桃']], '桃'],
  '櫻': [[SD_VERSION['櫻']], '櫻'],
  '紫': [[SD_VERSION['紫']], '紫'],
  '菫': [[SD_VERSION['菫']], '菫'],
  '白': [[SD_VERSION['白']], '白'],
  '雪': [[SD_VERSION['雪']], '雪'],
  '輝': [[SD_VERSION['輝']], '輝'],
  '霸': [[...new Set(Object.values(SD_VERSION))], '舞'],
  '舞': [[...new Set(Object.values(SD_VERSION))], '舞'],
  '熊': [[DX_VERSION['熊']], '熊&华'],
  '华': [[DX_VERSION['熊']], '熊&华'],
  '華': [[DX_VERSION['熊']], '熊&华'],
  '爽': [[DX_VERSION['爽']], '爽&煌'],
  '煌': [[DX_VERSION['爽']], '爽&煌'],
  '宙': [[DX_VERSION['宙']], '宙&星'],
  '星': [[DX_VERSION['宙']], '宙&星'],
  '祭': [[DX_VERSION['祭']], '祭&祝'],
  '祝': [[DX_VERSION['祭']], '祭&祝'],
  '双': [[DX_VERSION['双']], '双&宴'],
  '宴': [[DX_VERSION['双']], '双&宴'],
  '镜': [[DX_VERSION['镜']], '镜'],
  '彩': [[DX_VERSION['彩']], '彩'],
}

export const PLATE_CN = { '晓': '暁', '樱': '櫻', '堇': '菫', '辉': '輝', '华': '華' }

/** 曲目分类 → info_xxx.png 切图名 */
export const CATEGORY = {
  '流行&动漫': 'anime',
  '舞萌': 'maimai',
  'niconico & VOCALOID': 'niconico',
  '东方Project': 'touhou',
  '其他游戏': 'game',
  '音击&中二节奏': 'ongeki',
  'POPSアニメ': 'anime',
  'maimai': 'maimai',
  'niconicoボーカロイド': 'niconico',
  '東方Project': 'touhou',
  'ゲームバラエティ': 'game',
  'オンゲキCHUNITHM': 'ongeki',
  '宴会場': '宴会场',
}
