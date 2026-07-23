# Security policy

## Sensitive credentials

Microsoft/Bing Cookie、OAuth 授权码和刷新令牌都属于敏感凭据。

- 不要在 GitHub Issue、Pull Request、Actions 日志或截图中提交真实凭据；
- 如凭据曾被公开，立即从 Microsoft 账号退出相关会话并重新授权；
- `.state` 目录包含续期后的刷新令牌，应保持私有并限制文件权限；
- 浏览器扩展复制的内容只应粘贴到你自己的青龙环境变量。

## Reporting

安全问题可以通过 GitHub Security Advisory 的私密报告功能提交。报告中请使用脱敏请求、
虚构 Cookie 和最小复现，不要发送可登录的真实账号凭据。

## Scope

项目调用 Microsoft Rewards 的网页与未公开接口，接口变化、账号风控和服务条款不属于
安全漏洞。凭据泄漏、跨账号 Cookie 混用、扩展越权访问和远程代码执行属于安全问题。
