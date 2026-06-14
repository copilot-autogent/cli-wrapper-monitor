# PLAYBOOK.md Restructuring Feasibility Analysis

**Date**: 2026-06-14  
**Status**: Recommendation  
**Refs**: Issue #4, [autogent#383](https://github.com/JackywithaWhiteDog/autogent/pull/383) (maxCharsPerFile 20k→60k fix)

---

## Executive Summary

PLAYBOOK.md has grown from 39,673 chars (May 20) to 133,761 chars (June 14) — a **3.4× increase in 25 days**, reaching 2.2× the 60k per-file limit set by PR #383. At the current rate, even a 200k limit would be breached within 3 months. Increasing the limit again is not sustainable.

**Recommended path**: a two-phase approach —
1. **Immediate (no code change)**: archive long narrative examples to memory topics; apply priority ordering within the file so truncation drops least-critical sections first
2. **Medium-term (code change)**: implement on-demand section loading via a `playbook/` subdirectory + a `read_playbook_section` tool, building on the existing pattern already established for quantitative rules

---

## Current State (June 14, 2026)

| File | Size (chars) | vs 60k limit | vs 20k limit |
|------|-------------|-------------|-------------|
| PLAYBOOK.md | 133,761 | +123% over ❌ | +569% over ❌ |
| CONTEXT.md | 74,973 | +25% over ❌ | +275% over ❌ |
| SOUL.md | 4,517 | ✅ under | ✅ under |
| USER.md | 13,216 | ✅ under | ✅ under |
| **Total** | **226,467** | **56,617 tokens est.** | **28.3% of 200k window** |

### What's being silently dropped (at 60k limit)

| File | Delivered | Dropped | Drop % |
|------|-----------|---------|--------|
| PLAYBOOK.md | 60,000 | 73,761 | 55% 🔴 |
| CONTEXT.md | 60,000 | 14,973 | 20% 🟡 |

Over half of PLAYBOOK.md — including all sections added after May 31 — never reaches the model. CONTEXT.md also loses ~15k chars of content every session.

### 60k boundary in PLAYBOOK.md

At 60,000 chars, the content ends mid-way through the **"Verify git log Before Claiming a PR Merged"** section (line ~500 of 1,360). Everything after that is silently dropped:

- "You decide" means decide
- Project as First-Class Citizen
- Feedback Triage Before Dispatch
- Ask Before Guessing
- Diagnosis Before Iteration
- Async-First Execution
- Memory Safety, Content Placement
- Dev Workspace checklist
- Multi-Model Review & Dev Protocol
- Non-Negotiable Rules
- Autonomy Guidelines
- Session Habits
- …and ~40 more sections

---

## Growth Trajectory

| Date | PLAYBOOK.md | Growth | Interval |
|------|-------------|--------|----------|
| 2026-05-04 | ~26,000 chars* | — | — |
| 2026-05-20 | 39,673 chars | +13,673 | 16 days |
| 2026-05-27 | 53,583 chars† | +13,910 | 7 days |
| 2026-05-31 | 53,583 chars‡ | +0 | 4 days |
| **2026-06-14** | **133,761 chars** | **+80,178** | **14 days** |

\* Inferred from total system prompt sizes in historical baselines (May 4 baseline JSON not retained).  
† Directly measured in `baselines/2026-05-27.json` (`bootstrapFileSizes[PLAYBOOK.md].chars = 53583`; truncated to 20,000 by old limit).  
‡ Reconstructed from 2026-05-27 snapshot; identical contentHash (`e15890df...`) confirms no change between May 27 and May 31.

The growth **accelerated sharply between May 31 and June 14**: once the truncation constraint was removed by PR #383, development proceeded rapidly adding new operational rules. PLAYBOOK.md had already reached 53k by May 27 (silently truncated to 20k at the time); the +80k burst came in the 14 days following the fix.

### Projection under current growth rate

At ~5,700 chars/day (May 31→Jun 14 rate):

| Horizon | Projected PLAYBOOK.md | Status vs 60k |
|---------|-----------------------|---------------|
| Jun 28 | ~213,000 chars | +255% over limit |
| Jul 28 | ~375,000 chars | +525% over limit |
| Sep 14 | ~625,000 chars | Clearly unsustainable |

Even at 1,000 chars/day (conservative, post-burst-growth): 60k headroom fills in ~74 days.

---

## Options Analysis

### Option A: Increase `maxCharsPerFile` Again (band-aid)

**Approach**: raise the config to 150k or 200k.

**Impact on context window** (at 150k):
- System prompt: ~262k chars → ~65,500 tokens (33% of 200k window)
- Task session budget: currently hard-coded at 50k chars — PLAYBOOK alone exceeds this budget

**Verdict**: ❌ Not sustainable. Adds 25+ percentage points to context window consumption. Task session truncation in `assembleTaskPrompt` (50k hard cap) is already breached; raising the main session limit doesn't fix task agents. Kicks the can while making the window problem worse.

---

### Option B: Content Archiving to Memory (no code change)

**Approach**: Each PLAYBOOK section has two parts — the **rule** (2–5 sentences) and the **narrative** (anti-pattern story, extended example, historical context). The narrative can move to a memory topic; the bootstrap retains only the rule text plus a `recall_memory("topic-name")` pointer.

This pattern is already established:
```
> **Portfolio/quantitative analysis rules** (...) are archived in memory topic
> `playbook-quantitative-rules` to reduce context tax. `recall_memory("playbook-quantitative-rules")`
> at the start of any portfolio analysis session.
```

**Estimated size reduction**: examining the 20 largest sections shows narratives are typically 3–8× the length of the core rule. Aggressive archiving could reduce PLAYBOOK.md from 133k to 30–40k chars — under the 60k limit with room to grow.

**Example reduction for largest section ("Diagnosis Before Iteration" at 8,991 chars)**:
- Core rule: ~600 chars
- Narrative examples: ~8,400 chars → move to `recall_memory("diagnosis-before-iteration")`
- Savings: ~8,300 chars (92%)

**Largest sections by size (top 10):**

| Section | Size | Notes |
|---------|------|-------|
| Diagnosis Before Iteration | 8,991 | Long case studies |
| Async-First Execution | 8,361 | Detailed playbook with tables |
| Dev Pipeline (GH Issues + Labels) | 6,908 | Large reference table + rationale |
| Spike Methodology | 3,206 | N=2 case study |
| Quote Backtested Numbers | 3,199 | Anti-pattern example |
| Investigation Before Implementation | 3,319 | Case studies |
| Multi-Model Review & Dev Protocol | 3,737 | Procedure tables |
| Verify git log Before Claiming... | 3,292 | Anti-pattern examples |
| Subagent Usage | 2,618 | Reference material |
| MVP-First for N=1 Products | 3,141 | Extended example |

Top 10 sections alone account for ~47,000 chars. Archiving their narratives to memory could recover ~40k chars — enough to bring PLAYBOOK.md back under the 60k limit.

**Verdict**: ✅ Recommended as **immediate action**. No code change required. Reduces urgency significantly. Requires manual triage of each section to split rule vs. narrative.

**Cost**: ~2–4 hours of content triage + memory topic creation.

---

### Option C: Priority Ordering (defense-in-depth)

**Approach**: Reorder PLAYBOOK.md sections so most-critical rules appear first. When truncation happens, it drops the least-critical sections from the tail.

Proposed priority tiers:

| Tier | Examples | Keep position |
|------|----------|---------------|
| **P0 — Core autonomy** | Non-Negotiable Rules, Autonomy Guidelines, Session Habits | Top of file |
| **P1 — Active workflow** | Dev Pipeline, Sprint-Owns, Dev Workspace, Multi-Model Review | After P0 |
| **P2 — Epistemological** | Empirical-First, Diagnosis Before Iteration, Ask Before Guessing | After P1 |
| **P3 — Domain-specific** | Insurance-Sized Positions, Quantitative analysis rules | Bottom or memory |
| **P4 — Historical anti-patterns** | "Verify git log", "Verify spawn_history", "Phantom merge" examples | Memory preferred |

**Verdict**: ✅ Recommended as **complement to Option B**. Low-effort, improves robustness. Doesn't reduce size but ensures the important material survives truncation.

**Note**: Options B and C are naturally paired — archive the narratives (B) while ensuring core rules are at the top (C).

---

### Option D: On-Demand Section Loading (architectural change)

**Approach**: Split PLAYBOOK.md into a `playbook/` directory of named section files. The main session always loads a compact `playbook/core.md` (~10–15k chars). Additional sections are fetched on demand via a `read_playbook_section(section_name)` tool, or automatically based on session type (Discord vs cron vs task agent).

**Architecture sketch:**
```
~/.autogent/
├── PLAYBOOK.md         # Retained as index + P0 rules only (~15k chars)
├── playbook/
│   ├── dev-pipeline.md         # PR workflow, sprint management
│   ├── epistemological.md      # Empirical-first, diagnosis, anti-patterns  
│   ├── side-projects.md        # Routing, project-specific rules
│   ├── data-analysis.md        # (archived from memory) backtest rules
│   └── checklists.md           # Dev workspace, pre-push, post-merge
```

**Autogent changes required:**
1. New `read_playbook_section(section: string)` tool (maps to `playbook/<section>.md`)
2. `assembleSystemPrompt` continues loading PLAYBOOK.md (now a compact index)
3. `assembleTaskPrompt` maps task type → section list for auto-loading
4. Template migration: `ensureWorkspace` creates `playbook/` subdirectory from templates

**Key design constraints identified from codebase:**
- `BOOTSTRAP_FILES` constant in `manager.ts` would need to remain unchanged (or extend)
- `assembleTaskPrompt` hard-codes a 50k budget — already too small for current PLAYBOOK; this function needs budget fix regardless of option chosen
- Task agents currently have NO way to call `read_playbook_section` mid-session — tool would need to be in the task agent's tool list, which is currently SDK-defined

**Verdict**: ✅ Recommended as **medium-term target** (tier:2, downstream of content archiving). The memory system already provides on-demand recall for archived content — the upgrade here is adding first-class file-based sections for material too structured for freeform memory topics. Implementation is 1–2 days of engineering.

**Dependency**: should be designed after Option B/C reduce the file to manageable size, so the new section structure reflects the trimmed content, not the bloated current state.

---

## Recommendation

### Phase 1 — Immediate (no code change, ~1 week)

1. **Archive narratives to memory**: for each section with more than ~1,500 chars, extract the anti-pattern example / extended case study to a memory topic named `playbook-<section-slug>`. The bootstrap retains only the rule text + `recall_memory()` pointer. Target: bring PLAYBOOK.md from 133k → 40–50k chars.

2. **Apply priority ordering**: reorder sections in PLAYBOOK.md so Non-Negotiable Rules, Autonomy Guidelines, and the Active Workflow sections appear first. This ensures they survive if PLAYBOOK.md grows past the limit again before Phase 2 ships.

3. **Raise `maxCharsPerFile` temporarily to 150k** in `autogent.json` so no content is dropped in the **main session** while Phase 1 archiving is in progress. Note: task agents use `assembleTaskPrompt` with a separate hard-coded 50k budget — they continue to truncate until Phase 2 (or a separate fix to `assembleTaskPrompt`) ships. Revert to 60k after Phase 1 archiving is complete.

4. **CONTEXT.md scope note**: CONTEXT.md is also over the 60k limit at 74,973 chars (20% dropped). A parallel archiving pass for CONTEXT.md is recommended alongside Phase 1 PLAYBOOK archiving. A detailed section-size breakdown for CONTEXT.md is left to a follow-up issue.

### Phase 2 — On-demand section loading (new issue, ~1–2 weeks engineering)

File a follow-on issue: *"Implement `playbook/` subdirectory and `read_playbook_section` tool for structured on-demand loading"*. This is a tier:2 implementation once Phase 1 defines the natural section groupings (don't design sections from the bloated current state).

### Out of scope

Increasing `maxCharsPerFile` again without content reduction is not recommended — the window impact is already at 28% of 200k and rising.

---

## Impact on Task Agents

Task agents use `assembleTaskPrompt` with a hard-coded 50k budget. With PLAYBOOK.md at 133k, the function silently drops the last 83k chars of PLAYBOOK.md before the task prompt is even added. This is an independent issue from `maxCharsPerFile` — the task prompt budget cap needs its own fix (raise to 80k or apply section-selective loading).

Phase 1 content reduction directly improves task agent coverage (fewer chars = less truncation in task prompts too).

---

*Methodology: bootstrap file sizes measured directly from `/home/autogent/.autogent/` on 2026-06-14T08:50Z. Section-size analysis via `awk` on PLAYBOOK.md. Growth trajectory from historical baselines in this repo.*  
*Refs: [baselines/2026-05-31.json](../baselines/2026-05-31.json), [reports/diff-2026-05-27-to-2026-05-31.md](./diff-2026-05-27-to-2026-05-31.md)*
