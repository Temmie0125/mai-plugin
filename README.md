<!--
 * @Author: Temmie0125 1179755948@qq.com
 * @Date: 2026-09-09 14:46:59
 * @LastEditors: Temmie0125 1179755948@qq.com
 * @LastEditTime: 2026-09-09 19:14:17
 * @FilePath: \实验与作业e:\bot\Yunzai\plugins\mai-plugin\README.md
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
# mai-plugin

<p align="center">
  <img src="resources/icons/plugin_icon.png" width="128" alt="mai-plugin">
  <p align="center">TRSS-Yunzai 舞萌DX插件
  </p>
</p>

TRSS-Yunzai v3 舞萌DX（maimai DX）查询插件 —— 移植自 [nonebot-plugin-maimaidx](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx)（Yuri-YuzuChaN）开源项目，按 Yunzai 生态习惯本地化重写。

## 命令总览

指令前缀 `#` 或 `/` 均可触发；命令头默认 `mai`，可在配置中修改。发送 `#mai help` 查看完整帮助图。

```
#mai b50 / ap50 / score <曲名> / ginfo / song <关键词> / what <词>
#mai table <定数> / plate <条件或版本称号> / progress / list
#mai bind lxns|df / source / theme
#mai guess / guessill / fortune / rand / rise
#mai alias … / push on|off / sync
```

口语指令（无需前缀）保留：`来首紫14`、`XX是什么歌`、`我要上20分`、`XX有什么别名` 等。

> 相比原插件的行为变化：查歌族统一收编为 `#mai <子命令>`；原 `id nnn` 改为 `#mai song <纯数字>`；原「更新定数表/更新完成表」已删除（改为运行时渲染）；`update` 一词刻意避开，数据同步用 `#mai sync`。

## 安装与资源

### 1. 安装插件

```bash
cd <Yunzai根>/plugins
git clone https://github.com/Temmie0125/mai-plugin mai-plugin   # 或直接解压到 plugins/mai-plugin
```

### 2. 静态资源包（必需，约 600MB，不入 git 仓库）

资源根固定为 `plugins/mai-plugin/resources/static/`，二选一：

- **老用户（从 NoneBot 版迁移）**：把 NoneBot 资源包 `static/` 目录**整体复制**过来：

  ```
  xcopy /E /I "NoneBot资源包路径\static" "Yunzai\plugins\mai-plugin\resources\static"
  ```

  要求复制后存在 `static/mai/`、`static/font/`、`static/data/`、`static/echarts.min.js` 同级结构（与源包零差异）。`static/data/user.db` 是旧用户数据库，可一并复制供迁移（P2 提供导入脚本）；不复制则重新绑定。

- **新用户**：下载静态资源包压缩包（请前往[源项目主页](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx)进行下载），解压到 `plugins/mai-plugin/resources/`，保证目录结构为 `resources/static/mai/...`。

启动时自动检测：曲绘数 < 500 会红字告警并引导。缺失单项素材渲染时在线回退（可配 `assetsOnline`）。

## 配置

首次启动自动从 `config/default_config/` 生成 `config/config/` 用户副本：

- `config.yaml`：命令头（`cmdhead`）、双查分器凭据、渲染参数等，修改后重启生效；
- `banGroup.yaml`：封禁群列表。

装有 Guoba-Plugin 时可在面板中直接修改以上配置项。

## 运行数据

- `data/user.json`：用户绑定与主题（自 NoneBot 版 `user.db` JSON 化）；
- `data/group.json`：群开关（猜歌 / 别名推送）；
- `data/music/`：曲库/别名/牌子运行时缓存（`#mai sync` 重建）。

## 美术与版权声明（必读）

本插件的卡面布局、切图组合与配色方案**派生自 nonebot-plugin-maimaidx（作者 Yuri-YuzuChaN，https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx） 的美术设计**，仅作信息级还原复用，相关权利归原作者所有，感谢其开源贡献。

- 舞萌DX 相关素材版权归 SEGA 等原权利方所有，素材包由用户自行下载，请于 24 小时内自行删除或支持正版；
- 资源包内字体仅限个人学习研究，禁止商用；

## 开发

```bash
cd plugins/mai-plugin
node --test tests/          # 纯函数单测（配置/数据库/正则/帮助数据）
node tests/render-help.mjs  # 在 Yunzai 根目录运行：渲染管线冒烟，输出 tests/help.png
```

## 鸣谢

- [Yuri-YuzuChaN/nonebot-plugin-maimaidx](https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx) —— 美术设计与功能蓝本
- [Catrong/phi-plugin](https://github.com/Catrong/phi-plugin) —— Yunzai 侧架构范式参考
- TRSS-Yunzai 团队
