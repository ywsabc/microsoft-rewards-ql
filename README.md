# Microsoft Rewards 青龙重构版

这是一个独立的青龙 Node.js 脚本目录。青龙版基于 ScriptCat 脚本
[微软积分商城签到（全能智能重构版）v3.0.2](https://scriptcat.org/zh-CN/script-show-page/6241)
重构，保留原作者、来源和 MIT 许可证信息。

## 文件

- `microsoft_rewards_ql.js`：青龙共享运行核心，Node.js 18+，无第三方运行依赖。
- `microsoft_rewards_task_*.js`：7 个独立青龙定时任务入口。
- `browser-extension/`：浏览器插件源码；青龙拉取命令不会安装它，用户应从 Release
  单独下载发布包。
- `upstream/MicrosoftRewardsAuto-3.0.2.user.js`：抓取的原始源码，未修改。
- `LICENSE`：MIT License，保留原作者署名。
- `AUDIT.md`：质量审查、规格矩阵和已知技术债。
- `docs/QINGLONG.md`：青龙拉取、自动创建任务、定时配置和首次运行教程。
- `test/`：离线运行时、安全、源码完整性测试，以及显式运行的只读在线冒烟测试。

原始源码 SHA-256：

```text
12e286fccbac50ce615816582e5f723581076fbbea27877717649bd6b440629f
```

## 与浏览器版的差异

浏览器版自动读取已登录浏览器的 Cookie，并能通过 DOM 点击页面元素。青龙没有浏览器
上下文，因此青龙版：

- 通过环境变量接收 Microsoft/Bing 登录 Cookie；
- 为每个账号维护独立的内存 Cookie jar；
- 通过 `refreshToken` 或一次性 `authCode` 使用 App 接口；
- 用 HTTP 接口完成 PC/App 签到、阅读、活动卡片和搜索；
- 查询连签状态，但不伪造依赖真实浏览器 DOM 的点击结果；
- 使用仓库根目录的 `sendNotify.js` 发送青龙通知；
- 把续期后的 `refreshToken` 写入按账号身份隔离的 `.state/备注-身份摘要.json`，
  文件权限为 `0600`。

微软页面与未公开接口随时可能变化。接口没有明确确认成功时，脚本会报告失败或跳过，
不会仅因为请求已发出就标记成功。
活动提交后会同时复核 `earn`、`dashboard` 与 `getuserinfo` 的明确完成字段；卡片
从某个列表消失不再被当作完成。

当前青龙版能识别首页待领取积分，并使用页面同款 Server Action 领取后复核余额。
仍不会模拟依赖完整浏览器交互的特殊 Punch Card。当天 3 个每日活动从
`dashboard` 的 `dailySetItems` 读取，使用新版 Rewards Server Action 处理，并回读
`dashboard` 的 `isCompleted` 字段逐卡确认；其他普通卡片继续从 `earn` 读取和复核。
零分引导、长期搜索目标和锁定卡片不会按普通积分卡片提交，但会在结果中明确列出，
避免把“不可安全自动处理”显示成“全部完成”。

## 青龙配置

不想手工从开发者工具复制 Cookie 时，可以单独下载
[浏览器插件发布包](https://github.com/ywsabc/microsoft-rewards-ql/releases/latest)。
青龙拉取只安装运行脚本，不包含浏览器插件。扩展复用原脚本 OAuth 客户端获取
refreshToken，并且只向 Microsoft 登录服务和用户填写的青龙地址发送请求；详细用法
见[插件说明](browser-extension/README.md)。

账号配置改为与 `JD_COOKIE` 相同的青龙管理方式：**一个账号添加一条独立环境
变量，每条都使用同一个名称 `bing_ck`**。两个账号就是两条 `bing_ck`，三个账号
就是三条；没有 `bing_ck_1`、`bing_ck_2`，执行身份也不依赖排列顺序。

单条 `bing_ck` 内的 Cookie 字段使用 `&` 分隔。手工添加单账号的最简形式例如：

```text
名称：bing_ck
值：_U=...&.MSA.Auth=...&MUID=...
```

认证字段也可能是 `_C_Auth`。推荐直接使用
[`browser-extension`](browser-extension/README.md) 同步：扩展会给每条值加入
`__bing_account` 边界以及搜索 Cookie、refreshToken、`oauthRuid` 和 Cookie 指纹。
这些字段仍位于该账号自己的 `bing_ck` 中，不会再创建辅助或编号变量。边界字段是
必要的，因为青龙会在任务启动时自动用 `&` 聚合多条同名环境变量；核心据此还原每个
账号，并继续拒绝 Cookie 重复、OAuth 身份重复、指纹不符和两个站点 `_U` 不一致。

旧版 `BING_REWARDS_ACCOUNTS` 和单账号变量暂时保留为只读迁移兼容；只要存在
`bing_ck`，核心就优先使用新配置。扩展首次成功同步后会清理它创建的旧数组和编号
变量，不删除用户手工维护的其他名称。

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BING_REWARDS_TASKS` | `sign,read,promos,quiz,search,mobile,streak,claim` | 启用的任务；`mobile` 为移动 UA 搜索，`claim` 自动领取首页待领取积分 |
| `BING_REWARDS_LOCK_CN` | `1` | 非大陆出口 IP 时停止 |
| `BING_REWARDS_DRY_RUN` | `0` | `1` 时只查询，不提交任务 |
| `BING_REWARDS_NOTIFY` | `1` | 是否调用根目录 `sendNotify.js` |
| `BING_REWARDS_START_DELAY_MIN` | `5` | 真实执行前随机等待的最小秒数 |
| `BING_REWARDS_START_DELAY_MAX` | `95` | 真实执行前随机等待的最大秒数，与原版一致 |
| `BING_REWARDS_SEARCH_INTERVAL` | `30` | 搜索基础间隔秒数，实际加入 ±15 秒随机量 |
| `BING_REWARDS_SEARCH_COUNT` | `7` | 每轮上限；实际按原版随机执行 4–7 次 |
| `BING_REWARDS_MOBILE_SEARCH_COUNT` | `3` | 每轮最多移动搜索次数；新版国区 Rewards 通常与 PC 共用搜索配额 |
| `BING_REWARDS_SEARCH_SOURCE` | `hot` | `hot/auto` 使用热搜多源并失败回退；`local/offline` 只用本地词库 |
| `BING_REWARDS_MAX_PROMOS` | `20` | 每轮最多处理活动卡片数 |
| `BING_REWARDS_PROMO_RETRY_HOURS` | `12` | 未确认活动卡片的最短重试间隔，避免定时任务重复提交 |
| `BING_REWARDS_DELAY_SCALE` | `1` | 随机等待倍率，范围 `1–10`；不允许关闭生产等待 |
| `BING_REWARDS_STATE_DIR` | 当前目录下 `.state` | 令牌状态目录 |

布尔变量可以使用 `1/0`、`true/false`、`yes/no` 或 `on/off`。

## 青龙一键拉取

脚本无需执行 `npm install`。在青龙终端执行下面两条命令中的一条。

正常拉取：

```sh
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

GitHub 拉取超时时使用备用完整仓库：

```sh
ql repo "https://ghfast.top/https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

两条命令不要重复执行。任意一条成功后都会拉取青龙运行所需的共享核心和 7 个任务
入口，并自动创建或更新签到、阅读、活动、电脑搜索、移动搜索、连签和领取任务。
备用地址只负责源码下载，不会改变 Rewards 运行时的出口 IP。

**浏览器插件不会被青龙拉取。** 请用户自行从
[GitHub Releases](https://github.com/ywsabc/microsoft-rewards-ql/releases/latest)
下载 `microsoft-rewards-ql-extension-*.zip`，解压后加载到 Chrome 或 Edge。简短配置
步骤见[青龙安装与运行教程](docs/QINGLONG.md)。

## 安全与风险

- Cookie、授权码和刷新令牌都属于敏感账号凭据，请勿提交到 Git、日志或发送给他人。
- 自动化任务可能触发 Microsoft Rewards 风控，也可能不符合服务规则；请自行判断并承担风险。
- `.state` 含刷新令牌，已加入 `.gitignore`，仍应限制青龙主机与备份文件的访问权限。
- `.state` 中通过 Cookie 指纹和 `oauthRuid` 校验的续期令牌优先于环境变量；状态
  文件名包含账号身份摘要。同名账号更换 Cookie 后不会读取旧状态。升级后请使用扩展
  重新同步一次；旧版仅按备注命名的状态文件不会再加载。
- 热搜模式会在每个账号开始搜索前随机选择一个榜单，优先使用
  `hotapi.nntool.cc` 或 `cnxiaobai.com/DailyHotApi`，失败时自动切换提供方，全部失败
  才回退本地词库。热搜请求使用独立的无 Cookie HTTP 客户端，不会携带 Microsoft
  Cookie、OAuth Token 或青龙密钥；第三方仍能看到青龙主机的出口 IP 和请求时间。
- 使用热搜词只能减少固定、重复搜索词，不能保证避免 Microsoft Rewards 风控。
- 电脑搜索按 10:47、12:47、14:47、16:47、18:47 分轮执行，每轮随机 4–7 次；
  连续三轮服务端配额不增长时当天熔断，不再继续提交。不要另设高频重复任务。

## 许可证与来源

原始脚本作者：`liyan20001124-byte`

原始脚本页面：<https://scriptcat.org/zh-CN/script-show-page/6241>

原始版本：`3.0.2`

许可证：MIT

青龙重构代码继续使用 MIT License，完整文本见 `LICENSE`。
