# Microsoft Rewards 青龙重构版

这是一个独立的青龙 Node.js 脚本目录。青龙版基于 ScriptCat 脚本
[微软积分商城签到（全能智能重构版）v3.0.2](https://scriptcat.org/zh-CN/script-show-page/6241)
重构，保留原作者、来源和 MIT 许可证信息。

## 文件

- `microsoft_rewards_ql.js`：青龙版入口，Node.js 18+，无第三方运行依赖。
- `browser-extension/`：获取 Rewards Cookie/OAuth Token 并同步青龙的 Manifest V3 扩展。
- `upstream/MicrosoftRewardsAuto-3.0.2.user.js`：抓取的原始源码，未修改。
- `LICENSE`：MIT License，保留原作者署名。
- `AUDIT.md`：质量审查、规格矩阵和已知技术债。
- `test/`：不联网的运行时、安全与源码完整性测试。

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
- 把续期后的 `refreshToken` 写入 `.state/账号.json`，文件权限为 `0600`。

微软页面与未公开接口随时可能变化。接口没有明确确认成功时，脚本会报告失败或跳过，
不会仅因为请求已发出就标记成功。

当前青龙版不会处理必须在浏览器中点击弹窗的“待领取积分”，也不会模拟依赖完整页面
交互的特殊 Punch Card。普通每日活动和卡片会优先通过 `getuserinfo` 与
`reportactivity` 接口处理。

## 青龙配置

不想手工从开发者工具复制 Cookie 时，可以使用
[`browser-extension`](browser-extension/README.md)。扩展复用原脚本 OAuth 客户端获取
refreshToken，并且只向 Microsoft 登录服务和用户填写的青龙地址发送请求。

在青龙环境变量中添加 `BING_REWARDS_ACCOUNTS`，值为 JSON 数组：

```json
[
  {
    "name": "账号1",
    "cookie": "MUID=...; _U=...; ...",
    "refreshToken": "M.R3_BAY...."
  },
  {
    "name": "账号2",
    "cookie": "MUID=...; _U=...; ...",
    "authCode": "https://login.live.com/oauth20_desktop.srf?code=..."
  }
]
```

- `name`：账号备注。
- `cookie`：必填。在已登录 `https://rewards.bing.com/` 的浏览器请求头中取得完整
  `Cookie` 值。
- `refreshToken`：推荐配置，用于 App 签到和阅读。
- `authCode`：可选的一次性授权码或完整 OAuth 回调 URL。兑换成功后，新的
  `refreshToken` 会保存到 `.state`，之后不再需要配置 `authCode`。

单账号也可以分别使用：

```text
BING_REWARDS_NAME
BING_REWARDS_COOKIE
BING_REWARDS_REFRESH_TOKEN
BING_REWARDS_AUTH_CODE
```

不要同时使用单账号变量和 `BING_REWARDS_ACCOUNTS`；存在多账号变量时，以它为准。

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BING_REWARDS_TASKS` | `sign,read,promos,quiz,search,streak` | 启用的任务 |
| `BING_REWARDS_LOCK_CN` | `1` | 非大陆出口 IP 时停止 |
| `BING_REWARDS_DRY_RUN` | `0` | `1` 时只查询，不提交任务 |
| `BING_REWARDS_NOTIFY` | `1` | 是否调用根目录 `sendNotify.js` |
| `BING_REWARDS_SEARCH_INTERVAL` | `30` | 搜索基础间隔秒数，实际加入 ±15 秒随机量 |
| `BING_REWARDS_SEARCH_COUNT` | `6` | 每轮最多搜索次数 |
| `BING_REWARDS_MAX_PROMOS` | `20` | 每轮最多处理活动卡片数 |
| `BING_REWARDS_DELAY_SCALE` | `1` | 随机等待倍率；生产环境建议保持 `1` |
| `BING_REWARDS_STATE_DIR` | 当前目录下 `.state` | 令牌状态目录 |

布尔变量可以使用 `1/0`、`true/false`、`yes/no` 或 `on/off`。

## 青龙任务

脚本无需执行 `npm install`。在青龙面板的“订阅管理”中新增订阅，或在青龙终端执行：

```sh
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_ql[.]js$' "" "" "main" "js" "" "true" "true"
```

该命令只拉取主脚本，并让青龙根据脚本内的 `name` 和 `cron` 元数据自动添加或更新
“微软积分商城签到（青龙重构版）”任务。默认在每小时的第 7、27、47 分钟执行，即每
20 分钟一次。若面板全局配置关闭了自动添加任务，请在“配置文件”中设置
`AutoAddCron="true"`。

手动执行命令为：

```sh
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_ql.js
```

建议先临时设置：

```text
BING_REWARDS_DRY_RUN=1
```

确认日志能读取积分、搜索配额和连签状态后，再改回 `0`。默认每 20 分钟运行一次，
每轮只执行少量搜索，避免高频请求：

```cron
7,27,47 * * * *
```

本地/青龙 Node.js 验证：

```sh
cd MicrosoftRewardsQL
npm test
```

## 安全与风险

- Cookie、授权码和刷新令牌都属于敏感账号凭据，请勿提交到 Git、日志或发送给他人。
- 自动化任务可能触发 Microsoft Rewards 风控，也可能不符合服务规则；请自行判断并承担风险。
- `.state` 含刷新令牌，已加入 `.gitignore`，仍应限制青龙主机与备份文件的访问权限。
- `.state` 中成功续期的令牌优先于环境变量；如需强制更换账号令牌，请删除对应账号的
  `.state/账号.json` 后再运行。
- 原脚本连接的第三方热搜服务没有迁入青龙版；搜索词默认使用本地词库。

## 许可证与来源

原始脚本作者：`liyan20001124-byte`

原始脚本页面：<https://scriptcat.org/zh-CN/script-show-page/6241>

原始版本：`3.0.2`

许可证：MIT

青龙重构代码继续使用 MIT License，完整文本见 `LICENSE`。
