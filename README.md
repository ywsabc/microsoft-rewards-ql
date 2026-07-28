# Microsoft Rewards 青龙重构版

这是一个独立的青龙 Node.js 脚本目录。青龙版基于 ScriptCat 脚本
[微软积分商城签到（全能智能重构版）v3.0.2](https://scriptcat.org/zh-CN/script-show-page/6241)
重构，保留原作者、来源和 MIT 许可证信息。

## 文件

- `microsoft_rewards_ql.js`：青龙共享运行核心，Node.js 18+，无第三方运行依赖。
- `microsoft_rewards_task_*.js`：7 个独立青龙定时任务入口。
- `browser-extension/`：管理多个 Rewards 账号的 Cookie/OAuth Token 并统一同步青龙的
  Manifest V3 扩展。
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
活动提交后会同时复核 `earn` 与 `getuserinfo` 的明确完成字段；卡片从某个列表消失
不再被当作完成。

当前青龙版能识别首页待领取积分，并使用页面同款 Server Action 领取后复核余额。
仍不会模拟依赖完整浏览器交互的特殊 Punch Card。普通每日活动和卡片会优先通过
`getuserinfo` 与新版 Rewards Server Action 处理。
零分引导、长期搜索目标和锁定卡片不会按普通积分卡片提交，但会在结果中明确列出，
避免把“不可安全自动处理”显示成“全部完成”。

## 青龙配置

不想手工从开发者工具复制 Cookie 时，可以使用
[`browser-extension`](browser-extension/README.md)。扩展复用原脚本 OAuth 客户端获取
refreshToken，并且只向 Microsoft 登录服务和用户填写的青龙地址发送请求。

在青龙环境变量中添加 `BING_REWARDS_ACCOUNTS`，值为 JSON 数组：

```json
[
  {
    "name": "账号1",
    "cookie": ".MSA.Auth=...; _U=...; ...",
    "searchCookie": "_U=...; MUID=...; ...",
    "cookieFingerprint": "由扩展自动同步",
    "refreshToken": "M.R3_BAY....",
    "oauthRuid": "由扩展自动同步"
  },
  {
    "name": "账号2",
    "cookie": ".MSA.Auth=...; _U=...; ...",
    "searchCookie": "_U=...; MUID=...; ...",
    "cookieFingerprint": "由扩展自动同步",
    "refreshToken": "M.R3_BAY....",
    "oauthRuid": "由扩展自动同步"
  }
]
```

- `name`：账号备注。
- `cookie`：必填。在已登录 `https://rewards.bing.com/` 的浏览器请求头中取得完整
  `Cookie` 值；认证字段可能是 `.MSA.Auth` 或新版 `_C_Auth`。
- `searchCookie`：可选但推荐。在已登录 `https://www.bing.com/` 的浏览器请求头中
  取得。未配置时沿用 `cookie`；浏览器扩展会分别读取并自动填写两个站点的 Cookie。
- `cookieFingerprint`：扩展根据两个站点的登录字段生成；核心会重新计算并拒绝指纹
  不一致、Cookie 重复或两个站点 `_U` 不一致的账号。
- `refreshToken`：推荐配置，用于 App 签到和阅读。
- `oauthRuid`：浏览器扩展自动写入的匿名账号标识，用于阻止多账号 Token 串号。
  旧配置缺少此字段时，核心只允许在 Cookie 与 App 余额完全一致后建立本机绑定，
  仍建议尽快用扩展重新同步。
- `authCode`：可选的一次性授权码或完整 OAuth 回调 URL。兑换成功后，新的
  `refreshToken` 会保存到 `.state`，之后不再需要配置 `authCode`。

单账号也可以分别使用：

```text
BING_REWARDS_NAME
BING_REWARDS_COOKIE
BING_REWARDS_SEARCH_COOKIE
BING_REWARDS_REFRESH_TOKEN
BING_REWARDS_AUTH_CODE
BING_REWARDS_OAUTH_RUID
BING_REWARDS_COOKIE_FINGERPRINT
```

不要同时使用单账号变量和 `BING_REWARDS_ACCOUNTS`；存在多账号变量时，以它为准。

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

## 青龙任务

完整步骤见 [青龙安装与运行教程](docs/QINGLONG.md)。脚本无需执行 `npm install`。
在青龙终端执行：

```sh
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

该命令会拉取共享核心和 7 个入口脚本，并根据每个入口的 `name`、`cron` 自动添加或
更新签到、阅读、活动、电脑搜索、移动搜索、连签和领取任务。若面板全局配置关闭了
自动添加任务，请在“配置文件”中设置 `AutoAddCron="true"`。

例如手动执行签到和移动搜索：

```sh
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_sign.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_mobile.js
```

建议先临时设置：

```text
BING_REWARDS_DRY_RUN=1
```

确认日志能读取积分、搜索配额和连签状态后，再改回 `0`。普通任务默认在
09:07 至 12:07 之间错峰执行；电脑搜索在白天分 5 轮执行，具体时间见教程。

本地/青龙 Node.js 验证：

```sh
cd MicrosoftRewardsQL
npm test
```

不带账号 Cookie、不会提交 Rewards 活动的真实在线只读检查：

```sh
npm run test:online
```

已经配置账号环境变量后，可执行真实账号只读验收；命令会强制 `dry-run`，不会刷新
OAuth、写令牌或提交任务：

```sh
npm run test:account
```

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
