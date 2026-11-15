---
name: decision-records
description: "Propose and maintain architectural (ADR) and domain (DDR) decision records during exploration and design. Use for decision approval, supersession, retirement audits, post-merge repair, decision indexes, and glossary consistency."
argument-hint: "[propose | accept | supersede | audit | repair] [decision or path]"
license: MIT
---

# Decision records

## Start

1. Read the project's agent instructions and decision-records configuration, if
   present. Read the ADR and DDR indexes before opening individual records.
   Consult the configured glossary for terms used in the decision.
2. Select the requested operation below. For persistence or maintenance, read
   [the CLI contract](./references/cli.md) and run the bundled
   [script](./scripts/decision-records.mjs) with Node >=22.12.0. Resolve the
   script relative to this skill; pass the target project through `--root`.
3. Finish with the proposed decision or the exact changed paths and validation
   result. Distinguish documentation checks from application tests.

The package is self-contained: copy this directory into another project's
supported skills directory. Its scripts use only Node's standard library.
Copilot discovers this `SKILL.md`; other agent integrations need verification.

## Propose

During exploration or design, propose a record only when **all three** hold:

- **Reversal cost:** identify a concrete cost in code, data, contracts, or user
  expectations.
- **Surprise:** explain what would be surprising without the missing context.
- **Trade-off:** compare genuine alternatives and identify what is sacrificed.

If a criterion fails, keep the decision in the ordinary design/specification.
Use ADR for technical architecture and DDR for domain concepts and rules. Use
one primary type; split only decisions that can change independently.

Present the title, summary, context, decision, alternatives, consequences, and
the three justifications. Check existing records for overlap or contradiction.
Identify any predecessors and related records explicitly.
Use the [decision-record template](./templates/decision-record.md) for section
guidance; generate an editable copy with the CLI `template ADR` or `template
DDR` operation so its structure stays aligned with validation.

Persist a draft only when requested or authorized. Drafts are editable and
unnumbered. When a change proposal already exists, embed the draft there using
the documented `decision-record` block instead of maintaining a second copy.
Otherwise use `propose` to save a standalone draft. Completion: the user can
review the complete proposal and its eligibility, without an official record
having been created.

## Accept / supersede

1. Run the acceptance preview for the exact draft; present its content, planned
   predecessors, and SHA-256 approval fingerprint.
2. Obtain explicit approval of that content in this session, or inspect a
   verifiable reference to approval of exactly that content. A draft field,
   commit, silence, or generic approval is insufficient. Changed decisional
   content invalidates approval. An OpenSpec approval may cover both only when
   it explicitly includes the concrete decision content.
3. Hand the approved file, fingerprint, and approval reference to the **scribe**.
   The scribe executes `accept` or `supersede`, then `validate`; it decides
   neither content, classification, predecessors, nor glossary definitions.

Prefer a cheaper scribe model when the environment supports selection. Otherwise
the current agent performs the same restricted role; report that honestly.
The CLI checks fingerprints, not the identity or authority of an approver.
Record approval authorizes documentation, not implementation.

Official decisional content is immutable. A semantic correction needs a new
record. Status and inverse links are mechanically maintained with an audit
trail. Supersession supports multiple predecessors of the same type; changing
type requires explicitly approved retirement and a new related record instead.
Completion: numbered record, coherent relationships and indexes, successful
validation, and an approval reference.

## Audit

Start with `validate` and the indexes. Follow relevant records to source,
specifications, and glossary only as needed for the requested scope. Report
evidence-backed candidates: obsolete decisions, implementation drift, conflicts,
or terminology discrepancies. Code is evidence, not automatically the authority.
Age alone is not evidence of obsolescence.

For each candidate, recommend retaining, superseding, fixing the implementation,
or retiring. Present a retirement reason and preview fingerprint; execute
`retire` only after explicit approval of that exact intent. Retired and
superseded records stay at their existing paths and remain indexed.

Propose glossary additions or meaning changes separately for approval. A term
does not automatically deserve a DDR. Completion: findings with evidence and
only the specific approved retirements applied.

## Repair

Run `repair` without `--apply` first. Review its plan; apply only requested,
unambiguous index and inverse-link repairs. Duplicate IDs, missing targets,
cycles, altered immutable content, and ambiguous relationships are blockers:
report them rather than renumbering accepted records or choosing a winner.
Follow the CLI recovery instructions if an interrupted transaction is present.
Completion: either successful validation or explicit, actionable blockers.

## Adoption

Use the conventional paths unless the project already has conventions; obtain
approval before changing them. Do not retroactively manufacture historical
alternatives or approvals. An optional inventory of old decisions still passes
the same eligibility and approval gates. Keep unresolved decisions unresolved.
