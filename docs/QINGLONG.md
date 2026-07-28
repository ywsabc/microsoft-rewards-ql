# 青龙安装与运行教程

本文适用于青龙面板 Node.js 18 及以上版本。脚本只使用 Node.js 内置模块，不需要
执行 `npm install`。

## 1. 拉取脚本并自动创建任务

推荐在青龙“终端”中执行：

```sh
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

仓库地址：

```text
https://github.com/ywsabc/microsoft-rewards-ql.git
```

共享核心单文件地址：

```text
https://raw.githubusercontent.com/ywsabc/microsoft-rewards-ql/refs/heads/main/microsoft_rewards_ql.js
```

命令中的白名单同时拉取共享核心与所有 `microsoft_rewards_task_*.js` 入口；最后
两个 `true` 用于自动添加和更新定时任务。拉取完成后，青龙会自动创建或更新 7 个
独立任务。如果没有自动创建，请在青龙配置文件中确认：

```text
AutoAddCron="true"
```

也可以在“订阅管理”中新建 Git 仓库订阅，仓库地址填写：

```text
https://github.com/ywsabc/microsoft-rewards-ql.git
```

文件白名单填写：

```text
^microsoft_rewards_(ql|task_[a-z_]+)[.]js$
```

勾选“自动添加任务”和“自动删除任务”。建议把源码更新订阅设为每天 04:23
执行一次：

```cron
23 4 * * *
```

## 2. 默认子任务与定时时间

| 青龙任务 | 模块 | Cron |
| --- | --- | --- |
| 微软积分-01签到 | `sign` | `7 9 * * *` |
| 微软积分-02阅读 | `read` | `23 9 * * *` |
| 微软积分-03活动 | `promos,quiz` | `11 10 * * *` |
| 微软积分-04电脑搜索 | `search` | `47 10,12,14,16,18 * * *` |
| 微软积分-05移动搜索 | `mobile` | `29 11 * * *` |
| 微软积分-06连签 | `streak` | `43 11 * * *` |
| 微软积分-07领取 | `claim` | `7 12 * * *` |

以上时间均按青龙容器时区计算，中国大陆用户应确认青龙时区为
`Asia/Shanghai`。除电脑搜索外，其余子任务每天执行一次。电脑搜索恢复原版“少量
分轮”规则，但将原版每 20 分钟触发收敛为白天每 2 小时一轮：每轮随机 4–7 次、
单次间隔 30±15 秒，连续三轮服务端配额不增长时当天熔断。不要再额外添加高频搜索
任务。

## 3. 配置账号

推荐安装仓库 Release 中的浏览器扩展，通过账号备注把 Cookie、搜索 Cookie 和
OAuth refreshToken 同步到青龙。同步完成后，环境变量中应存在：

```text
BING_REWARDS_ACCOUNTS
```

其值为 JSON 数组，每个账号至少包含：

```json
[
  {
    "name": "账号1",
    "cookie": ".MSA.Auth=...; _U=...; ...",
    "searchCookie": "_U=...; MUID=...; ...",
    "cookieFingerprint": "由扩展自动同步",
    "refreshToken": "M.R3_BAY...",
    "oauthRuid": "由扩展自动同步"
  }
]
```

Cookie 和 refreshToken 等同账号密码，不要写入脚本、GitHub Issue 或公开日志。
多账号必须逐个切换 Microsoft 账号并授权。扩展 `3.0.2` 会同步 Cookie 指纹与匿名
`oauthRuid`；授权开始和回调时都会重新读取当前浏览器会话，并要求 Cookie 与 DAPI
余额完全一致。核心还会拒绝重复备注、重复 Cookie、重复 `oauthRuid` 和两个站点
`_U` 不一致的配置。旧配置暂时缺少 `oauthRuid` 时，仅可通过 Cookie/App 余额完全
一致建立本机绑定；升级后仍应重新用扩展同步一次。

## 4. 首次安全测试

在青龙“环境变量”中添加：

```text
BING_REWARDS_DRY_RUN=1
```

然后逐个手动执行自动创建的子任务。仓库拉取方式对应的命令例如：

```sh
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_sign.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_read.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_promos.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_search.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_mobile.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_streak.js
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_task_claim.js
```

共享核心仍可用于一次性手动执行全部模块，但不会自动创建总任务：

```sh
task ywsabc_microsoft-rewards-ql_main/microsoft_rewards_ql.js
```

确认日志能分别读取每个账号的余额、搜索进度、活动和连签状态后，把变量改为：

```text
BING_REWARDS_DRY_RUN=0
```

再启用定时任务。`0` 为真实执行，`1` 只查询不提交。

如果在仓库终端中验收，也可以执行 `npm run test:account`。该命令会在本次进程中强制
启用 `dry-run` 和关闭通知，不受面板里 `BING_REWARDS_DRY_RUN=0` 的影响。

## 5. 默认执行模块

默认模块为：

```text
sign,read,promos,quiz,search,mobile,streak,claim
```

- `sign`：App/兼容签到。
- `read`：App 阅读任务。
- `promos`：普通活动卡片。
- `quiz`：允许处理 Quiz 类型卡片；需要完整浏览器交互的题型可能跳过。
- `search`：带随机间隔的 Bing 搜索；白天分轮运行直到配额完成或触发无进度熔断。
- `mobile`：使用移动端 Bing 协议执行少量搜索，默认每轮 3 次。新版国区 Rewards
  通常把它计入与 PC 相同的合并搜索配额，因此日志会显示“合并配额”。
- `streak`：读取连签状态。
- `claim`：领取首页待领取积分；待领取为 0 时不会发送领取请求。

如需只运行部分模块，可设置：

```text
BING_REWARDS_TASKS=sign,read,claim
```

如需调整移动搜索次数，可设置：

```text
BING_REWARDS_MOBILE_SEARCH_COUNT=3
```

不建议为了跑满配额而提高频率或反复手动执行；电脑搜索已有 5 个错峰轮次，其他
子任务默认每天只运行一次。

## 6. 更新脚本

手动运行原来的仓库拉取或 Git 订阅即可更新。开启自动添加任务后，7 个入口脚本中的
名称和 Cron 元数据也会同步到现有任务。

更新后建议先把 `BING_REWARDS_DRY_RUN` 临时改为 `1`，手动运行一次确认日志，再恢复
为 `0`。

## 7. 常见检查

- 没有自动创建 7 个任务：确认使用了本教程的新白名单，检查
  `AutoAddCron="true"` 以及订阅的自动添加任务开关。
- 显示 Cookie 无效：重新在 Rewards 页面登录并用扩展同步对应账号。
- 阅读显示无 Token：重新获取该账号 OAuth Token，确认备注没有与其他账号重复。
- 搜索不入账：确认扩展同时同步了 Rewards Cookie 和 Bing 搜索 Cookie。
- 搜索显示“连续三轮服务端进度未变化”：当天已安全熔断；先检查 Cookie、账号状态
  和 Microsoft 页面是否限制搜索，不要继续手动高频执行。
- 青龙任务显示失败但日志仍有部分完成：新版会在任一启用模块失败、未确认或关键
  状态无法解析时返回非零退出码，避免把部分执行误报为全部成功。
- 活动显示“提交已接受但未确认”：请求已经到达服务端，但 `earn`/`getuserinfo`
  没有返回明确完成状态；卡片暂时消失也不会算完成，不要立刻高频重跑。
- 活动显示“零分/引导卡片未自动处理”或“锁定卡片”：服务端仍将它列为未完成，但
  它不是可直接提交的普通积分卡片；脚本会如实报告而不盲目点击。
- 页面显示“领取”但脚本显示 0：Rewards 首页固定显示领取入口，以“可领取”数值和
  `pointClaim` 服务端状态为准。
