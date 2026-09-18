---
pubDatetime: 2026-09-18T15:09:56+08:00
title: "从 Raft 到 EvoAgent：Agent Runtime 的并发、副作用与持久化执行"
description: "讨论 Agent 从一次性推理走向长期执行后，如何处理并发、副作用、事件路由与持久化，并将 Raft 的机制映射到 EvoAgent。"
tags:
  - agent
  - distributed-systems
  - architecture
  - project
  - tech
draft: false
---

传统 Agent 很容易被理解成：

```text
用户请求
→ LLM 推理
→ 调一次工具
→ 返回答案
```

在这个模型里，很多系统问题并不明显。

但当 Agent 开始执行几十秒甚至几分钟、调用多个外部工具、修改 GitHub / 数据库 / 文件、与其他 Agent 并发工作，还要等待 CI、Webhook 或 Human Approval 时，事情就变了。

Agent 不再只是一次 LLM 调用，而是一个长期运行、会产生副作用的异步 worker。

这时会出现一组很具体的问题：

- Agent Review PR 的时候，开发者又 push 了 commit，怎么办？
- Security Agent 和 Correctness Agent 同时发现同一个问题，怎么办？
- Agent push 成功但 create PR 失败，重试会不会重复 push？
- Agent 要等 CI 20 分钟，难道整个 Agent run 一直挂着？
- 系统里来了 100 个事件，难道全部塞进每个 Agent 的 Context？

这些问题也恰好会出现在我正在做的 EvoAgent PR Reviewer 中。因此，这篇文章前半部分会讨论这些问题需要什么 Runtime 语义，后半部分再把它们映射回真实的 PR Review、AutoFix 和 CI 场景。

## 1. Agent Runtime 真正需要解决什么

过去的执行过程可以简化成：

```text
Request
→ LLM
→ Tool
→ Response
```

而一个长期运行的 Agent 更接近：

```text
Event
→ Agent
→ Read State
→ Reason
→ Tool
→ External Effect
→ Wait
→ New Event
→ Resume
→ More Effects
→ Commit
```

执行模型变化以后，Runtime 需要面对五类问题：

```text
状态会变
→ stale execution

多个 Agent 会抢同一个任务
→ concurrent execution

Tool 会产生真实副作用
→ partial failure / retry

外界事件越来越多
→ routing / attention

任务会跨越很长时间
→ suspend / resume
```

所以 Agent Runtime 的核心问题，已经开始从“模型怎么推理”转向“执行过程怎么管理”。它需要的不只是 `Prompt + Tool Call`，而是：

```text
Agent Runtime
= LLM
+ 并发控制
+ Tool Effect 管理
+ 消息路由
+ Durable Execution
```

恰好，AI-Native 协作产品 Raft 在真实的多人 + Multi-Agent 环境里遇到了类似问题，它的一组机制很适合作为 Runtime 设计样本。

本文受到 Raft 文章 [Is Having Agents in the Room Meant to Be Chaotic?](https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/) 启发。这里的 Raft 不是分布式系统中的 Raft consensus algorithm；CAS、lock、Effect Ledger、durable continuation 等，是我从产品机制出发做的工程类比，并非 Raft 官方术语。

## 2. Raft 给出的五种 Runtime 语义

### 基于旧状态执行：Freshness Hold

传统聊天里，人看到一条消息，很快就回复了。

但 Agent 不一样。

Agent 收到消息以后，可能经历：

```text
读取上下文
→ 推理
→ 调工具
→ 查数据
→ 再推理
→ 生成答案
→ 发送
```

整个过程可能持续几十秒甚至几分钟。

问题在于，这段时间外部世界并不会停止变化。

例如：

```text
t0:
Agent 读取聊天室状态 S0

t1:
Agent 开始处理

t2:
用户发送了一条新消息
聊天室变成 S1

t3:
Agent 还基于 S0 生成答案
```

如果此时 Agent 直接提交，就属于：

基于旧状态完成了一次写操作。

这和我们熟悉的读写冲突其实是同一个问题。

文章里的 Freshness Hold，本质上可以理解成：

`Optimistic Lock / CAS`

Agent 开始执行时记录：

```text
version = S0
```

提交之前检查：

```text
current_version == S0 ?
```

如果还是 S0：

`Commit`

如果已经变成 S1：

```text
Hold
→ 把新增上下文给 Agent
→ 重新判断
→ revise / send / silence
```

所以它解决的是：

我读取数据以后，到提交结果之前，数据有没有发生变化？

和数据库里的：

```sql
UPDATE ...
WHERE version = old_version
```

本质非常接近。

### 多 Agent 重复执行：Task Claim

Freshness Hold 主要解决旧状态问题。

但 Multi-Agent 还有另一个问题：

```text
Agent A 看到任务 T
Agent B 也看到任务 T

A 开始执行
B 也开始执行
```

如果只是回答问题，可能只是重复。

但如果任务是：

- 改代码
- 创建 PR
- 部署
- 修改文件
- 调用外部 API

那就可能产生真正的冲突。

所以文章又设计了 Task Claim。

例如：

```text
Agent A:
claim(task)
→ success

Agent B:
claim(task)
→ already owned by A
```

这更接近：

`lock / lease / ownership`

所以这里其实有两类并发控制：

```text
Freshness Hold
→ CAS / optimistic concurrency
→ 防止基于旧状态提交

Task Claim
→ lock / ownership
→ 防止多个 Agent 同时执行同一任务
```

这两个不能完全混为一谈。

### Tool 部分失败：Partial Result

我觉得这是文章里非常有工程价值的一点。

普通 Tool API 很容易设计成：

```text
success
failed
```

但 Agent 调工具时，这远远不够。

因为一个工具调用内部可能已经产生了多个副作用。

例如：

`send_message()`

内部：

1. 正文发送成功
2. @mention 失败

如果 Tool 最后只告诉 Agent：

`FAILED`

Agent 很自然就会：

`retry`

结果就变成：

`正文发送两次`

这就是典型的：

```text
Partial Failure
+
Retry
=
Duplicate Side Effect
```

所以 Agent 真正需要的不是：

这个函数成功还是失败？

而是：

这个操作已经对外部世界造成了哪些影响？

因此 Tool Result 应该更像：

```yaml
status: PARTIAL_SUCCESS

effects:
  - message_created: success
  - mention_created: failed
```

这样 Agent 才知道：

- 不要重新发送正文
- 只补 mention 即可

这其实是 Effect Semantics

我会把它理解成：

```text
Tool Call Result
从 Function Result
升级成 Effect Report
```

例如一个 AutoFix 流程：

```text
create branch   success
commit          success
push            success
create PR       failed
```

正确恢复方式应该是：

`从 create PR 继续`

而不是：

`把整个 AutoFix 再执行一遍`

所以一个成熟 Agent Runtime 最好明确记录：

```text
Intent
→ Effect 1
→ Effect 2
→ Effect 3
```

甚至保存成 Effect Ledger。

这实际上对应很多传统系统里的概念：

- idempotency
- transaction log
- partial failure
- retry semantics
- workflow recovery

### 世界事件如何进入 Agent：Inbox

这一部分和我之前提到的“路由投递中心”非常像。

一个聊天室里可能每分钟都有大量消息，但对于某一个 Agent 来说，绝大部分消息其实都不重要。

如果系统设计成：

```text
聊天室新消息
→ 自动塞进 Agent Context
```

那么很快就会遇到两个问题：

- Context Window 被大量无关信息污染
- Agent 被无意义地频繁唤醒

所以文章设计了 Inbox。

我更倾向于把它理解成：

`Event Routing Center`

整体结构：

```text
所有事件
    │
    ▼
Routing / Inbox
    │
    ├── Agent A
    ├── Agent B
    └── Agent C
```

只有和某个 Agent 真正相关的事件，才投递给它。

例如：

- PR #123 updated
- CI failed
- 某人在群里聊午饭
- PR #999 merged
- @SecurityAgent

对于 Security Agent 来说，可能只需要：

- PR #123 updated
- CI failed
- @SecurityAgent

其他信息根本不用进入 Context。

**Routing 和 Attention 还可以再区分。**

更严格一点，可以拆成：

```text
Routing
→ 这个事件属于哪个 Agent？

Attention
→ 这个事件要不要现在进入 Agent Context？
```

于是变成：

```text
World Events
     ↓
Event Bus
     ↓
Router
     ↓
Agent Inbox
     ↓
Attention Policy
     ↓
Context Window
```

这个结构比：

`所有消息 → messages[]`

要合理很多。

因为：

世界状态和 Agent 当前注意到的信息，本来就不应该是同一个东西。

### 长时间等待：Reminder

这一点我一开始觉得最容易被误解。

文章所谓 Reminder，本质上不是：

`Agent sleep 一会`

而是：

当前执行先结束，把“未来还要继续做什么”持久化，之后再重新唤醒。

例如：

```text
Agent push code
↓
CI running
```

这时候 CI 要跑 20 分钟。

最笨的做法是：

`sleep 20 min`

或者：

```text
while CI running:
    poll()
```

这样 Agent 一直保持运行状态。

但实际上这 20 分钟 Agent 什么都做不了。

更合理的是：

```text
保存 checkpoint
↓
结束当前 Agent run
```

checkpoint 里保存：

```text
task = PR #123
completed = push commit
waiting_for = CI
next_step = CI finished 后检查结果
```

然后当前执行直接结束。

**后续再唤醒。**

未来由：

- Timer
- CI Event
- Webhook
- Scheduler

触发：

```text
Wakeup
↓
读取 checkpoint
↓
读取最新世界状态
↓
继续执行
```

这里非常关键的一点是：

它不是恢复 20 分钟前完整的程序运行现场。

而是恢复：

`logical state / continuation`

也就是：

- 我是谁
- 我在做什么
- 做到哪里了
- 我在等什么
- 醒来以后下一步是什么

所以我会把它叫做：

`durable continuation checkpoint`

比普通 checkpoint 更准确。

## 3. 把它们放在一起：Agent Execution Lifecycle

把文章重新整理以后，我觉得核心非常清楚：

| 问题                      | 文章机制       | 后端视角                                   |
| ------------------------- | -------------- | ------------------------------------------ |
| Agent 执行期间状态变化    | Freshness Hold | CAS / optimistic lock                      |
| 多 Agent 同时执行同一任务 | Task Claim     | lock / lease / ownership                   |
| Tool 部分成功             | Partial Result | effect log / idempotency                   |
| 消息太多                  | Inbox          | event routing / attention                  |
| 等待未来事件              | Reminder       | checkpoint / scheduler / durable execution |

最终其实可以统一成一个 Agent 生命周期：

```text
Event
  ↓
Router
  ↓
Agent
  ↓
Claim / Read State
  ↓
Execute
  ↓
Record Effects
  ↓
Freshness Check
  ↓
┌────────────────────┐
│ 能继续 → Continue  │
│ 要等待 → Checkpoint│
└────────────────────┘
             ↓
            Exit

       future event
             ↓
          Wakeup
             ↓
      Restore State
             ↓
      Refresh World
             ↓
      Continue / Replan
```

我觉得这才是整篇文章真正有价值的 mental model。

## 4. 放回 EvoAgent：问题如何出现在真实 Workflow

> **状态说明**：EvoAgent 当前已经实现 Lead、Security、Correctness/Reliability、Critic 的多 Agent 审查编排，并具备节点级 checkpoint/resume 基础。以下 Freshness Guard、finding ownership、effect-aware AutoFix、Event Router、CI wakeup/resume 等内容，属于从原文得到的启发或后续规划；除非明确标注为“已实现”，不代表当前已经落地。

放回当前 EvoAgent PR Reviewer，最值得关注的不是：

我们是不是也要做 Inbox、Reminder、Claim 这几个模块？

而应该问：

EvoAgent 现在有哪些真实问题，本质上属于这些系统问题？

### PR Review：Freshness Guard 与 Finding Dedup

**PR 在 Review 期间发生变化。**

**从原文得到的启发（尚未实现）：PR Freshness Guard。**

这是最直接可以吸收的。

当前可能出现：

```text
Agent 开始 review commit A
↓
运行几十秒 / 几分钟
开发者 push commit B
↓
Agent 最终把基于 A 的 comment 发出去
```

本质就是 stale state。

可以直接引入：

`review_base_sha`

开始时：

```text
base_sha = current_pr_head
```

发布 findings 前：

```text
current_head == base_sha ?
```

如果不相等：

`HOLD`

然后再决定：

- 重新 review
- 只 review incremental diff
- 废弃旧 finding
- 重新验证 finding

这就是 EvoAgent 版的 Freshness Hold。

而且这个功能非常适合做实验：

```text
baseline:
不检查 PR freshness

vs

new:
version-aware review
```

然后统计：

- stale findings 数量
- 重复 comment 数量
- 错误定位到旧代码的 comment 数量

这种东西会非常有 runtime evidence。

**多个 Agent 重复发现或修复问题。**

**当前设计：**

EvoAgent 当前设计中的角色包括：

- Security Agent
- Correctness Agent
- Performance Agent
- Critic

**从原文得到的启发（尚未实现）：finding dedup / ownership。**

很可能不同 Agent 会发现同一个问题。

例如：

```text
Security:
SQL 拼接存在风险

Correctness:
这里直接拼接 SQL 可能出错
```

如果没有协调层：

- 两个 finding
- 两个 comment
- 甚至两个 fix

这其实就是 ownership / dedup 问题。

但我觉得这里不一定需要真的做分布式锁。

对当前项目来说，轻量版本可能就够：

```text
finding fingerprint
+
semantic dedup
+
owner agent
```

比如：

```text
finding_id =
file
+ line range
+ category
+ normalized root cause
```

然后 Lead/Critic 做：

- merge
- claim
- deduplicate

这就已经吸收了文章的思想。

### AutoFix：Effect-aware Execution

**后续规划：Effect-aware AutoFix，尚未实现。**

这一点我觉得对 EvoAgent 特别有价值。

你的系统后面如果支持：

- 修改代码
- 运行测试
- 创建 branch
- commit
- push
- create PR
- comment

就一定会遇到 partial failure。

例如：

```text
修改代码        success
测试            success
commit          success
push            success
create Draft PR failed
```

如果现在只是：

`AutoFix status = failed`

那 Runtime 根本不知道该怎么恢复。

可以改成：

```text
FixExecution

patch_generated = true
patch_applied = true
tests_passed = true
commit_created = true
branch_pushed = true
draft_pr_created = false
```

然后恢复时：

`resume from draft_pr_created`

而不是重新跑全部流程。

这一点甚至可以成为 EvoAgent 的一个亮点

因为现在很多 Agent 项目展示的是：

`LLM 调工具成功了`

但真正工程系统更关心：

`失败以后怎么办？`

如果你的项目能展示：

```text
partial failure
→ persisted effects
→ restart
→ resume correctly
```

技术可信度会高很多。

### CI Validation：Checkpoint 与 Event-driven Resume

**已实现与后续规划的边界：** EvoAgent 已有节点级 checkpoint/resume 基础；下面的 CI 事件驱动等待与恢复属于后续规划，尚未实现。

这个也很自然。

比如 AutoFix：

```text
生成 patch
↓
push branch
↓
等待 CI
```

不要：

`Agent 一直轮询 CI`

而是：

```text
FixWorkflow checkpoint:

state = WAITING_FOR_CI
commit = abc123
next = evaluate_ci_result
```

然后：

`结束本轮 execution`

CI webhook 回来：

`CICompleted(commit=abc123)`

Router 找到对应 workflow：

```text
wake
↓
load checkpoint
↓
continue
```

这样就真正形成了：

`Durable Agent Workflow`

### GitHub、CI 与 Human：统一事件路由

**后续规划：Event Router，尚未实现。**

Inbox 的思想也非常适合 EvoAgent，但不需要真的做“Agent 邮箱”。

可以抽象成：

`Event`

例如：

- PullRequestOpened
- PullRequestUpdated
- ReviewRequested
- ReviewCommentAdded
- CICompleted
- FixRequested
- TimerExpired

所有东西先进入：

`Event Router`

然后：

```text
PullRequestUpdated
→ Review Workflow

CICompleted
→ Fix Validation Workflow

Security-related finding
→ Security Agent
```

也就是说：

- GitHub
- CI
- Timer
- Human

都只是 Event Source。

这可以把系统从：

```text
GitHub webhook
→ 一堆 if else
```

逐渐变成：

```text
Event
→ Routing
→ Workflow
→ Agent
```

架构会干净很多。

## 5. 实现边界：吸收 Runtime 语义，而不是造基础设施

**后续规划：以下是优先级建议，不代表已经实现。**

这一点很重要。

我不建议因为看了这篇文章，就直接：

- 造一个 Event Bus
- 造一个 Distributed Lock
- 造一个 Scheduler
- 造一个 Workflow Engine

这样很容易把三个月项目做炸。

我会这样分。

**当前 MVP 强烈值得吸收：**

1. PR Freshness Guard
2. Effect-aware execution state
3. Workflow state persistence
4. Finding dedup / ownership

这几个都非常贴近 PR Reviewer 的真实问题。

**可以做轻量版本：**

5. Event Router
6. CI wakeup / resume
7. task ownership

不需要通用化，先服务：

- PR Review
- AutoFix
- CI Validation

这几条路径即可。

**暂时不要做成通用基础设施：**

- 通用 Agent Inbox
- 通用 Distributed Lock Service
- 完整 Durable Scheduler
- 通用 Workflow DSL
- 类似 Temporal 的执行引擎

因为这些很容易偏离项目目标。

我们要吸收的是：

**系统语义。**

而不是：

**把 Raft / Temporal 重新实现一遍。**

**长期的架构转变。**

**后续规划：以下是目标架构方向，不代表已经实现。**

原来的 EvoAgent 很可能更接近：

```text
PR
↓
Lead Prompt
↓
几个 Specialist Prompt
↓
Critic Prompt
↓
输出结果
```

这种系统虽然叫 Multi-Agent，但本质上更像：

**多阶段 LLM Pipeline。**

而吸收这篇文章真正重要的部分以后，可以逐渐变成：

```text
GitHub / CI / Human Events
          ↓
      Event Router
          ↓
   Persistent Workflow
          ↓
     Agent Execution
          ↓
  Effect-aware Actions
          ↓
Freshness / Coordination
          ↓
 checkpoint / resume
```

这时候系统就不只是：

**“有多个 Agent”**

而是：

**“有 Agent Runtime 语义”**

这两者技术含量差别其实很大。

## 6. 总结

我对这篇文章最大的收获可以概括成一句话：

Agent 不能只被当成一个会自动回复消息的人，它更像一个运行在持续变化环境中的异步 worker。

一旦这样看，很多问题就自然变成了熟悉的后端问题：

```text
状态会变化
→ CAS / freshness

多人会抢任务
→ ownership

工具会部分成功
→ effect tracking

消息很多但注意力有限
→ routing

任务需要等待
→ checkpoint + wakeup
```

而对 EvoAgent 来说，最值得吸收的也不是“重新设计聊天系统”，而是这套思维：

把 Agent workflow 从一次性推理流程，升级成一个有版本、有状态、有副作用、可暂停、可恢复，并与外界持续交互的异步执行实体。
