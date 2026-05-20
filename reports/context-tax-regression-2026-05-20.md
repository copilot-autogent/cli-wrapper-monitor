# Context Tax Regression Report — May 20, 2026

**Status**: 🔴 Regression detected  
**Captured**: 2026-05-20T17:00Z  
**Interval since baseline**: 16 days (May 4 → May 20)

---

## What Changed

In 16 days of active development, the Copilot CLI wrapper overhead grew **24.5%** — from 12,956 to 16,126 estimated tokens.

| Component | May 4 | May 20 | Change |
|-----------|-------|--------|--------|
| System prompt | 12,455 tokens | 14,241 tokens | +1,786 (+14%) 🔴 |
| Tool definitions | 501 tokens | 1,885 tokens | +1,384 (+276%) 🔴 |
| **Total** | **12,956 tokens** | **16,126 tokens** | **+3,170 (+24%)** 🔴 |

For context: 16,126 tokens at session start = **8.1%** of claude-opus-4.6's 200k window (up from 6.5%). Still within budget, but the rate of growth is the concern.

---

## The Bootstrap Truncation Problem

This snapshot reveals a more important finding than the token count: **both PLAYBOOK.md and CONTEXT.md now exceed the 20,000 char per-file truncation limit** in autogent's system prompt assembly.

| File | Actual Size | Delivered to Model | Gap |
|------|------------|-------------------|-----|
| SOUL.md | 4,517 chars | 4,517 chars | — |
| PLAYBOOK.md | **39,673 chars** | 20,000 chars | **19,673 chars silently dropped** |
| CONTEXT.md | **41,739 chars** | 20,000 chars | **21,739 chars silently dropped** |
| USER.md | 11,872 chars | 11,872 chars | — |

**41,412 chars of operational guidelines — about half the total — never reach the model.** Every new PLAYBOOK section added after the 20,000-char mark is written, committed, and silently ignored.

### What's in the truncated tail?

The PLAYBOOK.md sections that fall after the 20,000-char cutoff include the recently added guidelines around:
- Sprint agent ordering (PR before review, never auto-merge)
- Side project bug tracking patterns
- Content placement (bootstraps vs memory)
- Side project kickstart protocols
- Scheduled task setup checklist
- Investigation before implementation
- Fix the startup path
- Post-merge verification
- Side project PR merge handoff
- Retros must produce actions
- Multi-model brainstorming

These are all **recently added rules** — meaning the most current operational guidelines are precisely the ones being dropped.

---

## Tool Growth: 11 → 29 Tools

The tool suite nearly tripled, with three coherent feature additions:

| Addition | Tools | Tokens Added |
|----------|-------|-------------|
| Playwright browser tools | 9 tools | ~450 tokens |
| Memory tools (save/delete/patch/list) | 4 tools | ~240 tokens |
| Data workbench (sql/load/list) | 3 tools | ~165 tokens |
| Bootstrap tools (write/patch/introspect/rollback) | 4 tools | ~220 tokens |
| Communication tools (send_file) | 1 tool | ~60 tokens |
| spawn_task | 1 tool | ~113 tokens |

Tool growth is expected and intentional. Each addition increased agent capability. The average tool cost grew from 163 to 260 chars because newer tools have more complex schemas (especially `manage_tasks` at ~800 chars).

---

## Growth Rate Projection

At the current growth rate observed over this 16-day window:

| Horizon | Projected Total Overhead | % of 200k window |
|---------|------------------------|------------------|
| Now (May 20) | 16,126 tokens | 8.1% |
| 1 month (June 20) | ~18,000 tokens | 9.0% |
| 3 months (Aug 20) | ~22,000 tokens | 11.0% |
| 6 months (Nov 20) | ~29,000 tokens | 14.5% |

The token budget concern is manageable. The bootstrap truncation concern is immediate — every new guideline added today lands in the invisible tail.

---

## Recommended Actions (Prioritized)

### 🔴 P1 — Fix bootstrap truncation (autogent config)

Raise `bootstrap.maxCharsPerFile` from 20,000 to 40,000 in autogent config. This ensures the full PLAYBOOK.md and CONTEXT.md reach the model. The total system prompt would grow to ~80,000 chars (~20,000 tokens) — still well within budget.

```json
// autogent.json
{
  "bootstrap": {
    "maxCharsPerFile": 40000,
    "totalMaxChars": 150000
  }
}
```

### 🟡 P2 — Add system prompt hash to baseline schema

Token count tells you *whether* the system prompt changed. A content hash tells you *that* it changed even when size is stable (e.g., a rewrite that keeps the same length). Add a SHA-256 hash of the assembled system prompt to each baseline.

### ⚪ P3 — Consider PLAYBOOK restructuring

At 39,673 chars, PLAYBOOK.md has become a monolith. A section-weighted approach (most-read sections at the top, historical examples at the bottom) would maximize the value of the first 20,000 chars even under the current truncation limit.

---

## Note on Methodology: RN-005

The cross-pollination log flagged that **LLM SDK 0.20a2 introduces interleaved reasoning via `/v1/responses`** which changes how overhead should be measured. In live mode, the reasoning tokens (if any are injected by the CLI wrapper) would add to the effective context consumption. This baseline uses static analysis mode and does not account for this. Future live-mode baselines should check whether the SDK version injects any reasoning preamble before the user's first message.

---

*Methodology: static analysis, bootstrap files measured from disk, token estimates use ÷4 heuristic.*  
*Full data: [baselines/2026-05-20.json](../baselines/2026-05-20.json)*  
*Compared to: [baselines/latest.json](../baselines/latest.json) (May 4)*
