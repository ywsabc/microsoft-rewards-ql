# 青龙安装与运行

青龙需要 Node.js 18 或更高版本。脚本没有第三方运行依赖，不需要执行
`npm install`，也不需要手工创建 7 个任务。

## 1. 拉取脚本

在青龙“终端”执行下面两条命令中的一条。

正常拉取：

```sh
ql repo "https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

如果 GitHub 拉取超时，改用备用完整仓库地址：

```sh
ql repo "https://ghfast.top/https://github.com/ywsabc/microsoft-rewards-ql.git" '^microsoft_rewards_(ql|task_[a-z_]+)[.]js$' "" "" "main" "js" "" "true" "true"
```

两条命令不要重复执行。任意一条成功后都会拉取共享核心和全部 7 个任务入口，并自动
创建或更新定时任务。备用地址只用于下载源码，不会给 Rewards 任务设置代理，也不会
改变任务运行时的出口 IP。

青龙只需要这些运行脚本，**不会拉取或安装浏览器插件**。

## 2. 单独下载浏览器插件

浏览器插件由用户在电脑浏览器中安装，请从
[GitHub Releases](https://github.com/ywsabc/microsoft-rewards-ql/releases/latest)
下载 `microsoft-rewards-ql-extension-*.zip`。解压后，在 Chrome、Edge 等 Chromium
浏览器的扩展管理页开启“开发者模式”，选择“加载已解压的扩展程序”，再选择直接包含
`manifest.json` 的目录。

插件用于获取当前浏览器账号的 Cookie 和 Token，并同步到用户自己的青龙。插件不在
青龙容器中运行。

## 3. 同步账号

在插件中依次添加、授权账号，然后填写青龙地址和 OpenAPI 信息进行同步。

同步后，每个账号在青龙中对应一条同名环境变量：

```text
bing_ck
```

两个账号就是两条 `bing_ck`，三个账号就是三条，不使用 `bing_ck_1`、
`bing_ck_2`。单个账号内部的 Cookie 字段使用 `&` 分隔；账号通过 Cookie 指纹和
OAuth 身份绑定，不依赖备注或排列顺序。

Cookie 和 refreshToken 等同账号密码，不要提交到 GitHub、公开日志或发给他人。

## 4. 首次运行

建议先在青龙环境变量中添加：

```text
BING_REWARDS_DRY_RUN=1
```

然后在定时任务页面手动运行自动创建的任务，确认每个账号的余额、活动和搜索进度都
能正确读取。确认无误后改为：

```text
BING_REWARDS_DRY_RUN=0
```

`1` 只读取真实状态但不提交，`0` 才会真实执行。

## 5. 自动创建的任务

| 青龙任务 | 内容 | Cron |
| --- | --- | --- |
| 微软积分-01签到 | 签到 | `7 9 * * *` |
| 微软积分-02阅读 | 阅读 | `23 9 * * *` |
| 微软积分-03活动 | 每日活动和普通活动 | `11 10 * * *` |
| 微软积分-04电脑搜索 | 电脑搜索 | `47 10,12,14,16,18 * * *` |
| 微软积分-05移动搜索 | 移动搜索 | `29 11 * * *` |
| 微软积分-06连签 | 连签状态 | `43 11 * * *` |
| 微软积分-07领取 | 待领取积分 | `7 12 * * *` |

时间按青龙容器时区计算，中国大陆用户应使用 `Asia/Shanghai`。不要另外添加高频搜索
任务。

## 6. 更新与简单排查

更新时再次执行最初成功的那条拉取命令即可。

- 拉取超时：停止当前拉取，执行上面的备用命令。
- 没有自动创建任务：确认青龙配置中的 `AutoAddCron="true"`。
- Cookie、Token 或搜索失效：在浏览器中重新登录对应账号，再用插件重新授权并同步。
- 活动提交后没有明确完成：脚本会报告未完成，不会用“请求已发送”冒充成功。
