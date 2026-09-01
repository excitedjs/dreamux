# Why dreamux development became painful after #110: a diagnostic

> **Frozen investigation snapshot (2026-09-01).** Preserved as evidence with
> original language intact; do not update the body. The live backlog moved to
> [/.agents/tasks/architecture/harness-gaps/README.md](/.agents/tasks/architecture/harness-gaps/README.md).


**Scope:** PRs/issues #110→#247. **One human** (`YourWildDad`); his correction signal lives in long planning/forensic posts (#135, #143, #147, #150, #151, #152, #182, #188, #197, #199, #209, #228, #230, #233) and terse Chinese owner-decisions/P1 verdicts, not in author-length heuristics.

**One-sentence answer:** The KB is **not the main culprit** — it is mostly accurate-but-insufficient with one inverted load-bearing fact. The dominant cause is **OTHER**: the architecture's load-bearing invariants (one-runtime-seam, ownership-in-the-owning-container, neutral-seam, production-must-actually-use-the-seam, ledger-as-source-of-truth) are **prose with no executable backstop**, so each agent re-derives them, places logic in the nearest convenient object, and ships code that compiles and "looks wired" but bypasses the real architecture — undetected until the operator manually reads the follow-up PRs.

> **Methodology caveat — read before trusting the frequency numbers.** This diagnostic rolls up evidence mined across five independent shards (A–E). Each shard was mined with its **own local theme numbering** (e.g. shard C's "routing/ownership re-derived" ≈ this report's global T1; shard D's "production-doesn't-use-seam" = global T3). The per-theme totals below are therefore a **re-projection of independently-numbered per-shard taxonomies onto one unified scheme** — they are **directionally accurate, not exact counts**. Treat "~25+ T1" as "T1 is clearly the most-recurrent class by a wide margin," not as a single consistently-applied label tallied once.

---

## 1. Taxonomy of recurring corrections (#110→#247)

Ranked by total recurrence across the five shards (directional — see caveat above). Each theme is the *same* correction restated PR after PR — that repetition is the proof the problem is systemic, not incidental.

### T1 — Capability/responsibility hung on the WRONG LAYER / nearest object (the master theme)
**Frequency: ~25+ across all shards. Span: #114→#247 (entire history).**
The agent attaches policy/state/capability to whatever class is nearest (the generic entity, the members collection, `server.ts`, `DispatcherService`) rather than the layer that *owns* the role.
- (#239) "为什么要在 teammateService 里判断 role？dispatcherService 和 TeamService 的…构造不是在 service 里吗？"
- (#239) "launchPolicyForTeamMate 这个函数怎么看起来这么蠢呢？DispatcherService 关 teamleader 什么事？"
- (#246) "Putting the scheduler [on TeammateService] turned 'does this entity have cron?' into a per-instance capability… Now 'only the dispatcher and each team leader have cron' is structural."
- (#135) "server.ts 成了事实上的 god object（2074 行）"; "`createBuiltinRegistry()` 在 6 处各自 `new`…并非 server 持有的单例"
- (#174) "`onTeamMateCompletion` sink still ignores identity owner/role and always calls `DispatcherAgentService.deliverCompletion`…reintroducing the completion-routing duality the Team Mode architecture needs to avoid."

This is *exactly* the CLAUDE.md "is this logic in the layer that owns it? / prefer a capability over a special case" rule — violated continuously.

### T2 — Parallel/duplicated abstraction instead of ONE unified seam
**Frequency: ~10. Span: #126→#240.**
A second tree gets forked beside the canonical one.
- (#135) "把该统一的 runtime 抽象做成了两套，而真正承重的 Dispatcher Service 反而没有实体。"
- (#135) "`teammate/worker/catalog.ts:9-17` 注释明说『故意不走 agent-runtime 的 registry』"; red line "④只有一个 AgentRuntime 接口、无第三套 provider"
- (#239) "team-collection 为什么要有一个这个 map？不能直接从 teamService 上拿吗？" → agent: "this map is a redundant parallel registry."
- (#103/#245) AgentHost aggregate wrapper rejected: "the Dispatcher/Team symmetry already comes from the shared primitives…not an aggregate wrapper."

### T3 — "Advertised through the seam, but production never actually uses it" / side-door bypass
**Frequency: ~14. Span: #147→#229. The single most expensive class** (spawned harness issue #228 + redo PR #229).
The interface exists and compiles; the real control flow goes around it, or the method has zero callers.
- (#147) "反向投送…**从来没有真正接通**"; "`completionInput`…在两个 builtin runtime 里都实现了,但**全 src 里零调用方**"
- (#151) claude dispatcher "**绕开了 dreamux 自己的 teammate MCP**,改用打包进来的 `tm` CLI…完全没有走到 dreamux 的 teammate 运行时."
- (#228) "A package can satisfy all of these checks and still fail the plugin-readiness goal…an external Agent Runtime provider must be usable by the production launcher without adding a provider-specific glue layer in core."
- (#228) "The review blocker was closed as soon as the real package became constructible through the generic loader. That is necessary, but not sufficient."
- (#185) "MCP shim and admin handlers validate, but `TeamService`/`TeamMateAgentService` write `input.intent`/`input.note` directly…In-process service/facade callers can still reach these paths without the required fields."

### T4 — Neutral-seam violation: provider/channel specifics leak into core
**Frequency: ~15. Span: #114→#230.**
- (#114) channel emitting Codex CLI strings → must emit runtime-neutral descriptors.
- (#209) "`DispatcherRow` is Feishu-coupled and must be de-coupled…Multi-channel cannot bake one Feishu bot into dispatcher identity."
- (#230) "MCP 工具描述和 dispatcher base prompt 里仍然写了 Feishu/chat-channel 风格的 selector 示例，这会把 provider-specific 的 selector 形状泄漏进 core-owned 文案."
- (#152) "那会让 channel 反过来认 runtime,职责错位."
- (#147) "手搓一段自造 XML、当成普通用户输入塞进上下文" instead of engine-native `thread/inject_items`.

### T5 — Drift teaching a REMOVED surface — split into two sub-classes
**Frequency: ~6-8 (T5a, the self-reinforcing class) + a larger T5b (human-facing) tail. Span: #134→#230.**
The original mining conflated these into one ~20-count theme; they must be separated because only the first sub-class is self-reinforcing and only the first is what backlog #4 fixes.

**T5a — model-facing prompt/skill drift (self-reinforcing, ~6-8).** The next agent reads its *own* retired model-facing artifact (base prompt, shipped skill) and re-introduces the removed shape:
- (#216) "the shipped dispatcher instructions still teach agents to use the removed generic Channel MCP surface and the old Feishu-shaped `chat_id` parameters…will cause agents to call the wrong surface."
- (#203) "KB / bundled skill text still teaches the removed session-ledger…agents will follow the wrong source of truth."
- (#191) "`.agents/components/dispatcher-skill.md` 仍在公开 KB 里描述已退场的 Team surface."
- (#159) "stale KB doc still advertises a removed dispatcher-facing MCP `resume` verb."

**T5b — human-facing KB / changelog / path-table drift (not self-reinforcing).** Reference prose or path tables describe a superseded layout. A maintainer can be misled, but the *agent's own loop* doesn't re-inject it:
- (#193) "the former monolithic architecture baseline still described the old
  pre-#182 layout... which could make later maintainers implement against the
  wrong state/runtime boundary."

Only **T5a** is the "KB actively misleading the next agent in a self-reinforcing loop" that *causes* the next T1/T3/T4 violation. Backlog #4 targets T5a specifically.

### T6 — Read surface / state built on the wrong data source; unbounded reads
**Frequency: ~9. Span: #174→#196.**
- (#189) "`history` 仍然以 identities 为主表…要求 `history` 恢复为 durable session ledger search surface."
- (#188) "`last`…reads from the live runtime (`getLast`) and is therefore not a durable session-ledger read."
- (#195) "`materializeSessions()` 又调用 `read()`，没有传 `limit`…违反 '单个 append-only per-dispatcher ledger 必须 streaming/bounded 读取' 的 final gate." (slipped through to the final integration PR).

### T7 — Wrong domain model: one-shot `task`/worker vs resumable teammate
**Frequency: ~6. Span: #126→#135.**
- (#135) "worker 当前是『一任务=一个 turn，跑完即焚』，与…半常驻、可 resume…直接冲突"; red lines "①worker 不回到一任务一 turn…②无 task 抽象".

### T8 — Glue-first instead of refactor-and-delete ("缝合"); fabricated behavior nobody designed
**Frequency: ~10. Span: #135→#236.**
- (#135) "不能做『新 service 先铺上，旧 worker/task 以后再删』的过渡…必须在同一个 PR 内完成迁移和删旧"; "缝合直接打回".
- (#235) "这段逻辑是早先由 agent 自行加入的,并非有意设计." (agent-fabricated "You are the TeamLeader" prompt).
- (#236) `close()` ran `git worktree remove` on a *borrowed* shared team worktree it didn't own.

### T9 — Dishonest capability / contract that lies to the model
**Frequency: ~8. Span: #129→#229.**
- (#139) "`context` capability 是空壳,与 `supported: true` 不符…『不得留空壳』红线的反面等价."
- (#134) "still says…'available by default'…no longer the honest capability model…overclaim."

### T10 — Lexical/shallow guard a real adversary bypasses
**Frequency: ~5. Span: #180→#193.**
- (#186) "`~/.dreamux` placement guard is lexical and can be bypassed by a symlinked dispatcher workspace…canonicalize…with `realpath`."

### T11 — Speculative surface built ahead of an UNSETTLED decision → operator reversal leaves an artifact to rip out
**Frequency: ~13 (incl. reversal churn). Span: #110→#246.**
This is **not** merely over-engineering. The distinguishing mechanic (see §2, cause 4): the agent builds fast on a decision the operator has **not yet settled**, so when the operator reverses, there is already a built type/tool/doc/test surface that must be excavated — the reversal itself becomes drift.
- (#182) "Do **not** introduce a live Codex socket registry…prevents a temporary runtime detail from becoming another maintained file surface." (reverses 4 of his own prior comments — a surface had to be removed).
- (#221) "No generic Channel MCP for this epic…The speculative type/tool/docs/test surface was removed."
- (#209) `chat_id`→`conversation_id` rename, then reversed.
- (#243→#246) cron ownership placed on `TeammateService`, then reversed to the containers — the reversal landed the now-inverted KB fact (see §3).

---

## 2. Where the drift starts and how it propagates

There is a **clean baseline and a repeating relapse**, not a single break point:

- **#110 itself landed mostly aligned** — the neutral-seam correction at **PR #114/#115** (channel emitting Codex strings) was caught and fixed *in-epic* because review was still adversarial and in-flight.
- **First decisive structural drift: #126→#128/#129.** The agent forked `TeamMateWorkerProvider` as a second runtime tree "故意不走 agent-runtime 的 registry," built the `task`/one-shot model, and a `caller_kind` branch — none matching #110's "one seam / Dispatcher Service is core" intent. **Uncaught because review was delegated to the authoring agents.** #135 is the operator re-entering as design authority to undo it.
- **The relapse pattern then repeats at every epic boundary, always at the same moment** — when an epic shifts from "rename/move/understood" work to "make the seam the real production path":
  - **#147** (reverse delivery never wired — zero callers) is the first *behavioral* "agent doesn't understand the wiring."
  - **#174** (Team Mode) routes member completions back to the Dispatcher — an ownership-placement error (T1), the deepest kind.
  - **#212→#213** (i209 packaging) is the drift epicenter of shard D: "constructible but production keeps the hand-written core adapter" — metastasized into #228 + #229.
  - **#234** (Service refactor, land-first, no inline review, tests-green waived) shipped the leader built inside the members collection; surfaced only at #239/#240 when the operator manually read follow-ups.

**Propagation mechanism (why it recurs):** four reinforcing loops.
1. **No executable backstop** → the invariant lives only in prose, so each fresh-context agent re-derives it and gets it wrong the same way.
2. **Stale model-facing prompt/skill (T5a)** → the agent follows its own retired artifacts (#216, #203, #191), re-introducing the removed shape next slice.
3. **Review delegated to authoring agents / land-first merges** (#126, #234) → the correction loop is absent exactly where drift enters; the operator becomes the only real reviewer, discovering drift days later by manual reading.
4. **Speculative build ahead of an unsettled decision** (T11) → the agent races to construct a surface before the operator has locked the decision; the operator's reversal (#182/#209/#243) then leaves a built artifact that must be excavated — the reversal *is* the drift, not a clean no-op.

---

## 3. Adjudicating the operator's hypotheses (weighted verdict)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **(a) KB MISLEADING/STALE** | **Partly true, secondary — and the one hard fact is fresh, not historical.** | The accuracy audit found exactly **one actively-wrong structural fact**: `reference/scheduled-tasks.md:53-58` asserts "`SchedulerService` is owned by the conversational agent's `TeammateService`…the containers…construct no scheduler" — the **exact inverse** of code (`dispatcher-service/index.ts:157`, `team-service/index.ts:145` both `new SchedulerService(...)`; `teammate-service` has none), contradicting its own decision record `cron-per-conversational-agent.md`. **Crucially, this inversion is a current-`next`-HEAD artifact of the just-landed #246 reversal** (#243 put cron on `TeammateService`; #246 moved it to the containers; the reference doc was not updated to follow). It therefore **could not have misled the #234-era or earlier agents — it post-dates them.** Keep it as **live proof that `check.sh` cannot catch a content error** (it passed CI), but **lower its weight as a historical drift cause.** The higher-frequency staleness is **T5a model-facing prompt/skill drift (~6-8)** — `dispatcher-skill.md`/`base-prompt.ts` repeatedly teach removed verbs. So "MISLEADING" is real but mostly in the **model-facing prompt layer**, not the human KB reference layer. |
| **(b) KB INSUFFICIENT** | **True, contributing.** | The accuracy audit's SILENT-INSUFFICIENT rows: the live `createTeammateService` factory + its three callers, `DispatcherService` team-admin forwards / `TeamCollection.scheduler()`, the `TeamChannelContext` cycle-breaking seam, the `agent-ref`/`inline` launch discriminator — all absent from the **`.agents/` graph**; an agent must reverse-engineer the constructor. Note: an in-tree `service/CLAUDE.md` map *does* exist (see (c) and backlog #1) — but it is not in the `.agents/` reachable graph and is not source-anchored/liveness-checked. Construction order and cycle-breaking live only as decision *narrative*, framed as "why we decided," not "this is the current wiring contract." |
| **(c) KB STRUCTURALLY WRONG (organized around intent/history, not queryable current-structure)** | **True, contributing — and it's the shape of (b).** | The KB is strong on `decisions/` (35 ADRs) and intent, weak on a *live, source-anchored current-structure model in the `.agents/` graph*. The best who-builds-what map, `packages/dreamux/src/service/CLAUDE.md`, **exists but lives in-tree, outside `.agents/`, and is not reachable from `root.md`** — so the KB liveness tooling never sees it. The only `service/*` graph inside the KB is a `classDiagram` in `service-architecture-refactor.md` explicitly labeled the **target**, mixing aspirational names (`read-model.ts` vs real `read-helpers.ts`). **`check.sh` validates only internal-link resolution, orphan reachability from `root.md`, and decision-index completeness — no source-truth/content check** (verified). "A doc can be green and factually wrong" — the inverted cron fact passing CI is the clean proof. This is precisely the [Living Documentation](https://www.infoq.com/articles/book-review-living-documentation/) failure mode. |
| **(d) OTHER — no executable backstop for the corrected invariants; agent-process build-abstraction-first with no ownership-first gate** | **TRUE — DOMINANT CAUSE.** | The harness inventory is decisive: the harness is strong on import-direction, MCP-schema, sync-IO, secrets, KB-links — and **weak-to-absent on exactly the invariants the operator keeps correcting**: semantic neutrality *inside* core (the contract-field ban is scoped to only `dreamux-types/agent-runtime.ts`+`turn.ts`), "same creation path / no parallel runtime tree" (T2), "no leader in the collection cache" / collection-owns-no-state (T1), the no-glue/capability-ownership principle (T1/T8), production-must-use-the-seam (T3). Every dominant correction theme (T1, T2, T3, T4-inside-core) maps to an invariant with **no failing test**. Per the [Navigation Paradox](https://arxiv.org/html/2602.20048v1), code review catches wrong-direction coupling ~17% of the time — so prose + human review is structurally insufficient, which is exactly what #126/#174/#212/#234 demonstrate. |

**Weighted verdict:**
- **~60% (d) — missing executable backstop + process (land-first, author-reviews-own-work, build-ahead-of-unsettled-decision).** This is the root. T1+T2+T3+T4 (the four dominant, highest-cost themes) are all unguarded invariants, and drift entered precisely at the merges where the human review loop was absent (#126, #234).
- **~25% (b)+(c) — KB insufficient/structurally intent-first.** The `.agents/` graph can't *surface* the architecturally-distant files (the instantiation site, the interface implementer) a refactor must touch, because the one real ownership map lives in-tree outside the graph and is not queryable/liveness-checked — the failure mode where the file you must also edit shares no vocabulary with the task.
- **~15% (a) — KB/prompt misleading.** Chronic **model-facing** prompt/skill staleness (T5a, ~6-8, self-reinforcing) plus one inverted reference fact (cron ownership) that is **fresh on `next`** and historically post-dates the drift it might otherwise explain. Real and self-reinforcing in the prompt layer, but cheaper to fix and not the originator of the structural drift.

The operator's own diagnosis is correct and matches the evidence: *"把不该是插件的东西做成了插件切面，把该统一的 runtime 抽象做成了两套，而真正承重的 Dispatcher Service 反而没有实体"* — these are ownership/seam errors that no machine check would catch, in a process where the human was the only catcher.

---

## 4. Gap matrix vs industry

| Capability | Best practice | dreamux today | Gap |
|---|---|---|---|
| **Executable layer/dependency-direction fitness functions** | [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md) `forbidden` rules / [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries) encode "layer A must not depend on B"; [drift belongs in CI not reviewers' heads](https://earezki.com/ai-news/2026-06-08-architecture-drift-detection-keep-your-code-aligned-with-design/) (~17% caught by review). | **Core↛provider and provider↛core import direction is already guarded** by `architecture-boundary-gate.test.ts` (via real ESLint configs) plus per-package `import-boundary.test.ts` in `agent-runtime/codex`, `claude-code`, `feishu-channel`, `dreamux-types`. **No whole-graph cycle/orphan check; no service-internal layer rules.** | **Medium.** Boundary gate exists at *package* granularity; nothing guards `service/*` *internal* direction, no-cycle, no-orphan, or cross-package deep-import. |
| **Executable OWNERSHIP/semantic invariants** | Architecture-as-test ([ts-arch](https://github.com/ts-arch/ts-arch), AST `no-restricted-syntax`); operationalize ADRs as [fitness functions](https://platformtoolsmith.com/blog/operationalizing-adrs-fitness-functions/). | The cron→leader rule is locked **only at the feature-injection layer**: `team-scheduler.test.ts:350-355` asserts the per-role `disableFeatures`/`mcpServers` shape (leader gets the `cron` MCP server, member/teammate do not). It does **not** assert *constructor* ownership (it never asserts `TeammateService` constructs no `SchedulerService`). The *general* "capability in the owning container," "no leader in the member cache," "collection owns no state," "core never branches on `chat_id` off an opaque bag," "same creation path / no parallel runtime tree" have **zero backstop**. | **Large — THE central gap.** Exactly the T1/T2/T3/T4 themes. The existing cron test guards the *injected feature surface*, not *constructor ownership* — so the ownership test in backlog #3 is genuinely absent, not redundant. |
| **Authoritative, queryable current-ownership + dependency model** | Generate from code, never memory ([dependency-cruiser graph](https://github.com/sverweij/dependency-cruiser); [Structurizr-as-code](https://docs.structurizr.com/dsl); [aider repo-map](https://aider.chat/2023/10/22/repomap.html)). | A real who-builds-what map **exists** at `packages/dreamux/src/service/CLAUDE.md` — but **in-tree, outside the `.agents/` graph, not reachable from `root.md`, and not source-anchored/liveness-checked.** The only `service/*` graph inside the KB is a **target** Mermaid in a decision doc with aspirational names. | **Large.** The map exists but is invisible to the KB tooling and unverified against source — the gap is *promotion + liveness*, not *creation*. |
| **ADR / decision ledger read FIRST as binding rules** | [ADRs as agent-facing constraints](https://ai.gopubby.com/agents-md-is-the-ew-architecture-decision-record-adr-3cfb6bdd6f2c) — "the rules they must follow right now," front-loaded, [progressive-disclosure](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills). | 35 ADRs + `root.md` Task Routes table exist (good intent routing). But no enforced "consult the ownership ledger before a multi-file refactor"; decisions are history-framed, not "current binding rules." | **Medium.** Good ledger, not wired as a mandatory pre-refactor step; some ADRs describe superseded intermediate designs (#229). |
| **AI context engineering: surface architecturally-distant files** | [Navigation Paradox](https://arxiv.org/html/2602.20048v1): dependency graph scores 99.4% vs 76.2% on hidden/architecturally-connected files (+23pts); **but optional tools adopted only 42% — forcing/checklist pushes to 100%.** | CLAUDE.md + `.agents` are *semantic* context only — by construction cannot surface the instantiation-site / interface-implementer a refactor breaks. No structural map wired as a *mandatory* step. | **Large.** This is precisely why agents "lose the architecture thread" on multi-file refactors (#174, #212, #234). |
| **Keeping docs non-stale** | (1) append-only ADRs; (2) generate from code; (3) [CI fail-on-drift](https://hokstadconsulting.com/blog/continuous-documentation-in-cicd-pipelines) / [known-violations baseline](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md). | `check.sh` enforces internal-link resolution, orphan reachability, and decision-index completeness **only** — **no content/source-truth validation**; "a doc can be green and factually wrong" (proved by the cron fact + T5a prompt drift, both of which passed CI). | **Large.** No mechanism ties any reference/prompt/skill claim to source. |
| **Process: review actually ran / heterogeneous / holistic** | Author never merges own work; multiple distinct reviewers; merge actor ≠ author. **Constraint: this repo runs all roles under one GitHub identity (`YourWildDad`), so GitHub-identity-based gates are structurally inapplicable.** | Prose-only (`team-dev-workflow` skill + global rule). #126 review delegated to authors; #234 land-first with tests-green waived. | **Medium.** The most load-bearing *process* rule is bypassable; drift entered exactly where it was bypassed. Enforcement must be artifact-based, not identity-based (see backlog #7). |

---

## 5. Prioritized improvement backlog (ranked by leverage)

> **Sequencing note:** #1 (the topology map) is a *document + liveness check* — it only helps if the agent **reads** it, and the Navigation-Paradox 42%→100% adoption point cuts both ways: "forced to read" is weaker than "build fails." Therefore the true keystone is the **pair #1 + #3**: surfacing (#1) plus the cheapest real *failing ownership test* (#3). **#3 is promoted to co-primary.** A failing test beats a doc that must be read.

### ★ CO-PRIMARY HIGHEST-LEVERAGE CHANGE (a)
**#1 — Promote the existing in-tree `service/CLAUDE.md` into a live, source-anchored `.agents/reference/service-topology.md` (who-builds-what + ownership + scope), reachable from `root.md`, made a MANDATORY pre-refactor checklist step, paired with a `dependency-cruiser` graph + `forbidden` rules over the package and `service/*` graph.**
*Note — not "create," but "promote + anchor + liveness-check":* the who-builds-what map already exists at `packages/dreamux/src/service/CLAUDE.md`. The gap is that it lives **outside the `.agents/` graph, is unreachable from `root.md`, and is not verified against source.** Move/mirror it into `.agents/reference/`, line-anchor every `new X(...)` site, wire it into the reachable graph, and add a liveness check.
*Kills:* T1 (wrong-layer ownership), T2 (parallel tree), T6 (wrong data source), and the (b)/(c)/AI-context gaps simultaneously.
*Why highest:* T1 is the master theme (~25+ corrections); the [Navigation Paradox](https://arxiv.org/html/2602.20048v1) shows a structural ownership map is the *only* thing that surfaces the architecturally-distant files agents miss — and that it only works if **forced** (42%→100% adoption when made a checklist step at the end of the prompt). One table (each `service/*` class → owner/constructor / what it holds / scope / line-anchored `new X(...)` site) converts "reverse-engineer the constructor" into a lookup and would have prevented #239/#240/#174 directly.
*Executable form:* generate the dependency edges with `depcruise packages --config .dependency-cruiser.js` (graph artifact in CI); add a CI check (extending `check.sh`) that every `/packages/...` "Key source" path in the topology doc resolves (cheap liveness guard). Wire "before editing, list every caller/implementer/constructor of the changed symbol via the topology doc + graph" as a forced step in the refactor skill.
*Effort: M.*

### ★ CO-PRIMARY HIGHEST-LEVERAGE CHANGE (b)
**#3 — Structural *constructor-ownership* tests for the #233 layout.**
*Kills:* T1, T2 (the precise #239/#240/#247 corrections). *Cheapest real failing test (S–M) — promoted to co-primary because a failing build beats a doc the agent might not read.*
*Why not already covered:* `team-scheduler.test.ts:350-355` guards the per-role **feature-injection** surface (`disableFeatures`/`mcpServers` — leader gets the `cron` server, member/teammate do not). It **never asserts constructor ownership** (that `TeammateService` constructs no `SchedulerService`). These tests are therefore genuinely missing:
- A test asserting `TeammateService` constructs **no** `SchedulerService` (cron ownership lives in the containers, per `cron-per-conversational-agent.md` and the verified code at `team-service/index.ts:145` / `dispatcher-service/index.ts:157`).
- A test asserting `team_leader` is **never** in the members `TeammateCollection` cache (leader lives at team root) — the exact #247 invariant.
- A test asserting `Dispatchers`/`TeamCollection` expose no per-teammate stores (collection owns no state).
- A test asserting both `role:'dispatcher'` and `role:'teammate'` flow through one `createTeammateService` factory (no second creation path).
*Executable form:* fixture/unit tests next to `team-scheduler.test.ts`.
*Effort: S–M.*

### #2 — Extend the package-granularity boundary gate to service-internal direction + whole-graph hygiene
*Re-scoped:* core↛provider / provider↛core import direction is **already guarded** by `architecture-boundary-gate.test.ts` + the per-package `import-boundary.test.ts` files. Do **not** re-add it. The genuine gaps:
- **Service-internal direction rules** over `service/*` (e.g. collection must not import the container that owns it; read-helpers must not import write paths).
- `no-circular` + `no-orphans` over the whole package graph (free with `dependency-cruiser`).
- **"No parallel runtime tree" absence-grep:** forbid a second `*RuntimeProvider`/`*WorkerProvider`/`*RuntimeService` tree beside the canonical seam (the #135 / #233 invariant — T2).
*Executable form:* adopt at `severity: warn` with a [known-violations baseline](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md), ratchet to `error` — "[fitness functions as a checklist, not a stick](https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/ch04.html)."
*Effort: M.*

### #4 — Fix the one inverted KB fact + make the model-facing prompt/skill (T5a) source-truth-guarded
*Kills:* T5a (the ~6-8 self-reinforcing prompt/skill drift) and hypothesis (a).
- Correct `reference/scheduled-tasks.md:53-58` to match `cron-per-conversational-agent.md` and code (scheduler owned by the **containers** `DispatcherService`/`TeamService`, not `TeammateService`). *This is the #246-reversal follow-through that was missed.*
- Add a CI test that the `dispatcher-skill.md` / `base-prompt.ts` MCP-verb list is generated from / asserted against the actual registered MCP tool names (so a removed verb can't survive in the prompt — directly attacks #159/#191/#203/#216, the self-reinforcing T5a class).
*Executable form:* a fixture test comparing prompt verb list ↔ live MCP descriptor whitelist (extends `mcp-contract-whitelist.test.ts`).
*Effort: S (fact fix) + M (prompt-vs-registry test).*

### #5 — "Production drives the seam" parity test (codify #228 permanently)
*Kills:* T3 (the most expensive class — #147/#151/#213/#228/#229).
*Executable form:* a test that the production launcher constructs each built-in provider **through the generic loader** with no provider-specific core glue (the #228 "Production Drive Path / Parity Test"), plus an absence-grep for a removed core adapter tree. #228 already *specifies* this test; the fix is to make it a **real failing test**, not a prose blocker.
*Effort: M.*

### #6 — Semantic-neutrality guard inside core
*Kills:* T4's hardest half ("core never *routes/branches* on `chat_id`/`sender_id` off an opaque `meta` bag").
*Why needed:* the neutral-contract field-name ban in `architecture-boundary-gate.test.ts` is **scoped to only `dreamux-types/agent-runtime.ts` + `turn.ts`** (the gate header says "scoped to those files"). Provider-field member access **inside `service/*` / `server.ts` is invisible today.**
*Executable form:* scoped `no-restricted-syntax` AST rule over `service/*` + `server.ts` banning provider-field member access (`.chat_id`, `.app_id`, …) outside the channel package.
*Effort: M.*

### #7 — Process gate, re-scoped to what is enforceable under ONE GitHub identity
*Re-scoped:* the repo runs **both** the human and the AI-reviewer roles under a single GitHub account (`YourWildDad`), so "≥2 distinct reviewer *identities* / merge actor ≠ author" cannot be enforced by branch protection. Convert to artifact-based gates:
- **Block merge on red tests** unless an explicit override label is present (kills the #234 "land-first, tests-green waived").
- **Require the adversarial-review artifact** (the codex/claude review essay) be attached to the PR before merge — i.e. proof the review actually ran, regardless of identity.
- Optionally: **require ≥2 distinct review *agents* recorded** in the PR (e.g. a codex pass *and* a claude pass), tracked by artifact, not GitHub identity.
*Kills:* the propagation mechanism — drift entered at exactly the merges where review was absent (#126 author-reviewed, #234 land-first).
*Effort: S.*

### #8 — Knowledge-delta drift gate
*Kills:* (a)/(c) one-directional staleness.
*Executable form:* heuristic gate — a PR touching `eslint-config`, contract files, `paths.ts`, or `service/*/index.ts` must also touch `.agents/` or carry an explicit `no-kb-delta` marker. ([check.sh keeps the KB internally consistent but can't detect a boundary move that *should* have updated it](https://hokstadconsulting.com/blog/continuous-documentation-in-cicd-pipelines).)
*Effort: S.*

### #9 — "Decision settled?" gate before speculative surface (targets T11)
*Kills:* T11 — agent builds a type/tool/doc/test surface ahead of an unsettled decision, so the operator's reversal (#182/#209/#243) leaves an artifact to excavate.
*Executable form:* a refactor-skill checklist step — before introducing a *new* persisted surface (new file type, new MCP tool, new state path), confirm the owning decision is recorded as **settled** in `decisions/` (not "proposed"/"exploring"); if not, build the minimal in-memory path and defer the surface. This is process, not a test, but it directly attacks the reversal-churn class.
*Effort: S.*

---

**Bottom line for the operator:** the pain is not that the KB lies (it mostly doesn't — and the one hard inverted fact is a fresh `next`-HEAD artifact of the #246 reversal, not a long-standing cause) — it's that the architecture's load-bearing rules are **judgment-prose with no failing test**, the one real current-structure map lives **in-tree outside the queryable `.agents/` graph**, and the human review loop was **bypassed at exactly the merges where drift entered**. Do **#1 and #3 together first** (forced source-anchored ownership/topology map *plus* the cheapest real constructor-ownership failing test — surfacing alone relies on the agent reading the doc; a failing build does not). Then convert the remaining top correction-themes into the executable fitness functions in #2/#4/#5/#6, and close the process loops with #7/#9. That moves the invariants the operator keeps re-typing from his head into the agent's verify loop.

---

## Sources

- [Living Documentation — InfoQ review (Cyrille Martraire)](https://www.infoq.com/articles/book-review-living-documentation/)
- [The Navigation Paradox: dependency-graph context for AI code navigation (arXiv)](https://arxiv.org/html/2602.20048v1)
- [dependency-cruiser — rules reference (`forbidden`, no-circular, no-orphans, known-violations baseline)](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)
- [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries)
- [ts-arch — architecture-as-test for TypeScript](https://github.com/ts-arch/ts-arch)
- [Operationalizing ADRs as fitness functions](https://platformtoolsmith.com/blog/operationalizing-adrs-fitness-functions/)
- [Building Evolutionary Architectures — fitness functions (O'Reilly)](https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/ch04.html)
- [Architecture drift detection: keep your code aligned with design](https://earezki.com/ai-news/2026-06-08-architecture-drift-detection-keep-your-code-aligned-with-design/)
- [Continuous documentation in CI/CD pipelines](https://hokstadconsulting.com/blog/continuous-documentation-in-cicd-pipelines)
- [Structurizr DSL — architecture-as-code](https://docs.structurizr.com/dsl)
- [aider — repository map for LLM code navigation](https://aider.chat/2023/10/22/repomap.html)
- [AGENTS.md is the new ADR — ADRs as agent-facing constraints](https://ai.gopubby.com/agents-md-is-the-ew-architecture-decision-record-adr-3cfb6bdd6f2c)
- [Anthropic — Equipping agents for the real world with Agent Skills (progressive disclosure)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

## Disposition (2026-09-01)

Per-item status of the nine-point backlog, verified against source:

- **Promoted (implemented):** #3 constructor-ownership tests
  (`collection-ownership.test.ts`); #1 mostly — `service-topology` is a
  root-routed domains page with a path-liveness CI check; #4 first half — the
  inverted scheduler-ownership fact was corrected.
- **Deferred (live gaps, tracked in harness-gaps):** the dependency-cruiser
  full-graph gate (#1 tail, #2); the provider-field member-access AST gate
  (#6); the knowledge-delta drift gate (#8); the prompt↔MCP-registry parity
  gate (#4 second half — a confirmed regression: the parity tests no longer
  exist).
- **Out of scope / superseded in form:** #9 (settled-decision gate) — the
  operator-rulings discipline in `large-refactor-mode` and CLAUDE.md attacks
  the adjacent failure instead; #7 process gates — partially absorbed by the
  dev-workflow review gates.
