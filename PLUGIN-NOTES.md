# dsh-unstuck 档案

> 这份文件是**决策记录**，不是使用手册。
> 怎么装、怎么调、怎么卸 → 看 [README.md](./README.md)。
> 这份只回答三件事：当初为什么这么写、证据是什么、改代码之前必须知道什么。

写于 2026-10-21，对应版本 `0.1.0`，目标 dsh `0.2.1-rc.2`。

---

## 一、为什么会有这个东西

起因是一句话：「dsh 经常跑着跑着自己断了，各种原因，需要我手动发个消息才能继续。」

后来发生了更讽刺的事：在写这个插件的过程中，我自己就断了一次，而日志里那一轮写的是
`kind=completed`——**正常结束**。所以问题不在「报错」，而在「它以为自己干完了」。

### 实测到的断连形态

扫本机 41 个会话 / 140 个轮次（`node tools/diag.mjs --all` 可复现）：

| turn/end kind | 轮次 |
| --- | --- |
| `completed` | 107 |
| `error` | 14 |
| `aborted` | 11 |
| `max-tokens` | 4 |
| `interrupted` | 1 |
| 未结束 | 3 |

只看 `error`/`aborted` 会漏掉最大的那一类：`completed` 里 **19 轮（13.6%）是「假完成」**——
轮次正常收尾，活却没干。近 15 个会话这个比例升到 17.5%。

假完成只有两种形态：

| why | 轮次 | 末条 assistant 消息长什么样 |
| --- | --- | --- |
| `dsml-leak` | 11 | 正文末尾是模型原生的工具调用标记，例如 `…</｜｜DSML｜｜ calls>` |
| `no-output` | 8 | 只写了 reasoning，正文一个字都没有 |

### 根因

模型（`deepseek-v4.1-flash`，走中转站 `https://8888ok.cc/v1`，协议声明 `openai-completions`）
把工具调用写成了 DeepSeek 原生 DSML 标记的**纯文本**，而中转站没有把它翻译成
`tool_calls` 字段。于是：

1. assistant 消息里只有 `reasoning` + `text`，没有 `tool-call` 块；
2. agent 循环看不到工具调用，认为模型说完了 → 正常 `turn/end completed`；
3. 会话安静地回 `idle`，等你说话；
4. dsh 自带的「继续」按钮也救不了：`completed` 属于它的
   `SETTLED_TURN_END_KINDS = ["completed", "blocked", "max-tokens"]`，会被 409 拒掉。

另外实测发现 `reasoning` 与 `text` **逐字节相同**——中转站把推理内容也塞进了正文。
这一条也是判据之一（`echo-reasoning`）。

---

## 二、为什么不「从源头修」

最直接的想法是：在消息进入 agent 之前，把 DSML 文本转回 `tool_calls`。

**做不到。** dsh 的 agent 事件面里没有「改写消息」的 waterfall：

- `agent/pre-step` 返回 `PreStepDecision`，其文档明确写 *Model-visible content must use
  logged channels; this waterfall cannot mutate messages*；
- 消息一旦写入会话日志，就没有任何插件钩子能改它。

所以只能在**轮次结束后**补一条带指向性的「继续」，让模型自己重发工具调用。
这不是最优解，但是插件层唯一能做的事。

> 想根治，得换掉那个不翻译 DSML 的中转站，或者让模型别走 DSML 通道。
> 那属于配置/选型问题，不是插件能解决的。

---

## 三、三层工作方式

| 层 | 触发 | 动作 | 判据 |
| --- | --- | --- | --- |
| 续跑 | `turn/end` 异常，或「假完成」 | 等一会儿补「继续」 | `shouldAutoContinue()` |
| 假死救援 | 请求发出后长时间无流片段 | `cancel({kind:'hook'})` 掐掉本轮，再补「继续」 | `requestAt` / `lastStreamAt` 锚点 |
| 阻塞记录 | 等审批 / 等回答 | 只记录 + 通知，**绝不代答** | `approval/asked`、`user-questions/request` |

三条铁律（改代码前务必确认还成立）：

1. **发「继续」的那一刻要重新校验一切**：`status`、`inbox`、有没有真人新消息。
   dsh-purge 的注释里记着这个竞态——*idle 后 280ms 自动续跑与用户 submit 竞态*——
   它因此默认关掉了 autoContinue。我们保留 autoContinue，但把校验推迟到真正发送前。
2. **续跑消息的 `source.kind` 必须是 `dsh-unstuck`**，否则会被自己
   `hasFreshHumanTurn()` 当成人类输入，把预算清零后无限续跑。
3. **插件发起的 cancel 用 `{kind:'hook'}`，不能用 `{kind:'user'}`**，
   否则 `isUserAbort()` 会把「监督员掐的」误判成「用户按了停止」。

---

## 四、踩过的坑（都是真金白银）

### 1. `source.kind` 必须用白名单，不能用黑名单

第一版写的是黑名单 `NON_HUMAN_SOURCES = {plugin, system, dsh-purge, self}`。
看着合理，实际会把 harness 自己塞的上下文当成「真人接手」：

真实会话里 `user/message` 的 `source.kind` 分布（349 条样本）：

```
time-context 114   user 108   runtime-context 31   skill-catalog 31
continue 21        agent-instructions 18   goal 6   user-approval 5
plugin:dsh-im 4    plugin:hindsight 4   dsh-rewind 2   tool-jobs 2
model-selection 2  tool-goal 1
```

**只有 `user` 是真人打的字。** 用黑名单的后果是：每次轮次结束前 harness 都会塞一条
`time-context`，于是监督员永远判定「用户还在，别插嘴」→ 功能静默失效。
静默失效比多发一条「继续」糟糕得多，因为你看不出它坏了。

现在改成白名单：`HUMAN_SOURCE_KINDS = {user}`，
`CONTINUE_LIKE_KINDS = {continue, dsh-unstuck}`。

### 2. 防误伤：讨论 DSML 不等于泄漏 DSML

`tailLooksLikeDsml()` 是兜底规则，会把正文尾部出现 `DSML` 的消息判成泄漏。
但**人在讨论这个问题时，一定会把标记放进代码围栏里举例**——那是我自己写的
说明文字，不是模型泄漏。所以加了一条：正文里出现三反引号代码围栏，就判它不是泄漏。

### 3. 不要把不存在的服务写进 `inject`

Cordis 会一直等那个服务 → 插件 pending → **宿主退出码 1**。
本插件纯靠事件，`inject = []`。

### 4. `agent/assistant-stream` 的 frame 用 `.type` 不是 `.kind`

值仍是 `start` / `chunk` / `end`，但字段名是 `type`。写错会导致假死检测永远不刷新
`lastStreamAt`，把所有长请求都误判成卡死。

### 5. `node --test test/` 在 Windows + node 24 上会挂

报 `Cannot find module '...\test'`。必须写成 `node --test "test/*.test.js"`。

### 6. 机器打盹会把健康请求判成卡死

假死检测靠「请求发出后多久没有流片段」。但**静默时长不等于模型没响应**：
笔记本合盖、系统挂起、事件循环被一个大同步任务卡住，醒来后 `Date.now()` 的差值
会一次性跳几十秒，于是巡检第一眼就把一个正在正常生成的长请求掐掉。

修法：巡检记 `lastTickAt`，发现两次巡检的间隔远超预期（`max(3000, tickMs*8)`，
含时钟被 NTP 往回校正的负跳变）就把所有时间锚点整体平移相同量，并跳过这一轮判定，
留一条 `clock-jump` 记录。

这个坑是**测试先发现的**：一条「还没到阈值不该动手」的负向断言偶尔失败。
原因不是测试写得差，而是事件循环被阻塞时，`wait()` 的定时器和巡检定时器同时到期，
Node 按到期时间先跑巡检 → 直接掐掉 → 断言才看到 `cancels.length === 1`。
所以负向断言现在会先自证「我确实是在阈值之前观察到的」。

顺带一个坑：`cfg.tickMs` 在 `config.js` 里被 clamp 到 **最小 1000ms**，
写测试时等 300ms 是等不到任何一次巡检的。

---

## 五、和别的方案的关系

| 方案 | 它做什么 | 本插件怎么配合 |
| --- | --- | --- |
| dsh 自带「继续」按钮 | 手动续跑，且拒绝 `completed`/`blocked`/`max-tokens` | 我们做的正是把它自动化，并且**覆盖它拒绝的那三类** |
| dsh-purge 的 autoRetry | 模型请求层重试，默认**开** | 所以本插件 `autoRetry` 默认**关**，否则叠成 6 次重试，更容易打挂上游 |
| 桌面端进程监控（`dsh process monitor`） | 整个进程退出后重启 | 插件管不了进程级退出，那是它的活；两者互补 |

### 市场里的同类插件（2026-10-21 查 catalog，共 6084 条）

| 插件 | 它做什么 | 和本插件的区别 |
| --- | --- | --- |
| `dsh-loop-continue` | **同样盯「假完成」**：在 `agent/turn-stopping` 回放日志，让裁判模型答 true/false，命中就把同一轮再推进一步 | 它要**多调一次模型**（延迟 + 花钱 + 裁判本身可能被上游吞）；本插件用**结构指纹**（reasoning 与 text 逐字节相同 / 空输出 / DSML 泄漏）本地判定，零调用零延迟 |
| `dsh-auto-continue` | 网络、超时、宿主崩溃后自动发「继续」，带错误分类、退避、模板化文本、浏览器通知 | 只处理**报错型**中断；「假完成」这类**不报错**的它看不见 |
| `dsh-continue` | 规则表路由（限流/额度/鉴权/上下文超限/崩溃孤儿），可视化规则编辑器 | 有 UI、面更宽；本插件故意不做 UI，只留一个 JSON 配置 |
| `dsh-autoresume`、`dsh-continuechat`、`dsh-continue-on-limit`、`dsh-continue-button`、`dsh-auto-continue-429`、`dsh-recovery-resume`、`dsh-resume-on-restart`、`dsh-auto-goal-resume`、`dsh-restart-autoresume` | 各种「续跑」变体（重启后、上限截断、429、手动按钮…） | 都只覆盖其中一种触发源；本插件把「异常结束 + 假完成 + 请求假死」三种一次管完 |
| `dsh-serverchan-watchdog` | 审批/问答超时用 Server酱推手机 | 只做通知；本插件记录 + 可选本地命令，且**绝不替你回答** |
| `dsh-subagent-watchdog` | 子代理 max-tokens 后自动续一次 | 只管子代理；本插件 `skipOwnedAgents` 默认不碰子代理，各管一段 |

一句话：市面上「续跑」插件很多，但**没有一个用零模型调用的结构指纹去认「这轮其实没干完」**。这是本插件唯一的护城河。


---

## 六、维护者须知

- **纯逻辑在 `lib/core.js`**：不 import cordis、不碰定时器/文件系统，所以能直接单测。
  加判据请加在这里，`lib/index.js` 只负责副作用。
- **改判据先跑 `tools/diag.mjs`**：它把每个会话逐轮列出来，能立刻看出新规则会误伤多少轮。
  `--all` 全量、`--limit N` 只看最近几个、`--home` 指定 DSH_HOME。
- **测试**：`node --test "test/*.test.js"`，当前 57 个用例。
  `test/smoke-cordis.mjs` 是拿真 cordis Context 跑的冒烟（不是单测），验证 8 个监听器装得上、dispose 干净。
- **改完要同步到已安装目录**才能生效：
  `$env:DSH_HOME\plugins\dsh-unstuck`（profile 里是指向它的 NTFS 联接）。
- **热重载机制（2026-10-21 03:00 实测纠正）**：dsh 监听的是**插件目录里的文件**，
  不是 profile 的 patch。所以同步完 `lib/*.js` 后 1~2 秒内会自动 `dispose` + `boot`，
  不必重启。反过来，**只往 `profiles\tauri\cordis.patch.yml` 追加注释不会触发任何重载**
  （实测轮询 30 秒、日志零新增）—— 早先记的「追加注释触发 recomposition，约 0.75 秒」
  是错的，那是被 `install.ps1` 重建插件目录带出来的假象。
  最稳的兜底永远是：重跑 `install.ps1`，或重启桌面端。
- 验证是否真的换了代码：看 `unstuck.jsonl` 最新 `boot` 行里的字段。新增配置项会直接印在
  boot 行上（例如 `continueOnSwallowed`），这是判断「运行的是不是新代码」最快的办法。
- **日志**：`$env:DSH_HOME\unstuck\unstuck.jsonl`，
  只记 info 及以上；`verbose: true` 才写 debug。

---

## 七、安装状态快照（2026-10-21 02:40，改名后）

| 项 | 值 |
| --- | --- |
| 源码 | `<仓库根目录>` |
| 已安装 | `$env:DSH_HOME\plugins\dsh-unstuck` |
| profile | `$env:DSH_HOME\profiles\tauri` |
| 依赖声明 | `"dsh-unstuck": "file:C:/Users/Administrator/.dsh/plugins/dsh-unstuck"` |
| 联接 | `profiles\tauri\node_modules\dsh-unstuck` → 已安装目录 |
| profile 备份 | `package.json.bak-unstuck-20261021-024053` |
| 用户配置 | `$env:DSH_HOME\unstuck\config.json`（不存在则全用默认值） |
| 日志 | `$env:DSH_HOME\unstuck\unstuck.jsonl` |
| dsh 里的显示名 | `Unstuck`（`locale/en.json`；`meta.title` 与包名 `dsh-unstuck` 一致，不再提供中文名） |
| 市场里的描述 | 写进 `profiles\tauri\.dsh-market\state.json` 的 `notes["dsh-unstuck"]`（见第九节） |
| 旧名残留 | 旧目录 `plugins\dsh-supervisor.bak-*`、旧日志 `<DSH_HOME>\supervisor\supervisor.jsonl`（留作历史，可删） |

---

## 八、命名与「市场里为什么没描述」

### 为什么从 `dsh-supervisor` 改成 `dsh-unstuck`

两条硬理由，都是查出来的，不是口味问题：

1. **`dsh-supervisor` 这个 npm 名已经废了。** registry 里只剩墓碑：2026-08-19 有人发过 `0.1.0`，08-20 整包 unpublished，现在 `versions` 为空、无维护者。我们**发不了**这个名字，也就永远进不了 catalog。
2. **`supervisor` / `warden` / `continue` / `resume` 在 dsh 生态里已被占满**（`dsh-focus-supervisor`、`dsh-warden`、`dsh-continue`、`dsh-auto-continue`、`dsh-autoresume`、`dsh-loop-continue`…）。再叫一次只会被当成又一个续跑插件。

`dsh-unstuck` 在 catalog 与 npm 上都是**双空闲**，且语义正好覆盖三种失效：异常结束、假完成、请求假死——都是「卡住」，本插件做的事就是把你解开。

改名的连带影响（已全部处理）：
- `SELF_SOURCE` → `"dsh-unstuck"`；`CONTINUE_LIKE_KINDS` 额外保留旧名 `"dsh-supervisor"`，这样**改名前的会话**里已有的旧消息仍被认作「已续跑」，不会补出第二条。
- 日志与配置目录 `<DSH_HOME>\supervisor\` → `<DSH_HOME>\unstuck\`。
- `supervisor.config.example.json` → `unstuck.config.example.json`；`cancel` 原因 `supervisor-stall` → `unstuck-stall`。
- 去掉 `locale/zh-CN.json`：显示名统一用英文 `Unstuck`。

### 市场里为什么「没有任何描述」

不是漏写。`package.json` 里 `description` 一直在，但**市场根本不读本地 package.json**。

- dshmarket 客户端全部 7 处描述读取都走 `entry.description`（本地化映射），而 `entry` 来自 **catalog**：`awesome-dsh-plugin.com/plugins.json`（当前 6084 条，另有 npm 包 `dsh-plugin-catalog` 做镜像）。
- 本地 `file:` 插件在 catalog 里没有条目 → `entry === undefined` → 描述为空，行里只显示包名。见 `client/client.js:13699`（`authored = entry?.description…`）与 `:13924`（`shown = note ?? authored`）。

### 让描述出现的两条路

1. **市场备注（已采用）**：市场自带 note 功能，≤200 字，覆盖作者描述。已写进
   `$env:DSH_HOME\profiles\tauri\.dsh-market\state.json` 的 `notes["dsh-unstuck"]`，
   重启/刷新市场页面即显示。用户之后可在市场行尾「···」里随时改或删。
2. **发布到 npm 并被 catalog 收录**（未做）：只有这条路才有「作者描述」+ 英文/中文双语描述。
   catalog 的字段支持 `description.en` 与 `description.zh-CN`，所以发布时两边都能有。

---

## 九、变更记录

### 0.2.0 — 2026-10-21（改名）

- 插件名 `dsh-supervisor` → **`dsh-unstuck`**（原因见第八节）。
- 数据目录、配置文件名、cancel 原因、日志名同步改名。
- `CONTINUE_LIKE_KINDS` 保留旧 kind `dsh-supervisor`，兼容改名前的会话。
- 去掉 `locale/zh-CN.json`，显示名统一英文 `Unstuck`。
- `package.json` 描述改为英文；`files` 增加 `install.ps1`/`uninstall.ps1`。
- `install.ps1` 的复制清单改为直接读 `package.json` 的 `files`，不再手写第二份清单（这次就是它漏拷了 `locale/`、`tools/`、`PLUGIN-NOTES.md`、`icon.svg`）。
- 57 个单测全绿；真 cordis 冒烟 8 监听器；改名后热重载验证通过。

### 0.2.1 — 2026-10-21（纠正热重载认知）

- **推翻旧结论**：早先记的「往 profile `cordis.patch.yml` 追加注释即触发 recomposition（约 0.75 秒）」
  是错的。干净的对照实验：只改 patch → 轮询 30 秒日志零新增；只改已安装插件目录里的
  `lib/index.js` → 1~2 秒内 `dispose` + `boot`。
- 结论写进文档：热重载靠的是**插件目录的文件变更**；改配置要写 `unstuck/config.json` 再重启；
  兜底手段是重跑 `install.ps1` 或重启桌面端。
- README「开发」节补上同步命令与验证方法。

### 0.1.0 — 2026-10-21

- 首版。三层：异常续跑、「假完成」识别、假死救援、阻塞记录。
- `source.kind` 由黑名单改为白名单（修静默失效）。
- 假死检测区分「请求在飞」和「在跑长工具」，避免误掐。
- 防误伤：带代码围栏的消息不算 DSML 泄漏。
- 时钟跳变防护（`clock-jump`）：机器睡眠/事件循环卡顿不再被误判成卡死。
- 56 → 57 个单测 + 1 个真 cordis 冒烟。
- 加 `tools/diag.mjs` 诊断工具。
- 加 `locale/` 双语显示名、`icon.svg`。
