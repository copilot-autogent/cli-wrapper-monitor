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

**Implementation**:
1. Audit PLAYBOOK.md sections by access frequency:
   - **Hot** (every sprint): Feedback Triage, Verify Before Claiming, Baseline Green
   - **Warm** (weekly): Diagnosis Before Iteration, Asymmetric-Regret
   - **Cold** (monthly or less): Portfolio rules (already migrated), research methodology

2. Migrate **cold** sections to memory:
   - Sprint recovery → memory topic `playbook-sprint-recovery-patterns`
   - Research paper analysis → `playbook-research-patterns`
   - Shogi methodology → `playbook-shogi-patterns` (if not already in `project-shogi-srs-manifest`)

3. Update PLAYBOOK.md to add a "Memory Topics Index" section pointing to migrated content

**Estimated savings**: 53k → 35k chars (~-34%), recovering ~18k chars (~4.5k tokens)

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
2. **Phase 2** (follow-up issue): Audit PLAYBOOK.md, identify cold sections (target: 15-20k chars to migrate).
3. **Phase 3** (follow-up issue): Migrate cold sections to memory topics, update PLAYBOOK.md with memory index.
4. **Phase 4** (July baseline): Capture post-migration baseline, verify ~-35% reduction.

**Success criteria**:
- PLAYBOOK.md drops from 53k → 35k chars
- No loss of operational knowledge (still accessible via recall)
- Session prompts guide agents to recall when needed

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
