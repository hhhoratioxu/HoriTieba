# HoriTieba · 贴吧追评助手

打开贴吧，页面底部会出现一个输入框。填好文字，点 **开始**。

| 打开的页面           | 助手做什么                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| **某个吧的帖子列表** | **自动评论**。给启动后发现并核实的新帖各发一条一级评论。                                       |
| **一篇具体的帖子**   | **自动回复**。逐条回复这篇帖子的评论和楼中楼，也会等新评论。它会跳过自己和已经处理过的原评论。 |

![贴吧列表页的自动评论输入栏](docs/images/forum-comment-bar.png)

![帖子页的自动回复输入栏](docs/images/thread-reply-bar.png)

可以同时保留一个列表页和一个帖子页。同一个账号的发送至少间隔 30 秒。点 **停止** 或关闭对应页面，就会结束那一项。

**[下载 Chrome 扩展](https://github.com/hhhoratioxu/HoriTieba/releases/latest/download/HoriTieba-extension.zip)** · [v0.4.1 发行页](https://github.com/hhhoratioxu/HoriTieba/releases/tag/v0.4.1)

## 安装

1. 解压 `HoriTieba-extension.zip`。
2. Chrome 打开 `chrome://extensions`，打开「开发者模式」，点「加载已解压的扩展程序」，选择解压出的 `HoriTieba-extension` 文件夹。
3. 在同一个 Chrome 里登录贴吧，打开或刷新你想操作的页面。

[使用说明](docs/user-guide.md) · [验证记录](docs/verification.md) · [权限说明](docs/permissions.md)

## 从源码构建

使用 Node.js 22.12 或以上和 pnpm 11.25.0。

```sh
pnpm install --frozen-lockfile
pnpm build
```

将生成的 `dist/` 加载到 Chrome 即可。本地全量测试还使用 Playwright Chromium 和 OpenSSL，生成 ZIP 需要 Python 3。

```sh
pnpm exec playwright install chromium
pnpm check
pnpm package
```
