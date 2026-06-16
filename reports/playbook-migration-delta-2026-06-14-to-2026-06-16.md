# PLAYBOOK Migration Delta Report — autogent#571

**Report type**: Before/after validation  
**Migration**: [autogent#571](https://github.com/JackywithaWhiteDog/autogent/issues/571) — Archive PLAYBOOK.md narrative sections to memory  
**Merged**: 2026-06-14 09:45 UTC  
**Report generated**: 2026-06-16  
**Tracking issue**: [cli-wrapper-monitor#21](https://github.com/copilot-autogent/cli-wrapper-monitor/issues/21)

---

## Summary

| | Value |
|---|---|
| **Pre-migration** | 2026-06-14T09:45:30Z (workspace git `9a8735d6`) |
| **Post-migration** | 2026-06-16T21:20:00Z (current state) |
| **System prompt reduction** | **−70,709 chars (−31.2%)** |
| **Token savings** | **−17,677 tokens** |
| **Success criteria (≥30%)** | ✅ **PASSED** (size reduction; semantic rule verification out of scope — see caveats) |

---

## Context-Tax Metrics

| Metric | Pre-migration | Post-migration | Change | |
|--------|--------------|----------------|--------|--|
| systemPromptChars | 226,953 chars | 156,244 chars | −31.2% | ✅ |
| systemPromptTokensEstimated | 56,738 tokens | 39,061 tokens | −31.2% | ✅ |
| toolDefinitionsChars | 3,283 chars | 3,283 chars | 0.0% | ⚪ |
| toolDefinitionsTokensEstimated | 821 tokens | 821 tokens | 0.0% | ⚪ |
| toolCount | 21 tools | 21 tools | 0 | ⚪ |
| avgCharsPerTool | 156 chars | 156 chars | 0.0% | ⚪ |
| totalOverheadChars | 230,236 chars | 159,527 chars | −30.7% | ✅ |
| totalOverheadTokensEstimated | 57,559 tokens | 39,882 tokens | −30.7% | ✅ |

---

## Bootstrap File Breakdown

| File | Pre-migration | Post-migration | Delta |
|------|--------------|----------------|-------|
| SOUL.md | 4,493 chars | 4,493 chars | 0 |
| **PLAYBOOK.md** | **134,969 chars** | **49,583 chars** | **−85,386 (−63.3%)** |
| CONTEXT.md | 74,532 chars | 88,715 chars | +14,183 (+19.0%) |
| USER.md | 12,938 chars | 13,432 chars | +494 |
| **Sum (files)** | **226,932 chars** | **156,223 chars** | **−70,709 (−31.2%)** |

> **Note on totals**: The per-file sum differs from `systemPromptChars` by exactly 21 chars
> in both cases (3 separators × `"\n\n---\n\n"` = 7 chars each). Pre: 226,932 + 21 = 226,953 ✓
> Post: 156,223 + 21 = 156,244 ✓. All values use `String.length` (UTF-16 code units) for
> consistency with the baseline metric. Raw byte counts (`wc -c`) are larger due to
> multi-byte UTF-8 chars (emoji, `→`, `—`, etc.) in the bootstrap files.
>
> CONTEXT.md grew +14,183 chars between June 14 and June 16 as new gotchas were added
> (empirical-first, self-skip escalation, security checklist, etc.). This partially offsets
> the PLAYBOOK reduction. Without that growth the net reduction would have been ~84k
> chars (−37%).

---

## What changed in PLAYBOOK.md

The migration archived two large narrative sections to memory topics:

| Archived section | Memory topic | Approx chars removed |
|---|---|---|
| Portfolio/quantitative analysis rules | `playbook-portfolio-rules` | ~50k |
| Product development lessons (MVP-First, extract-working-patterns) | `playbook-product-lessons` | ~25k |
| Inline backstory/case-study prose (throughout) | (trimmed inline) | ~10k |

All archived sections should be reachable via `recall_memory("topic-name")`. Per the
autogent#571 acceptance criteria: "every operational rule still discoverable (either
inline OR via referenced memory topic)". Semantic verification of rule preservation is
outside the scope of this observation-only report.

---

## Prediction vs Actual

The PR #9 (2026-06-10) analysis predicted:

| Metric | Predicted | Actual | Assessment |
|---|---|---|---|
| System prompt reduction % | ~34% | **31.2%** | Close — within 3pp ✅ |
| Absolute char reduction | "53k→35k" (18k chars) | **−70,709 chars** | Prediction severely underestimated (PLAYBOOK had grown to 133k+ by migration day) |
| Token savings | ~4.5k tokens | **−17,677 tokens** | ~4× larger than predicted |

The percentage prediction (34%) was accurate. The absolute numbers were not — because the
June 10 analysis was based on an earlier PLAYBOOK state, and PLAYBOOK grew by ~80k chars
between the PR #9 analysis and the migration date (new rules added daily).

---

## Regression Check

| Check | Result |
|---|---|
| Tool count stable | ✅ 21 tools (unchanged) |
| Binary hash | ✅ unchanged (`sha256:2ce57cb2…`) — PLAYBOOK migration is bootstrap-only |
| System prompt hash changed | ✅ expected (PLAYBOOK content changed) |
| PLAYBOOK.md ≤ 50k ceiling | ✅ 49,583 chars (verified from git commit `9b378da1`, the migration commit itself) |
| No operational rules removed | ⚠️ not verified by this report — size metrics cannot establish semantic equivalence; covered by autogent#571 acceptance criteria |

---

## Success Criteria

- [x] Pre-migration baseline captured (2026-06-14, reconstructed from workspace git `9a8735d6`)
- [x] Post-migration baseline captured (2026-06-16, `baselines/2026-06-16-post-migration.json`)
- [x] Delta report confirms ≥30% system prompt reduction (actual: **31.2%**)
- [ ] No unexpected regressions: tool count stable ✅; semantic rule preservation not verified by this observation-only report (see autogent#571)

---

## Caveats

1. **Pre-migration baseline is reconstructed** from the workspace git history (commit `9a8735d6`,
   the parent of the migration commit). It was not captured live by the monitor script at the
   moment of migration. The character counts are exact (read from git-stored file content); the
   tool defs and binary hash reflect the current `/app` state since the PLAYBOOK migration
   involved no code changes.

2. **Model pool not captured** — the CopilotClient model pool API requires a running SDK process.
   These baselines use static analysis only (`SKIP_MODEL_POOL=true` equivalent). The 2026-06-03
   baseline also lacked a model pool capture (same limitation).

3. **Post-migration includes post-June-14 growth** — CONTEXT.md and USER.md received updates
   between June 14 and June 16 (new rules and gotchas). The post-migration baseline reflects the
   state as of 2026-06-16. The −17,677 token delta reported here reflects the June 14→June 16
   net change (migration reduction minus subsequent additions). Token savings at the exact
   migration moment were larger (~85k chars PLAYBOOK reduction minus ~0 CONTEXT growth
   on June 14 = ~21k token savings); subsequent rule additions partially offset this.

---

*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor)*  
*Baselines: `baselines/2026-06-14-pre-migration.json` → `baselines/2026-06-16-post-migration.json`*
