# Operator rulings for the resident-session replacement

These rulings reopen the existing PR #384 task. They do not authorize replacing
Core routing or deleting unrelated provider capabilities. Timestamps use the
operator's local time (UTC+08:00). Original quotations are preserved; the rest
of the record is English.

## R1: Evaluate the provider as a fresh implementation

2026-09-07 13:38:

> 我们换一个标准啊，假如说Claude Code的这个Provider直接全部删掉，完全重写的话，还需要实现成现在这个样子吗？就是我感觉这边是在最初的代码上反复堆砌成现在这样的。这个问题确实是在我预料之外的。说明这块的架构对你来说有些难理解了。

Scope: architecture assessment of the Claude provider. This was a question
about the clean target, not permission to discard user-visible capabilities.

The TeamLeader's proposal was to replace input-to-settlement coordination:
remove the artificial request window and aggregate drainage; use one input
path, resident activity, and direct associations between submitted requests
and observed native results. Retain Core completion routing, process recovery,
MCP, skills, and the other independent provider capabilities.

## R2: Implement the replacement

2026-09-07 13:45, replying to that proposal:

> 按照这个新的思路，你来重新写一下代码

Translation: rewrite the code according to this new approach.

Development approval: granted for the proposal above and its verification,
with the existing PR as the delivery surface. The approved solution is
[resident-session input and settlement](technical-design/session-submissions.md).
This is a replacement of the request-window model, not a request to add the
two compatibility patches from the preceding review to that model.

## Retained product constraints

The original requirements still apply: native background work may survive and
start new turns; an unbound result produces no automatic parent completion;
an explicit steer consumed by that turn must receive its answer; a queued
request waits; folded requests share one completion per recipient. See the
[requirement](requirement.md#background-turn-repair-2026-09-07) and
[product catalog](/.agents/product/README.md#background-work-and-completion-delivery).

The earlier instruction "不要轮询结果。" remains in force: await automatic
TeamMate completion notifications, without result/status polling.

## R3: Publish the PR link and omit the workflow review

2026-09-07 14:28:

> 开 pr 之后把 pr 链接发给我

Delivery: update the existing PR #384 and send its link after pushing the
replacement. This does not authorize merge or another alpha release.

2026-09-07 14:35:

> 别跑  dynamic-workflow 了

The workflow review had not started. Omit that review for this replacement;
retain TeamLeader whole-diff pre-review, the completed four Rush gates, native
provider/Core verification and normal PR checks. No independent workflow pass
is claimed for this revision.
