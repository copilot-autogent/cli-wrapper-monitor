# PLAYBOOK.md Restructuring Recommendation

**Date**: 2026-06-10
**Issue**: #4
**Context**: Post-PR #383 baseline (2026-06-03) shows system prompt at 183,547 chars, with PLAYBOOK.md contributing ~53k chars

## Problem Statement

PLAYBOOK.md has grown from ~30k to 53k chars over 7 weeks (Feb-May 2026), contributing significantly to context tax. The post-PR #383 baseline shows:

- **System prompt total**: 183,547 chars (~46k tokens)
- **PLAYBOOK.md contribution**: ~53,000 chars (~13k tokens)
- **% of total**: ~29% of system prompt

This growth pattern creates two tensions:

1. **Operational value vs. context cost**: PLAYBOOK contains hard-won lessons from production incidents (phantom-merge, stuck-defer, verify-before-claiming patterns). Removing these would lose institutional memory.

2. **Monolithic loading**: The entire PLAYBOOK is loaded into every session, regardless of whether the agent needs portfolio analysis rules vs. sprint methodology vs. refactoring discipline.

## Feasibility Analysis

### Option A: Split into multiple bootstrap files (NO GO)

**Hypothesis**: Split PLAYBOOK.md → PLAYBOOK-portfolio.md, PLAYBOOK-dev.md, PLAYBOOK-research.md, loaded conditionally based on session context.

**Blocker**: The autogent `BootstrapLoader` (as of PR #383) loads all `.md` files in `~/.autogent/` into a single system prompt. There's no conditional loading mechanism.

**Implementation cost**: Would require upstream autogent changes:
1. Add "conditional bootstrap" schema to `BootstrapConfigSchema`
2. Modify system prompt assembly to include/exclude files based on session metadata
3. Update session initialization to tag sessions with "mode" (portfolio/dev/sprint/research)

**Risk tier**: `tier:3-risky` — changes scaffold layer (session.ts, bootstrap.ts, system prompt assembly)

**Verdict**: Not viable without tier:3 upstream work. Defer.

### Option B: Memory-based contextual loading (RECOMMENDED)

**Hypothesis**: Move rarely-accessed PLAYBOOK sections to memory topics, loaded via `recall_memory` when needed.

**How it works**:
1. Keep **frequently-used patterns** in PLAYBOOK.md:
   - Asymmetric-Regret Framing
   - Baseline Must Be Green
   - Diagnosis Before Iteration
   - Verify Before Claiming (phantom-merge/dispatch/merge patterns)
   - Feedback Triage

2. Move **domain-specific sections** to memory topics:
   - Portfolio analysis rules → `playbook-quantitative-rules` ✅ (already migrated as of May 30)
   - Shogi-SRS methodology → `playbook-shogi-patterns`
   - Academic paper analysis → `playbook-research-patterns`

3. Session-level prompt mentions memory topics: *"For portfolio analysis, recall `playbook-quantitative-rules`. For systematic debugging, recall `systematic-debugging-skill`."*

**Benefits**:
- Reduces baseline PLAYBOOK from 53k → ~30-35k chars (~-35%)
- Domain knowledge still accessible via `recall_memory` (cost: 1 tool call, ~10 tokens per search)
- No upstream autogent changes needed (`tier:1-trivial` memory operations only)

**Trade-offs**:
- Adds 1 turn latency when agent needs a migrated pattern (must recall first)
- Relies on agent knowing WHEN to recall (prompt must guide this)
- **`recall_memory` is search/rank-based, not deterministic keyed lookup**: without explicit trigger rules, canonical topic aliases, and a defined fallback path for miss scenarios, agents may silently skip recall or retrieve the wrong section — negating the "no operational knowledge loss" success criterion. Each migrated topic MUST ship with: (a) a trigger phrase in PLAYBOOK.md or session prompt, (b) the exact topic key, and (c) a fallback instruction (e.g., "if recall returns no match, treat as if that rule says X").
- **End-to-end session cost is not purely the baseline reduction**: recalled topics re-add tokens during the sessions that need them. Workflows that touch migrated patterns multiple times per session will pay the recall overhead on each turn the agent decides to retrieve. Net savings depend heavily on actual access frequency — the Phase 2 audit must measure per-section access counts before committing a savings estimate.
- **Governance drift risk**: PLAYBOOK.md is versioned in git, diff-reviewable, and auditable. Memory topics are mutable at runtime. Moving operational doctrine to memory weakens review/audit visibility unless a versioning rule is enforced. Mitigation: each migrated memory topic must have a corresponding stub in PLAYBOOK.md (`## <Section> — archived to memory topic <name> on <date>`), treated as the canonical record of intent.

**Implementation**:
1. Audit PLAYBOOK.md sections by access frequency:
   - **Hot** (every sprint): Feedback Triage, Verify Before Claiming, Baseline Green
   - **Warm** (weekly): Diagnosis Before Iteration, Asymmetric-Regret
   - **Cold** (monthly or less): Portfolio rules (already migrated), research methodology

   > **Note on high-blast-radius cold sections**: Frequency alone is insufficient. Sprint recovery / outage runbooks are rare but are needed most urgently in ambiguous, degraded conditions — precisely when an agent has the weakest cue to proactively recall them. **These must stay in PLAYBOOK.md** even if access frequency is low. Classification rule: any section whose absence during an incident could cause irreversible harm stays in the always-loaded bootstrap regardless of frequency tier.

2. Migrate **cold** sections to memory (frequency-low AND blast-radius-low):
   - Research paper analysis → `playbook-research-patterns`
   - Shogi methodology → `playbook-shogi-patterns` (if not already in `project-shogi-srs-manifest`)

   > Sprint recovery / incident runbook patterns are excluded from migration per the blast-radius rule above.

3. Update PLAYBOOK.md to add a "Memory Topics Index" section pointing to migrated content, with stub entries (`## <Section> — archived <date>`) serving as the audit trail.

**Estimated savings**: 53k → ~35k chars (~-34%), recovering ~18k chars (~4.5k tokens) at baseline. Actual per-session savings lower when migrated patterns are in active use; actual net reduction depends on Phase 2 frequency audit.

### Option C: Lazy-loaded skill files (MEDIUM COMPLEXITY)

**Hypothesis**: Convert long PLAYBOOK sections into skill definitions, loaded only when invoked.

**How it works**:
1. Portfolio analysis patterns → `portfolio-analysis.skill.md` in `.github/skills/`
2. Session prompt includes: *"When user asks portfolio questions, invoke `portfolio-analysis` skill."*
3. Skill system loads the full content only when skill is invoked (not at session start)

**Benefits**:
- Similar savings to Option B (~-35%)
- Skill content is versioned in git (easier to audit than memory topics)
- No per-session tool call cost (skill loads once when invoked, not per-pattern)

**Blockers**:
- Skills are **procedural tools** (run and return result), not **reference knowledge**
- Using skills for "knowledge lookup" would be an anti-pattern
- Would require wrapping every pattern in a skill execution flow

**Verdict**: Conceptual mismatch. Skills = actions; memory = knowledge. Option B is cleaner.

## Recommendation

**Implement Option B (memory-based contextual loading):**

1. **Phase 1** (this issue): Write this recommendation report. No code changes yet.
2. **Phase 2** (follow-up issue): Audit PLAYBOOK.md — measure per-section access frequency AND blast-radius, identify cold+low-blast-radius sections (revised target: 10-15k chars to migrate, excluding high-blast-radius content).
3. **Phase 3** (follow-up issue): Migrate qualifying cold sections to memory topics. For each: add PLAYBOOK.md stub, define trigger phrase, define topic alias, define miss fallback. Update PLAYBOOK.md with memory index.
4. **Phase 4** (July baseline): Capture post-migration baseline, verify net reduction (expect ~-25–34% depending on actual access frequency).

**Success criteria**:
- PLAYBOOK.md drops from 53k → ≤ 38k chars (conservative floor accounting for blast-radius exclusions)
- No loss of operational knowledge (still accessible via recall)
- Session prompts include explicit trigger rules for each migrated topic
- Each migrated topic has a PLAYBOOK.md stub as audit trail
- High-blast-radius incident runbooks remain in PLAYBOOK.md

**Alternative path**: If Jacky/upstream autogent team decides to build conditional bootstrap loading (Option A), revisit this recommendation. Option B is reversible — memory topics can be reintegrated into PLAYBOOK if conditional loading ships.

## Appendix: PLAYBOOK.md Growth History

| Date | PLAYBOOK chars | System prompt total | PLAYBOOK as % |
|------|---------------|---------------------|---------------|
| ~Feb 2026 | ~30,000 | ~120,000 | ~25% |
| May 4 | ~35,000 | ~130,000 | ~27% |
| May 20 | (truncated at 20k) | 118,737 (truncated) | — |
| May 27 | (truncated at 20k) | 118,737 (truncated) | — |
| **June 3** | **~53,000** | **183,547** | **~29%** |

The May 20-27 baselines artificially suppressed PLAYBOOK growth due to the 20k truncation bug. The June 3 baseline reveals the true size.

## References

- Monitor issue #4: https://github.com/copilot-autogent/cli-wrapper-monitor/issues/4
- Post-PR #383 baseline: `baselines/2026-06-03.json`
- Portfolio rules migration precedent: memory topic `playbook-quantitative-rules` (migrated May 30, 2026)
