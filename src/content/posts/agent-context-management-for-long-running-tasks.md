---
pubDatetime: 2026-09-19T00:34:34+08:00
title: "Agent 长任务里的上下文管理：不要把所有历史都塞进 Context"
description: "探讨如何通过持久化历史、结构化状态、证据引用和动态 Context Projection，提高长任务 Agent 的稳定性与可追溯性。"
tags:
  - agent
  - architecture
  - engineering
draft: false
---

最近看到一个关于长任务 Agent 上下文管理的讨论，其中一个思路让我很有共鸣：

> 当上下文快满时，与其不断压缩旧上下文，不如结束当前窗口，保留必要状态和历史引用，再用一个新的上下文继续执行。

仔细想下来，这和我目前在 Agent 系统里采用的策略其实很接近。

我的核心思路一直不是“怎么把越来越多的信息塞进上下文”，而是：

> **完整信息应该持久化保存，但只有当前真正需要的信息才进入模型上下文。**

随着 Agent 执行时间越来越长，我越来越觉得，Context Window 不应该承担 Agent 的全部记忆。它更像工作内存，而不是数据库。

这篇文章主要整理一下这个问题，以及我目前采用的一套方案。

## 核心观点

- Context Window 更适合作为工作内存，而不是完整历史的存储空间。
- 原始消息、Tool Result 和 Artifact 应持久化，并通过引用保持可追溯。
- Agent 应显式维护小而稳定的 Structured Working State。
- Context Builder 根据当前任务投影必要信息，并结合规则与 Agent 主动 Retrieval。
- 长任务应从原始历史和近期事件重建状态，避免无限递归压缩 Summary。

---

## 一、问题：Agent 的 Context 为什么迟早会出问题

一个最简单的 Agent 可能长这样：

```text
用户请求
  ↓
LLM
  ↓
调用工具
  ↓
Tool Result
  ↓
继续推理
  ↓
继续调用工具
```

如果每一步的信息都继续追加到 `messages[]`：

```text
System Prompt
User Message
Assistant Message
Tool Call
Tool Result
Assistant Message
Tool Call
Tool Result
...
```

短任务没有什么问题。

但一旦 Agent 开始执行几十分钟甚至几个小时，这种设计很快会遇到麻烦。

### 1. Tool Result 往往非常大

例如一个 Code Review Agent 可能读取：

```text
完整 Git Diff
多个源代码文件
静态扫描结果
编译日志
测试日志
Git History
多个子 Agent 的输出
```

其中一个工具结果就可能有几千甚至几万 token。

真正影响当前决策的内容可能只有几十行。

如果把所有原始结果永久留在 Context 里，本质上是在用最昂贵的存储空间保存大量低频数据。

---

### 2. 历史信息不一定还有价值

Agent 在调查问题过程中可能经历：

```text
怀疑 A
→ 调查
→ 排除 A

怀疑 B
→ 调查
→ 排除 B

最终确认 C
```

如果完整历史一直留着，那么模型每一次后续推理都要继续看到：

```text
关于 A 的大量讨论
关于 B 的大量讨论
各种失败尝试
已经废弃的假设
已经过期的代码
```

Token 够用并不意味着这些内容有帮助。

很多时候恰恰相反：

> **旧信息太多本身就是噪声。**

---

### 3. 一直做 Summary 也不是完美方案

一个常见办法是：

```text
Context 快满
→ Summary
→ 继续

又快满
→ Summary of Summary
→ 继续
```

问题在于压缩本身就是有损的。

比如原始约束是：

```text
不要修改 auth.go，
这里只允许调查问题。
```

第一次压缩可能变成：

```text
需要调查 auth 模块。
```

再经过几轮：

```text
当前任务与 auth 有关。
```

最重要的“不要修改”可能已经消失了。

所以我不太喜欢：

```text
Summary1
→ Summary2
→ Summary3
→ Summary4
```

这种无限递归压缩。

它很像重复压缩一张 JPEG。

每次损失一点，长期运行以后误差可能会不断累积。

---

## 二、核心思路：Context 只是工作内存

我目前更倾向于把 Agent 的信息分成三个层级。

```text
Persistent History
        ↓
Structured Working State
        ↓
Current Context
```

分别承担不同职责。

### 第一层：Persistent History

这一层保存完整信息：

```text
历史消息
Tool Call
完整 Tool Result
日志
Diff
文件内容
测试结果
Agent 输出
```

原则是：

> **尽量不丢。**

但是“不丢”不代表“全部放进 Context”。

它们更像数据库里的原始记录。

例如：

```text
artifact://test-run-184
artifact://security-scan-91
artifact://git-diff-abc123
```

需要的时候再读。

---

### 第二层：Structured Working State

这是 Agent 当前真正需要长期记住的东西。

例如：

```text
goal
current_step
confirmed_facts
constraints
unresolved_items
next_actions
evidence_refs
version
```

举个 Code Review 的例子：

```text
Goal:
Review PR #123

Current PR Head:
abc123

Confirmed Findings:
- F17: Potential SQL Injection

Pending:
- Verify whether input is sanitized upstream

Constraint:
- Do not modify public API

Evidence:
- security-scan-91#42
- diff-abc123#dao.go:80-96
```

这一层应该很小。

因为它不是保存“发生过什么”，而是在回答：

> **我们现在知道什么？正在做什么？接下来要做什么？**

---

### 第三层：Current Context

真正调用 LLM 时，再根据当前任务组装 Context：

```text
System Prompt
+
Current Task
+
Working State
+
Relevant Evidence
+
Recent Important Events
```

而不是：

```text
整个 Agent 历史
```

例如 Security Agent 当前正在验证 SQL Injection，那么它可能只需要：

```text
当前 finding
相关代码
相关 diff
数据流证据
必要约束
```

之前扫描过另外 30 个文件的完整结果没有必要一起带进来。

于是整个过程变成：

```text
Persistent Memory
       ↓
Context Builder
       ↓
只挑当前需要的信息
       ↓
LLM
```

我认为这里最重要的不是“压缩”，而是：

> **Context Projection：当前这次推理到底需要看到什么？**

---

## 三、完整结果不进入 Context，但必须随时可以回来

我目前非常认可一个原则：

> **完整结果不默认进入 Context。**

注意，是“不默认”，而不是“永远不允许”。

比如静态扫描工具返回了 500 行结果。

第一次可以只告诉 Agent：

```text
Scanner found 3 suspicious locations.

F17:
dao.go:83
Possible SQL Injection

Full result:
security-scan-91
```

模型不需要立刻看到完整 500 行。

如果之后 Critic 想确认：

> 这个 finding 的原始证据到底是什么？

再执行：

```text
read(security-scan-91#F17)
```

把需要的部分加载进来。

所以更合理的模式是：

```text
默认：
Summary + Reference

必要时：
Fetch Full Evidence
```

而不是两个极端：

```text
所有东西一直塞进 Context
```

或者：

```text
压缩之后原始结果直接消失
```

---

## 四、Summary 最好带 Evidence Reference

这里还有一个我认为很重要的设计。

不要让 Working State 只有结论：

```text
CI failed because of dependency conflict.
```

最好是：

```text
Conclusion:
Dependency conflict caused the CI failure.

Evidence:
build-log-92#L420
dependency-tree-17
```

这样即使后面发现 Summary 有问题，Agent 仍然可以返回原始证据重新判断。

这其实是在把：

```text
State
```

和：

```text
Evidence
```

分开。

当前 Agent 只需要背着结论走。

证明这个结论的几十 KB 日志可以留在后面。

可以概括成一句：

> **状态向前走，证据留在身后。**

需要的时候再回来查。

---

## 五、不要做 Summary of Summary，而是定期 Rebuild State

这是我觉得长期运行 Agent 很容易踩的一个坑。

不太理想的是：

```text
Summary V1
+ 新内容
→ Summary V2

Summary V2
+ 新内容
→ Summary V3
```

因为一旦 V1 丢掉一个细节，后面几乎永远恢复不了了。

我更倾向于：

```text
Persistent History
+
Current Structured State
+
Recent Important Events
        ↓
重新构建
        ↓
State V3
```

也就是：

> **Rebuild，而不是 Recursive Summarization。**

两者看起来都叫“压缩”，但逻辑不一样。

Recursive Summary 是：

```text
压缩上一次的压缩结果
```

Rebuild 是：

```text
重新计算“当前世界状态”
```

后者更像数据库里的 Materialized View。

原始数据仍然存在，只是定期重新生成一份适合当前 Agent 使用的视图。

---

## 六、仅靠 Agent 主动 Retrieval 也不够

到这里，这套方案还有一个明显的问题。

假设完整历史都保存着，并且 Agent 可以随时搜索：

```text
search_history()
read_artifact()
```

是不是就解决了？

还没有。

因为这里有两种情况。

第一种：

```text
Agent 知道自己缺信息
```

例如：

> 我需要刚才那份测试日志。

很好，它会主动查。

但更危险的是第二种：

```text
Agent 不知道自己缺信息
```

比如 Working State 里写：

```text
数据库问题已经排除。
```

但实际上历史里只检查了 Primary DB，没有检查 Replica。

如果 Agent 相信当前摘要，它根本不会产生：

```text
search history about replica
```

这个动作。

这就是经典的：

> **unknown unknowns。**

所以 Retrieval 不能全部依赖 LLM 自己决定。

---

## 七、Context Builder 应该承担一部分主动补充职责

因此我觉得更成熟的方案应该是：

```text
LLM-driven Retrieval
+
Policy-driven Retrieval
```

比如 Code Review 场景，可以制定确定性的 Context Policy：

```text
验证 Finding
→ 自动加入相关代码 + Diff

重新验证旧 Finding
→ 自动加入旧 Evidence

执行 AutoFix
→ 自动加入相关测试结果

PR Head 改变
→ 自动标记旧 Diff / Finding 可能 stale
```

也就是说：

> Agent 可以主动找信息，但系统也应该根据任务类型自动给它补必要信息。

于是 Context Builder 不再只是：

```text
token 截断工具
```

而是一个真正的 Runtime 组件。

---

## 八、信息还应该有 Version 和 Freshness

这一点在真实 Agent 系统里很重要。

假设 Security Agent 在：

```text
PR head = abc123
```

时生成：

```text
Finding F17
```

后来开发者又 push：

```text
PR head = def456
```

那么之前保存的：

```text
Diff
代码片段
Finding
Summary
```

并不是全部仍然有效。

所以 Memory 不能只保存：

> 这是什么信息？

还应该保存：

> **它基于哪个世界状态产生？**

例如：

```text
Finding {
    id: F17
    source_sha: abc123
    evidence_ref: ...
    created_at: ...
    status: confirmed
}
```

之后 Context Builder 发现：

```text
current_head != source_sha
```

就可以决定：

```text
重新验证
标记 stale
重新加载最新代码
```

这相当于把我们熟悉的乐观锁 / Freshness Check 也带进了 Context Management。

---

## 九、Context 本身也应该有 Budget

最后还有一个比较工程化的问题：

> 即使已经做了按需加载，应该优先放什么？

我比较喜欢把信息简单分层：

```text
Tier 0
当前任务 + 强约束
永远保留

Tier 1
Working State
默认保留

Tier 2
当前步骤相关 Evidence
按需加载

Tier 3
完整 History / Raw Tool Result
默认不加载
```

如果 Context Budget 开始紧张：

```text
先 Drop Tier 3
再减少 Tier 2
```

而不是碰：

```text
任务目标
用户约束
当前状态
```

也就是说，Context Window 应该有自己的资源管理策略。

---

## 十、新窗口到底有没有必要？

对于 ChatGPT、Codex 这种长会话 Agent，新窗口是比较自然的解决方式。

因为整个系统天然是：

```text
Conversation
→ Message
→ Message
→ Tool Result
→ Message
→ ...
```

Conversation 本身就是 Working Memory。

跑久以后，显式：

```text
保存 Notes
保存 History
结束旧 Context
创建新 Context
恢复 State
```

是合理的。

但对于自己开发的 Agent Runtime，我认为不一定需要把“开新窗口”做成一个非常明显的动作。

因为我们本来就控制每次模型请求。

完全可以做到：

```text
Persistent State
      ↓
Context Builder
      ↓
一次全新的 LLM Call
```

从 Runtime 的逻辑建模上看，每一次 LLM 调用都可以基于当前状态重新组装输入，等价于获得一个新的轻量 Context：

> **这里的“新 Context”指重新构建模型输入，不代表必须创建新的会话实体。**

Agent 的连续性不再来自：

```text
messages[] 永远不断
```

而来自：

```text
Persistent State + History + Retrieval
```

我觉得这是一个更干净的模型。

---

## 十一、这套方案的优点

最大的优点当然是 **Context 更干净**。

模型主要看到当前真正相关的信息，而不是大量历史噪声。

其次是 **Token 成本更可控**。

一个 100KB 的 Tool Result 不会在之后每一次 LLM 调用里反复付费。

第三是 **长任务更稳定**。

Agent 的连续性由外部状态保证，而不是依赖某一个永远不能结束的 Conversation。

第四是 **可以追溯**。

Summary 错了，还能通过 `evidence_ref` 回到原始结果。

最后是 **系统职责更清楚**：

```text
History
负责保存发生过什么

Working State
负责保存现在是什么状态

Context Builder
负责决定这次模型应该看到什么

LLM
负责推理
```

这比让 `messages[]` 同时承担所有职责清晰很多。

---

## 十二、它的缺点也很明显

首先，系统复杂度会提高。

以前：

```text
messages.append(...)
```

就结束了。

现在需要：

```text
Persistent Store
Artifact Store
Working State
Context Builder
Retrieval
Version Management
```

工程量明显增加。

其次，Context Selection 本身可能选错。

如果系统漏掉了某条重要信息：

```text
信息明明存在
但没有进入 Context
```

对于模型来说和“不存在”没有区别。

第三，Working State 本身仍然可能产生错误。

即使有 Evidence Reference：

```text
错误 Summary
```

仍然可能误导后续 Agent。

所以必须允许重新验证。

最后，Retrieval Policy 很难做到完美。

完全交给 LLM 不可靠；

全部写死规则又缺乏灵活性。

最终大概率还是需要：

```text
Deterministic Policy
+
LLM Retrieval
```

两者结合。

---

## 十三、我目前更倾向的 Agent Memory 架构

如果把前面的思路组合起来，我目前比较认可的是：

```text
                Persistent Source of Truth
              /            |             \
         Messages       Tool Results     Artifacts
              \            |             /
                       History
                          │
                          ▼
                 Structured State
                          │
                  evidence references
                          │
                          ▼
                  Context Builder
                  /              \
          Policy Retrieval    Agent Retrieval
                  \              /
                          ▼
                    Context Window
                          │
                          ▼
                         LLM
```

并且所有信息最好再带：

```text
version
timestamp
source
scope
evidence_ref
```

这样 Agent 不仅知道：

> 我知道什么。

还知道：

> 我为什么知道，以及这个信息现在是否仍然有效。

---

## 结语

我现在越来越觉得，长任务 Agent 的核心问题并不是：

> **怎么造一个更大的 Context Window？**

而是：

> **怎么让 Agent 不需要一直依赖一个巨大的 Context Window？**

完整历史应该持久化。

原始 Tool Result 应该可追溯。

当前状态应该显式维护。

真正进入 Context 的内容应该根据当前任务动态构建。

必要时重新读取证据，而不是把所有过去一直背在身上。

最终：

```text
Agent Memory
≠ Conversation History
```

更合理的模型可能是：

```text
Agent Memory
=
Persistent History
+ Structured State
+ Evidence
+ Retrieval
```

而：

```text
Context Window
```

只是这套 Memory System 在某一个时间点投影出来的一小部分。

**Context 是工作台，不是仓库。**
