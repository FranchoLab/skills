# francho-decision-records

Propose and maintain architectural (ADR) and domain (DDR) decision records.

## What this plugin does

- Evaluates decisions against reversal cost, surprise without context, and a
  genuine trade-off before proposing a record.
- Keeps editable, unnumbered drafts separate from approved records.
- Requires explicit approval of exact content before acceptance or retirement.
- Generates sequence numbers, indexes, and inverse supersession links
  deterministically.
- Validates immutable content, approvals, relationships, and merge integrity.
- Provides a shared explanatory template for ADRs and DDRs.

## Skill

- `decision-records`: propose, accept, supersede, audit, and repair decision
  records without deciding or approving on the user's behalf.

## Usage

- Keep the plugin enabled in your Copilot setup.
- Invoke `/decision-records` during exploration, for example:
  "propose an ADR for the storage decision" or "audit the decision indexes".
- Use the bundled Node CLI for deterministic operations; see
  `skills/decision-records/references/cli.md` for commands and recovery.
- The CLI requires Node >=22.12.0 and uses only the standard library.

## Version

- 0.2.0
