# dsh-unstuck

给 DeepSeek Harness 用的**监督员**插件。dsh 跑着跑着自己断了、卡住了、闷头不动了，它负责发现并把你解开（`unstuck`），不需要你手动发消息。

> **English** — A watchdog plugin for DeepSeek Harness. When a run stops on its own and waits for you to say something, this continues it.
>
> It handles three cases, and nothing else:
> - **Abnormal turn end** (`error`, `aborted` not caused by you, `max-tokens`, `interrupted`) — sends one "continue" after a short delay.
> - **Swallowed turns** — the turn is logged as `completed` even though the model meant to call a tool and an OpenAI-compatible relay emitted the call markup as plain text instead, leaving the agent silently idle. Detected structurally (the reasoning block and the text block are byte-identical, or the text is empty while reasoning is not, or the tail is a broken call tag) and continued with a pointed message asking for the tool call again.
> - **Stalled requests** — a model request was issued and then no stream frame arrived for `stallMs`. The turn is cancelled (`kind: 'hook'`, inbox kept) and continued.
>
> Waiting on an approval or on a question is logged and notified, never answered on your behalf. A stop you pressed yourself, a turn that really finished, and non-retryable errors (auth, quota, context overflow) are all left alone. Detection is pure structure over the session log — no judge model, no network calls.
>
> Install: `dsh plugin --profile <profile> add github:Chlyz621/dsh-unstuck` (or run `install.ps1` from a local clone). Config: `<DSH_HOME>/unstuck/config.json`. Log: `<DSH_HOME>/unstuck/unstuck.jsonl`. The detailed documentation below is in Chinese; `PLUGIN-NOTES.md` records why each decision was made.

---

## 它管四件事

| 现象 | 监督员怎么做 |
| --- | --- |
| 一轮对话异常结束（上游报错、输出被截断、进程崩溃留下的残局、非你按的中断） | 等一小会儿，补发一条「继续」 |
| **「假完成」**：日志写着这轮正常结束，其实工具调用被吞了、活没干完（最常见，见下节） | 补一条带指向性的「继续」，让它重新发工具调用 |
| 模型请求发出去了，但很久**没有任何流片段**（假死：TCP 断了但不报错） | 掐掉当前这一轮，再补「继续」 |
| **「问了不等」**：正文问你「你认可吗？」，你没回它，它自己往下开工 | 掐掉这一轮，把发言权还给你（见「问了不等」一节） |
| 卡在等你审批 / 等你回答问题 | 只记录 + 通知，**绝不替你回答** |

不插手的情况：你按了停止、你这轮真的干完了、你正在输入（inbox 里有你的消息）、连续中断超过预算、认证失败这类再试也没用的错误。

「异常结束」具体指这几种 `turn/end` 原因：`error`（上游报错）、`aborted`（不是你按的停止）、`max-tokens`（输出被 token 上限截断）、`interrupted`（进程中断留下的残局）。

---

## 断连根因：中转站把工具调用吞成了正文

这不是猜的，是从真实会话日志里挖出来的。同一会话三轮，**每一轮都是这么断的**：

| turn | 末 step | 耗时 | 块结构 | reasoning 与 text | tool-call | 正文尾部 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 21 | 10.6s | reasoning+text | **逐字节相同** | 无 | `…</｜｜DSML｜｜ calls>` |
| 2 | 138 | 4.5s | reasoning+text | **逐字节相同** | 无 | `…temp dir.</｜｜DSML｜｜ parameter>` |
| 3 | 10 | 18.4s | reasoning+text | **逐字节相同** | 无 | `Hmm, the`（断在词中间） |

同一会话 172 条 assistant 消息里，「reasoning 和 text 逐字节相同且没有 tool-call」只出现这 3 次 —— 正是被吞的 3 次，其余 169 条零误报。

**机理**：模型本来要发工具调用，中转站（`api: openai-completions` 兼容层）没能把 DeepSeek 原生的 `｜｜DSML｜｜` 工具调用标记转成 OpenAI 的 `tool_calls`，那段标记被当普通正文吐了出来。于是 assistant 消息里只剩 reasoning + text、没有 tool-call；agent 循环认为「模型没要求调工具 = 这轮说完了」，`turn/end` 记成 `completed`，agent 静默 idle。

你看到的现象就是「跑着跑着自己断了，得手动发一句才继续」。耗时正常（4.5–18.4s，不是超时）、长度不一（2868–8892 字符，不是 token 上限），所以既不是超时也不是截断，是**协议转换层偶发失败**。

dsh 自带的「继续」按钮也救不了它 —— 那个按钮把 `completed` 当「已收工」，直接拒绝续跑。本插件的 `continueOnSwallowed` 就是专门补这个洞。

### 想根治的话（可选）

根因在中转站那一层，插件只能兜底。能减轻的办法：

- **换模型**：`glm-5.3` / `kimi-k3-1` / `minimax-m3` 这些模型原生就是 OpenAI 风格的工具调用，不走 DSML，理论上不会踩这个坑。改 profile 的 `agent-default-model` 即可。
- **降 `reasoningEffort`**：`max` 会让 reasoning 特别长，长流更容易在中转站出错。降到 `high` 试试。
- **换官方端点**：DeepSeek 官方 API 不会有这层转换。

---

## 问了不等：它问你「你认可吗」，然后自己开工

这是实测抓到的另一种更隐蔽的中断，2026-10-22 02:07 在会话 `session-d54e23f7` 里完整发生了一遍：

| 时刻 | 发生了什么 |
| --- | --- |
| 02:07:24 | assistant 正文写「上面这个 5 表 3 页的范围，**你认可吗？**」，并承诺「认可 → 我下一轮直接出工程骨架」 |
| 02:07:51 | **同一个轮次**里自己开始建工程（`mkdir` → 写 `package.json` → `npm install`） |
| 02:10:10 | 装完 244 个包，后台起好了 |
| 02:10:11 | 你按了停止，然后问「你刚刚都给我提了什么问题？」 |

问题不在「它做错了」，而在**它把「等你点头」和「先干起来」放在了同一个轮次里**：你还没来得及回答，工已经开了一半。等你想改主意，成本已经产生了。

`pauseOnUnansweredQuestion` 就是拦这个：

| 值 | 行为 |
| --- | --- |
| `off` | 不管 |
| `mutate`（默认） | 问完之后只要它开始**动文件**（`write` / `edit` / `delete` / `apply_patch` …）就掐 |
| `any` | 问完之后只要有**任何**下一步动作（含 `bash`）就掐 |

判定用的是结构而不是关键字：正文最后 400 字里出现求确认措辞（「你认可吗」「需要你点头」「请确认」…）或第二人称问句（`你/您 … ？`）。代码围栏里的问号不算 —— 否则它解释这条规则的时候会被自己误伤。

掐掉之后**不会**自动补「继续」，因为该说话的是你。日志里留一条 `question-paused`。

> 只在它真的往下干的时候才掐。只是问一句、然后等你回话，是正常行为。

---

## 三个必须知道的默认行为

1. **只补「继续」两个字。** 它不猜你想干什么，也不改你的需求。续跑消息的来源标记是 `dsh-unstuck`，所以它不会把自己发的消息当成你在说话。
2. **有预算。** 同一个会话连续中断最多自动续跑 `continueMax`（默认 3）次，用完就停手并在日志里记一条 `continue-budget-exhausted`。你只要手动发一条消息，预算立刻清零。
3. **有退避。** 第 1/2/3 次续跑前分别多等 1.5s / 5s / 15s，避免把上游打爆、也避免烧钱。

---

## 安装

两种装法。只想装上用走第一种；要改代码或者离线装走第二种。

### 一、从 GitHub 装（推荐）

```powershell
dsh plugin --profile tauri add github:Chlyz621/dsh-unstuck
```

dsh 会把仓库取到 profile 的 `node_modules` 下并登记进 `dsh.profile.bundles`。装完**完全退出** DeepSeek Harness（含托盘图标）再打开。

### 二、从本地目录装（改代码时用）

```powershell
cd <仓库根目录>
pwsh -File .\install.ps1
```

装完**完全退出** DeepSeek Harness（含托盘图标）再打开。

脚本做三件事，每一步都会先备份：

1. 把插件复制到 `<DSH_HOME>\plugins\dsh-unstuck`
2. 在 `<DSH_HOME>\profiles\tauri\package.json` 里登记依赖并加进 `dsh.profile.bundles`
3. 在 profile 的 `node_modules` 下建一个目录联接，让 dsh 能 `require` 到它（不联网、不跑 pnpm）

参数：

```powershell
pwsh -File .\install.ps1 -Profile tauri -DshHome C:\Users\me\.dsh -Force
```

卸载：

```powershell
pwsh -File .\uninstall.ps1          # 只从 profile 摘掉，插件文件留着
pwsh -File .\uninstall.ps1 -Purge  # 连插件文件一起删
```

---

## 怎么确认它活着

```powershell
Get-Content "$env:USERPROFILE\.dsh\unstuck\unstuck.jsonl" -Tail 20
```

开机应该有一行 `{"event":"boot",...}`，里面能看到当前生效的配置和挂上了几个监听器。之后每次动手都有记录：

| event | 含义 |
| --- | --- |
| `boot` / `dispose` | 装上了 / 卸载了 |
| `continue-sent` | 补了一条「继续」（带 attempt、kind、code） |
| `turn-swallowed` | 发现「假完成」（带 why：`dsml-leak` / `echo-reasoning` / `no-output`） |
| `continue-skipped` | 判断过但没补（带 why：`user-abort` / `policy` / `stall-already-handled`） |
| `continue-deferred` | 本来要补，但你在输入或已经跑起来了（`user-took-over` / `inbox-busy`） |
| `continue-budget-exhausted` | 预算用完，需要人看一眼 |
| `stall-detected` | 判定假死（带 silenceMs） |
| `clock-jump` | 机器睡眠/事件循环被卡，这一轮巡检只搬时间锚点、不判定（带 gapMs） |
| `question-paused` | 命中「问了不等」，掐掉了这一轮（带 tools：它本来要动哪些文件） |
| `user-abort-noted` | 你按了停止、且这一轮一个字都没输出（可能就是界面看着卡住） |
| `question-asked` / `approval-asked` | 记录了你被卡住 |
| `question-blocked` / `approval-blocked` | 卡太久，提醒你 |
| `request-retry` | 重试了一次模型请求（默认关闭） |

debug 级的记录（比如每轮一条 `running`）默认不落盘，只有 `verbose: true` 才写，免得把上面这些有用的记录淹掉。

---

## 调参

默认值够用。想改就把示例配置复制过去，改完重启 dsh：

```powershell
Copy-Item .\unstuck.config.example.json "$env:USERPROFILE\.dsh\unstuck\config.json"
```

优先级：内置默认 < profile 里 `cordis.patch.yml` 的 config < 这个 `config.json`（后者赢）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉后一个监听器都不装 |
| `autoContinue` | `true` | 续跑总开关 |
| `continueMax` | `3` | 每个会话最多自动续几次 |
| `continueText` | `"继续"` | 续跑发什么 |
| `continueOnSwallowed` | `true` | 「假完成」也续跑，见「断连根因」一节 |
| `continueTextSwallowed` | 带指向性的一句 | 「假完成」时发的措辞 |
| `continueOnUserAbort` | `never` | 你按了停止怎么办：`never` 不碰 / `silent` 只在零输出时续 / `always` 一律续 |
| `notifyUserAbort` | `true` | 零输出的用户中断额外提醒一次 |
| `pauseOnUnansweredQuestion` | `mutate` | 「问了不等」拦不拦：`off` / `mutate` / `any`，见上文 |
| `continueDelayMs` | `700` | 发现中断后先等多久 |
| `backoffMs` | `[1500,5000,15000]` | 每次续跑额外等待 |
| `continueOn` | 异常类原因 | 只在这些 turn 结束原因上续跑 |
| `skipCodes` | 认证类错误码 | 命中就不续（试也没用） |
| `autoRetry` | `false` | 模型请求层重试，**默认关**，见下 |
| `retryMax` | `2` | 请求重试次数 |
| `stallEnabled` | `true` | 假死检测开关 |
| `stallMs` | `180000` | 请求发出后多久没流片段算假死（3 分钟） |
| `stallResumeMs` | `800` | 掐掉后等多久再补「继续」 |
| `tickMs` | `15000` | 巡检间隔 |
| `hardStallMs` | `0` | 整轮零事件的兜底阈值，0=关闭（长工具本来就很久没事件） |
| `notifyBlocked` | `true` | 卡审批/等回答时提醒 |
| `blockedNotifyMs` | `120000` | 卡多久开始提醒 |
| `notifyCommand` | `""` | 额外执行的命令，`{msg}` 会替换成正文；留空只写日志 |
| `skipOwnedAgents` | `true` | 子 agent 不插手 |
| `verbose` | `false` | 连 debug 级也打印到控制台 |

### 和 dsh 自带「继续」按钮的关系

桌面端本来就有一个「继续」按钮（`POST /api/tauri/ui/session/resume`），它做的事和本插件一样：判断上一轮是不是正常结束，不是就补一条 `Continue the interrupted task...`。

区别在于**它是手动的**——得你去点。本插件把那套判断搬进进程内、按事件自动触发，而且更保守：

- 你按了停止 → 不续（`continueOnUserAbort` 默认 `never`；想连这种也救就设 `silent`）
- 认证失败 / 余额不足 / 上下文超长 → 不续（点了也没用）
- 连续中断超过 `continueMax` 次 → 停手并提醒
- 你的消息一进来 → 立刻让位

它发的消息 source.kind 是 `dsh-unstuck`，跟桌面端按钮的 `continue` 区分开，日志里一眼能看出是谁干的。反过来，如果发现会话里已经有一条 `continue` 或 `dsh-unstuck` 消息，本插件不会再补第二条。

### 和 dsh-purge 的关系

dsh-purge 自带一个 `autoRetry`（profile 里默认**开着**），做的是同一件事。所以本插件 `autoRetry` 默认 `false`，避免两边叠成 6 次重试。

想让监督员统一管：在 profile 的 `cordis.patch.yml` 里把 dsh-purge 的 `autoRetry` 设成 `false`，再把本插件的 `autoRetry` 设成 `true`。

---

## 桌面通知（可选）

Windows 上想收气泡提醒，把 `notifyCommand` 设成：

```json
{ "notifyCommand": "msg * {msg}" }
```

或者用 [BurntToast](https://github.com/Windos/BurntToast)：`pwsh -NoProfile -c "New-BurntToastNotification -Text 'dsh', '{msg}'"`。

---

## 它做不到的事

- **dsh 进程整个没了（崩溃、被关掉、桌面端退出）** —— 插件在进程内，进程死了它也跟着死，救不了。这种要靠外部守护进程，不在本插件范围。
- **模型一直返回同样错误** —— 预算用完后它只提醒，不硬刚。
- **它不替你回答提问、不替你点审批。** 这是故意的：那类决定不该自动化。

---

## 开发

```powershell
cd <仓库根目录>
node --test "test/*.test.js"
```

- `lib/core.js` 纯逻辑（判原因、算退避、造消息、读 session 事件），无副作用，好测
- `lib/config.js` 默认值 + 归一化 + 用户配置文件
- `lib/index.js` cordis 装配层，只管接事件和发消息
- `test/core.test.js` 逻辑单测；`test/plugin.test.js` 用假 ctx / 假 agent 跑装配层

改完 `lib/` 想让它生效，有两条路（实测过，别信「改 profile patch 就能热重载」这种说法，那个不成立）：

1. **改已安装目录里的文件** —— dsh 在监听 `~/.dsh/plugins/` 下的插件目录，文件一变，1~2 秒内自己 `dispose` + `boot`，不用重启。所以先同步：
   ```powershell
   Copy-Item .\lib\*.js $env:DSH_HOME\plugins\dsh-unstuck\lib\ -Force
   ```
   然后看 `~/.dsh/unstuck/unstuck.jsonl` 尾部有没有新的 `boot` 行。
2. **重跑 `install.ps1` 或直接重启桌面端** —— 最稳，任何情况下都算数。

注意：只往 profile 的 `cordis.patch.yml` 里加注释**不会**触发重载（实测等 30 秒无反应）。想改配置，写进 `<DSH_HOME>\unstuck\config.json` 再重启。

---

## 关于名字和市场里的描述

**为什么叫 `unstuck`**：它的三件事——异常结束、假完成、请求假死——本质都是「卡住了」，本插件做的就是把卡住解开。这个名字在 npm 和插件市场 catalog 上都是空闲的；而 `dsh-supervisor` 那个名字已经被人发布后撤回（registry 里只剩墓碑，0 版本），发不了，也进不了 catalog。

**为什么插件市场里一开始没有描述**：市场只显示 **catalog 里已发布插件**的描述，不读本地 `package.json`。本地 `file:` 安装的插件没有 catalog 条目，所以只有包名、没有描述。目前的解决办法是把一条说明写进市场备注（`.dsh-market\state.json` 的 `notes`），市场「已安装」那一行会显示它；你可以在行尾「···」里改成自己的话。

想让它有真正的「作者描述」，只能发布到 npm 并被 catalog 收录——catalog 支持 `description.en` 与 `description.zh-CN` 两栏。发布前请确认 `package.json` 里的 `files`、`dsh.bundle.patch`、`dshTarget` 都对（现在是对的）。
