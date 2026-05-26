---
name: security-paper-review
description: |
  Critical reviewer pass on a security-paper draft, modeled on top-tier security-venue PC review. Reads the paper end-to-end, checks structural coherence, audits claims (not just citations) via paperbridge, surfaces engineering-communication gaps, names implicit trade-offs the authors left unsaid, and hunts for unfound prior art that solves the same problem. Outputs an under-700-word actionable report with file:line references. Pairs with `citation-verify` (audits cites that exist) and `literature-strengthen` (adds cites that should exist) — this skill audits *the paper itself*, not its bibliography.
---

# Security Paper Review

A focused critical-review skill calibrated for IEEE / USENIX / ACM security venues (CNS, S&P, USENIX Security, NDSS, CCS, RAID, TIFS, DSN, EuroS&P). Operates as if you were the third reviewer — the one who actually reads the paper closely instead of skimming for obvious red flags.

## When to use

- Right before submission: catch contradictions, overclaims, scope drift before a PC member does.
- After a structural revision: verify the revision didn't over-correct or introduce new gaps.
- Cross-paper consistency: when multiple papers from the same dissertation will go to the same venue concurrently, run this skill on each to catch series-identifier risks.

## Core principle

Every load-bearing sentence is a claim. The bibliography proves citations exist; the abstract proves you wrote a paper. **What this skill audits is whether the claims you make are supported by either evidence in the paper or the literature you cite — and whether the engineering choices you announced are actually communicated, justified, and sufficiently scoped that a careful reviewer can rebuild the system.**

A good security-paper review surfaces:
1. **Structural failures** — concept introduced after it's used, threat model missing, contributions vague.
2. **Claim-level overclaims** — numbers asserted without source, qualitative claims ("X cannot scale") attributed to papers that don't argue scale.
3. **Engineering-communication gaps** — design choices announced without rationale, header sizes / hyperparameters / algorithm choices presented as faits accomplis.
4. **Unsurfaced trade-offs** — "we use SAC" without naming the cost; "BMv2 throughput" without naming the gap to ASIC; "we drop malicious flows" without naming the false-positive cost.
5. **Unfound prior art** — work that solves the same problem and is not cited, often because the search terms used by the authors didn't intersect the venue's vocabulary.

## Workflow

### Phase 1 — Structural read

Read the paper sections in order. Score each against a checklist:

- **Argument coherence:** does intro → background → threat-model → design → related-work → eval → conclusion build a single thesis? Is each concept introduced before it is used?
- **Contribution discipline:** are 2–3 contributions stated? Each one survives the question "what does prior work do, and what specifically do you add"?
- **Scope honesty:** does every quantitative claim attach a scope qualifier on first mention (N=, single-seed, BMv2 vs hardware, in-distribution-only, closed-world)?
- **Threat model:** explicit adversary capabilities, defended attack classes (each tied to a detection mechanism), trust assumptions, and out-of-scope items with rationale?
- **Mitigation realism:** if the paper claims inline mitigation, does it discuss what gets dropped, the false-positive cost, rollback, and the operator-in-the-loop path?
- **Limitations:** dedicated subsection or paragraph at end of evaluation; enumerates BMv2 vs hardware, dataset bias, within-distribution-only, single-seed, closed-world. Each item honestly named, not a deflection.

For each failure, capture file:line and the exact wording so the author can act on it.

### Phase 2 — Claim audit via paperbridge

Identify the 5–10 most load-bearing quantitative or comparative claims in the paper. For each:

1. Locate the citing sentence and any citation it carries.
2. If the claim has no citation, decide whether it needs one (common-knowledge passes; specific numbers fail).
3. If the claim has a citation, fetch the cited paper's abstract via paperbridge:
   ```bash
   paperbridge papers resolve-doi --doi "<doi>"
   paperbridge papers search --q "<title>" --limit 3
   ```
4. Compare the citing sentence's scope to what the cited abstract supports. Flag overclaims (sentence asserts more than the abstract argues) and misattributions (cited paper doesn't address the claim).

This phase complements `citation-verify`: that skill audits every cite; this one audits *load-bearing claims* and is willing to flag uncited ones too.

### Phase 3 — Engineering-communication gap audit

For each major engineering choice in §Design, ask: "did the author tell me why?" Common gaps in security-paper drafts:

- **Algorithm choice without justification.** "We use SAC / PPO / Random Forest" with no comparison or rationale.
- **Header / packet / table sizes.** "23-byte header" / "8192-entry table" without saying why this size and not another.
- **Hyperparameter choices.** "Temperature 0.5" / "Threshold 0.7" / "Buffer 256" without saying what was tuned vs inherited vs guessed.
- **Hardware vs software target.** "1 Gbps on BMv2" without naming the gap to production ASIC.

For each gap, propose the one-paragraph rationale that would close it.

### Phase 4 — Implicit trade-off audit

Authors describe what they did. Reviewers ask what it costs. Common trade-offs that drafts hide:

- **Mitigation false-positive cost.** "We drop malicious flows" → cost: legitimate flows dropped; mitigation: rollback / TTL / human-in-the-loop.
- **Inline detection latency.** "Sub-5\,ms per packet" → cost: data-plane CPU/state budget; mitigation: bounded table sizes.
- **RL exploration cost.** "We use RL" → cost: cold-start exploration in production = false alarms during warmup.
- **Single-seed reporting.** "F1 = 1.0" → cost: no variance bound; reviewer can't tell if it's reproducible.
- **BMv2 measurement.** "1 Gbps throughput" → cost: software target; production ASIC numbers will differ.

For each trade-off the paper announces a benefit but does not surface the corresponding cost, flag it.

### Phase 5 — Unfound prior-art audit (paperbridge driven)

Authors search using the words they think describe their problem. Reviewers search using the words their venue uses. The intersection is often empty. For each major technical component (e.g., "cross-layer 5G IDS", "P4 5G UPF parsing", "RL-driven NIDS"):

1. Run a paperbridge search with the venue-vocabulary phrasing:
   ```bash
   paperbridge papers search --q "<venue-vocabulary phrasing>" --limit 5
   ```
2. Check the top results against the paper's bibliography. Flag any peer-reviewed work that:
   - Targets the same problem with a different mechanism, but isn't cited.
   - Was published at the target venue's conference series in the last 2 years and isn't cited.
   - Solves a strictly easier problem (e.g., per-packet inspection where you need cross-layer) — useful as a counter-example.

Surface the candidates as a shortlist; the author decides whether each candidate warrants a citation.

## What NOT to do

- Don't rewrite the paper. The skill produces *findings*, not edits.
- Don't soften the headline contribution. Many drafts already over-hedge; resist the urge to add more qualifiers when the existing ones are calibrated.
- Don't enforce a single section structure if the existing one works. If the paper has §Methodology not §Design, that's fine — review what's there.
- Don't flag minor typos or formatting. This skill is for substance.

## Output format

Single report, under 700 words. Structure:

```
# Review: <paper> (<venue> target)

**Verdict:** <accept | minor revision | major revision | weak>. <one-sentence summary>

### Structural read
- Argument coherence: <pass/fail with file:line>
- Contribution discipline: <each contribution audited>
- Scope honesty: <where qualifiers are missing or correct>
- Threat model: <adequacy>
- Mitigation realism: <if applicable>
- Limitations: <calibration>

### Claim audit (paperbridge)
- <load-bearing claim>: <citation status | overclaim risk>
- ...

### Engineering-communication gaps
- <design choice>: <rationale missing | rationale present>
- ...

### Implicit trade-offs
- <announced benefit> → <missing cost>
- ...

### Unfound prior art
- <candidate paper>: <relationship to your work>
- ...

### Single biggest pushback target
<the one thing the toughest PC member will zero in on>

### What NOT to change
<things already well-calibrated; resist the urge to over-revise>
```

Always include file:line references when calling out specific issues so the author can act on them directly.

## Honest failure modes

- **Paperbridge offline / Crossref rate-limited.** Phase 2 and Phase 5 degrade. Report this back rather than guessing.
- **Paper genuinely already addresses the gap.** Note it and move on — the review's job is to find real gaps, not invent ones.
- **Claim is supported by a paper you cannot access.** Flag as "unverified" rather than overclaim or underclaim. Let the author decide.

## Calibration data (this dissertation's accumulated patterns)

These overclaim and gap patterns recurred across paper-1, paper-2, and paper-3 drafts; check explicitly for each:

- **"50–100\,ms IDS latency" claims** without a published source. Soften to "tens of milliseconds" or cite a specific peer-reviewed measurement.
- **F1 = 1.0 hero numbers** on small N test splits, presented in the abstract before the per-variant breakdown. Lead with scope (N=, single-seed, in-distribution) before the number.
- **BMv2-vs-hardware framing slip.** "X Gbps throughput on BMv2" in the abstract without "(software target)" qualifier. Production ASIC numbers will differ.
- **Companion-paper cross-references.** When two papers from the same dissertation submit to the same venue concurrently, two cross-references in either paper read as a series identifier under double-blind. Reduce to zero or use anonymized "(under separate peer review)" framing.
- **Under-review companion-paper `\cite{}` keys with no bib entry.** Often takes the form `\cite{paper-N-name}` where the cited paper is the author's own under-review work. These render as `?` on PDF compile and bibtex flags them as missing entries — but if the missing-entry warning is ignored or the orphan cite was added recently, it can ship into a submission. Grep for `\cite{` keys that don't appear in the bib AND any prose containing internal author-system names (e.g., "DAF", "Sunago") that may identify under-review work even after the cite is removed. Anonymize fully or rephrase functionally.
- **Hallucinated bib metadata.** Correct titles, fabricated authors / DOIs / venues. Crossref-resolve every cited DOI before submission; this dissertation's `paper-merged.bib` had ~7 such entries discovered across audit passes.
- **Editorial annotations in `note` fields** of bib entries (accuracy figures, evaluation summaries). These leak from notes-files into the rendered bibliography and look unprofessional. Strip them.
- **RL-as-contribution overclaim.** Naming a standard RL algorithm (SAC, PPO) as a contribution. The contribution is the *coupling* (state representation, reward shaping, integration with telemetry), not the algorithm.

When reviewing future papers from this dissertation, run the calibration data list as a fast pre-check before the structural read.
