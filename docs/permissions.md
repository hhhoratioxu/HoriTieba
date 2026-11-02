# 权限、安全与数据范围

| Manifest 项                                 | 用途                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `storage`                                   | 轻量界面偏好及本扩展创建的监控/执行标签页 ID；核心事务保存在 IndexedDB |
| `alarms`                                    | 在后台被回收后按事件恢复有边界调度；不用永久定时器人为保活             |
| `sidePanel`                                 | 轻量侧边栏；失败时可回退完整管理页                                     |
| `https://tieba.baidu.com/*` host permission | 只在贴吧主域读取经验证 DOM；已启动的自动批次通过普通编辑器发布与核实   |

没有 `<all_urls>`、`cookies`、`history`、`webRequest`、`debugger`、`scripting` 或全局 `tabs` 敏感权限。基础 tabs API 仅创建、定位本扩展自己的工作标签页；已授予的贴吧 host permission 允许识别该域标签页 URL。

内容脚本只接受同一扩展的后台来源、顶层 frame 和经白名单 schema 校验的读取、官方旧版切换、准备、提交、展开与取消消息。没有 window.postMessage 桥接或 externally_connectable。普通网页不能启动扩展队列。管理消息校验扩展来源、受支持页面、frame、requestId、上下文及 payload；页面响应也经过运行时结构校验。

发送准备 token 仅在扩展隔离上下文中使用，并绑定工作页、任务步骤和运行 epoch。点击前后台再次检查已持久化的发送意图和额度，先写单次点击许可；内容脚本也只能消费准备 token 一次。后台重启、页面刷新或取消会让旧准备失效。所有内容通过文本节点和 BR 写入编辑器，不解释内容库中的 HTML，不调用隐藏页面变量、私有接口或 Cookie。

草稿保护同时检测文字与图片、视频等非文字内容；空 alt 图片也不能被当作空编辑器覆盖。发送等待期间出现额外媒体内容会取消点击，保留现场供用户处理。

JSON 导入只从通过白名单 schema 的字段构建配置，不把任意 JSON 展开覆盖内部状态。React 作为文本渲染用户内容，无 `dangerouslySetInnerHTML`。不使用 eval，不下载执行远程核心代码。CSP 为仅本地脚本，禁止 object 和 base 注入。

当前账号标识是用户界面中可读取的个人主页 ID，不读取登录 Cookie、密码、验证码、BDUSS 或其他会话令牌。它仅用于当前运行绑定及本地去重。日志只记录事件和必要错误，不记录完整页面 HTML或会话。源码、测试数据和发布包没有用户实际账号标识；DOM fixture 中的身份为合成数据。

配置和内容、任务与证据默认保留在当前浏览器资料本地。没有遥测、广告、统计服务和开发者服务器。导出内容配置不含账号绑定或会话；历史导出可能含本地任务中的账号 ID、文本和证据，应由用户自行保管。日志保留上限为两种模式合计 2000 条；观察帖子缓存每模式目标为 10000 条（有任务关联的证据不强制删除）。任务历史需用户手动清理，去重 tombstone 持续保留。

权限与 API 依据：[Chrome 权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[Chrome 消息通信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。文档支持 API 设计，不证明当前浏览器品牌已完成兼容测试。
