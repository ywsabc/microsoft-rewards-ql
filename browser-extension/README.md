# Microsoft Rewards 青龙同步助手

这是青龙脚本配套的 Manifest V3 浏览器扩展。它可以读取 Rewards Cookie、复用原脚本
的 Microsoft OAuth 客户端自动捕获 `refreshToken`，并通过用户自己的青龙 OpenAPI
同步环境变量。

## 安装

Chrome、Edge 或其他 Chromium 浏览器：

1. 打开扩展管理页面；
2. 开启“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择本 `browser-extension` 文件夹。

当前版本使用 Chromium 的 `chrome.storage.session` 与运行时主机授权，支持 Chrome、
Edge 和其他兼容的 Chromium 浏览器。

## 使用

1. 在浏览器登录 <https://rewards.bing.com/>；
2. 点击扩展图标；
3. 确认检测到 `_U`、`.MSA.Auth` 和 `tifacfaatcs`；缺少任一字段时，先打开积分
   仪表板并完成登录；
4. 点击“开始 OAuth 授权”，在新标签页完成 Microsoft 授权；扩展会自动捕获回调并
   兑换 `refreshToken`；
5. 填写青龙地址及具有 `envs` 权限的 OpenAPI Client ID、Client Secret；
6. 点击“同步到青龙”。

同步会新增或更新：

- `BING_REWARDS_ACCOUNTS`
- `bing_ck_1`
- `bing_token_1`

## 权限与隐私

- `cookies`：读取 Rewards 页面实际会发送的 Cookie；
- `clipboardWrite`：在用户点击按钮后复制配置；
- `storage`：仅使用 `chrome.storage.session` 暂存 OAuth 状态和 Token；
- `https://bing.com/*`、`https://*.bing.com/*`：Cookie API 所需站点权限；
- `https://login.live.com/*`：Microsoft OAuth 授权、桌面回调捕获和 Token 兑换；
- 可选 HTTP/HTTPS 主机权限：只在点击同步时针对用户填写的青龙 origin 请求授权，
  同步结束后立即移除。

扩展没有内容脚本、外部依赖、远程代码或统计。OAuth Client ID 固定复用原脚本的
`0000000040170455`；青龙地址、OpenAPI Client ID 和 Secret 不保存。refreshToken
只存放在浏览器会话级内存存储中，点击清除或浏览器会话结束后删除。

导出的 Cookie 等同敏感登录凭据。请勿提交到 GitHub、截图分享或粘贴到不可信网站。
