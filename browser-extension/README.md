# Microsoft Rewards Cookie Exporter

这是青龙脚本配套的 Manifest V3 浏览器扩展，用于在用户主动点击时读取
`https://rewards.bing.com/` 会使用的 Cookie，并复制为
`BING_REWARDS_ACCOUNTS` JSON。

## 安装

Chrome、Edge 或其他 Chromium 浏览器：

1. 打开扩展管理页面；
2. 开启“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择本 `browser-extension` 文件夹。

Firefox 可在调试扩展页面临时载入 `manifest.json`；不同 Firefox 版本对 Manifest V3
Cookie 权限的支持可能不同。

## 使用

1. 在浏览器登录 <https://rewards.bing.com/>；
2. 点击扩展图标；
3. 确认检测到 `_U`、`.MSA.Auth` 和 `tifacfaatcs`；缺少任一字段时，先打开积分
   仪表板并完成登录；
4. 输入账号备注，点击“复制账号 JSON”；
5. 将复制结果填入青龙环境变量 `BING_REWARDS_ACCOUNTS`。

扩展只导出 Cookie，不会获取 OAuth `refreshToken`。未配置刷新令牌时，青龙版仍可尝试
PC Cookie 任务，但会跳过依赖 App Token 的签到和阅读。

## 权限与隐私

- `cookies`：读取 Rewards 页面实际会发送的 Cookie；
- `clipboardWrite`：在用户点击按钮后复制配置；
- `https://bing.com/*`、`https://*.bing.com/*`：Cookie API 所需站点权限。

扩展没有后台脚本、内容脚本、外部依赖、远程请求、统计或持久化存储。源码不会把
Cookie 插入页面或发送到网络。

导出的 Cookie 等同敏感登录凭据。请勿提交到 GitHub、截图分享或粘贴到不可信网站。
