import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { main } from '../scripts/decision-records.mjs';

const script = fileURLToPath(new URL('../scripts/decision-records.mjs', import.meta.url));

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'decision-records-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => main([...args, '--root', root]);
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const read = (path) => readFileSync(join(root, path), 'utf8');
  function draft(type = 'ADR', overrides = {}) {
    const name = overrides.name ?? `${type.toLowerCase()}-proposal.md`;
    let source = run('template', type)
      .replace('title: ""', `title: ${JSON.stringify(overrides.title ?? 'Preserve approved decisions')}`)
      .replace('summary: ""', `summary: ${JSON.stringify(overrides.summary ?? 'Keep a durable decision history.')}`)
      .replace(/<!-- REQUIRED: .*? -->/g, 'Concrete evidence demonstrating this requirement.');
    if (overrides.supersedes) source = source.replace('supersedes: []', `supersedes: ${JSON.stringify(overrides.supersedes)}`);
    if (overrides.related) source = source.replace('related: []', `related: ${JSON.stringify(overrides.related)}`);
    write(name, source);
    return name;
  }
  function accept(file, command = 'accept') {
    const preview = run(command, file);
    return run(command, file, '--apply', '--approved-sha256', preview.sha256, '--approval', 'User approved exact content in test');
  }
  return { root, run, write, read, draft, accept };
}

test('empty repository validates without creating artifacts; template stays incomplete', (t) => {
  const p = project(t);
  assert.deepEqual(p.run('validate'), { valid: true, records: 0 });
  assert.deepEqual(p.run('repair', '--apply'), { applied: false, changed: [], records: 0 });
  assert.deepEqual(readdirSync(p.root), []);
  p.write('incomplete.md', p.run('template', 'ADR'));
  assert.throws(() => p.run('accept', 'incomplete.md'), /title/);
  assert.deepEqual(Object.keys(p.run('config')), ['adr', 'ddr', 'drafts', 'state', 'glossary']);
});

test('draft persistence is unnumbered, canonical, unique and outside official indexes', (t) => {
  const p = project(t);
  const source = p.draft();
  const first = p.run('propose', source);
  const second = p.run('propose', source);
  assert.equal(first.applied, true);
  assert.notEqual(first.draft, second.draft);
  assert.match(first.draft, /^docs\/decisions\/drafts\/preserve-approved-decisions-[a-f0-9]{8}\.md$/);
  assert.equal(p.read(first.draft), p.read(source));
  assert.equal(existsSync(join(p.root, 'docs/decisions/state.json')), false);
  assert.equal(p.run('validate').records, 0);
});

test('accept requires exact approval; preview does not reserve a number or write records', (t) => {
  const p = project(t);
  const file = p.draft();
  const preview = p.run('accept', file);
  assert.equal(preview.applied, false);
  assert.equal(preview.id, 'ADR-0001');
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(p.root, 'docs')), false);
  assert.throws(() => p.run('accept', file, '--apply'), /approved-sha256/);
  assert.throws(() => p.run('accept', file, '--apply', '--approved-sha256', preview.sha256), /approval/);
  p.write(file, p.read(file).replace('Concrete evidence demonstrating this requirement.', 'Changed decision.'));
  assert.throws(() => p.run('accept', file, '--apply', '--approved-sha256', preview.sha256, '--approval', 'Old approval'), /stale/);
  assert.equal(existsSync(join(p.root, 'docs')), false);
  assert.equal(existsSync(join(p.root, '.decision-records.lock')), false);
});

test('accept preserves prose, generates receipts and both indexes; duplicate acceptance fails', (t) => {
  const p = project(t);
  const file = p.draft('ADR', { title: 'Choose A | B <contract>', summary: 'A & B | C' });
  const preview = p.run('accept', file);
  const result = p.accept(file);
  assert.equal(result.id, 'ADR-0001');
  const record = p.read('docs/decisions/adr/ADR-0001-choose-a-b-contract.md');
  assert.match(record, /# ADR-0001: Choose A \| B <contract>/);
  assert.ok(record.endsWith(p.read(file).split('---\n\n')[1]));
  assert.ok(record.includes(`content-sha256: "${preview.sha256}"`));
  assert.match(p.read('docs/decisions/adr/index.md'), /Choose A &#124; B &lt;contract>/);
  assert.match(p.read('docs/decisions/adr/index.md'), /A &amp; B &#124; C/);
  assert.match(p.read('docs/decisions/ddr/index.md'), /# DDR index/);
  assert.deepEqual(p.run('validate'), { valid: true, records: 1 });
  assert.throws(() => p.accept(file), /already accepted/);
  assert.equal(p.run('repair').changed.length, 0);
});

test('ADR and DDR counters are independent and retained high-water marks are never reused', (t) => {
  const p = project(t);
  assert.equal(p.accept(p.draft()).id, 'ADR-0001');
  assert.equal(p.accept(p.draft('DDR')).id, 'DDR-0001');
  const statePath = 'docs/decisions/state.json';
  const state = JSON.parse(p.read(statePath));
  state.counters.ADR = 9;
  p.write(statePath, JSON.stringify(state));
  assert.equal(p.accept(p.draft('ADR', { name: 'new.md', title: 'Another decision' })).id, 'ADR-0010');
  assert.equal(p.run('validate').records, 3);
});

test('multiple same-type predecessors are superseded in one coherent operation', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { name: 'second.md', title: 'Second decision' }));
  p.accept(p.draft('DDR'));
  const file = p.draft('ADR', {
    name: 'replacement.md', title: 'Replace both decisions',
    supersedes: ['ADR-0001', 'ADR-0002'], related: ['DDR-0001'],
  });
  const result = p.accept(file, 'supersede');
  assert.equal(result.id, 'ADR-0003');
  for (const name of ['ADR-0001-preserve-approved-decisions', 'ADR-0002-second-decision']) {
    const record = p.read(`docs/decisions/adr/${name}.md`);
    assert.match(record, /status: "superseded"/);
    assert.match(record, /superseded-by: \["ADR-0003"\]/);
  }
  assert.equal(p.run('validate').records, 4);
  assert.throws(() => p.run('supersede', p.draft('ADR', { name: 'no-predecessor.md', title: 'No predecessor' })), /requires at least/);
});

test('unknown, duplicate, self and cross-type references block acceptance', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('DDR'));
  assert.throws(() => p.run('accept', p.draft('ADR', { supersedes: ['DDR-0001'] })), /across record types/);
  assert.throws(() => p.run('accept', p.draft('ADR', { supersedes: ['ADR-0001', 'ADR-0001'] })), /duplicate/);
  assert.throws(() => p.run('accept', p.draft('ADR', { related: ['DDR-9999'] })), /Unknown relationship/);
  assert.throws(() => p.run('accept', p.draft('ADR', { related: ['ADR-0002'] })), /Unknown relationship/);
  for (const id of ['ADR-0000', 'ADR-00001', 'ADR-1', 'ADR-9007199254740992']) {
    assert.throws(() => p.run('accept', p.draft('ADR', { related: [id] })), /array of record IDs/);
  }
});

test('retirement binds exact current record and reason, leaves immutable prose and path intact', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  const before = p.read(path);
  const reason = 'The approved subsystem has been removed.';
  const preview = p.run('retire', 'ADR-0001', '--reason', reason);
  assert.equal(p.read(path), before);
  assert.throws(() => p.run('retire', 'ADR-0001', '--reason', 'Other reason', '--apply',
    '--approved-sha256', preview.sha256, '--approval', 'User'), /stale/);
  p.run('retire', 'ADR-0001', '--reason', reason, '--apply',
    '--approved-sha256', preview.sha256, '--approval', 'User approved retirement');
  const after = p.read(path);
  assert.match(after, /status: "retired"/);
  assert.equal(after.slice(after.indexOf('# ADR-0001:')), before.slice(before.indexOf('# ADR-0001:')));
  assert.match(p.read('docs/decisions/adr/index.md'), /\| retired \|/);
  assert.equal(p.run('validate').records, 1);
  assert.throws(() => p.run('retire', 'ADR-0001', '--reason', reason), /Only active/);
  assert.throws(() => p.run('accept', p.draft('ADR', { title: 'New', supersedes: ['ADR-0001'] })), /retired/);
});

test('superseded records cannot be retired', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { title: 'Successor', supersedes: ['ADR-0001'] }));
  assert.throws(() => p.run('retire', 'ADR-0001', '--reason', 'Old'), /Only active/);
});

test('embedded OpenSpec proposals avoid duplicate drafts and support explicit block selection', (t) => {
  const p = project(t);
  const a = p.read(p.draft());
  const b = p.read(p.draft('DDR'));
  const path = 'openspec/changes/example/proposal.md';
  const proposal = `# Existing change\n\n\`\`\`decision-record\n${a}\`\`\`\n\n\`\`\`decision-record\n${b}\`\`\`\n`;
  p.write(path, proposal);
  assert.throws(() => p.run('accept', path), /Multiple decision blocks/);
  const preview = p.run('accept', path, '--entry', '2');
  assert.equal(preview.id, 'DDR-0001');
  p.write(path, proposal.replace('Existing change', 'Unrelated proposal edit'));
  p.run('accept', path, '--entry', '2', '--apply', '--approved-sha256', preview.sha256, '--approval', 'Joint explicit approval');
  assert.equal(existsSync(join(p.root, 'docs/decisions/drafts')), false);
  assert.equal(p.run('validate').records, 1);
  assert.throws(() => p.run('accept', path, '--entry', '0'), /Invalid --entry/);
  assert.throws(() => p.run('accept', 'adr-proposal.md', '--entry', '1'), /requires a decision-record block/);
});

test('repair previews missing inverse links and status, then applies with an audit event', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { title: 'Successor', supersedes: ['ADR-0001'] }));
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  p.write(path, p.read(path).replace('status: "superseded"', 'status: "accepted"')
    .replace('superseded-by: ["ADR-0002"]', 'superseded-by: []'));
  const broken = p.read(path);
  assert.throws(() => p.run('validate'), /inconsistent inverse/);
  assert.throws(() => p.run('index', '--apply'), /inconsistent inverse/);
  const preview = p.run('repair');
  assert.deepEqual(preview.repaired, ['ADR-0001']);
  assert.equal(preview.applied, false);
  assert.equal(p.read(path), broken);
  const result = p.run('repair', '--apply');
  assert.equal(result.applied, true);
  assert.equal(p.run('validate').records, 2);
  assert.equal(JSON.parse(p.read('docs/decisions/state.json')).events.at(-1).operation, 'repair');
});

test('repair fills missing links on a predecessor already superseded by another successor', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { title: 'First successor', supersedes: ['ADR-0001'] }));
  p.accept(p.draft('ADR', { title: 'Second successor', supersedes: ['ADR-0001'] }));
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  p.write(path, p.read(path).replace('superseded-by: ["ADR-0002","ADR-0003"]', 'superseded-by: ["ADR-0002"]'));
  assert.deepEqual(p.run('repair').repaired, ['ADR-0001']);
  p.run('repair', '--apply');
  assert.equal(p.run('validate').records, 3);
});

test('stale indexes can be rebuilt without changing official content or receipts', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const before = p.read('docs/decisions/adr/ADR-0001-preserve-approved-decisions.md');
  const state = p.read('docs/decisions/state.json');
  p.write('docs/decisions/adr/index.md', 'stale');
  assert.throws(() => p.run('validate'), /Stale or missing index/);
  assert.deepEqual(p.run('index').changed, ['docs/decisions/adr/index.md']);
  assert.equal(p.read('docs/decisions/adr/index.md'), 'stale');
  p.run('index', '--apply');
  assert.equal(p.read('docs/decisions/adr/ADR-0001-preserve-approved-decisions.md'), before);
  assert.equal(p.read('docs/decisions/state.json'), state);
  assert.equal(p.run('validate').valid, true);
});

test('immutable content, outgoing relationships and receipts cannot be repaired away', (t) => {
  for (const change of [
    (source) => source.replace('Concrete evidence demonstrating this requirement.', 'Unapproved semantic edit.'),
    (source) => source.replace('summary: "Keep a durable decision history."', 'summary: "Different summary"'),
    (source) => source.replace('related: []', 'related: ["DDR-0001"]'),
    (source) => source.replace('approval: "User approved exact content in test"', 'approval: "Fabricated reference"'),
  ]) {
    const p = project(t);
    p.accept(p.draft());
    const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
    const edited = change(p.read(path));
    p.write(path, edited);
    assert.throws(() => p.run('repair', '--apply'), /immutable content|receipt differs/);
    assert.equal(p.read(path), edited);
  }
});

test('duplicates, absent state, missing records and lowered counters fail explicitly', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const record = p.read('docs/decisions/adr/ADR-0001-preserve-approved-decisions.md');
  p.write('docs/decisions/adr/copy.md', record);
  assert.throws(() => p.run('repair'), /Duplicate ID/);
  rmSync(join(p.root, 'docs/decisions/adr/copy.md'));
  const statePath = 'docs/decisions/state.json';
  const stateSource = p.read(statePath);
  rmSync(join(p.root, statePath));
  assert.throws(() => p.run('validate'), /without tracked state/);
  p.write(statePath, stateSource);
  const state = JSON.parse(stateSource);
  state.counters.ADR = 0;
  p.write(statePath, JSON.stringify(state));
  assert.throws(() => p.run('validate'), /high-water/);
  p.write(statePath, stateSource);
  rmSync(join(p.root, 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md'));
  assert.throws(() => p.run('repair'), /State\/record mismatch/);
});

test('unexpected inverse links and unsupported status changes block the whole repair', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { title: 'Unrelated decision' }));
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  const original = p.read(path);
  p.write(path, original.replace('superseded-by: []', 'superseded-by: ["ADR-0002"]'));
  assert.throws(() => p.run('repair', '--apply'), /unexpected inverse/);
  p.write(path, original.replace('status: "accepted"', 'status: "retired"'));
  assert.throws(() => p.run('repair', '--apply'), /inconsistent/);
});

test('repair diagnoses contradictory merged history with a supersession cycle', (t) => {
  const p = project(t);
  p.accept(p.draft());
  p.accept(p.draft('ADR', { title: 'Successor', supersedes: ['ADR-0001'] }));
  const modifiedDraft = p.draft('ADR', { supersedes: ['ADR-0002'] });
  const fingerprint = createHash('sha256').update(p.read(modifiedDraft)).digest('hex');
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  p.write(path, p.read(path).replace('supersedes: []', 'supersedes: ["ADR-0002"]')
    .replace(/content-sha256: "[a-f0-9]+"/, `content-sha256: "${fingerprint}"`));
  const statePath = 'docs/decisions/state.json';
  const state = JSON.parse(p.read(statePath));
  state.records['ADR-0001'].sha256 = fingerprint;
  p.write(statePath, JSON.stringify(state));
  assert.throws(() => p.run('repair', '--apply'), /Supersession cycle/);
});

test('malformed frontmatter and incomplete eligibility are rejected', (t) => {
  const p = project(t);
  const file = p.draft();
  const original = p.read(file);
  for (const source of [
    original.replace('type: "ADR"', 'type: ADR'),
    original.replace('type: "ADR"', 'type: "ADR"\ntype: "DDR"'),
    original.replace('type: "ADR"', 'type: "ADR"\nextra: "field"'),
    original.replace('type: "ADR"', 'type: "ADR"\nbody: "ignored"'),
    original.replace('## Context\n\nConcrete evidence demonstrating this requirement.', '## Context'),
    original.replace('Concrete evidence demonstrating this requirement.', '<!-- REQUIRED: fill this -->'),
    original.replace('### Surprise without context', '### Something else'),
  ]) {
    p.write(file, source);
    assert.throws(() => p.run('accept', file));
  }
});

test('configured paths are portable, normalized, and honored for records, drafts and state', (t) => {
  const p = project(t);
  p.write('decision-records.config.json', JSON.stringify({
    adr: './decisions/technical', ddr: 'decisions/domain',
    drafts: 'proposals/decisions', state: 'decisions/registry.json', glossary: 'GLOSSARY.md',
  }));
  const source = p.draft();
  const saved = p.run('propose', source);
  assert.match(saved.draft, /^proposals\/decisions\//);
  p.accept(source);
  assert.equal(existsSync(join(p.root, 'decisions/technical/ADR-0001-preserve-approved-decisions.md')), true);
  assert.equal(existsSync(join(p.root, 'decisions/registry.json')), true);
  assert.equal(p.run('validate').records, 1);
});

test('invalid configuration and unsafe paths are errors, never silent defaults', (t) => {
  const p = project(t);
  for (const config of [
    '{invalid', '[]', '{"unknown":"value"}', '{"constructor":"bad"}',
    '{"adr":"../outside"}', '{"adr":"/tmp/outside"}', '{"adr":"."}',
    '{"adr":"same","ddr":"same/child"}', '{"state":"docs/decisions/adr/state.json"}',
    '{"glossary":"decision-records.config.json"}', '{"drafts":null}',
  ]) {
    p.write('decision-records.config.json', config);
    assert.throws(() => p.run('validate'));
  }
});

test('symbolic link and dangling symbolic link outputs are rejected', (t) => {
  const p = project(t);
  p.draft();
  mkdirSync(join(p.root, 'real'));
  symlinkSync(join(p.root, 'real'), join(p.root, 'docs'));
  assert.throws(() => p.run('accept', 'adr-proposal.md'), /Symbolic link/);
  rmSync(join(p.root, 'docs'));
  symlinkSync(join(p.root, 'absent'), join(p.root, 'docs'));
  assert.throws(() => p.run('accept', 'adr-proposal.md'), /Symbolic link/);
});

test('concurrent writer locks are explicit and never stolen', (t) => {
  const p = project(t);
  p.write('.decision-records.lock', JSON.stringify({ pid: process.pid }));
  assert.throws(() => p.run('validate'), /lock exists/);
  assert.equal(JSON.parse(p.read('.decision-records.lock')).pid, process.pid);
});

test('interrupted transactions block normal work and can be previewed then rolled back', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const old = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  const created = 'docs/decisions/adr/ADR-0002.md';
  const before = p.read(old);
  p.write(old, 'new content');
  p.write(created, 'created');
  p.write('.decision-records.pending.json', JSON.stringify({ version: 1, entries: [
    { path: old, before, after: 'new content' },
    { path: created, before: null, after: 'created' },
    { path: 'docs/decisions/state.json', before: p.read('docs/decisions/state.json'), after: 'not yet written' },
  ] }));
  assert.throws(() => p.run('validate'), /Interrupted transaction/);
  assert.equal(p.run('recover').applied, false);
  assert.equal(p.read(old), 'new content');
  assert.equal(p.run('recover', '--apply').applied, true);
  assert.equal(p.read(old), before);
  assert.equal(existsSync(join(p.root, created)), false);
  assert.equal(existsSync(join(p.root, '.decision-records.pending.json')), false);
  assert.equal(p.run('validate').valid, true);
});

test('recovery refuses divergent edits and unsafe or duplicate journal targets', (t) => {
  const p = project(t);
  const edited = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  p.write(edited, 'independent user work');
  const journal = (entries) => p.write('.decision-records.pending.json', JSON.stringify({ version: 1, entries }));
  journal([{ path: edited, before: 'old', after: 'new' }]);
  assert.throws(() => p.run('recover', '--apply'), /divergent edits/);
  assert.equal(p.read(edited), 'independent user work');
  for (const path of ['../outside.md', '.decision-records.lock', './.decision-records.lock', 'decision-records.config.json', 'unrelated.md']) {
    journal([{ path, before: null, after: 'new' }]);
    assert.throws(() => p.run('recover', '--apply'));
  }
  journal([{ path: 'docs/decisions/state.json', before: null, after: 'new' }, { path: 'docs/decisions/state.json', before: null, after: 'new' }]);
  assert.throws(() => p.run('recover', '--apply'), /Duplicate recovery/);
});

test('ordinary write failure rolls back records, counters and indexes', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const file = p.draft('ADR', { title: 'New decision' });
  const beforeState = p.read('docs/decisions/state.json');
  const beforeIndex = p.read('docs/decisions/adr/index.md');
  const rename = fs.renameSync;
  let injected = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!injected && to === join(p.root, 'docs/decisions/adr/index.md')) {
      injected = true;
      assert.equal(existsSync(join(p.root, 'docs/decisions/adr/ADR-0002-new-decision.md')), true);
      assert.equal(JSON.parse(p.read('docs/decisions/state.json')).counters.ADR, 2);
      throw new Error('Injected failure after record and state writes');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => p.accept(file), /Injected failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(p.read('docs/decisions/state.json'), beforeState);
  assert.equal(p.read('docs/decisions/adr/index.md'), beforeIndex);
  assert.equal(existsSync(join(p.root, 'docs/decisions/adr/ADR-0002-new-decision.md')), false);
  assert.equal(existsSync(join(p.root, '.decision-records.pending.json')), false);
  assert.equal(p.run('validate').valid, true);
  assert.equal(p.accept(file).id, 'ADR-0002');
});

test('rollback failure preserves a recoverable journal and reports both errors', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const file = p.draft('ADR', { title: 'New decision' });
  const beforeState = p.read('docs/decisions/state.json');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(p.root, 'docs/decisions/adr/index.md')) throw new Error('Injected write failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => p.accept(file), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /rollback failed/);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(join(p.root, '.decision-records.pending.json')), true);
  assert.throws(() => p.run('validate'), /Interrupted transaction/);
  p.run('recover', '--apply');
  assert.equal(p.read('docs/decisions/state.json'), beforeState);
  assert.equal(p.run('validate').records, 1);
});

test('record receipts, dates and canonical filenames are validated', (t) => {
  const p = project(t);
  p.accept(p.draft());
  const path = 'docs/decisions/adr/ADR-0001-preserve-approved-decisions.md';
  const original = p.read(path);
  for (const source of [
    original.replace(/date: "[^"]+"/, 'date: "2026-02-30"'),
    original.replace('retirement-reason: ""', 'retirement-reason: "Unapproved withdrawal"'),
    original.replace('status: "accepted"', 'status: "unknown"'),
    original.replace('id: "ADR-0001"', 'id: "ADR-00001"'),
    original.replace('# ADR-0001:', '# DDR-0001:'),
  ]) {
    p.write(path, source);
    assert.throws(() => p.run('validate'));
  }
  p.write(path, original);
  rmSync(join(p.root, path));
  p.write('docs/decisions/adr/renamed.md', original);
  assert.throws(() => p.run('repair', '--apply'), /record filename must be docs\/decisions\/adr\/ADR-0001-preserve-approved-decisions\.md/);
});

test('CLI success returns JSON previews and validates persisted records end to end', (t) => {
  const p = project(t);
  const file = p.draft();
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args, '--root', p.root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const preview = cli('accept', file);
  assert.equal(preview.applied, false);
  const accepted = cli('accept', file, '--apply', '--approved-sha256', preview.sha256, '--approval', 'Reviewed CLI payload');
  assert.equal(accepted.applied, true);
  assert.equal(accepted.id, 'ADR-0001');
  assert.deepEqual(cli('validate'), { valid: true, records: 1 });
});

test('portable skill metadata, bundled references and license are present', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /^---\nname: decision-records\n/);
  const description = /^description: (.+)$/m.exec(skill);
  assert.ok(description);
  const content = JSON.parse(description[1]);
  assert.ok(content.length > 0 && content.length <= 1024);
  assert.ok(skill.split('\n').length < 500);
  for (const match of skill.matchAll(/\]\((\.\/[^)]+)\)/g)) {
    assert.equal(existsSync(new URL(`../${match[1].slice(2)}`, import.meta.url)), true);
  }
  assert.match(readFileSync(new URL('../LICENSE.txt', import.meta.url), 'utf8'), /^MIT License/);
});

test('ADR and DDR templates share validated structure and explain each required section', (t) => {
  const p = project(t);
  const adr = p.run('template', 'ADR');
  const ddr = p.run('template', 'DDR');
  const template = readFileSync(new URL('../templates/decision-record.md', import.meta.url), 'utf8');
  for (const [type, generated] of [['ADR', adr], ['DDR', ddr]]) {
    assert.match(generated, new RegExp(`type: "${type}"`));
    assert.match(generated, /Describe the situation and problem/);
    assert.match(generated, /State the chosen option precisely/);
    assert.match(generated, /Compare credible alternatives/);
    assert.match(generated, /Describe expected benefits, costs, risks/);
    assert.match(generated, /Give concrete evidence that reversing this decision is costly/);
    assert.match(generated, /Explain what a future reader or contributor would reasonably find surprising/);
    assert.match(generated, /Name the competing values or outcomes/);
  }
  assert.deepEqual(
    [...adr.matchAll(/^#{1,3} .*$/gm)].map((match) => match[0]),
    [...template.matchAll(/^#{1,3} .*$/gm)].map((match) => match[0]),
  );
  const draft = p.draft('DDR');
  assert.equal(p.run('accept', draft).id, 'DDR-0001');
});

test('CLI reports errors on stderr with nonzero exit; help and options are explicit', (t) => {
  const p = project(t);
  const result = spawnSync(process.execPath, [script, 'unknown', '--root', p.root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command/);
  assert.match(p.run('help'), /Preview before --apply/);
  assert.throws(() => p.run('validate', '--approval', 'ignored'), /Unsupported option/);
  assert.throws(() => p.run('accept'), /missing arguments/);
  assert.throws(() => p.run('template', 'OTHER'), /ADR or DDR/);
  assert.throws(() => p.run('index', '--apply', '--apply'), /Duplicate option/);
  assert.throws(() => p.run('index', '--unknown'), /Unknown option/);
});

test('record and draft filenames use the normalized title', (t) => {
  const p = project(t);
  const title = 'Usar Ñandú, café & I/O: límites del módulo; con un título muy largo que supera el máximo permitido';
  const file = p.draft('DDR', { title });
  assert.match(p.run('propose', file).draft,
    /^docs\/decisions\/drafts\/usar-nandu-cafe-i-o-limites-del-modulo-con-un-titulo-muy-[a-f0-9]{8}\.md$/);
  const result = p.accept(file);
  const path = 'docs/decisions/ddr/DDR-0001-usar-nandu-cafe-i-o-limites-del-modulo-con-un-titulo-muy.md';
  assert.equal(result.path, path);
  assert.equal(existsSync(join(p.root, path)), true);
  assert.match(p.read('docs/decisions/ddr/index.md'),
    /\[DDR-0001\]\(DDR-0001-usar-nandu-cafe-i-o-limites-del-modulo-con-un-titulo-muy\.md\)/);
  assert.equal(p.run('validate').valid, true);
});
