# CLI contract

Run from the target project's root (or pass `--root /absolute/project`):

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs help
node --test .agents/skills/decision-records/tests/decision-records.test.mjs
```

Requires Node >=22.12.0; no package installation. The tested runtime is reported
in the repository's verification results, not inferred from the minimum.
Copy the whole skill directory, including its `LICENSE.txt`, to reuse it.
No APM dependency or machine-wide configuration is changed.

## Configuration

An optional `decision-records.config.json` at the project root accepts only
these keys; the following values are the defaults:

```json
{
  "adr": "docs/decisions/adr",
  "ddr": "docs/decisions/ddr",
  "drafts": "docs/decisions/drafts",
  "state": "docs/decisions/state.json",
  "glossary": "docs/GLOSSARY.md"
}
```

Paths must be relative to and contained in the project, without symbolic links.
Record directories must be distinct and non-overlapping. State and glossary
must be outside the record/draft directories and distinct from each other.
Missing configuration uses defaults; malformed or unknown settings are errors.
The CLI reports the resolved glossary path through `config`; the agent reads
it if present, or reports its absence rather than inventing terminology.

Keep the state file in version control: it holds high-water counters, immutable
content fingerprints, approval receipts, and maintenance events. Removing a
record or its state is a validation failure, not permission to reuse its number.
There is no automatic import of pre-existing records.

## Drafts

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs template ADR
```

The output is generated from the bundled
[decision-record template](../templates/decision-record.md), which explains
what evidence and content belongs in each section. Pass `DDR` for a domain
decision. Fill every field and section before using `propose` or `accept`.
Frontmatter is a deliberately
restricted YAML subset: each value is a JSON string or array on one line;
unknown keys, duplicate keys, and ordinary YAML extensions are rejected.
Section headings and order are fixed; use H4 or deeper headings inside sections.
Write content in English.

After authorization to persist, save a completed draft using:

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs propose /tmp/reviewed-draft.md
```

This assigns a readable provisional filename, the normalized title plus a
random 8-character suffix, in the configured drafts directory,
not an official number. It never overwrites an existing draft. Draft editing is
ordinary file editing; rejected drafts remain unofficial and can be removed
when the user requests it.

Alternatively embed the entire draft, including frontmatter, in an existing
proposal inside a fenced block:

````markdown
```decision-record
---
type: "ADR"
...remaining draft frontmatter and body...
```
````

The opening fence is exactly three backticks followed by `decision-record`.
The closing fence is a line containing three backticks. Use `--entry 1`,
`--entry 2`, etc. for multiple decision blocks in one proposal. With exactly
one block the selector is optional. Only the selected draft is fingerprinted,
so unrelated proposal edits do not invalidate its approval.

## Acceptance and supersession

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs accept path/to/draft.md
node .agents/skills/decision-records/scripts/decision-records.mjs accept path/to/draft.md \
  --approved-sha256 HASH_FROM_REVIEW \
  --approval "Explicit user approval in session X, message Y" --apply
```

The preview reports the exact normalized draft, fingerprint, prospective ID,
and affected predecessors. The number is provisional until the write lock is
held. Approval binds the proposed content and relationships, not the eventual
number or date. JSON output uses `applied: false` for a plan and `applied: true`
only after successful writes. Errors go to stderr with nonzero exit status.

IDs are `ADR-0001` / `DDR-0001`, with independent monotonic sequences and no
reuse. Filenames are `ID-normalized-title.md`: the title is lowercased,
stripped of accents, reduced to `a-z`, `0-9`, and hyphens, and capped at 60
characters on a word boundary. Titles are immutable, so filenames are stable.
Records created by 0.1.x as `ID.md` fail validation with the expected name;
rename them with `git mv`, then run `index --apply` and `validate`. Official files include
acceptance date, status, content fingerprint and approval reference, followed
by the approved body. The script generates H1 and frontmatter; the scribe does
not rewrite the approved prose. Drafts remain available as proposals and are
not official merely because their content was accepted; accepting the same
content twice is an error.

To supersede, set the draft's `supersedes` array to same-type predecessor IDs
and use `supersede` with the same options. `accept` also handles this array.
Predecessors must exist and not be retired. Each successor points back through
`supersedes`; each predecessor points forward through `superseded-by`.
`related` contains existing IDs of either type and has no automatic inverse.
All relationships are explicitly selected before approval.

The fingerprint protects decisional content and outgoing relationships.
The tracked state also protects acceptance receipts. Validation detects
accidental edits; neither hashes nor a locally editable state file provide
cryptographic proof of human authorization. Use version-control review for
that trust boundary.

## Retirement

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs retire ADR-0001 \
  --reason "The subsystem was removed; see approved change X."
node .agents/skills/decision-records/scripts/decision-records.mjs retire ADR-0001 \
  --reason "The subsystem was removed; see approved change X." \
  --approved-sha256 HASH_FROM_REVIEW --approval "Approval reference" --apply
```

Only active (`accepted`) records can be retired. Superseded records already
have a successor; audit the active successor instead. The preview fingerprint
binds the ID, exact current record, and reason. Retirement records the reason
and approval in state and frontmatter; the file stays in place. There is no
automatic expiry or delete operation.

## Validation and repair

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs config
node .agents/skills/decision-records/scripts/decision-records.mjs validate
node .agents/skills/decision-records/scripts/decision-records.mjs index
node .agents/skills/decision-records/scripts/decision-records.mjs index --apply
node .agents/skills/decision-records/scripts/decision-records.mjs repair
node .agents/skills/decision-records/scripts/decision-records.mjs repair --apply
```

`validate` checks schema, content fingerprints, receipts, IDs, counters,
relationships, cycles, statuses, and exact generated indexes. An untouched
project with no records/state is valid and produces no directories.
`index` only rebuilds indexes and requires sound records.
`repair` additionally fills missing inverse supersession links and their
unambiguous status changes. It never removes unexpected links or rewrites
immutable content. All other record inconsistencies block the entire operation.
Indexes include every official status with ID, title, status, and summary.
Mechanical inverse-link repairs are recorded in state.

### Interrupted operations and concurrent writers

Mutations use an exclusive root `.decision-records.lock` and a write-ahead
`.decision-records.pending.json` journal. Every changed file is staged as a
whole-file atomic rename. Normal failures restore prior contents; abrupt
interruption leaves a journal and blocks subsequent reads/writes. This is
recoverable multi-file consistency, not simultaneous visibility to arbitrary
external readers. Do not edit records while a transaction is running.

```sh
node .agents/skills/decision-records/scripts/decision-records.mjs recover
node .agents/skills/decision-records/scripts/decision-records.mjs recover --apply
```

Recovery previews, then restores the previous file set, provided every current
file still matches either its old or intended new contents. Divergent edits
block recovery instead of being overwritten. A lock contains the owning PID:
after a crash, verify that process has exited before manually removing that
specific stale lock file. The CLI never steals locks. Ignore only these two
root transient files in Git; keep state and official records tracked.

Resolve duplicate IDs or conflicting state merges with human review and Git
history before retrying. Accepted IDs are never automatically renumbered.
The CLI does not recover lost provenance by accepting edited hashes.
