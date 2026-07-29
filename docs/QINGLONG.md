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
https://cdn.jsdelivr.net/gh/ywsabc/microsoft-rewards-ql@main/microsoft_rewards_ql.js
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

### 1.1 GitHub 超时：无代理单文件方案

如果 `git clone` 无法完成，不需要安装代理或 GitHub 镜像。在青龙“订阅管理”中新建
“单文件”订阅：

```text
https://cdn.jsdelivr.net/gh/ywsabc/microsoft-rewards-ql@main/microsoft_rewards_ql.js
```

关闭这个单文件订阅的“自动添加任务”和“自动删除任务”。青龙保存的脚本名应为：

```text
raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js
```

然后按下一节的 Cron 新建 7 个任务，命令分别填写：

```sh
bash -c 'export BING_REWARDS_TASKS=sign; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=read; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=promos,quiz; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=search; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=mobile; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=streak; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
bash -c 'export BING_REWARDS_TASKS=claim; export BING_REWARDS_NOTIFY=${BING_REWARDS_NOTIFY:-0}; task raw_microsoft-rewards-ql@main_microsoft_rewards_ql.js'
```

可先在青龙终端验证下载地址，命令只下载并检查 JavaScript 语法，不执行脚本：

```sh
wget -q --timeout=30 -O /tmp/microsoft_rewards_ql.download-test.js \
  "https://cdn.jsdelivr.net/gh/ywsabc/microsoft-rewards-ql@main/microsoft_rewards_ql.js"
node --check /tmp/microsoft_rewards_ql.download-test.js
sha256sum /tmp/microsoft_rewards_ql.download-test.js
```

仓库在每次更新 `main` 后会自动请求 jsDelivr 清除这些脚本的分支缓存，并轮询确认 CDN
内容与新提交逐字节一致。刷新通常会有短暂延迟；自动刷新工作流成功后，后续单文件
订阅即可取得新版本。

### 1.2 已有可信代理时的 Git 仓库方案

青龙订阅中的“代理”字段接收的是标准 HTTP/HTTPS 代理地址，不是 GitHub
镜像前缀。已有可信的中国大陆出口代理时，可以保留 Git 仓库订阅，在订阅页面的
“代理”中填写例如：

```text
http://192.168.1.2:7890
```

终端命令也可以把代理作为 `ql repo` 的第 7 个参数传入：

```sh
MSR_GITHUB_PROXY='http://192.168.1.2:7890'
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "$MSR_GITHUB_PROXY" "true" "true"
unset MSR_GITHUB_PROXY
```

代理必须能从青龙容器内部访问。不要把
`https://某镜像/https://github.com/...` 填入“代理”字段；这种地址如果要用，属于替换
仓库 URL，而且应只使用自己控制或明确信任的镜像。公开镜像能够修改下载到的可执行
脚本，不作为本项目默认安装源。不要为拉取源码给全部青龙任务设置全局代理，以免
Rewards 执行时改变出口地区。

### 1.3 缓存与备用地址

jsDelivr 官方规则说明 GitHub 分支可缓存 12 小时，所以本仓库用 GitHub Actions 在
每次合并脚本变更后调用官方 Purge API，并把 CDN 文件与当前 `main` 逐字节比较。
如果刷新工作流暂时失败，需要确定内容不变时，可把 `main` 换成 GitHub 上当前提交的
完整 SHA：

```text
https://cdn.jsdelivr.net/gh/ywsabc/microsoft-rewards-ql@完整提交SHA/microsoft_rewards_ql.js
```

提交 SHA 链接内容固定且不会自动更新。如果本机能够直接访问 GitHub 文件，也可以把
单文件订阅改为：

```text
https://github.com/ywsabc/microsoft-rewards-ql/raw/refs/heads/main/microsoft_rewards_ql.js
```

这个备用地址对应的青龙脚本名通常为 `raw_main_microsoft_rewards_ql.js`，应以订阅
日志里的实际“保存路径”为准。

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

推荐安装仓库 Release 中的浏览器扩展，把 Cookie、搜索 Cookie 和 OAuth
refreshToken 同步到青龙。配置方式与京东 `JD_COOKIE` 一致：每个账号一条环境
变量，所有账号都使用同一个名称：

```text
bing_ck
```

例如两个账号在青龙环境变量页面显示为两条独立记录：

```text
bing_ck    第一个账号的值
bing_ck    第二个账号的值
```

单条值内的 Cookie 字段使用 `&`，而不是 HTTP Cookie Header 原来的分号。手工
添加单账号的最简示例：

```text
_U=...&.MSA.Auth=...&MUID=...
```

扩展 `3.1.0` 会在每条值开头加入 `__bing_account` 边界，并在同一条 `bing_ck`
中保存该账号的搜索 Cookie、refreshToken、匿名 `oauthRuid` 和 Cookie 指纹。不要
删除这些扩展字段：青龙会把同名变量用 `&` 聚合后交给任务，核心依靠边界字段无歧义
地拆回多个账号。账号按 Cookie 指纹和 `oauthRuid` 绑定，不按备注或所在顺序绑定。

Cookie 和 refreshToken 等同账号密码，不要写入脚本、GitHub Issue 或公开日志。
多账号必须逐个切换 Microsoft 账号并授权。授权开始和回调时都会重新读取当前浏览器
会话，并要求 Cookie 与 DAPI 余额完全一致。核心会拒绝重复 Cookie、重复
`oauthRuid`、伪造指纹和两个站点 `_U` 不一致的配置。首次同步会把扩展创建的旧
`BING_REWARDS_ACCOUNTS`、`bing_ck_1`、`bing_search_ck_1`、`bing_token_1`
等变量迁移并清理。

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
- `promos`：普通活动卡片，以及 `dashboard` 中当天 3 个每日活动。
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

无代理单文件订阅只更新共享核心；按计划运行该订阅即可，不要开启自动添加或自动
删除任务。仓库合并脚本变更后会自动清除并验证 jsDelivr 缓存。

更新后建议先把 `BING_REWARDS_DRY_RUN` 临时改为 `1`，手动运行一次确认日志，再恢复
为 `0`。

## 7. 常见检查

- GitHub 拉取一直停在“开始下载”：先停止残留订阅任务，再改用上面的 jsDelivr
  单文件订阅；代理留空，并关闭自动添加和自动删除任务。不要在同一个订阅仍运行时
  反复点击运行。
- 没有自动创建 7 个任务：确认使用了本教程的新白名单，检查
  `AutoAddCron="true"` 以及订阅的自动添加任务开关。
- 显示 Cookie 无效：重新在 Rewards 页面登录并用扩展同步对应账号。
- 阅读显示无 Token：重新获取该账号 OAuth Token，确认备注没有与其他账号重复。
- 搜索不入账：确认扩展同时同步了 Rewards Cookie 和 Bing 搜索 Cookie。
- 搜索显示“连续三轮服务端进度未变化”：当天已安全熔断；先检查 Cookie、账号状态
  和 Microsoft 页面是否限制搜索，不要继续手动高频执行。
- 青龙任务显示失败但日志仍有部分完成：新版会在任一启用模块失败、未确认或关键
  状态无法解析时返回非零退出码，避免把部分执行误报为全部成功。
- 活动显示“提交已接受但未确认”：请求已经到达服务端，但 `earn`、`dashboard`
  或 `getuserinfo` 没有返回明确完成状态；卡片暂时消失也不会算完成，不要立刻
  高频重跑。
- 页面“每日活动”显示 `0/3`、脚本却没有发现活动：确认已更新到 `ql.18` 或更高
  版本；新版会单独读取 `/dashboard`，不会再把 `/earn` 的普通卡片误当作每日活动。
- 活动显示“零分/引导卡片未自动处理”或“锁定卡片”：服务端仍将它列为未完成，但
  它不是可直接提交的普通积分卡片；脚本会如实报告而不盲目点击。
- 页面显示“领取”但脚本显示 0：Rewards 首页固定显示领取入口，以“可领取”数值和
  `pointClaim` 服务端状态为准。
