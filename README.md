# HoriTieba · 贴吧追评助手

打开一篇贴吧帖子，在页面底部输入要回复的文字，点 **开始**。助手会翻页，逐条回复这篇帖子的评论，包括楼中楼和后来新增的评论。它会跳过自己的评论，记住已经回复过的原评论。点 **停止** 或关闭帖子即可结束。

![帖子底部的自动回复输入框](docs/images/thread-reply-bar.png)

**[下载 Chrome 扩展](https://github.com/hhhoratioxu/HoriTieba/releases/latest/download/HoriTieba-extension.zip)** · [全部发行文件与校验值](https://github.com/hhhoratioxu/HoriTieba/releases/tag/v0.3.0)

## 安装

1. 解压下载的 ZIP，保留整个 `HoriTieba-extension` 文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions`，打开「开发者模式」，点「加载已解压的扩展程序」，选择刚才解压的文件夹。
3. 在同一个 Chrome 里登录贴吧，打开或刷新一篇帖子，底部就能看到「本帖自动回复」。

两条回复之间至少间隔 30 秒。遇到验证码、已有草稿或无法确认的回复结果时，助手会暂停。内容、设置和去重记录保存在当前浏览器中。[使用说明](docs/user-guide.md) · [权限说明](docs/permissions.md)

工具栏里的控制台另提供新帖监控，可以在符合规则的新帖上发一条首评，再按设置最多回复自己的首评四次。

## 验证情况

- **HoriTieba 0.3.0** 的帖子底部输入栏已在品牌 Chrome 的真实贴吧页检查。逐条回复、两种分页、后台等待新评论、停止和跨批次去重通过了隔离浏览器测试。本帖模式的这次实机检查共发布 0 条。[测试记录](docs/verification.md)
- **高级控制台 0.2.2** 曾在真实 Chrome 账号上完成新帖发现、1 条首评、4 条追评及自动停止。[Chrome 记录](docs/chrome.md)
- Safari 提供单独的临时扩展测试包。Safari 历史实机追评结果未知，Edge 尚未独立验收。[Safari 说明](docs/safari.md)

## 从源码构建

使用 Node.js 22.12 或以上、pnpm 11.25.0。生成 ZIP 还需要 Python 3。

```sh
pnpm install --frozen-lockfile
pnpm build
```

在 Chrome 的扩展管理页加载生成的 `dist/` 文件夹即可。要运行完整的本地回归并生成发行包，可执行以下命令。

```sh
pnpm exec playwright install chromium
pnpm check
pnpm package
```

[安装说明](docs/installation.md) · [测试报告](docs/test-report.md) · [已知限制](docs/known-limitations.md) · [架构](docs/architecture.md)
