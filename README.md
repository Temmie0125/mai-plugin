<div align="center">
  <img src="resources/icons/plugin_icon.png" width="128" alt="mai-plugin">
  <h3>TRSS-Yunzai 舞萌DX插件
  </h3>

<img alt="GitHub issues" src="https://img.shields.io/github/issues/Temmie0125/mai-plugin?style=flat-square"/>
<img alt="GitHub license" src="https://img.shields.io/github/license/Temmie0125/mai-plugin?style=flat-square"/>
<img alt="GitHub stars" src="https://img.shields.io/github/stars/Temmie0125/mai-plugin?style=social"/>

[![version](https://img.shields.io/badge/插件版本-0.1.0-9cf?style=flat-square)](./)
[![version](https://img.shields.io/badge/舞萌DX-2026-9cf?style=flat-square)](./)
[![TrssYunzai](https://img.shields.io/badge/TRSS--Yunzai-v3.0-9cf?style=flat-square&logo=dependabot)](../../TimeRainStarSky/Yunzai)


</div>

## 简介

TRSS-Yunzai v3 舞萌DX（maimai DX）查询插件 —— 移植自 [nonebot-plugin-maimaidx](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx)（Yuri-YuzuChaN）开源项目，按 Yunzai 生态习惯本地化重写。

同时兼容 **OneBot（QQ 号）** 与 **官方 QQBot（openid）** 两种事件协议：绑定与查询以平台用户标识原样落库。openid 环境下水鱼查分器按 QQ 代查受限——可发送 `#mai bind qq <你的QQ号>` 主动补充游戏 QQ 解锁水鱼（`bind qq clear` 解除）；落雪数据源无需 QQ、全功能可用。

## 命令总览

指令前缀 `#` 或 `/` 均可触发；命令头默认 `mai`，可在配置中修改。发送 `#mai help` 查看完整帮助图。

```
#mai b50 / ap50 / score <曲名> / ginfo <曲名> / rank <用户名|页码> / myrank
#mai song <曲名|ID> / search <关键词> / what <词>
#   检索语法：search 定数14+ / 定数14-15 / bpm200-300（区间用 - 或 ~，尾部数字为页码）
#mai fsline [难度色]<曲名|ID|别名> [达成率]
#   分数线成图（四张表全由物量推出）；难度色与曲名顺序可互换，达成率可省略
#mai table <定数> / plate <条件或版本称号> / plateinfo / progress / list
#mai bind lxns|df|qq / unbind <lxns|df|qq> / source / theme
#mai guess / guessill / letter（开字母）/ fortune（今日舞萌）/ rand / rise
#   游戏进行中：开 <一个字符> 翻牌 · #mai tips 提示 · #mai ans 答案 · guess on|off|reset 群开关
#mai alias <词> 查别名 / alias apply <ID> <别名> 申请 / vote <ID> 同意 / votes 当前投票
#   / alias local <ID> <别名> 本地别名 / alias sync 更新别名库
#mai push on|off 群别名推送开关 / push global on|off 全局（仅主人）
#mai 更新 / 强制更新 / download（资源包）/ sync（曲库）—— 均仅主人
```

口语指令（无需前缀）保留：`今天mai什么`、`来个紫14`、`今日舞萌`、`XX是什么歌`、`我要上20分`、`XX有什么别名`、`真极完成表` 等。

> 相比原插件的行为变化：查歌族统一收编为 `#mai <子命令>`（`song` 精确出详情卡，`search` 检索出列表——对齐 phi-plugin 的 search 心智）；原 `id nnn` 改为 `#mai song <纯数字>`；原「更新定数表/更新完成表」已删除（改为运行时渲染）；`update` 一词刻意避开，数据同步用 `#mai sync`。

> `#mai fsline`：单曲分数线成图，内含「分数线 / DX 等级 / 目标评级 / BREAK 等效数量」四张表，全部由谱面物量（各判定音符数）推出、与达成率无关；带达成率时在图外附加一行该达成率下的容错文本。难度色与曲名顺序可互换（`紫799` / `799 紫`），达成率可省略（只出图）。`#mai fsline 帮助` 查看详细用法。

## 安装与资源

### 1. 安装插件

```bash
cd <Yunzai根>/plugins
git clone https://github.com/Temmie0125/mai-plugin mai-plugin   # 或直接解压到 plugins/mai-plugin
```

插件无额外依赖，开箱即用，克隆仓库后重启Bot即可。

### 2. 静态资源包（必需，约 600MB，不入 git 仓库）

资源根固定为 `plugins/mai-plugin/resources/static/`。**首选途径**是装好插件后由主人（超级用户）执行：

```
#mai download      # 或 #mai 下载资源
```

首次执行自动克隆资源仓库 `https://github.com/Temmie0125/mai-plugin-resource-static.git`；之后再次执行即为**增量更新**（已是最新会直接回执，不会重复下载）。若 `resources/static/` 下已手工放好资源包（下方两条迁移途径），命令会**就地接管**该目录、只补差异，不会重下 600MB；目录内的 `data/` 不会被清除，迁移用户的 `user.db` 与曲库缓存均保留。

也可以先手工放好资源包、再执行一次 `#mai download` 接管：

- **老用户（从 NoneBot 版迁移）**：把 NoneBot 资源包 `static/` 目录**整体复制**过来：

  ```
  xcopy /E /I "NoneBot资源包路径\static" "Yunzai\plugins\mai-plugin\resources\static"
  ```

  要求复制后存在 `static/mai/`、`static/font/`、`static/data/`、`static/echarts.min.js` 同级结构（与源包零差异）。`static/data/user.db` 是旧用户数据库，可一并复制供迁移（P2 提供导入脚本）；不复制则重新绑定。

- **新用户**：下载静态资源包压缩包（请前往[源项目主页](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx)进行下载），解压到 `plugins/mai-plugin/resources/`，保证目录结构为 `resources/static/mai/...`。

国内直连 GitHub 不畅时，把配置项 `assetsRepo` 改填代理前缀地址即可，例如 `https://gh-proxy.com/https://github.com/Temmie0125/mai-plugin-resource-static.git`。

启动时自动检测：曲绘数 < 500 会红字告警并引导。缺失单项素材渲染时在线回退（可配 `assetsOnline`）。

## 配置

首次启动自动从 `config/default_config/` 生成 `config/config/` 用户副本：

- `config.yaml`：命令头（`cmdhead`）、双查分器凭据、渲染参数、静态资源包地址与自动更新（`assetsRepo` / `autoUpdateAssets`）、每日自动同步（`autoSync` / `autoSyncTime`）等，修改后重启生效；
- `banGroup.yaml`：封禁群列表。

装有 Guoba-Plugin 时可在面板中直接修改以上配置项。

> [!NOTE]
> 使用水鱼 OAuth 绑定时，用户发送 `#mai bind df`，BOT 会返回一条授权链接，用户打开并确认页面上显示的绑定身份后点击「同意授权」即可，**不需要把授权码回贴给 BOT**。绑定关系与授权范围保存在水鱼服务端，BOT只保管应用凭据，不保存任何用户令牌；用户可随时在 https://auth.diving-fish.com/apps 撤销授权。未绑定的用户仍可使用 `#mai b50` 指令。

> [!WARNING]
> 开发者 token 已被水鱼查分器弃用：它能按 QQ 号读取任意用户的成绩，用户从未对 BOT 做过授权，也无法撤销。水鱼已停止签发新的开发者 token，并将在过渡期后关闭该鉴权方式。请申请 OAuth 应用并配置 `dfClientId` 与 `dfClientSecret`。
> 您在申请水鱼 OAuth 应用时，请至少申请「读取你在查分器的资料」和「读取你的舞萌 DX 成绩的权重」两项权限。权限不足本插件对应功能将无法工作。

> [!NOTE]
> 使用落雪 OAuth 绑定时，可在群聊或私聊发送 `#mai bind lxns`，按提示完成授权后发送授权码或完整回调链接；群聊发起的绑定也可以转到同一 Bot 的私聊完成。若设置 `lxnsBindPrivateOnly=true`，群聊只会提示用户添加 Bot 好友后前往私聊。部分 OneBot 实现无法接收陌生人的私聊消息，因此该选项默认关闭。
> 您在申请落雪 OAuth 应用时，OAuth 权限范围请选择前三项，不包括「读取个人API秘钥」。权限不足本插件对应功能将无法工作。
> 绑定后还需在落雪查分器「账号设置 → 隐私设置」中开启「允许读取玩家信息」「允许读取谱面成绩」「允许读取历史成绩」三项，否则 BOT 无法获取您的落雪数据（查询被拒时回复中也会给出此引导）。

> [!NOTE]
> 插件带有别名更新推送功能，默认关闭全部群组推送，仅白名单群聊会启用。如有需要请在对应群内使用指令 `#mai push on`（需要管理员或群主）；`#mai push global on` 为全局开关（仅主人）。


## 插件更新

仓库已内置 git 远程（`https://github.com/Temmie0125/mai-plugin`）。主人（超级用户）发送：

- `#mai 更新`：`git pull` 拉取远端更新（本地改动冲突时引导强制更新）；
- `#mai 强制更新`：`git fetch --all --prune` → `reset --hard origin/main` → `clean`，**放弃本地未提交改动**（自动保留 `resources/static/`、`data/`、`config/config/`、`tests/` 等运行产物与用户数据）；
- `#mai download` / `#mai 下载资源`：单独下载或更新静态资源包（即下面自动跟进的那一步，可随时手动执行）。

插件更新成功后会按配置项 `autoUpdateAssets`（默认**开启**）自动检查并更新静态资源包——等同 phi-plugin 更新插件时自动拉曲绘。不需要可在锅巴面板或 `config/config/config.yaml` 里关掉。

更新成功会回执最近提交日志；涉及命令/启动逻辑的改动需**重启 Bot** 生效。

自定义分发：改仓库 remote 即可 `git remote set-url origin <你的仓库地址>`；资源包地址同理，改配置项 `assetsRepo`。

## 运行数据

- `data/user.json`：用户绑定与主题（自 NoneBot 版 `user.db` JSON 化）；
- `data/group.json`：群开关（猜歌 / 别名推送，**默认全关**，白名单语义——只有显式开过的群才生效）；
- `data/music/`：曲库/别名/牌子运行时缓存（`#mai sync` 重建）。

曲库默认**每日 05:30 自动同步**一次。主人可随时用 `#mai sync`（别名 `更新曲库` / `数据更新`）手动同步；不需要自动同步就把配置项 `autoSync` 关掉，改为纯手动。

> [!IMPORTANT]
> 若在宿主 `config/config/bot.yaml` 里启用了**定时更新**（`update_cron`）或**间隔更新**（`update_time`），请把本插件的 `autoSyncTime` 与之**错开**，避免同步进行到一半被宿主重启打断。特别注意 `update_time` 是「启动后 N 分钟」的间隔模式，触发时刻**不可预测**，靠挑时间躲不掉——因此本插件的写盘一律采用**原子替换**（先写 `.tmp` 再 rename），被任何来源的重启打断都不会留下截断的缓存文件。

## 美术与版权声明（必读）

本插件的卡面布局、切图组合与配色方案**派生自 nonebot-plugin-maimaidx（作者 Yuri-YuzuChaN，https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx） 的美术设计**，仅作信息级还原复用，相关权利归原作者所有，感谢其开源贡献。

- 舞萌DX 相关素材版权归 SEGA 等原权利方所有，素材包由用户自行下载，请于 24 小时内自行删除或支持正版；
- 资源包内字体仅限个人学习研究，禁止商用；

## 开发

### 调试数据安全（重要）

- 任何离线脚本/调试驱动若 import `lib/database.js`，**必须**先 `setDataRoot(临时目录)`——
  直接读写真机 `data/` 会导致用户绑定凭据被旧快照覆盖（lxns 401 刷新后的新 refresh_token
  一旦被旧值回退即不可逆失效，服务端已轮换）。
- `lib/database.js` 已内置三道防护：行级 read-merge-write（磁盘为全集，尊重外部新增/删除）、
  凭据空值不回退（accessToken/refreshToken/friendCode）、写前时间戳备份轮转
  （`user.json.<yyyymmddHHmmss>.bak`，保留最近 10 份，可用于人工回溯）。

```bash
cd plugins/mai-plugin
npm test                    # 纯函数单测（node --test "tests/*.test.js"）
# 渲染冒烟三连（须在 Yunzai 根目录；流程与判定见 docs/visual-acceptance.md）：
cd <Yunzai根>
node plugins/mai-plugin/tests/render-pages.mjs     # JS 出图 → tests/out/*.jpg
node plugins/mai-plugin/tests/refs/make_refs.py    # 源 NoneBot PIL 参照图（需 venv python）
node plugins/mai-plugin/tests/refs/compare.py      # 数值比对报告
# 分数线海报：
node plugins/mai-plugin/tests/render-fsline.mjs    # 渲染冒烟 → tests/out/fsline.png
# 四表算法的对照基准由 tests/refs/gen-fsline-ref.mjs 真跑用户样板生成（fsline_ref.json 已入库，无需样板）
```

## 许可

本项目 **mai-plugin** 整体以 **GNU General Public License v3.0（GPL-3.0）** 发布，完整许可证文本见仓库根目录 [`LICENSE`](LICENSE)。你可以在 GPL-3.0 条款下使用、修改和分发本项目；分发修改版、衍生作品或打包产物时，必须按 GPL-3.0 提供相应源代码，保留版权与许可声明，并附带 GPL-3.0 全文。

本项目移植自 [nonebot-plugin-maimaidx](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx)，该源项目采用 **MIT License**。MIT 许可允许商业或非商业使用，但要求在所有副本或重要部分中保留原始版权声明和 MIT 许可声明。MIT 与 GPLv3 兼容；因此，源自该项目的代码部分在被纳入本项目后，整体按 GPL-3.0 分发，同时其原始 MIT 许可与版权声明继续适用，分发时不得移除。原始 MIT 许可与版权声明收录于 [`MIT-nonebot-plugin-maimaidx.txt`](MIT-nonebot-plugin-maimaidx.txt)。

由于本项目作为 **TRSS-Yunzai** 插件运行，而 TRSS-Yunzai 上游采用 GPL-3.0，为满足 GPL 对衍生/组合作品的开源要求，并避免许可不确定性，本项目选择以 GPL-3.0 开源发布。

分发或修改时，请遵守以下要求：

- 附上仓库根目录 `LICENSE` 中的 GPL-3.0 全文；
- 保留 `MIT-nonebot-plugin-maimaidx.txt` 或等价文件中的 MIT 许可与原始版权声明；
- 标明本项目对 `nonebot-plugin-maimaidx` 的移植、修改关系；
- 若分发二进制、打包资源或其他非源码形式，应按 GPL-3.0 向接收者提供对应源代码；
- 商业使用可以，但不得通过闭源方式规避 GPL-3.0 的源码开放要求；MIT 部分仍需保留署名与许可声明；
- 舞萌DX 相关素材、字体等第三方资源的版权限制，详见上文“美术与版权声明”。

本项目按“现状”提供，不提供任何明示或默示担保。以上内容仅为许可证说明，不构成法律意见；如有疑问，请咨询专业律师。

## 鸣谢

- [Yuri-YuzuChaN/nonebot-plugin-maimaidx](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx) —— 美术设计与功能蓝本
- [Catrong/phi-plugin](https://github.com/Catrong/phi-plugin) —— Yunzai 侧架构范式参考
- TRSS-Yunzai 团队
