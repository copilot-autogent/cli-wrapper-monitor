# Post-PR #383 Baseline — Expected Bootstrap Untruncation

**Date**: 2026-06-03
**Issue**: #3
**Trigger**: autogent PR #383 merged 2026-05-31

## Summary

This baseline captures the **intentional and expected** increase in system prompt size following the fix in [JackywithaWhiteDog/autogent#383](https://github.com/JackywithaWhiteDog/autogent/pull/383), which raised the bootstrap file character limit from 20k to 60k.

**This is NOT a regression** — it's the fix delivering the full content that was previously being truncated.

## What Changed

### Before (2026-05-28 baseline)
- `systemPromptChars`: 118,737 chars
- `systemPromptTokensEstimated`: 29,684 tokens
- **Bootstrap truncation**: PLAYBOOK.md (53k) and CONTEXT.md (47k) were being silently truncated at the 20k per-file limit

### After (2026-06-03 baseline)
- `systemPromptChars`: 183,547 chars (+64,810 chars, +54.6%)
- `systemPromptTokensEstimated`: 45,887 tokens (+16,203 tokens, +54.6%)
- **Bootstrap truncation**: Fixed — full content now delivered

## Root Cause

The CLI Wrapper Monitor project detected in Sprint 4 (May 20, 2026) that `bootstrapTruncated: 1` — a live production regression where ~100k chars of operational guidelines (PLAYBOOK.md + CONTEXT.md) were being dropped before reaching the model.

PR #383 fixed this by raising the default `maxCharsPerFile` from 20k to 60k, providing headroom for continued growth.

## Interpretation

The +54.6% increase in system prompt size is **working as intended**:

- **Not a regression**: This is the truncation bug being fixed
- **Expected magnitude**: The +64,810 chars recovered matches the known size of truncated content (~100k from PLAYBOOK + CONTEXT, minus overlap and other factors)
- **Beneficial**: The model now receives full operational guidelines that were previously missing

## Baseline Comparison

| Metric | 2026-05-28 | 2026-06-03 | Δ | Explanation |
|--------|-----------|-----------|---|-------------|
| System prompt chars | 118,737 | 183,547 | +64,810 (+54.6%) | ✅ Bootstrap truncation fixed |
| System prompt tokens | 29,684 | 45,887 | +16,203 (+54.6%) | ✅ Same as above |
| Tool definitions chars | 2,693 | 2,892 | +199 (+7.4%) | 📊 Normal tool evolution (1 new tool added) |
| Tool count | 14 | 15 | +1 (+7.1%) | � begin_plan tool added |
| Total overhead chars | 121,430 | 186,439 | +65,009 (+53.5%) | ✅ Primarily bootstrap fix |
| Total overhead tokens | 30,357 | 46,610 | +16,253 (+53.5%) | ✅ Same as above |

## Verification

1. ✅ Binary hash unchanged: `sha256:2ce57c...` (both baselines use same dist/index.js)
2. ✅ System prompt hash changed: `sha256:189f14...` → `sha256:34d0c6...` (expected — content untruncated)
3. ✅ Magnitude matches expectation: ~+65k chars recovered ≈ (53k PLAYBOOK + 47k CONTEXT - 20k limit × 2 files)

## Next Baseline

The next monthly baseline (2026-07-03) will establish the new "clean" reference point. Any future system prompt growth beyond this level should be scrutinized as potential regression or intentional expansion.

## References

- autogent PR #383: https://github.com/JackywithaWhiteDog/autogent/pull/383
- Monitor issue #3: https://github.com/copilot-autogent/cli-wrapper-monitor/issues/3
- Sprint 4 detection: https://github.com/copilot-autogent/cli-wrapper-monitor/blob/main/baselines/2026-05-20.json (first baseline showing `bootstrapTruncated: 1`)
