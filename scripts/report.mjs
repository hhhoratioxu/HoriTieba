import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
const unit = JSON.parse(await readFile('artifacts/unit-results.json', 'utf8'));
const e2e = JSON.parse(await readFile('artifacts/e2e-results.json', 'utf8'));
const real = JSON.parse(await readFile('artifacts/real-e2e-results.json', 'utf8'));
const single = JSON.parse(await readFile('artifacts/thread-reply-e2e.json', 'utf8'));
const perf = JSON.parse(await readFile('artifacts/performance.json', 'utf8'));
if (
  !single.passed ||
  unit.numFailedTests ||
  e2e.error ||
  real.error ||
  !unit.numPassedTests ||
  !e2e.results.length ||
  !real.results.length ||
  [...e2e.results, ...real.results].some((t) => t.status !== 'passed')
)
  throw Error('存在失败测试，不能生成通过报告');
await mkdir('docs/evidence', { recursive: true });
await writeFile(
  'docs/evidence/unit-summary.json',
  JSON.stringify(
    {
      date: '2026-11-02',
      passed: unit.numPassedTests,
      failed: unit.numFailedTests,
      tests: unit.testResults.flatMap((f) =>
        f.assertionResults.map((t) => ({
          name: t.fullName,
          status: t.status,
          duration: t.duration,
        })),
      ),
    },
    null,
    2,
  ),
);
await copyFile('artifacts/e2e-results.json', 'docs/evidence/e2e-results.json');
await copyFile('artifacts/real-e2e-results.json', 'docs/evidence/real-e2e-results.json');
await copyFile('artifacts/thread-reply-e2e.json', 'docs/evidence/thread-reply-e2e.json');
await copyFile('artifacts/performance.json', 'docs/evidence/performance.json');
await mkdir('docs/images', { recursive: true });
for (const [from, to] of [
  ['dashboard-light.png', 'console-light.png'],
  ['dashboard-dark.png', 'console-dark.png'],
  ['sidepanel.png', 'sidepanel.png'],
  ['real-fixture-completed.png', 'real-fixture-completed.png'],
])
  await copyFile(`artifacts/screenshots/${from}`, `docs/images/${to}`);
const rows = [
  ['五库独立导入、编辑、排序', '通过，数据层/导入 schema；界面实际编辑保存与文本安全另测'],
  ['各库独立游标、循环开关、内容耗尽', '通过，含成功提交旧版本游标与耗尽阻断'],
  ['回复自己总开关、仅启用 1/3', '通过，顺序为首评→1→3，其余 disabled'],
  ['基线不处理旧帖、旧帖上浮', '通过，发布时间门槛与不可靠列表只读'],
  ['重复发现、跨重启和跨运行去重', '通过，数据库唯一约束和持久化 tombstone'],
  [
    '首评/楼中楼语义分离、错误作者阻断',
    '通过，DOM fixture 和完整真实适配器流程；Chrome 本机批次 1 条首评及 4 条追评均已核实',
  ],
  ['成功推进、明确失败不推进', '通过，本地事务及证据校验'],
  ['超时未知、不自动重发、重复核实', '通过，未知占额度，核实仅提交一次'],
  [
    '迟到许可和提交响应丢失',
    '通过，5 秒许可截止、页面挂起后迟到响应不点击；取消后只读核实，成功仅提交一次且批次保持暂停',
  ],
  [
    '准备阶段临时加载失败',
    '通过，两次有界延后仅发生在发送尝试创建前；不占额度，不推进游标，暂停优先，提交未知不自动重试',
  ],
  ['暂停和紧急停止竞态', '通过，准备阶段停止后的提交被拒绝'],
  ['关闭侧栏、多个控制台', '通过，侧栏 HTML 页关闭及多管理页共享后台'],
  ['后台回收/浏览器重启恢复', '通过，数据层故障恢复和独立浏览器资料重启'],
  ['关闭所有管理页后的调度', '通过，等待真实浏览器 alarm 唤醒并执行演示首评'],
  ['标签页关闭、账号切换、验证码、平台拒绝', '通过模拟阻断；实际平台限流发布测试未执行'],
  ['存储写入失败、配额不足', '通过故障注入；含平台账本已写而本地提交失败后的恢复'],
  ['恶意 HTML、异常 JSON', '通过，文本显示与严格结构版本校验'],
  ['帖子上限、评论总上限、时钟回退', '通过，评论额度包含追评及未知尝试'],
  ['大列表、大量日志和五库 25000 条内容', '通过有界数据层测量；非长期性能结论'],
  ['演示隔离', '通过，真实库/任务/游标与模拟数据隔离；跨模式调用拒绝，真实只读配置不发送'],
  ['真实列表内容脚本集成', '通过本地页面 fixture，测试登记的工作标签页复用'],
  [
    '分钟时间、延后核实与基线',
    '通过，旧帖上浮、启动分钟重叠、未来时间排除；待核实新帖补证后只入队一次',
  ],
  [
    '临时楼中楼与正式编号',
    '通过，临时节点不计成功，安全刷新后取得 spid 且不重发；实际页面观察与刷新核实一致',
  ],
  [
    '单次点击许可与执行页关闭恢复',
    '通过，标签/epoch/尝试绑定与持久化防重复；失效页 ID 清理后只读重开，有草稿不刷新',
  ],
  [
    'Safari 来源与严格 CSP',
    '本地回归通过：UUID 主机大小写、外域/凭据/端口拒绝、无动态代码生成；Safari 真实账号预检通过',
  ],
  [
    '刷新后旧文档仍可响应',
    '本地回归通过：必须等待文档标识变化，导航未完成时有界停止；浏览器实机结果分别记录',
  ],
];
const report = `# 测试报告

日期：2026-11-02（Asia/Taipei）。记录已执行结果，不将构建、fixture 或页面手工发布合并成未执行的整体验收。

## 自动化结果

- Vitest：${unit.numPassedTests} 项通过，${unit.numFailedTests} 项失败，包含单元、集成、DOM fixture 和性能测量。
- 0.3.0 本帖回复隔离浏览器通过 ${single.results.length} 组，包括同作者两条楼中楼、两种分页、后来新增的评论、关闭停止与发送未知保护。未使用真实账号发布该模式的回复。
- TypeScript 检查及 Vite/esbuild 扩展构建：通过。
- 扩展界面、演示队列与恢复：${e2e.results.length} 组通过，未捕获页面脚本异常。
- 真实适配器全链路本地 fixture：${real.results.length} 组通过；不访问实际账号、不对外发布。
- 浏览器：Playwright Chromium ${e2e.browser}，macOS ${perf.environment.arch}，${perf.environment.cpu}，Node ${perf.environment.node}。
- 侧边栏测试加载扩展 sidepanel.html，使用 390px 视口，不等同于品牌浏览器原生侧栏外壳验收。
- E2E 使用独立临时资料，部分场景在测试数据库中提前截止时间；另有一组实际等待 34 秒验证 alarm，无产品加速或发布后门。

### 界面与后台场景

${e2e.results.map((r) => '- ' + r.name + '：通过（' + r.ms + ' ms）').join('\n')}

### 真实适配器隔离场景

${real.results.map((r) => '- ' + r.name + '：通过').join('\n')}

此组运行生产扩展的 TiebaAdapter、工作页、内容脚本和事务队列，合成页面模拟服务端持久评论及缺编号的临时节点。首评按钮点击一次、四个追评库各点击一次，刷新后取得正式证据，全部关联同一首评且五库游标各推进一次；外部网络被拦截。

## 验收覆盖映射

| 要求 | 结果和边界 |
| --- | --- |
${rows.map(([a, b]) => '| ' + a + ' | ' + b + ' |').join('\n')}

上述合并行覆盖需求中 30 类测试点；明确标为模拟的结果不扩展为真实平台验收。

## 实机验证

当前 0.3.0 在真实 Chrome 帖子页验证了输入栏和按钮状态。逐条回复路径使用隔离浏览器验证。历史 0.2.2 高级控制台的五条评论已通过 Chrome 真实账号验收。[真实接入验证](verification.md) · [Chrome](chrome.md) · [Safari](safari.md)

## 性能测量

数据量：10000 帖、2500 条输入日志（裁剪为 2000 条）、5×5000 条内容、20 次增量更新。

| 测量 | 本次实测 |
| --- | ---: |
| 数据准备与日志裁剪 | ${perf.seedMs.toFixed(2)} ms |
| 后台分页快照 | ${perf.snapshotMs.toFixed(2)} ms |
| 当前页快照大小 | ${perf.snapshotBytes} bytes |
| 单条增量更新平均 | ${perf.incrementalUpdateMeanMs.toFixed(2)} ms |

环境为 Node + fake-indexeddb，${perf.environment.platform}/${perf.environment.arch}。这是数据层测量，不是实际浏览器 IndexedDB 吞吐、帧率、内存泄漏或长期挂机证明。界面每页渲染 25 条，不传其他库的大数组。

## 待完成的实际浏览器验收

1. 品牌 Edge 兼容性及真实发布尚未验收。Chrome 的已执行项目见独立记录，未执行项目不得由 Chromium fixture 代替。
2. 实际环境扩大到更多帖子、不同账号及多日运行尚未验收。
3. Safari 当前未知追评仅可只读核实，后续真实发布须另获具体目标、内容和数量授权。Chrome 本轮以独立记录为准。
4. 验证实际断网、睡眠、浏览器升级、配额不足、标签页丢弃、账号切换、限流、主题关闭和楼层删除；模拟结果不替代这些测试。
5. 如验证历史数据库迁移，先备份并构造旧版本数据；当前只存在 schema v1。

证据：evidence/unit-summary.json、e2e-results.json、real-e2e-results.json、thread-reply-e2e.json、performance.json。Safari 详细边界见 [Safari 安装与验收](safari.md)。
截图：images/console-light.png、console-dark.png、sidepanel.png、real-fixture-completed.png。含真实账号的原始页面截图不进入发布包。

复现命令：pnpm test、pnpm build、pnpm test:e2e、pnpm test:e2e:real、pnpm test:e2e:thread、pnpm package。
扩展测试方式参考 [Playwright 官方扩展文档](https://playwright.dev/docs/chrome-extensions)。
`;
await writeFile('docs/test-report.md', report);
console.log('已生成中文测试报告和脱敏证据摘要');
