# CLI Wrapper Monitor

Automated regression detection for Copilot CLI wrapper behavior. Tracks how changes to the scaffold layer — system prompt, tool definitions, and hooks — affect model behavior over time.

## Problem

When Copilot CLI behavior changes unexpectedly, it's difficult to isolate the cause:

- Did the **underlying model** change?
- Did the **CLI wrapper** (system prompt, tools, hooks) change?
- Or some combination of both?

The community has documented dozens of open issues about unexplained behavior regressions with no tooling to decompose these two sources of change. This project addresses the wrapper-layer side of that gap.

## Approach

Snapshot-based regression testing scoped to the **Copilot CLI/SDK wrapper layer only**. Run standardized experiments monthly, compare against a stored baseline, and generate a diff report when behavior changes.

This is **not** a benchmark or leaderboard. It's a regression detector.

## Focus Areas

### 1. Context Tax

Measures token overhead imposed by the wrapper before any user content:

- System prompt character count + estimated token count
- Tool definition payload size (per-tool and aggregate)
- Total registered tool count
- Estimated total overhead tokens per session

Context tax directly reduces the effective context window available for user work. A 10%+ increase in overhead tokens is flagged as a regression.

### 2. Security Posture

Tests refusal behavior across a standardized probe set:

| Category | Expected | Examples |
|----------|----------|----------|
| **Safe** | Always allowed | List files, read package.json, debug TypeScript |
| **Borderline** | Varies by config | Delete all files, read SSH key |
| **Dangerous** | Always refused | Malware creation, credential exfiltration |

Tracking this over time reveals when hook or system prompt changes silently alter the security boundary.

## Metrics

| Metric | Experiment | Unit |
|--------|-----------|------|
| `systemPromptChars` | context-tax | chars |
| `systemPromptTokensEstimated` | context-tax | tokens |
| `toolDefinitionsChars` | context-tax | chars |
| `toolDefinitionsTokensEstimated` | context-tax | tokens |
| `toolCount` | context-tax | count |
| `totalOverheadTokensEstimated` | context-tax | tokens |
| `bootstrapTruncated` | context-tax | bool |
| `safeAllowedRate` | refusal-rate | fraction |
| `dangerousRefusedRate` | refusal-rate | fraction |
| `borderlineRefusedRate` | refusal-rate | fraction |

*Token estimates use the ÷4 heuristic (1 token ≈ 4 chars), appropriate for English prose and JSON.*

## Project Structure

```
cli-wrapper-monitor/
├── src/
│   ├── harness/
│   │   ├── types.ts         # Core types: Experiment, MetricSnapshot, DiffReport
│   │   ├── runner.ts        # ExperimentRunner — registers and runs experiments
│   │   ├── snapshot.ts      # SnapshotStore — saves/loads JSON baselines
│   │   └── diff.ts          # diffSnapshots() + formatDiffReport()
│   └── experiments/
│       ├── context-tax.ts   # Token overhead of system prompt + tool definitions
│       └── refusal-rate.ts  # Refusal behavior on standard probe set (sprint 2)
├── scripts/
│   ├── run-experiments.ts          # Run all experiments, save snapshot
│   ├── capture-autogent-baseline.ts # Capture live autogent session baseline
│   ├── generate-diff-report.ts     # Compare two snapshots, output markdown diff
│   └── trend-report.ts             # Show all historical baselines as trend table
└── baselines/
    ├── schema.json          # JSON Schema for snapshot files
    ├── latest.json          # Symlink to most recent baseline
    ├── 2026-05-20.json      # Second baseline — 🔴 +24% regression detected
    ├── 2026-05-27.json      # Third baseline — 🟡 +2.3% (cumulative: +27.3% from May 4)
    ├── 2026-05-31.json      # Post-fix baseline — ✅ PR #383 resolved truncation
    └── 2026-06-14.json      # 🔴 New regression — PLAYBOOK.md breaches 60k limit
```

## Usage

```bash
# Install dependencies
npm install

# Run all experiments (static analysis mode — no credentials needed)
npm run experiments

# Pass a system prompt file for accurate token counts
SYSTEM_PROMPT_FILE=./my-prompt.txt npm run experiments

# Pass tool definitions JSON
TOOL_DEFS_FILE=./tools.json npm run experiments

# Generate a diff report comparing baseline to a new snapshot
npm run diff -- --baseline baselines/2026-05-31.json --current baselines/2026-06-14.json

# Generate a diff report and save to reports/
npm run diff -- --baseline baselines/2026-05-31.json --current baselines/2026-06-14.json --output reports/diff-2026-05-31-to-2026-06-14.md

# Show trend table across all historical baselines
npm run trend

# Save trend report to file
npm run trend -- --output reports/trend-2026-06.md
```

> **Note**: The refusal-rate experiment requires a live SDK connection (`GITHUB_TOKEN`). This is a sprint 2 feature.

## Snapshot Format

Results are stored as JSON in `baselines/` following [schema.json](./baselines/schema.json).

Starting with the May 27 baseline, each bootstrap file entry includes a `contentHash` (MD5) to detect content rewrites that happen to preserve file length.

## Regression Thresholds

| Severity | Threshold |
|----------|-----------|
| ⚪ Info | < 5% change |
| 🟡 Warning | 5–10% change |
| 🔴 Regression | > 10% change |

## Published Reports

| Date | Report | Summary |
|------|--------|--------|
| 2026-05-04 | [Context Tax Baseline](./reports/context-tax-baseline-2026-05-04.md) | 12,956 tokens overhead (6.5% of 200k window) |
| 2026-05-20 | [Diff: May 4 → May 20](./reports/diff-2026-05-04-to-2026-05-20.md) | 🔴 +24% regression — 29 tools, bootstrap truncation detected |
| 2026-05-20 | [Regression Analysis](./reports/context-tax-regression-2026-05-20.md) | Root cause: PLAYBOOK/CONTEXT exceed 20k truncation limit |
| 2026-05-27 | [Diff: May 20 → May 27](./reports/diff-2026-05-20-to-2026-05-27.md) | 🟡 +2.3% this period; fix PR open; cumulative +27.3% from baseline |
| 2026-05-31 | [Diff: May 27 → May 31](./reports/diff-2026-05-27-to-2026-05-31.md) | ✅ Fix delivered — truncation resolved, +105% intentional growth |
| 2026-06-14 | [Diff: May 31 → Jun 14](./reports/diff-2026-05-31-to-2026-06-14.md) | 🔴 New regression — PLAYBOOK +150% in 14 days, 60k limit breached again |
| 2026-06-14 | [PLAYBOOK Restructuring Feasibility](./reports/playbook-restructuring-feasibility-2026-06-14.md) | Three-option analysis with recommendation (issue #4) |

**Blog coverage**:
- [The Hidden Cost of Instructions](https://copilot-autogent.github.io/ai-security-blog/blog/hidden-cost-of-instructions) — May baseline analysis
- [We Found a Regression in Our Own Agent](https://copilot-autogent.github.io/ai-security-blog/blog/we-found-a-regression-in-our-own-agent) — the bootstrap truncation story

## Methodology Notes

- **Monthly cadence** — not CI on every commit; wrapper changes are infrequent
- **Copilot CLI/SDK only** — no cross-CLI comparison (resource constraint)
- **Static + live modes** — context-tax works without credentials; refusal-rate needs a live session
- **Results in repo** — snapshots committed to `baselines/`, reports generated locally
- **Blog only on interesting findings** — this is not a vanity metric dashboard
- **Content hashes** — each bootstrap file entry includes MD5 hash to detect rewrites that preserve length
- **Tool definition measurement** — from Jun 14 baseline onward, tool chars are measured via `JSON.stringify()` on the actual definition objects (not per-tool estimates). This corrects a systematic undercount in prior baselines (~275 chars/tool estimated vs ~932 chars/tool actual).
- **RN-005**: LLM SDK 0.20a2 introduces interleaved reasoning via `/v1/responses` — live-mode baselines should check for reasoning token overhead

## Roadmap

### Sprint 1 — Scaffold ✅
- Harness framework (types, runner, snapshot store, diff reporter)
- Context-tax experiment (static analysis mode)
- Refusal-rate experiment (stub)
- JSON schema for baseline snapshots

### Sprint 2 — Live Experiments ✅
- Connect context-tax to live SDK for exact token counts
- Implement refusal-rate live mode with SDK session
- Capture first real baseline snapshot (12,956 tokens overhead)

### Sprint 3 — Analysis Tooling ✅
- Automated diff report generation (`npm run diff`)
- Trend visualization across historical baselines (`npm run trend`)
- Blog cross-post: [The Hidden Cost of Instructions](https://copilot-autogent.github.io/ai-security-blog/blog/hidden-cost-of-instructions)

### Sprint 4 — First Regression Detected ✅
- Second baseline captured (May 20, 2026)
- First real diff: 🔴 +24% total overhead in 16 days
- Bootstrap truncation discovery: PLAYBOOK.md and CONTEXT.md silently truncated
- Published regression analysis report

### Sprint 5 — Fix + Blog ✅
- Blog post: [We Found a Regression in Our Own Agent](https://copilot-autogent.github.io/ai-security-blog/blog/we-found-a-regression-in-our-own-agent)
- Upstream fix PR opened: [autogent#383](https://github.com/JackywithaWhiteDog/autogent/pull/383) (maxCharsPerFile 20k→60k)
- Third baseline captured (May 27, 2026) — 🟡 +2.3% this period, cumulative +27.3% from May 4
- Content hash added to baseline schema (detect rewrites that preserve length)

### Sprint 6 — Post-Fix Validation ✅
- Post-fix baseline captured (May 31, 2026) — ✅ bootstrapTruncated resolved, +105% intentional
- Tool definition measurement corrected: actual JSON.stringify() vs prior estimates
- New regression detected: PLAYBOOK.md +150% in 14 days, breaches 60k limit again
- PLAYBOOK restructuring feasibility analysis completed (issue [#4](https://github.com/copilot-autogent/cli-wrapper-monitor/issues/4))

### Sprint 7 — PLAYBOOK Restructuring
- Apply Phase 1 fix: reorder PLAYBOOK sections + archive domain-specific rules to memory
- Target: PLAYBOOK.md < 60k chars, `bootstrapTruncated: 0` restored
- Upstream autogent PR: add `bootstrap.files` array config (sectioned loading)
- Fix local config override: update `maxCharsPerFile` from 20k → 60k in runtime config
- Add PLAYBOOK size check to monthly monitor threshold (🟡 45k, 🔴 55k)
