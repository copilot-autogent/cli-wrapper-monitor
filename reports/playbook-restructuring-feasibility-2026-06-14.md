# PLAYBOOK.md Restructuring — Feasibility Report

**Date**: 2026-06-14  
**Status**: 🔴 Action required — PLAYBOOK.md at 133,761 chars, exceeds 60k per-file limit by 2.2×  
**Refs**: Issue [#4](https://github.com/copilot-autogent/cli-wrapper-monitor/issues/4), [autogent#389](https://github.com/JackywithaWhiteDog/autogent/issues/389)

---

## The Problem

PLAYBOOK.md has grown from 53,583 chars on May 31 to 133,761 chars on June 14 — a **150% increase in 14 days**. The PR #383 fix (raising maxCharsPerFile from 20k → 60k) that resolved the May truncation regression is no longer sufficient.

| Scenario | PLAYBOOK delivered | Operational rules lost |
|----------|-------------------|----------------------|
| Local config override (20k limit) | 15% (20k/133k) | 85% of all rules |
| Code default (60k limit) | 45% (60k/133k) | 55% of all rules |
| No limit | 100% | 0% |

With 43 sections and 1,360 lines, PLAYBOOK.md has become structurally unmanageable as a single file.

---

## Section Inventory

PLAYBOOK.md contains 43 sections across three functional categories:

### Category 1: Operational rules (must always be in context)
High-frequency, actively referenced every session:
- Dev Pipeline / GH Issues + Labels (~90 lines)
- Sprint-Owns End-to-End (#549 Architecture) (~25 lines)
- Self-Skip Early-Returns Must Escalate (~42 lines)
- Security-Implications Checklist (~24 lines)
- Baseline Must Be Green Before New Work (~14 lines)
- Dev Workspace — Mandatory for ALL Code Changes (~30 lines)
- Pre-Push Checklist, Non-Negotiable Rules, Autonomy Guidelines (~50 lines)
- Session Habits (~18 lines)

### Category 2: Anti-pattern lessons (should be in context)
Triggered by specific failure classes; referenced 1-2× per week:
- Empirical-First Anchoring Trap (~21 lines)
- Verify origin/main Before Closing PRs (~18 lines)
- Verify spawn_history Before Claiming Dispatch (~12 lines)
- Verify git log Before Claiming PR Merged (~29 lines)
- Research Deliverables Default to Memory-Only (~31 lines)
- File All Phases of Rollout Upfront (~14 lines)
- Extract Working Patterns Before Designing Primitives (~20 lines)

### Category 3: Domain-specific extended rules (loaded on demand)
Referenced only in specific domain contexts (portfolio analysis, shogi, spike methodology):
- Insurance-Sized Positions Have No Bleed-Duration Kill Criterion (~18 lines)
- Quote Backtested Numbers, Don't Reconstruct From Memory Narrative (~15 lines)
- Audit Sprint Recommendations Against Own Data (~15 lines)
- Citation-Chain Audit: Single-Source Numbers Propagate Errors (~17 lines)
- Spike Methodology: Outcome-Balanced Pairing (~15 lines)
- Asymmetric-Regret Framing for Which Direction First (~16 lines)
- MVP-First for N=1 Products (~21 lines)
- Stuck-Defer Cascade — Once-Tasks Against Busy Channels (~20 lines)

**Already archived to memory** (pattern already established):
- Portfolio quantitative analysis rules → memory topic `playbook-quantitative-rules`  
  (noted in PLAYBOOK header: *"archived in memory topic playbook-quantitative-rules"*)

---

## Option Analysis

### Option A: On-Demand Section Recall via Memory (Near-term)

**What**: Archive Category 3 domain-specific sections from PLAYBOOK to dedicated memory topics. Load via `recall_memory` at the start of relevant sessions.

**Feasibility**: ✅ Already proven — `playbook-quantitative-rules` memory topic exists and works. The PLAYBOOK header already references this pattern.

**Implementation**:
- No code changes to autogent required
- Archive 8+ Category 3 sections to memory topics
- Add session habit: `recall_memory("playbook-analysis-rules")` at start of analysis sessions
- Estimated size reduction: ~30–40k chars (bringing PLAYBOOK to ~90–100k)

**Limitation**: Even after archiving Category 3, PLAYBOOK remains ~90-100k chars — still exceeding the 60k limit. Requires also applying Option B or C.

**Effort**: Low (content curation only)

---

### Option B: Sectioned Bootstrap Files (Medium-term, upstream autogent change)

**What**: Extend autogent's bootstrap loader to support multiple named files via a `files` array config. Each file gets its own per-file budget.

```json
// autogent.json
{
  "bootstrap": {
    "files": ["SOUL.md", "PLAYBOOK-CORE.md", "PLAYBOOK-ANALYSIS.md", "CONTEXT.md", "USER.md"],
    "maxCharsPerFile": 60000,
    "totalMaxChars": 350000
  }
}
```

**Feasibility**: ✅ Technically straightforward — autogent's workspace already manages 4 named files (SOUL, PLAYBOOK, CONTEXT, USER). Making the list configurable is ~20–30 lines of code in `src/workspace/bootstrap.ts`.

**Implementation**:
- Upstream autogent PR: modify `BootstrapConfigSchema` to accept optional `files` array
- Split PLAYBOOK into `PLAYBOOK-CORE.md` (~60k) and `PLAYBOOK-EXTENDED.md` (~70k)
- Each gets independent 60k budget → 120k total vs current 60k for one file
- Fallback: default `files` list maintains backward compatibility

**Benefit**: Scales cleanly as PLAYBOOK grows. Each section group gets its own context budget.

**Effort**: Medium (~30 lines code, upstream PR required)

---

### Option C: Section-Ordering Optimization (Immediate, no code changes)

**What**: Reorder PLAYBOOK.md sections so the highest-priority operational rules appear in the first 60k chars. Lower-priority historical sections move to the end (dropped first).

**Feasibility**: ✅ Immediate — manual edit, no code changes.

**Implementation**:
- Move Category 1 (operational rules) and Category 2 (anti-patterns) to the top
- Move Category 3 (domain-specific) to the bottom (acceptable to drop)
- Estimated: top 60k would contain all of Category 1 + most of Category 2

**Limitation**: Doesn't solve the growth problem. As PLAYBOOK grows, ever-more of Category 2 falls below the 60k cutoff. Requires re-curating ordering each time a new section is added.

**Effort**: Low (manual reorder only)

---

### Option D: Raise maxCharsPerFile Further

**What**: Increase the limit to 150k or 200k.

**Feasibility**: ✅ Trivial — one-line config change.

**Cost**: System prompt grows to 226,467 chars (~56,617 tokens) — 28% of a 200k context window consumed by wrapper overhead before any user content.

**Why not recommended as sole solution**: Purely defers the problem. At the current growth rate (+150% in 14 days), a 200k limit would be breached within weeks. The root cause is unbounded PLAYBOOK growth, not a miscalibrated limit.

---

## Recommendation

### Phase 1 — Immediate (no code changes)

**Apply Option C + partial Option A in one PLAYBOOK edit:**

1. Reorder sections: Category 1 → Category 2 → Category 3
2. Archive the 3 largest domain-specific sections to memory (portfolio rules are already archived; add shogi/spike methodology sections)
3. Target: PLAYBOOK.md < 60k chars while retaining all operational and anti-pattern rules in the first 60k

This restores `bootstrapTruncated: 0` without any upstream code change.

### Phase 2 — Upstream PR (1–2 sprints)

**Implement Option B as [autogent#389](https://github.com/JackywithaWhiteDog/autogent/issues/389) follow-on:**

- Add `bootstrap.files` array config to autogent
- Split into `PLAYBOOK-CORE.md` + `PLAYBOOK-EXTENDED.md`
- Each gets independent 60k budget
- Provides sustainable headroom without re-curating section order

### Phase 3 — Hygiene (ongoing)

- Add PLAYBOOK size check to monthly monitor runs: 🟡 warn at 45k chars, 🔴 flag at 55k
- When adding new sections > 500 chars, check if anything in Category 3 can move to memory
- Update this feasibility report after Phase 1 and Phase 2 complete

---

## Also Fix: Local Config Override

The local `~/.autogent/autogent.json` contains `maxCharsPerFile: 20000` — a pre-PR-#383 value that was never updated. This means the actual runtime truncation is 20k (not 60k). Fix: update the local config to `"maxCharsPerFile": 60000`.

This is a separate action item from PLAYBOOK restructuring but should be applied immediately.

---

*Methodology: static analysis, bootstrap files measured from disk (chars + MD5), tool definitions measured via JSON.stringify() serialization.*  
*Full data: [baselines/2026-06-14.json](../baselines/2026-06-14.json)*  
*Compared to: [baselines/2026-05-31.json](../baselines/2026-05-31.json)*
