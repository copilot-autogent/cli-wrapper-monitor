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

## Historical Trend

System prompt size and tool count over time, generated from all accumulated baseline snapshots:

![Historical trend chart: system prompt size and tool count over time](./chart.svg)

_Chart regenerated automatically on each monthly baseline capture. To update manually after adding a baseline: `npm run chart`. Source: [`scripts/generate-chart.ts`](./scripts/generate-chart.ts)_

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

## Automated Capture

Captures run automatically on a regular schedule via GitHub Actions.

### Capture Schedule

| Workflow | Trigger | Location | PR opened? | Purpose |
|----------|---------|----------|------------|----------|
| [Monthly Capture (PR flow)](./.github/workflows/monthly-capture.yml) | 3rd of month, 00:00 UTC | `baselines/YYYY-MM-DD.json` | **Yes** — `baseline: YYYY-MM capture` | Milestone baseline; reviewed before merging |
| [Weekly Capture (reference snapshots)](./.github/workflows/weekly-capture.yml) | Every Monday, 00:00 UTC | `baselines/weekly/YYYY-MM-DD.json` | **No** | Lightweight reference; catches regressions within the month |
| [Weekly Stability Digest](./.github/workflows/weekly-stability-digest.yml) | Every Monday, 08:00 UTC | n/a (Discord notification only) | **No** | Heartbeat confirming baseline is unchanged; fires even when nothing changed |

Both workflows can also be triggered manually via *Actions → \<workflow name\> → Run workflow*.

**When to use each:**

- **Monthly (PR flow)** — the authoritative baseline for blog posts, trend analysis, and the retention policy. Every run opens a PR so a human can review before the snapshot is merged to `main`.
- **Weekly (reference)** — committed directly to `main` without a PR. Useful for spotting a silent regression mid-month before the next monthly capture. A Discord notification fires only when changes are detected.

### workflow_dispatch inputs

Both workflows accept manual-trigger inputs:

| Input | Monthly | Weekly | Default | Effect |
|-------|---------|--------|---------|--------|
| `capture_reason` | ✓ | ✓ | `scheduled` / `weekly` | Label added to the PR title (monthly) or commit message |
| `send_discord_notification` | ✓ | ✓ | `true` | Send Discord notification on completion / when changes detected |

### Capture configuration

Directory layout and retention are configured via [`capture.config.json`](./capture.config.json) in the repository root:

```json
{
  "monthlyBaselinesDir": "baselines",
  "weeklyBaselinesDir":  "baselines/weekly",
  "retentionMonths":    6
}
```

All three fields are optional — the defaults above apply when the file is absent.

### What the monthly workflow does

1. Checks out both this repo and `JackywithaWhiteDog/autogent` (for tool-count and source extraction)
2. Runs `npm run capture` — exits non-zero if any metric regresses by >10%
3. Generates a markdown diff report and writes it to the workflow run summary
4. Commits the new baseline and diff report back to a dated branch, then opens a PR
5. Fails the workflow run when regressions are detected so GitHub notifies the maintainer

### What the weekly workflow does

1. Same checkout + capture steps as monthly
2. Commits `baselines/weekly/YYYY-MM-DD.json` directly to `main` (no PR)
3. Sends a Discord notification only when the snapshot changed (i.e. wrapper layer changed)

### Weekly Digest

A separate weekly heartbeat workflow (`weekly-stability-digest.yml`) runs every **Monday at 08:00 UTC** and posts a compact Discord notification summarising the current baseline state.  Unlike the alert webhooks (which only fire on regressions), the digest fires every week to confirm the monitor is alive and the baseline is unchanged.

Example output:
```
📊 CLI Wrapper Monitor — Weekly Digest (2026-07-07)
✅ No regressions detected since last capture (2026-06-16)
  Latest snapshot: 2026-06-16
• Tools: 21
• Models (enabled): 8
• Hooks: 3 (fingerprint stable)
• System prompt: 156,244 chars / 39,061 tokens
• Headroom: 80% (above 50% threshold) ✅
```

When regressions are present (e.g. run mid-capture-cycle), emoji indicators change to 🔴 BREAKING or 🟡 WARNING with brief details.

**`workflow_dispatch`** is supported for manual status pings — navigate to *Actions → Weekly Stability Digest → Run workflow*.  Set *dry_run* to `true` to print the digest to the log without posting to Discord.

### One-time setup

Add a repository secret named **`AUTOGENT_PAT`** containing a GitHub personal access token with at least `contents: read` on `JackywithaWhiteDog/autogent`. Without it the capture still runs but extracts 0 tools and an empty system prompt — useful for testing the workflow plumbing but not for real regression tracking.

Steps:
1. Create a [fine-grained PAT](https://github.com/settings/tokens?type=beta) for `JackywithaWhiteDog/autogent` → *Repository permissions → Contents → Read-only*
2. In `copilot-autogent/cli-wrapper-monitor` → *Settings → Secrets and variables → Actions → New repository secret*
3. Name: `AUTOGENT_PAT`, Value: the token

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
├── .github/
│   └── workflows/
│       ├── monthly-capture.yml  # Monthly PR-flow capture (3rd of month)
│       ├── weekly-capture.yml   # Weekly reference snapshot (every Monday)
│       └── ci.yml               # CI: lint + test on PRs
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
│   ├── capture-autogent-baseline.ts  # Capture live autogent session baseline
│   ├── capture-config.ts             # Config loader for capture.config.json
│   ├── archive-baselines.ts          # Archive old baselines (monthly + weekly)
│   ├── validate-baselines.ts         # Validate all baseline files (monthly + weekly)
│   ├── generate-diff-report.ts       # Compare two snapshots, output markdown diff
│   └── trend-report.ts               # Show all historical baselines as trend table
├── baselines/
│   ├── schema.json          # JSON Schema for snapshot files
│   ├── latest.json          # Most recent monthly baseline
│   ├── YYYY-MM-DD.json      # Monthly baseline snapshots
│   ├── archive/YYYY/        # Archived monthly baselines (> 6 months old)
│   └── weekly/              # Weekly reference snapshots
│       ├── YYYY-MM-DD.json  # Weekly snapshot
│       └── archive/YYYY/    # Archived weekly baselines (> 6 months old)
└── capture.config.json  # Capture directory layout + retention policy
```

## Usage

### Before You Capture

Before running a full baseline capture, use the pre-flight validator to check that your environment is ready. This catches auth, network, and disk issues upfront — avoiding wasted time from a capture that fails mid-flight.

```bash
# Install dependencies first (required for npm run preflight)
npm install

# Run all pre-flight checks (auth, webhook, disk space, TypeScript compilation)
# Exits 0 on all-pass, 1 on any failure — does NOT proceed to capture.
npm run preflight

# Or invoke via the capture script (same checks, same exit codes, no capture)
npx tsx scripts/capture-autogent-baseline.ts --preflight
```

**What each check does:**

| Check | What it verifies | Failure action |
|---|---|---|
| **Auth** | Calls `listModels()` via CopilotClient to confirm SDK auth is valid | Run `/login` in Copilot CLI |
| **Webhook** | POSTs a `{"content":"preflight-test"}` ping to `DISCORD_WEBHOOK_URL` (skipped if unset) | Check URL or network connectivity |
| **Disk space** | Verifies ≥ 10 MB free in `baselines/` | Clear old baselines or free disk space |
| **TypeScript** | Runs `tsc --noEmit` to catch pre-existing type errors | Fix type errors shown in output |

On success, prints `✅ Pre-flight checks passed — ready to capture.` and exits 0.  
On failure, prints which check failed with an actionable message and exits 1.

```bash
# Install dependencies
npm install

# Run all experiments (static analysis mode — no credentials needed)
npm run experiments

# Pass a system prompt file for accurate token counts
SYSTEM_PROMPT_FILE=./my-prompt.txt npm run experiments

# Pass tool definitions JSON
TOOL_DEFS_FILE=./tools.json npm run experiments

# Capture baseline from a local autogent checkout (defaults to /app)
npm run capture
AUTOGENT_PATH=/path/to/autogent npm run capture

# Validate environment without writing files (dry run)
# Authenticates, verifies SDK connection, calls listModels(), runs a lightweight
# probe, and prints what would be written — exits without writing any files.
npx tsx scripts/capture-autogent-baseline.ts --dry-run

# Generate a diff report comparing two baselines
npm run diff -- --baseline baselines/2026-05-27.json --current baselines/2026-05-31.json

# Generate a diff report and save to reports/
npm run diff -- --baseline baselines/2026-05-27.json --current baselines/2026-05-31.json --output reports/diff-2026-05-31.md

# Show trend table across all historical baselines (includes archived)
npm run trend

# Save trend report to file
npm run trend -- --output reports/trend-2026-05.md

# Archive baselines older than 6 months (monthly + weekly)
npm run archive

# Preview what would be archived (dry run)
npm run archive -- --dry-run

# Archive with custom retention window (12 months)
npm run archive -- --older-than-months 12

# Archive only monthly baselines (skip weekly)
npm run archive -- --skip-weekly

# Validate all baselines (monthly + weekly)
npm run validate

# Validate only monthly baselines
npm run validate -- --skip-weekly

# Generate a self-contained HTML dashboard from all baselines
npm run dashboard

# Save dashboard to a custom path
npm run dashboard -- --output reports/dashboard-2026-07.html
```

> **Note**: The refusal-rate experiment requires a live SDK connection (`GITHUB_TOKEN`). This is a sprint 2 feature.

## Snapshot Format

Results are stored as JSON in `baselines/` following [schema.json](./baselines/schema.json).

Starting with the May 27 baseline, each bootstrap file entry includes a `contentHash` (MD5) to detect content rewrites that happen to preserve file length.

## Baseline Retention Policy

Captures accumulate over time. To keep the repository lean, baselines older than **6 calendar months** can be moved to `archive/YYYY/` subdirectories using the archive script. The policy applies to both monthly and weekly directories.

```bash
# Archive baselines older than 6 months (default — covers both monthly and weekly)
npm run archive

# Preview without moving files
npm run archive -- --dry-run

# Custom retention window (e.g. keep 12 months)
npm run archive -- --older-than-months 12
```

**Behaviour:**

- Files are moved by date prefix in the filename (`YYYY-MM-DD`). Files whose names don't start with a date (e.g. `schema.json`, `latest.json`) are always left in place.
- Monthly: `baselines/archive/YYYY/*.json` — archived files organised by year.
- Weekly: `baselines/weekly/archive/YYYY/*.json` — same structure.
- `npm run trend` and `npm run validate` automatically include both archive directories so historical data is never lost.
- The script is **idempotent**: running it twice has no side effects.
- Retention window and directory layout are read from [`capture.config.json`](./capture.config.json).

## Regression Thresholds

| Severity | Threshold |
|----------|----------|
| ⚪ Info | < 5% change |
| 🟡 Warning | 5–10% change |
| 🔴 Regression | > 10% change |

## Dashboard

Generate a self-contained HTML snapshot of all baseline history with trend charts and regression detection:

```bash
npm run dashboard
# → writes reports/dashboard.html
```

The dashboard is **zero-dependency** (no JS frameworks, no CDN links) and can be opened directly in any browser, emailed, or linked from the README.

### What the dashboard includes

1. **Summary card** — latest baseline date, tool count, hook count, system prompt size, estimated tokens, context headroom, model, SDK version
2. **Trend sparklines** — inline SVG line charts for: tool count over time, system prompt tokens over time, injection refusal rate over time
3. **Regression timeline** — table of all detected BREAKING/WARNING changes with dates and descriptions
4. **Model pool section** — active models with context window sizes; retired models with first/last seen dates
5. **Zero external deps** — pure HTML/CSS/inline SVG, works offline

`reports/dashboard.html` is gitignored by default. To commit the file, remove the `reports/dashboard.html` line from `.gitignore`.

## Published Reports

| Date | Report | Summary |
|------|--------|-------|
| 2026-05-04 | [Context Tax Baseline](./reports/context-tax-baseline-2026-05-04.md) | 12,956 tokens overhead (6.5% of 200k window) |
| 2026-05-20 | [Diff: May 4 → May 20](./reports/diff-2026-05-04-to-2026-05-20.md) | 🔴 +24% regression — 29 tools, bootstrap truncation detected |
| 2026-05-20 | [Regression Analysis](./reports/context-tax-regression-2026-05-20.md) | Root cause: PLAYBOOK/CONTEXT exceed 20k truncation limit |
| 2026-05-27 | [Diff: May 20 → May 27](./reports/diff-2026-05-20-to-2026-05-27.md) | 🟡 +2.3% this period; fix PR open; cumulative +27.3% from baseline |
| 2026-05-31 | [Diff: May 27 → May 31](./reports/diff-2026-05-27-to-2026-05-31.md) | ✅ Fix delivered (+105% intentional); truncation resolved |
| 2026-06-14 | [PLAYBOOK Restructuring Analysis](./reports/playbook-restructuring-feasibility-2026-06-14.md) | PLAYBOOK.md at 133k chars (2.2× 60k limit); two-phase restructuring recommended |

**Blog coverage**:
- [The Hidden Cost of Instructions](https://copilot-autogent.github.io/ai-security-blog/blog/hidden-cost-of-instructions) — May baseline analysis
- [We Found a Regression in Our Own Agent](https://copilot-autogent.github.io/ai-security-blog/blog/we-found-a-regression-in-our-own-agent) — the bootstrap truncation story

## Methodology Notes

- **Dual cadence** — monthly PR-flow captures (3rd of month) for authoritative baselines; weekly reference snapshots (every Monday) for early regression detection
- **Copilot CLI/SDK only** — no cross-CLI comparison (resource constraint)
- **Static + live modes** — context-tax works without credentials; refusal-rate needs a live session
- **Results in repo** — monthly snapshots in `baselines/`, weekly in `baselines/weekly/`, diff reports in `reports/`
- **Blog only on interesting findings** — this is not a vanity metric dashboard
- **Content hashes** — each bootstrap file entry includes MD5 hash to detect rewrites that preserve length
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

### Sprint 6 — Monthly Automation ✅
- Fourth baseline captured (May 31, 2026) — post-fix: +105% system prompt chars, truncation resolved
- Monthly baseline capture automated via GitHub Actions ([`.github/workflows/monthly-capture.yml`](./.github/workflows/monthly-capture.yml))
- Workflow fires on the 3rd of each month; commits baselines and diff reports back to a dated branch; opens a PR
- Regressions surface as red workflow runs with step-summary diff report

### Sprint 7 — Growth Analysis + Restructuring Recommendation ✅
- June 14 measurement: PLAYBOOK.md at 133,761 chars (2.2× the new 60k limit)
- [PLAYBOOK restructuring feasibility analysis](./reports/playbook-restructuring-feasibility-2026-06-14.md) published
- Two-phase recommendation: content archiving (immediate) + on-demand section loading (engineering sprint)

### Sprint 8 — Configurable Capture Schedule ✅
- `weekly-capture.yml`: weekly reference snapshots every Monday at 00:00 UTC
- `monthly-capture.yml`: `workflow_dispatch` inputs for `capture_reason` and `send_discord_notification`
- `capture.config.json`: repo-level config for directory layout and retention
- `archive-baselines.ts`: extended to archive both monthly and weekly directories
- `validate-baselines.ts`: extended to scan `baselines/weekly/` and its archive
- `capture-config.ts`: config loader + directory routing logic with full unit-test coverage

### Sprint 9 — Next Steps
- Add `AUTOGENT_PAT` secret and validate first automated capture fires correctly (July 1)
- Begin refusal-rate live experiment with standardized probe set
- File upstream issue: on-demand `playbook/` section loading
- Capture July baseline (post-PLAYBOOK archiving)
