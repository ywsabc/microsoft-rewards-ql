# Microsoft Rewards 青龙同步助手

这是青龙脚本配套的 Manifest V3 浏览器扩展。它可以依次保存多个 Rewards/Bing
浏览器会话，复用原脚本的 Microsoft OAuth 客户端为每个账号自动捕获
`refreshToken`，并通过用户自己的青龙 OpenAPI 一次同步全部账号。

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

1. 分别登录 <https://www.bing.com/> 与 <https://rewards.bing.com/>；
2. 点击扩展图标，扩展会打开固定尺寸的独立小窗；再次点击图标会聚焦原小窗；
3. 确保两个站点登录同一个账号，然后在小窗中点击“刷新状态”；
4. 填写备注并点击“添加当前账号”，再点击“授权所选账号”。Microsoft 每次都会显示
   账号选择页；扩展会自动捕获回调、核对 Rewards 匿名身份，并把 `refreshToken`
   写入所选账号；
5. 在 Bing 与 Rewards 中切换到下一个账号，重复步骤 3、4；
6. 填写青龙地址及具有 `envs` 权限的 OpenAPI Client ID、Client Secret；
7. 可以点击“按身份同步所选”，把当前账号合并进青龙现有记录；也可以在所有账号都
   显示“Token 已获取”后，点击“覆盖同步列表全部账号”。

账号备注只用于显示，不再作为同步身份键。扩展使用 Cookie 指纹和 OAuth `ruid`
定位账号；Cookie 与 Token 命中不同账号时会拒绝同步。只有明确点击“更新所选账号”
才会替换浏览器会话，并在身份变化时清除旧 Token、要求重新授权。

账号列表、Cookie 和 refreshToken 保存在 `chrome.storage.session`。关闭插件小窗后
仍可继续切换账号；浏览器重启、扩展更新或停用后会自动清除。青龙地址、OpenAPI
Client ID 和 Secret 只有在勾选“保存青龙连接信息”时才写入
`chrome.storage.local`。

同步后，一个账号对应青龙中的一条 `bing_ck`；所有账号的变量名完全相同，不添加
`_1`、`_2` 等序号。每条值内的 Cookie 字段用 `&` 分隔，并以扩展生成的
`__bing_account` 字段作为账号边界。搜索 Cookie、refreshToken、`oauthRuid` 和
Cookie 指纹也保存在对应账号的同一条 `bing_ck` 中。

“按身份同步所选”会保留其他 `bing_ck`，只更新 Cookie 指纹或 `oauthRuid` 命中的
账号；“覆盖同步”会让青龙中的 `bing_ck` 与扩展列表一致。首次成功同步后，扩展会
删除它以前创建的 `BING_REWARDS_ACCOUNTS` 及 `bing_ck_1`、
`bing_search_ck_1`、`bing_token_1` 等旧编号变量。

旧版 Rewards 实现可能下发 `tifacfaatcs`，但当前登录会话不一定包含它。扩展不会再
把该旧 Cookie 当作登录必需字段。

Rewards 认证 Cookie 会因页面版本不同使用 `.MSA.Auth` 或 `_C_Auth`；扩展兼容两种
会话，不要求二者同时存在。

## 权限与隐私

- `cookies`：分别读取 Bing 搜索页与 Rewards 页面实际会发送的 Cookie；
- `clipboardWrite`：在用户点击按钮后复制配置；
- `storage`：使用 `chrome.storage.session` 暂存多账号 Cookie、Token、OAuth 状态和
  同步结果；勾选保存时使用 `chrome.storage.local` 保存青龙连接信息；
- `https://bing.com/*`、`https://*.bing.com/*`：Cookie API 所需站点权限；
- `https://login.live.com/*`：Microsoft OAuth 授权、桌面回调捕获和 Token 兑换；
- `https://prod.rewardsplatform.microsoft.com/*`：授权后核对匿名 Rewards 账号标识，
  防止同一个 OAuth 账号误绑到多个备注；
- 可选 HTTP/HTTPS 主机权限：只在点击同步时针对用户填写的青龙 origin 请求授权；
  权限会保留以避免每次弹窗确认，点击“清除保存信息”时一并撤销。

扩展没有内容脚本、外部依赖、远程代码或统计。OAuth Client ID 固定复用原脚本的
`0000000040170455`，并使用 `prompt=select_account` 强制显示账号选择。青龙连接信息
只保存在本机浏览器扩展存储中；多账号 Cookie 和 refreshToken 不写入长期存储，
删除账号或浏览器会话结束后清除。

从 `2.2.2` 起，OAuth 状态查询会同时返回账号会话指纹，并在打开授权地址前先保存
回调所需状态，避免快速单点登录跳转造成 Token 已获取却被误判为账号不匹配。

从 `3.0.0` 起，后台按账号 ID 独立保存 Cookie、会话指纹和 refreshToken。一次只进行
一个 OAuth 流程，但可以在同一浏览器会话内依次为最多 20 个账号授权并统一同步。

从 `3.0.1` 起，授权后会读取 Rewards 匿名账号标识 `ruid`。如果该身份已绑定在另一
备注下，扩展拒绝保存并提示切换账号。升级后请依次切换 Microsoft 账号，为每个备注
重新授权一次；同步到青龙的 `oauthRuid` 会由核心脚本再次校验。

从 `3.0.2` 起，扩展在授权开始和 OAuth 回调时都会重新读取 Bing/Rewards 当前
Cookie 指纹，并用 Rewards Cookie 余额与 DAPI 余额做精确核对。授权过程中切号、
同名备注误换号或选择了另一个 Microsoft 账号时不会保存 Token。同步数据也会包含
`cookieFingerprint`，供青龙核心再次校验。

从 `3.1.0` 起，青龙环境变量改为 JD_COOKIE 风格：每个账号一条同名 `bing_ck`，
Cookie 字段用 `&` 分隔，账号用内部边界和身份指纹识别，不再创建数组或编号变量。

导出的 Cookie 等同敏感登录凭据。请勿提交到 GitHub、截图分享或粘贴到不可信网站。
