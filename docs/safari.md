# Safari 临时安装与验收

本页记录 macOS Safari 27.2 的实际临时扩展验收。构建复用同一套业务代码，仅移除 Safari 打包工具明确不支持的 Chrome 侧边栏字段、后台模块类型声明和最低 Chrome 版本。权限保持为 `storage`、`alarms` 和 `https://tieba.baidu.com/*`，没有扩大网站范围。

## 安装方式

1. 解压 `HoriTieba-safari.zip`，保留整个 `HoriTieba-safari` 文件夹。
2. 在 Safari 设置的“高级”中显示网页开发功能，再进入“开发者”。
3. 选择“添加临时扩展”，由本人完成系统要求的 Touch ID 或本机密码认证，选择直接包含 `manifest.json` 的文件夹。
4. 在“扩展”列表确认 HoriTieba 已启用，只授予 `tieba.baidu.com` 的网站访问权限。
5. 从扩展“设置”或工具栏图标打开完整控制台。Safari 控制台使用 `safari-web-extension://` 地址；侧边栏不可用时使用完整控制台。
6. 在 Safari 正常登录贴吧。其他浏览器中的登录状态不会自动迁入，不需要导出密码或 Cookie。

这是用于本机开发验收的临时扩展，不是 App Store 安装包。Apple 文档说明临时扩展会在 Safari 退出或 24 小时后移除；退出后未签名扩展许可也会重置。重装前请导出配置与历史，不承诺临时安装的数据能跨移除保留。长期分发需另做签名的 Safari 容器应用与相应发布流程。

依据：[Apple 在 Safari 中运行扩展](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)、[Apple 扩展打包说明](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)。

## 实机范围

Safari 27.2 上的 0.2.0 已验证临时安装、工具栏和控制台、本地存储与演示调度。登录后的真实新主题发现和自动首评通过。楼中楼追评因响应超时进入未知状态，未重发，完整真实批次未通过。0.3.0 的帖子底部自动回复尚未在 Safari 上完成真实账号验收。
