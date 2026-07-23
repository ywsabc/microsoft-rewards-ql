# Microsoft Rewards 青龙同步助手

这是青龙脚本配套的 Manifest V3 浏览器扩展。它可以读取 Rewards Cookie、复用原脚本
的 Microsoft OAuth 客户端自动捕获 `refreshToken`，并通过用户自己的青龙 OpenAPI
同步环境变量。

## 安装

Chrome、Edge 或其他 Chromium 浏览器：

1. 先解压 ZIP，浏览器不能直接加载 ZIP；
2. 打开扩展管理页面并开启“开发者模式”；
3. 点击“加载已解压的扩展程序”；
4. 选择解压后**直接包含 `manifest.json`** 的目录。

从 v2.0.2 开始，发布包根目录直接包含 `manifest.json`，不再额外嵌套一层同名文件夹。

当前版本使用 Chromium 的 `chrome.storage.session` 与运行时主机授权，支持 Chrome、
Edge 和其他兼容的 Chromium 浏览器。

## 使用

1. 在浏览器登录 <https://rewards.bing.com/>；
2. 点击扩展图标，扩展会打开一个固定标签页，不再使用容易消失的临时弹窗；
3. 确认检测到 `_U` 和 `.MSA.Auth`；缺少任一字段时，先打开积分仪表板并完成
   登录；
4. 点击“开始 OAuth 授权”，在新标签页完成 Microsoft 授权；扩展会自动捕获回调并
   兑换 `refreshToken`；
5. 填写青龙地址及具有 `envs` 权限的 OpenAPI Client ID、Client Secret；
6. 点击“同步到青龙”。

默认勾选“保存账号备注和青龙连接信息”。页面关闭或浏览器重启后，账号备注、青龙
地址、OpenAPI Client ID 和 Secret 会自动恢复。Cookie 不重复保存，始终从当前
Rewards 登录会话读取；refreshToken 仍只在当前浏览器会话保存。

同步会新增或更新：

- `BING_REWARDS_ACCOUNTS`
- `bing_ck_1`
- `bing_token_1`

旧版 Rewards 实现可能下发 `tifacfaatcs`，但当前登录会话不一定包含它。扩展不会再
把该旧 Cookie 当作登录必需字段。

## 权限与隐私

- `cookies`：读取 Rewards 页面实际会发送的 Cookie；
- `clipboardWrite`：在用户点击按钮后复制配置；
- `storage`：使用 `chrome.storage.session` 暂存 OAuth 状态、Token 和同步结果；
  勾选保存时使用 `chrome.storage.local` 保存账号备注及青龙连接信息；
- `https://bing.com/*`、`https://*.bing.com/*`：Cookie API 所需站点权限；
- `https://login.live.com/*`：Microsoft OAuth 授权、桌面回调捕获和 Token 兑换；
- 可选 HTTP/HTTPS 主机权限：只在点击同步时针对用户填写的青龙 origin 请求授权；
  权限会保留以避免每次弹窗确认，点击“清除保存信息”时一并撤销。

扩展没有内容脚本、外部依赖、远程代码或统计。OAuth Client ID 固定复用原脚本的
`0000000040170455`。青龙连接信息只保存在本机浏览器扩展存储中；Cookie 和
refreshToken 不写入长期存储，点击清除或浏览器会话结束后删除。

导出的 Cookie 等同敏感登录凭据。请勿提交到 GitHub、截图分享或粘贴到不可信网站。
