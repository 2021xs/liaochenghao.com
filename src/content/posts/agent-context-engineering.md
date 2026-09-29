---
pubDatetime: 2026-09-29T17:05:00+08:00
title: "Context Engineering：Agent 的核心不是能看到多少，而是每一步该看到什么"
description: "从 Policy、Skill、State、Compression 与 Sub-Agent 出发，讨论长任务 Agent 如何为每一步决策构建真正需要的 Context。"
tags:
  - agent
  - architecture
  - engineering
draft: false
---

刚开始接触 Agent 时，我对 Context 的理解比较直接：

模型既然要完成任务，那就尽可能把信息给全。

用户需求、历史消息、相关代码、搜索结果、测试日志、工具返回值……只要上下文窗口装得下，就尽量保留。

直觉上，模型看到的信息越多，判断应该越准确。

但当 Agent 真正开始执行几十步甚至更长的任务后，这个直觉很快就会失效。

真正的问题逐渐从：

> 上下文窗口还能不能装下？

变成了：

> **在当前这一步决策时，模型到底应该看到什么？**

这也是我现在理解 Context Engineering 的起点。

本文关注的不是“如何把长上下文压短”，也不只是 RAG 或 Prompt 怎么写，而是一个更完整的问题：

Agent 运行过程中，不同信息应该什么时候进入 Context、以什么形式存在、什么时候退出。

## 几个核心观点

先把全文的结论放在前面：

- Context 不是一个 Prompt，而是一套运行时信息管理机制。
- 长 Context 不一定是好 Context，信息密度比单纯的窗口长度更重要。
- Trajectory 记录“发生过什么”，State 应该描述“现在是什么状态”，两者不应该混为一谈。
- Skills 的价值之一，是让知识按需进入 Context，而不是启动时全部加载。
- Compression 的重点不是“总结得更短”，而是保留后续决策真正需要的约束、失败和证据。
- Multi-Agent 不只是拆角色，也可以用来拆 Context：把重型调查过程隔离到独立 Sub-Agent 中。

## Context 不是一个字符串，而是一套运行时信息系统

先从一个最简单的 Agent Loop 看：

```text
Context
   ↓
Model
   ↓
Action / Tool
   ↓
Environment
   ↓
Observation
   ↓
更新 Context
   ↺
```

模型每一步都根据当前 Context 做决策，执行动作以后获得新的 Observation，然后继续下一轮。

所以随着 Agent 不断运行，Context 也在不断变化。

为了方便分析，我习惯把一次模型调用看到的 Context 粗略拆成：

```text
Context
=

Stable Prefix
+
Trajectory
+
Current State
```

这只是一种建模方式，不代表所有 Agent Runtime 都采用完全相同的实现。

其中：

```text
Stable Prefix
→ 相对稳定的系统规则、基础能力描述

Trajectory
→ user / model action / tool result 等运行历史

Current State
→ 当前阶段、TODO、预算、环境状态等派生信息
```

真正的问题出现在 Trajectory 不断增长之后。

一个 Coding Agent 运行几十轮，历史里可能已经存在：

```text
用户需求

搜索了哪些文件
读过哪些代码
跑过哪些测试

方案 A 为什么失败
方案 B 做了什么修改

新的错误日志
新的搜索结果
新的测试输出

当前 TODO
剩余预算
……
```

这些内容虽然都和任务有关，但并不意味着它们应该以原始形式一直存在于模型眼前。

长任务最终会遇到两种完全不同的问题：

```text
Context Overflow
→ 装不下了

Context Rot
→ 装得下，但已经不好用了
```

第二种往往更隐蔽。

关键信息依然在 Context 中，但被大量中间输出包围以后，Agent 开始：

```text
忘记早期约束
重复已经做过的搜索
重新尝试已经证明失败的方案
过度关注最近发生的局部问题
```

系统没有显式报错，但决策质量已经下降。

所以我现在更愿意把 Context Engineering 理解成：

> **管理模型每个决策点所依赖的信息生命周期。**

## 不同信息不应该被同等对待

一个比较实用的划分是：

```text
Policy
→ Agent 长期应该遵守什么规则

Capability
→ Agent 可以使用哪些 Tool / Skill

Working State
→ 当前任务进行到了哪里

Evidence
→ 当前判断建立在哪些证据上
```

这四类信息的生命周期完全不同。

Policy 通常比较稳定，例如：

```text
修改代码前先调查相关实现
finding 必须提供证据
高风险操作必须经过确认
```

Capability 也相对稳定：

```text
read_file
search_code
run_test
apply_patch
```

但 Working State 高频变化：

```text
phase = verification

todo:
✓ 定位问题
✓ 完成修改
→ regression test

test_attempts = 3
remaining_budget = 8
```

Evidence 则既动态，又特别容易膨胀：

```text
源码
grep 结果
调用链
测试日志
scanner output
```

如果这些信息全部混进一个越来越大的 Prompt，后续维护会越来越困难。

很多看起来互不相关的 Agent 技术，其实都是从这个问题自然产生的。

## Skills：最好的压缩，是一开始就不要加载

假设一个通用 Agent 可以处理：

```text
Java
Go
数据库
PDF
PPT
部署
Security Review
……
```

一种最直接的设计，是把所有领域规则全部写进 System Prompt。

但正在修 Go Bug 的 Agent，完全没必要同时知道 PPT 怎么生成。

更合理的方式是：

```text
先提供能力目录
        ↓
发现当前任务需要某项能力
        ↓
加载对应 Skill
        ↓
需要更深细节
        ↓
继续加载子文档 / 模板 / 脚本
```

这就是 Progressive Disclosure。

可以把它理解成一个很简单的原则：

> **先告诉模型“去哪里找”，真正需要时再把完整内容放进 Context。**

这样做的价值不仅是减少 token。

更重要的是：

> **某段知识是否进入 Context，本身成为了一个运行时决策。**

与其先塞进去 100K token，再想办法压缩成 30K，不如让那 70K 从一开始就不存在。

因此我现在会把 Prompt 和 Skill 做一个简单区分：

```text
Prompt / Stable Policy
→ 几乎所有任务都会用到的基础规则

Skill
→ 只有某类任务才需要的 SOP 和领域知识
```

例如：

```text
read_file
search_code
run_test
```

属于通用能力。

但：

```text
如何审查跨租户数据泄露
如何调查 Go 并发问题
如何完成一次数据库迁移
```

更适合以 Skill 的形式按需加载。

## Trajectory 记录过去，State 描述现在

另一个很容易混在一起的东西是 Trajectory 和 State。

Trajectory 适合回答：

> 之前发生过什么？

但它并不适合直接回答：

> 现在是什么状态？

例如 Agent 已经经历：

```text
run_test → fail
edit
run_test → fail
继续调查
edit
run_test → pass
```

如果下一轮还让模型重新扫描整段历史，然后自己判断：

```text
一共执行了几次测试？
当前测试是否通过？
现在应该进入哪个阶段？
```

实际上是在浪费模型的推理能力。

更合理的方式，是由 Harness 维护一份派生状态：

```text
test_attempts = 3
test_status = PASS

phase = regression

changed_files = [...]
remaining_budget = 8
```

作为后端开发者，我觉得可以用一个很熟悉的类比：

```text
Trajectory
≈ Event Log
→ 记录发生过什么

State
≈ Materialized View
→ 描述现在是什么
```

Event Log 当然可以推导当前状态。

但如果每一次查询都从头重放所有 Event，系统就会变得又贵又脆弱。

Agent 也是一样。

所以：

```text
tool_call_count
remaining_budget
current_phase
changed_files
test_status
```

只要程序能够确定性维护，我都会更倾向于交给 Harness，而不是让 LLM 每轮重新统计。

模型的推理能力应该留给真正存在不确定性的判断。

### State 还有一个作用：把重要信息重新放回模型眼前

长任务还有一个很实际的问题。

最重要的任务约束可能出现在最开始：

```text
修复 race condition。

约束：
不得改变现有 API 语义。
```

随后 Agent 产生了几十 K token：

```text
源码
搜索结果
测试
错误日志
中间尝试
……
```

模型运行到后面时，很容易越来越沉浸在当前局部问题中。

这时候可以把少量关键状态重新显式提供：

```text
Current Goal:
修复 race condition

Invariant:
不得改变 API 语义

Current Phase:
验证 patch
```

这并没有增加新的事实。

它只是把散落在历史中的重要状态重新提炼到了当前决策附近。

所以 State 不仅是状态存储，也是对模型注意力的一种管理。

## Compression：重点不是“总结”，而是提高信息密度

再好的 Context 管理，也不可能彻底避免 Trajectory 膨胀。

最终仍然会需要 Compression。

但我认为最危险的做法之一就是：

> 请总结前面的内容。

假设原始调查过程是：

```text
尝试方案 A

测试失败：
expected = 3
actual = 4

继续调查发现：
方案 A 改变了 merge ordering

因此确定：
不能修改现有 dedup semantics
```

如果最后压成：

> 方案 A 失败。

确实省 token 了。

但几乎所有对未来有价值的信息都没了。

更合理的压缩至少应该保留：

```text
Decision
Constraint
Failure
Evidence
Unresolved Question
```

例如：

```text
REJECTED: 方案 A

Reason:
会改变 merge ordering，
从而影响现有 dedup semantics。

Evidence:
foo_test.go:123
expected=3, actual=4

Constraint learned:
后续方案不得改变 merge ordering。
```

这里 Failure 尤其重要。

如果 Agent 最后只记录：

> 最终采用方案 C

却没有记录：

```text
为什么 A 不行
为什么 B 不行
```

任务足够长以后，它完全可能重新发明方案 A。

所以我现在觉得，Compression 真正值得优化的指标不是：

> token 越少越好。

而是：

> **单位 token 中，能支撑未来决策的信息有多少。**

## Multi-Agent 不只是拆角色，也是在拆 Context

这是我最近对 Multi-Agent 一个比较大的认知变化。

以前想到 Multi-Agent，我首先想到的是角色专业化：

```text
Security Agent
Correctness Agent
Performance Agent
```

也就是：

> 一个 Agent 做不完，那就拆成几个专家。

但还有一种完全不同的拆法：

不是因为另一个 Agent 更专业，而是因为我不希望它产生的大量中间信息进入 Main Agent 的 Context。

例如 Main Agent 正在分析一个 Bug：

```text
当前假设：

问题可能和
payment callback 的调用链有关。
```

接下来需要调查整个调用链。

如果 Main Agent 自己完成：

```text
grep 40 个文件
读 15 个实现
找 8 个 caller
看 5 个测试
翻 git history

→ 产生几万 token 中间过程
```

但真正支撑后续推理的结果可能只有：

```text
入口：
callback.go:81

主要 caller：
A、B

结论：
问题发生在 X

证据：
foo.go:123
bar_test.go:55

未知：
异步入口尚未确认
```

那么可以换一种结构：

```text
Main Agent
    │
    │ 调查 payment callback 调用链
    ↓
Investigation Sub-Agent
    │
    ├─ search
    ├─ grep
    ├─ read
    ├─ test
    └─ git history
    │
    ↓
Conclusion

- Evidence
- Unknowns
    │
    ↓
Main Agent
继续主推理
```

Sub-Agent 调查过程中产生的几十 K token，只存在于它自己的 Context 中。

任务结束以后，这些中间材料可以和它的 Context 一起被丢弃。

Main Agent 最终只接收几百 token 的调查结果。

这时候使用 Sub-Agent 的原因并不是：

> 它比 Main Agent 更懂调用链。

它甚至可以：

```text
使用完全相同的模型
使用完全相同的工具
没有特殊角色 Prompt
```

它存在的价值，仅仅是：

> **给这次重型调查提供一张独立的草稿纸。**

这让我意识到：

> **Multi-Agent 不只是拆角色，也是拆 Context。**

## 什么时候适合用 Sub-Agent 隔离 Context

当然，这也不是越多越好。

我现在会用一个很简单的判断：

如果一个子任务满足：

```text
中间信息量很大
+
任务边界相对明确
+
最终结果可以很小
```

那么使用独立 Sub-Agent 往往很合理。

例如：

```text
大范围代码搜索
调用链调查
几十 MB 日志分析
大量网页调研
批量实验
```

反过来，如果：

> 子任务每得到一个 Observation，都可能立刻改变 Main Agent 的下一步推理，

那么强行切开 Context 会制造大量 handoff 成本。

Main Agent 要不断把自己的背景发给 Sub-Agent，Sub-Agent 又要不断把中间状态传回来。

最终 Context 没省多少，通信复杂度反而增加了。

所以以后判断：

> 这个任务需不需要拆一个 Sub-Agent？

除了“是否需要专业能力”，我觉得还应该问：

> **这个子任务产生的中间信息，值得长期占用 Main Agent 的 Context 吗？**

如果答案是否定的，那么即使完全不存在角色专业化，也已经有了拆 Sub-Agent 的理由。

## 从“拆角色”到“拆 Context”

这样重新理解以后，Multi-Agent 至少可以有几种完全不同的拆分动机：

```text
Specialization
→ 拆能力

Parallelism
→ 拆执行

Independent Verification
→ 拆认知

Context Isolation
→ 拆信息
```

这四个理由并不是一回事。

其中“模拟一个软件团队，每个 Agent 一个角色”反而只是最直观的一种。

对我来说，更有意思的是后面三种：

```text
能不能并行？

能不能获得一套独立判断？

能不能把大量中间 Context 隔离出去？
```

这几个问题比“应该设计几个 Agent 角色”更接近真正的系统设计。

## Context Engineering 最终在管理什么

把前面的技术重新放到一起：

```text
Prompt
→ 定义稳定规则

Skill
→ 按需加载领域 SOP

State
→ 显式维护当前运行状态

Compression
→ 提高历史信息密度

Sub-Agent
→ 隔离不值得进入主 Context 的中间过程
```

它们表面上是五种不同的 Agent 技术。

但其实一直在回答同一个问题：

> **下一次 Model 做决策之前，Harness 应该让它看到什么？**

所以现在再让我解释 Context Engineering，我不会简单说：

> 它是比 Prompt Engineering 更全面的提示词工程。

Prompt Engineering 更关注：

> **如何把话说清楚。**

Context Engineering 则更进一步：

> **这一刻，到底应该把哪些话放到模型面前。**

真正需要设计的是：

```text
什么应该长期存在？

什么应该按需加载？

什么应该维护成 State？

什么应该压缩？

什么应该直接删除？

什么从一开始
就不应该进入主 Context？
```

对于长时间运行的 Agent 来说，这些问题最终决定的不是“Prompt 好不好看”，而是整个系统能不能持续做出稳定判断。

我现在越来越觉得：

> **Agent 的能力上限，不只取决于模型有多聪明，也取决于 Harness 能不能在每一个决策点，把真正需要的信息放到模型眼前。**
