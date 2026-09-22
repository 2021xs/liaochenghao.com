---
pubDatetime: 2026-09-22T16:44:15+08:00
title: "当 Agent 的 Tool 太多时，是否应该加一层“工具路由”？"
description: "讨论当 Agent 的工具规模增长后，如何通过 Routing、Retrieval 与 Lazy Loading 缩小当前模型需要看到的能力空间。"
tags:
  - agent
  - architecture
  - thought
draft: false
---

最近看到一种 Agent Skills 的实现思路，我觉得其中最值得抽象出来的，并不是 Skill 这个名字本身，而是一个很简单的架构问题：

> **当 Agent 拥有大量 Tool 时，主模型是否还应该直接看到所有 Tool？**

传统 Agent 通常会把所有 Tool 的 `name`、`description` 和参数 Schema 一起注册给模型：

```text
Main Agent
   ↓
Tool A
Tool B
Tool C
...
Tool N
```

Tool 很少时，这种方式最简单，也最直接。

但如果一个 Agent 未来拥有几十、几百甚至上千种能力，每一轮推理都把所有 Tool 定义放进 Context，就会带来两个问题：

```text
Context 成本增加
+
Tool 选择空间越来越大
```

Agent Skills 的一种实现思路就是把这个过程拆成 **发现、加载、执行** 三步：Agent 不需要一开始掌握所有 Tool 的详细定义，而是在真正需要某种能力时再查找、加载和调用。

## 给 Tool 加一个“中转站”

可以把原来的：

```text
Main Agent
    ↓
All Tools
```

改成：

```text
Main Agent
    ↓
Tool Router
    ↓
Candidate Tools
    ↓
Tool Execution
```

这个 Router 并不一定非得是另一个 LLM。

最简单可以是规则：

```text
SQL 相关问题
→ sql_parser
→ schema_reader
→ index_checker
```

也可以是检索：

```text
当前任务
↓
BM25 / Embedding
↓
Top-K Tools
```

也可以进一步使用小模型做 Tool Routing：

```text
Main Agent
↓
Router Model
↓
Top-K Tools
↓
Main Agent 最终选择
```

甚至可以组合：

```text
Rule Filter
→ Retrieval
→ LLM Rerank
→ Candidate Tools
```

文章中的实现就是给主模型只保留 `list_skill`、`get_skill`、`run_skill` 三个 Meta Tool：先检索有哪些相关能力，再按需获得某个 Tool 的完整 Schema，最后统一代理执行。

我觉得这里真正有价值的不是这三个 Tool 本身，而是：

> **Tool 的“发现”和“使用”开始解耦了。**

## Router 最好先缩小范围，而不是替 Agent 做完决定

这里还可以有两种不同的设计。

一种是 Router 直接决定：

```text
Request
↓
Router
↓
Tool X
```

这种方式简单、确定、延迟也低。

但 Router 一旦选错，主模型没有多少纠错空间。

另一种是：

```text
1000 Tools
↓
Router
↓
5 Candidate Tools
↓
Main Agent
↓
最终选择一个
```

我目前更倾向于第二种。

Router 的职责不是替 Agent 思考，而是：

> **把一个很大的能力空间压缩成当前任务真正相关的一小部分。**

这和消息路由其实非常像：

```text
所有消息
↓
Message Router
↓
只把相关消息给 Agent
```

现在变成：

```text
所有 Tools
↓
Tool Router
↓
只把相关 Tool 给 Agent
```

继续抽象下去，本质上都是同一个问题：

> **不要把整个世界都放进 Agent 的当前 Context。**

## 什么时候值得做？

我觉得这套设计有一个非常重要的前提：

**Tool 得真的多。**

如果 Agent 只有：

```text
read_file
search_code
run_test
call_graph
```

四五个 Tool，却额外增加：

```text
list_tool
get_tool
run_tool
```

反而只是增加了一层间接调用和延迟。

文章自己的实验也观察到了动态加载存在额外时延，而它真正面向的是大量长尾能力的场景。作者甚至直接用“1000 个 Tool”举例：这种规模下，不可能每轮都把所有 Tool 定义完整塞进上下文。

所以更自然的演进方式可能是：

```text
Tool 很少
→ 全部直接注册

Tool 开始变多
→ 按领域 / Actor 分组

Tool 非常多
→ Tool Router / Retrieval

大量长尾 Tool
→ Discovery + Lazy Loading
```

例如在 Code Review Agent 中：

```text
Review Orchestrator
        ↓
Security Actor
        ↓
Security Core Tools
```

这一层本身已经把整个系统的 Tool Space 缩小了一次。

如果以后 Security Actor 自己又拥有几十种能力，再进一步：

```text
Core Tools
→ 常驻

Long-tail Tools
→ 按需发现和加载
```

就会比较自然。

## 一个更大的抽象

前段时间我一直在思考 Agent 的 Context 管理：

```text
完整 History
不要全部进入 Context

完整 Tool Result
不要全部进入 Context

Knowledge
按需 Retrieval
```

现在看来，Tool 其实也一样：

```text
完整 Tool Catalog
也不一定需要全部进入 Context
```

于是它们可以统一成：

```text
Persistent World
│
├─ History
├─ Knowledge
├─ Artifacts
├─ Skills
└─ Tools
        ↓
Routing / Retrieval
        ↓
Current Context
        ↓
LLM
```

Agent Runtime 一个越来越重要的职责，可能就是：

> **决定当前这一轮推理，到底有哪些信息和能力值得被模型看到。**

所以我对 Agent Skills 这类方案目前最大的理解并不是“又出现了一种新的 Tool Calling 方法”，而是：

> **能力不需要始终存在于 Context 中，只需要能够被发现、加载和执行。**

Tool 少的时候没有必要增加复杂度。

但当能力规模真正增长起来时，在主模型和全量 Tool 之间增加一层 Router，可能会成为一个很自然的架构选择。
