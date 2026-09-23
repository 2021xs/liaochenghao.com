---
pubDatetime: 2026-09-23T15:39:13+08:00
title: "Agent 不需要预先知道整个世界，只需要知道如何发现世界"
description: "从 History、Knowledge、Skill、Tool 与 CLI 出发，讨论 Agent 如何通过小型核心、通用 Primitive 和动态发现机制组合外部能力。"
tags:
  - agent
  - architecture
  - thought
draft: false
---

最近在看 Agent 的 Context、Skill、Tool、CLI 设计时，我发现这些看起来分散的话题，最后其实都在指向同一个方向：

> **Agent 不需要预先知道整个世界，只需要知道如何发现世界。**

这句话背后并不只是“节省 Context”这么简单。我觉得它反映的是 Agent 架构正在发生的一种变化：

```text
过去：
把知识、工具、历史、规则尽可能预装给 Agent

现在：
只保留一个小而稳定的核心
其余能力按需发现、加载和组合
```

如果继续往下推，这甚至可能意味着：

> Agent Tool Design 的终点，未必是越来越丰富的 Tool Schema，而可能是越来越少、越来越通用的 Primitive，再让强模型通过 CLI、Skill 和 Retrieval 动态组合能力。

---

## 一、过去的 Agent：把整个世界塞进 Context

最直接的 Agent 设计通常是：

```text
Agent
=
LLM
+ Prompt
+ History
+ Knowledge
+ Tools
+ Rules
```

需要什么，就往里面加什么。

Agent 要记住历史：

```text
→ 把历史消息全部放进 Context
```

Agent 要了解领域知识：

```text
→ 把文档塞进 Prompt
```

Agent 要调用工具：

```text
→ 把所有 Tool Schema 注册给模型
```

Agent 要掌握某种专业能力：

```text
→ 把 SOP 继续写进 System Prompt
```

当系统还比较小时，这种方式最简单。

但随着 Agent 能力持续增加，很快就会出现一个共同问题：

> **模型背着越来越多当前根本用不到的信息工作。**

假设一个通用 Agent 背后拥有：

```text
100 万条历史消息
10000 篇知识文档
1000 个 Tools
500 个 Skills
一个大型代码仓库
```

真正处理某一个问题时，也许只需要：

```text
当前任务
1 条用户约束
3 个代码片段
1 个 Skill
4 个 Tool
```

如果仍然坚持把“所有可能有用的东西”都交给模型，不仅 Token 成本会上升，模型的注意力本身也会被大量无关信息污染。

所以问题逐渐从：

> 如何扩大 Context？

变成：

> **这一轮推理，到底什么东西值得进入 Context？**

---

## 二、History：不需要记住所有过去，只需要知道怎么回去看

最早很多 Agent 的 Memory 本质上就是：

```text
messages[]
```

用户消息、Assistant 输出、Tool Call、Tool Result 不断往后追加。

时间一长：

```text
Context 越来越大
→ 压缩
→ 再继续
→ 再压缩
```

但真正更自然的方向可能是：

```text
完整 History
      ↓
Persistent Storage
      ↓
Retrieval
      ↓
Relevant Context
      ↓
LLM
```

也就是说，Agent 不需要始终“记住所有过去”。

它只需要知道：

```text
历史在哪里
+
什么时候应该查
+
怎么把相关内容取回来
```

这其实已经是第一次能力外置：

```text
remember everything
```

变成：

```text
retrieve when needed
```

所以 Memory 的核心不一定是“保存多少”，而越来越像：

> **如何从一个巨大的历史空间里恢复当前真正需要的信息。**

---

## 三、Knowledge：优秀的 Agent 不一定知道所有答案，但应该知道去哪里找

Knowledge 也是一样。

传统方式可能把大量业务规则直接塞进 Prompt：

```text
System Prompt
+
产品文档
+
研发规范
+
安全要求
+
业务规则
```

但随着知识越来越多，这显然不能无限扩展。

于是变成：

```text
Knowledge Store
      ↓
Search / Retrieval
      ↓
Relevant Knowledge
      ↓
Context
```

这里发生了一个很重要的变化：

> Agent 的能力，不再完全取决于它“已经知道什么”，而开始取决于它“是否知道如何获得自己不知道的东西”。

这其实很像真实工程师。

一个优秀工程师并不是把 MySQL、Linux、Kubernetes 的所有文档背下来。

更重要的是：

```text
看到一个现象
↓
判断可能和 MVCC 有关
↓
知道应该查什么
↓
找到正确资料
↓
完成验证
```

所以真正稀缺的能力逐渐从：

```text
Knowledge
```

变成：

```text
Discovery + Retrieval + Reasoning
```

---

## 四、Skill：不需要永远背着所有 SOP

Skill 又把这个思路往前推进了一步。

假设一个 Agent 拥有很多专业能力：

```text
SQL Injection Review
Auth Bypass Review
Database Migration Review
K8s Troubleshooting
Performance Profiling
...
```

最直接的做法是把所有 Instructions 塞进 Prompt。

但实际上，一个处理数据库迁移问题的 Agent，这一轮根本不需要知道：

```text
如何排查 K8s NetworkPolicy
```

所以更合理的方式是渐进式加载：

```text
Metadata
→ 知道这个 Skill 存在

Instructions
→ 真正需要时加载执行步骤

Resources / Code
→ 执行过程中再按需加载
```

Agent 不需要一直记得：

> K8s 网络故障应该按照哪 17 个步骤排查。

它只需要知道：

> 我有一个 K8s Troubleshooting Skill，需要的时候可以加载。

因此：

```text
Know every procedure
```

开始变成：

```text
Know how to discover and load procedures
```

---

## 五、Tool：为什么一定要提前告诉 Agent 所有能力？

Tool 也是完全一样的问题。

传统 Function Calling：

```text
Agent
├─ Tool A schema
├─ Tool B schema
├─ Tool C schema
├─ ...
└─ Tool 500 schema
```

当工具数量很少时，这没有任何问题。

但当 Agent 拥有上百种能力时，每轮都让模型面对完整 Tool Catalog 就开始变得不自然。

更合理的方式可能是：

```text
当前任务
   ↓
Tool Retrieval / Router
   ↓
Top-K Candidate Tools
   ↓
Main Agent
   ↓
最终选择
```

也就是把：

```text
Know every tool
```

变成：

```text
Know how to discover tools
```

这和 RAG 的思路其实完全一样。

RAG 是：

```text
10000 篇文档
→ 检索 5 篇
→ 给模型
```

Tool Routing 是：

```text
1000 个 Tool
→ 检索 5 个
→ 给模型
```

它们解决的本质都是：

> **从一个巨大的外部空间中，找到当前最相关的一小部分。**

---

## 六、CLI：甚至未必需要提前定义这么多 Tool

CLI-first 的思路则更加激进。

比如 Git 本身已经提供：

```bash
git status
git diff
git log
git blame
git branch
```

如果再为 Agent 包装：

```text
GitStatusTool
GitDiffTool
GitLogTool
GitBlameTool
GitBranchTool
```

有时是在重复构造一层接口。

对于足够强的 Coding Agent，也许只需要给它：

```text
execute
```

然后让它自己：

```bash
git --help
git log --help
git log ...
```

这里有一个很有意思的变化。

过去我们试图为每一种高阶能力定义 Tool：

```text
InvestigateCommitTool
AnalyzeHistoryTool
FindRegressionTool
```

但 CLI 的思路更像：

```text
提供少量 Primitive
↓
让 Agent 自己组合
```

例如：

```bash
git log --oneline |
grep fix |
head -20
```

实际上已经组合出了一个原本没有专门定义过的新能力。

所以我开始觉得：

> **Agent Tool Design 的终点未必是越来越丰富的 Tool Schema，而可能是越来越少、越来越通用的 Primitive。**

---

## 七、这很像计算机本身的设计

我觉得一个很好理解的类比是 CPU。

我们并没有给每一个应用需求设计一个 CPU 指令。

CPU 只有少量 Primitive：

```text
load
store
add
compare
jump
...
```

但这些 Primitive 组合之后，可以构造：

```text
编译器
数据库
浏览器
游戏
```

Agent 也可能走向类似的方向。

真正长期存在于 Agent Core 里的能力也许并不需要很多：

```text
read
search
edit
execute
retrieve
persist
delegate
```

然后：

```text
调查 Git 历史
```

可以理解成：

```text
execute + git
```

```text
查领域规范
```

可以理解成：

```text
retrieve + knowledge
```

```text
检查 SQL Injection
```

则可能是：

```text
load skill
+
search code
+
execute analyzer
+
read evidence
```

也就是说：

> **高阶能力不一定需要全部被预定义，它们可以由少量 Primitive 动态组合出来。**

---

## 八、从“全能 Agent”到“Agent Kernel”

沿着这个思路继续走，我觉得未来 Agent 更像一个小型 Kernel，而不是一个预装了整个世界的全能应用。

```text
                Agent Kernel
                     │
            ┌────────┼────────┐
            │        │        │
         Reason   Discover  Compose
            │        │        │
            └────────┼────────┘
                     ↓
               External World
        ┌────────────┼────────────┐
        │            │            │
     History      Knowledge      Skills
        │            │            │
     Artifacts      Tools         CLI
```

Agent Kernel 自己真正长期需要拥有的，也许只有：

```text
当前目标
关键约束
Working State
少量核心 Primitive
发现外部能力的方法
```

剩下的都在外部世界中。

需要时再获取。

所以可以换一种说法：

> **Agent 不需要把世界放进 Context，只需要拥有访问世界的方法。**

---

## 九、Context Engineering 本质上是在做“世界投影”

这样再看 Context Engineering，就会发现它远不只是：

```text
Context 太长
→ 做 Summary
```

真正的问题是：

> **这一轮模型应该看到什么？**

外部系统可能拥有：

```text
History
Knowledge
Tools
Skills
Code
Artifacts
Subagent Results
Task State
```

而 Context Engineering 要做的是：

```text
World State
     ↓
Routing / Retrieval / Filtering
     ↓
Current Context
     ↓
LLM
```

可以把它理解成一种：

> **Context Projection。**

把一个巨大的真实世界投影成当前推理所需要的一小部分。

所以最近看到的这些方向：

```text
Memory Retrieval
Skill Loading
Tool Routing
Context Compression
Subagent Context Isolation
```

其实不是五个独立的问题。

它们都在回答同一个问题：

> **什么东西现在值得进入模型的注意力？**

---

## 十、但“Primitive 越少越好”也是一个陷阱

这个方向同样不能走向极端。

不能因为：

```text
一个 shell
```

理论上可以完成很多操作，就认为：

```text
所有 Tool 都应该变成 shell
```

越通用的 Primitive，意味着自由度越高。

同时也意味着：

```text
可控性下降
权限边界变宽
输出更难结构化
失败语义更复杂
副作用更难管理
```

例如：

```text
create_pr(title, body)
```

和：

```bash
gh pr create ...
```

后者更加通用。

但前者拥有很明显的工程优势：

```text
参数明确
权限清晰
方便审计
容易幂等
容易记录 Effect
容易做 Evaluation
```

所以最终合理的架构应该不是：

```text
Structured Tool
vs
Primitive
```

二选一。

而是一种分层。

---

## 十一、我更认可“小核心 + 动态外围”

最终我比较认可的形式是：

```text
Agent Core

常驻：
- 少量核心 Tool / Primitive
- 当前任务
- Working State
- 强约束

按需：
- Domain Skills
- Knowledge
- Long-tail Tools
- MCP capabilities
- Historical Evidence
- Large Artifacts
```

同时按照能力本身的性质决定暴露方式。

对于：

```text
高频
高风险
高结构化
有明确副作用
```

的能力，保留专门 Tool：

```text
apply_patch
create_pr
deploy
send_message
```

因为这些能力需要严格定义：

```text
input
permission
effect
retry
audit
```

而对于：

```text
git
rg
semgrep
go test
jq
```

这类成熟、低层、可自由组合的开发环境能力，则可以更多利用 CLI。

所以我觉得比较合理的原则是：

> **稳定核心能力结构化，长尾能力动态发现；低风险能力允许自由组合，高风险能力保持强约束。**

---

## 十二、放到 Coding Agent 里

例如一个 Security Actor，不一定需要永久注册几十个 Security Tool。

它可以常驻：

```text
search_repository
read_file
read_artifact
execute_safe_command
```

同时知道自己拥有：

```text
SQL Injection Review Skill
Auth Bypass Review Skill
Dependency Vulnerability Skill
```

当遇到 SQL Injection 时：

```text
加载 SQL Injection Skill
        ↓
发现需要 Source → Sink 分析
        ↓
搜索相关代码
        ↓
必要时加载 / 调用 taint analyzer
        ↓
读取 Evidence
        ↓
形成 Finding
```

整个过程中，Agent 不需要：

```text
永远看到所有 Security Tool
永远背着所有 Security SOP
永远加载整个 Repository
```

但它仍然能够使用这些能力。

这其实比“在 Prompt 里拥有很多东西”更接近真正的可扩展性。

---

## 结语

最近看的很多 Agent 设计，看起来分别在解决不同问题：

```text
Context
所有 History 不要全部塞进模型
→ 按需加载

Skills
所有 Skill 不要全部塞进去
→ Progressive Disclosure

Tools
所有 Tool Schema 不要全部塞进去
→ Router / Lazy Load

CLI
甚至 Tool 本身都不用提前注册
→ 提供通用 Primitive
→ 按需发现
```

但继续抽象以后，它们其实正在汇聚成同一条主线：

> **Agent 不需要预先知道整个世界，只需要知道如何发现世界。**

进一步说：

> **Agent 的能力，不应该由“它当前 Context 里装了多少东西”决定，而应该由“它能够按需发现、获取并组合多少外部能力”决定。**

也许未来一个真正强大的 Agent，并不会拥有一个越来越庞大的 Prompt、越来越多的 Tool Schema 和越来越长的 Context。

反而可能只是：

```text
一个足够强的模型
+
一个很小的 Working Context
+
少量通用 Primitive
+
一套可靠的 Discovery / Retrieval 机制
```

剩下的知识、工具、技能和历史，都在外部世界里。

**需要的时候，再去拿。**
