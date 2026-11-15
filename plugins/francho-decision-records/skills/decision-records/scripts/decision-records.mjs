#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaults = {
  adr: 'docs/decisions/adr',
  ddr: 'docs/decisions/ddr',
  drafts: 'docs/decisions/drafts',
  state: 'docs/decisions/state.json',
  glossary: 'docs/GLOSSARY.md',
};
const draftKeys = ['type', 'title', 'summary', 'supersedes', 'related'];
const recordKeys = [
  ...draftKeys, 'id', 'date', 'status', 'superseded-by', 'approval',
  'content-sha256', 'retirement-reason', 'retirement-approval',
];
const templatePath = resolve(dirname(dirname(fileURLToPath(import.meta.url))), 'templates/decision-record.md');
const idPattern = /^(ADR|DDR)-(\d{4,})$/;
const hashPattern = /^[a-f0-9]{64}$/;
const validId = (id) => {
  if (typeof id !== 'string') return false;
  const match = idPattern.exec(id);
  if (!match) return false;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 && String(number).padStart(4, '0') === match[2];
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : null;
const today = () => new Date().toISOString().slice(0, 10);

function keys(value, expected, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  check(same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected or missing fields`);
}

function ids(value, label) {
  check(Array.isArray(value) && value.every(validId),
    `${label}: expected an array of record IDs`);
  check(new Set(value).size === value.length, `${label}: duplicate relationships`);
}

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    check(['root', 'entry', 'approval', 'approved-sha256', 'reason', 'apply'].includes(key),
      `Unknown option: ${arg}`);
    check(!(key in options), `Duplicate option: ${arg}`);
    if (key === 'apply') options[key] = true;
    else {
      check(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value: ${arg}`);
      options[key] = args[++i];
    }
  }
  return { options, positional };
}

function safePath(root, path) {
  check(text(path) && !isAbsolute(path), `Expected a project-relative path: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  check(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `Path escapes project or names its root: ${path}`);
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info) check(!info.isSymbolicLink(), `Symbolic link is not supported: ${current}`);
  }
  return absolute;
}

function configuration(root) {
  const file = safePath(root, 'decision-records.config.json');
  const source = read(file);
  const overrides = source === null ? {} : JSON.parse(source);
  check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'Configuration must be an object');
  check(Object.keys(overrides).every((key) => Object.hasOwn(defaults, key)), 'Unknown configuration key');
  const result = { ...defaults, ...overrides };
  for (const key of Object.keys(result)) result[key] = relative(root, safePath(root, result[key]));
  const paths = Object.values(result).map((path) => safePath(root, path));
  const overlaps = (a, b) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      check(!overlaps(paths[i], paths[j]), 'Configured paths must be distinct and non-overlapping');
    }
    for (const reserved of ['decision-records.config.json', '.decision-records.lock', '.decision-records.pending.json']) {
      check(!overlaps(paths[i], safePath(root, reserved)), `Configuration overlaps reserved path: ${reserved}`);
    }
  }
  return result;
}

function splitDocument(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  check(match, 'Expected restricted frontmatter delimited by ---');
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z][a-z0-9-]*): (.+)$/.exec(line);
    check(field, `Invalid frontmatter line: ${line}`);
    check(!Object.hasOwn(metadata, field[1]), `Duplicate frontmatter field: ${field[1]}`);
    metadata[field[1]] = JSON.parse(field[2]);
  }
  return { metadata, body: match[2].trim() };
}

const templateSource = readFileSync(templatePath, 'utf8');
const parsedTemplate = splitDocument(templateSource);
keys(parsedTemplate.metadata, draftKeys, 'Bundled decision-record template');
const sections = [...parsedTemplate.body.matchAll(/^#{1,3} .*$/gm)].map((match) => match[0]);
check(sections.length >= 5 && sections.includes('## Eligibility'),
  'Bundled decision-record template must define the required sections');

function validateDraft(draft) {
  keys(draft, [...draftKeys, 'body'], 'Draft');
  check(['ADR', 'DDR'].includes(draft.type), 'Draft type must be ADR or DDR');
  for (const field of ['title', 'summary']) {
    check(text(draft[field]) && !/[\r\n]/.test(draft[field]) && draft[field] === draft[field].trim(),
      `Draft ${field} must be a nonempty, trimmed single line`);
  }
  ids(draft.supersedes, 'supersedes');
  ids(draft.related, 'related');
  check(draft.supersedes.every((id) => id.startsWith(`${draft.type}-`)),
    'Supersession across record types is not supported');
  check(typeof draft.body === 'string', 'Draft body must be text');
  const headings = [...draft.body.matchAll(/^#{1,3} .*$/gm)];
  check(same(headings.map((match) => match[0]), sections), `Required headings, in order: ${sections.join(', ')}`);
  for (let i = 0; i < sections.length; i++) {
    if (sections[i] === '## Eligibility') continue;
    const start = headings[i].index + sections[i].length;
    const end = i + 1 < sections.length ? headings[i + 1].index : draft.body.length;
    check(text(draft.body.slice(start, end)), `Empty section: ${sections[i]}`);
  }
  check(!/<!--\s*REQUIRED\b/.test(draft.body), 'Replace all REQUIRED template placeholders');
  return draft;
}

function document(metadata, body) {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body.trim()}\n`;
}

function draftDocument(draft) {
  return document(Object.fromEntries(draftKeys.map((key) => [key, draft[key]])), draft.body);
}

function draftFromSource(file, entry) {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...source.matchAll(/^```decision-record\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1]);
  let content = source;
  if (blocks.length) {
    check(entry !== undefined || blocks.length === 1, 'Multiple decision blocks: select --entry N');
    const number = entry === undefined ? 1 : Number(entry);
    check(Number.isInteger(number) && number >= 1 && number <= blocks.length, 'Invalid --entry');
    content = blocks[number - 1];
  } else check(entry === undefined, '--entry requires a decision-record block');
  const { metadata, body } = splitDocument(content);
  keys(metadata, draftKeys, 'Draft frontmatter');
  return validateDraft({ ...metadata, body });
}

function template(type) {
  check(['ADR', 'DDR'].includes(type), 'template requires ADR or DDR');
  return draftDocument({ ...parsedTemplate.metadata, type, body: parsedTemplate.body });
}

function parseRecord(source, path) {
  const { metadata: meta, body } = splitDocument(source);
  keys(meta, recordKeys, path);
  check(validId(meta.id), `${path}: invalid ID`);
  check(meta.id.startsWith(`${meta.type}-`), `${path}: type and ID mismatch`);
  check(body.startsWith(`# ${meta.id}: ${meta.title}\n\n`), `${path}: invalid record H1`);
  const draft = validateDraft({
    ...Object.fromEntries(draftKeys.map((key) => [key, meta[key]])),
    body: body.slice(body.indexOf('\n\n') + 2),
  });
  check(['accepted', 'superseded', 'retired'].includes(meta.status), `${path}: invalid status`);
  check(typeof meta.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.date)
    && !Number.isNaN(Date.parse(meta.date)) && new Date(meta.date).toISOString().slice(0, 10) === meta.date,
  `${path}: invalid acceptance date`);
  check(text(meta.approval), `${path}: missing approval reference`);
  check(hashPattern.test(meta['content-sha256']), `${path}: invalid fingerprint`);
  ids(meta['superseded-by'], `${path}: superseded-by`);
  check(typeof meta['retirement-reason'] === 'string' && typeof meta['retirement-approval'] === 'string',
    `${path}: invalid retirement receipt`);
  check(meta['content-sha256'] === hash(draftDocument(draft)), `${path}: immutable content was changed`);
  return { meta, draft, path, source };
}

function renderRecord(record) {
  return document(record.meta, `# ${record.meta.id}: ${record.meta.title}\n\n${record.draft.body}`);
}

function emptyState() {
  return { version: 1, counters: { ADR: 0, DDR: 0 }, records: {}, events: [] };
}

function load(root, config) {
  const records = new Map();
  for (const type of ['ADR', 'DDR']) {
    const folder = safePath(root, config[type.toLowerCase()]);
    if (!existsSync(folder)) continue;
    check(lstatSync(folder).isDirectory(), `Expected directory: ${folder}`);
    for (const file of readdirSync(folder).sort()) {
      if (file === 'index.md') continue;
      check(file.endsWith('.md'), `Unexpected entry in record directory: ${file}`);
      const path = relative(root, safePath(root, `${config[type.toLowerCase()]}/${file}`));
      const record = parseRecord(readFileSync(safePath(root, path), 'utf8'), path);
      check(record.meta.type === type, `${path}: wrong record directory`);
      check(!records.has(record.meta.id), `Duplicate ID: ${record.meta.id}`);
      records.set(record.meta.id, record);
    }
  }
  for (const record of records.values()) {
    check(record.path === `${config[record.meta.type.toLowerCase()]}/${record.meta.id}.md`,
      `${record.path}: record must keep its canonical ID filename`);
  }
  const source = read(safePath(root, config.state));
  check(source !== null || records.size === 0, 'Records exist without tracked state; restore state from version control');
  const state = source === null ? emptyState() : JSON.parse(source);
  keys(state, ['version', 'counters', 'records', 'events'], 'State');
  check(state.version === 1, 'Unsupported state version');
  keys(state.counters, ['ADR', 'DDR'], 'Counters');
  check(state.records && typeof state.records === 'object' && !Array.isArray(state.records), 'Invalid state records');
  check(Array.isArray(state.events), 'Invalid state events');
  for (const type of ['ADR', 'DDR']) {
    const number = state.counters[type];
    check(Number.isSafeInteger(number) && number >= 0, `Invalid ${type} counter`);
    const maximum = Math.max(0, ...[...records.keys()].filter((id) => id.startsWith(type)).map((id) => Number(id.split('-')[1])));
    check(number >= maximum, `${type} high-water counter is behind existing records`);
  }
  check(same(Object.keys(state.records).sort(), [...records.keys()].sort()),
    'State/record mismatch: restore missing records or resolve the state merge');
  for (const [id, record] of records) {
    const receipt = state.records[id];
    keys(receipt, ['sha256', 'date', 'approval', 'retirement'], `${id} state receipt`);
    check(receipt.sha256 === record.meta['content-sha256']
      && receipt.date === record.meta.date && receipt.approval === record.meta.approval,
    `${id}: acceptance receipt differs from tracked state`);
    if (receipt.retirement !== null) {
      keys(receipt.retirement, ['reason', 'approval'], `${id} retirement receipt`);
      check(text(receipt.retirement.reason) && text(receipt.retirement.approval), `${id}: empty retirement receipt`);
    }
  }
  return { records, state, stateExists: source !== null };
}

function relationships(model, repair = false) {
  const { records, state } = model;
  const inverse = new Map([...records.keys()].map((id) => [id, []]));
  for (const [id, record] of records) {
    for (const target of [...record.meta.supersedes, ...record.meta.related, ...record.meta['superseded-by']]) {
      check(target !== id && records.has(target), `${id}: missing or self-referencing target ${target}`);
    }
    for (const target of record.meta.supersedes) inverse.get(target).push(id);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    check(!visiting.has(id), `Supersession cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of records.get(id).meta.supersedes) visit(target);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of records.keys()) visit(id);
  const changed = [];
  for (const [id, record] of records) {
    const expected = inverse.get(id).sort();
    const current = [...record.meta['superseded-by']].sort();
    check(current.every((target) => expected.includes(target)), `${id}: unexpected inverse relationship`);
    const retirement = state.records[id].retirement;
    const status = retirement ? 'retired' : expected.length ? 'superseded' : 'accepted';
    check(!retirement || expected.length === 0, `${id}: retired record has successors`);
    check(record.meta['retirement-reason'] === (retirement?.reason ?? '')
      && record.meta['retirement-approval'] === (retirement?.approval ?? ''),
    `${id}: retirement receipt differs from state`);
    if (!same(current, expected) || record.meta.status !== status) {
      check(repair && !retirement && (
        record.meta.status === 'accepted' && expected.length > 0
        || record.meta.status === 'superseded' && expected.length > current.length),
      `${id}: inconsistent inverse links or status; use repair for missing inverse links`);
      record.meta['superseded-by'] = expected;
      record.meta.status = status;
      changed.push(id);
    }
  }
  return changed;
}

function indexFiles(model, config) {
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' ');
  const result = new Map();
  for (const type of ['ADR', 'DDR']) {
    const records = [...model.records.values()].filter((record) => record.meta.type === type)
      .sort((a, b) => Number(a.meta.id.split('-')[1]) - Number(b.meta.id.split('-')[1]));
    const rows = records.map(({ meta }) =>
      `| [${meta.id}](${meta.id}.md) | ${escape(meta.title)} | ${meta.status} | ${escape(meta.summary)} |`);
    result.set(`${config[type.toLowerCase()]}/index.md`,
      `# ${type} index\n\nGenerated by decision-records; edit records through the workflow.\n\n| ID | Title | Status | Summary |\n| --- | --- | --- | --- |\n${rows.length ? `${rows.join('\n')}\n` : ''}`);
  }
  return result;
}

function validateIndexes(root, model, config) {
  if (!model.stateExists && model.records.size === 0) return;
  for (const [path, content] of indexFiles(model, config)) {
    check(read(safePath(root, path)) === content, `Stale or missing index: ${path}; run index`);
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function restore(root, entries, field) {
  for (const entry of entries) {
    const path = safePath(root, entry.path);
    if (entry[field] === null) {
      if (existsSync(path)) unlinkSync(path);
    } else atomicWrite(path, entry[field]);
  }
}

function transaction(root, changes) {
  const entries = [...changes].map(([path, after]) => ({
    path, before: read(safePath(root, path)), after,
  })).filter((entry) => entry.before !== entry.after);
  if (!entries.length) return [];
  const journal = safePath(root, '.decision-records.pending.json');
  writeFileSync(journal, json({ version: 1, entries }), { flag: 'wx' });
  try {
    restore(root, entries, 'after');
  } catch (error) {
    try { restore(root, entries, 'before'); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Write and rollback failed; preserve journal and run recover');
    }
    unlinkSync(journal);
    throw error;
  }
  unlinkSync(journal);
  return entries.map((entry) => entry.path);
}

function approval(options, expected) {
  check(options['approved-sha256'] === expected, 'Missing or stale --approved-sha256; review a fresh preview');
  check(text(options.approval), 'Explicit --approval reference is required');
}

function recover(root, config, apply) {
  const path = safePath(root, '.decision-records.pending.json');
  const source = read(path);
  check(source !== null, 'No interrupted transaction to recover');
  const journal = JSON.parse(source);
  keys(journal, ['version', 'entries'], 'Recovery journal');
  check(journal.version === 1 && Array.isArray(journal.entries) && journal.entries.length > 0, 'Invalid recovery journal');
  const seen = new Set();
  for (const entry of journal.entries) {
    keys(entry, ['path', 'before', 'after'], 'Journal entry');
    const target = safePath(root, entry.path);
    const path = relative(root, target);
    const managedRecord = ['ADR', 'DDR'].some((type) => {
      const directory = config[type.toLowerCase()];
      return path === `${directory}/index.md`
        || path.startsWith(`${directory}/`) && validId(path.slice(directory.length + 1, -3))
          && path.endsWith('.md') && path.slice(directory.length + 1).startsWith(`${type}-`);
    });
    const draftName = path.startsWith(`${config.drafts}/`) ? path.slice(config.drafts.length + 1) : '';
    const managedDraft = /^[a-f0-9-]{36}\.md$/.test(draftName);
    check(path === config.state || managedRecord || managedDraft, `Journal targets an unmanaged file: ${entry.path}`);
    check(!seen.has(target), 'Duplicate recovery target');
    seen.add(target);
    check((entry.before === null || typeof entry.before === 'string') && typeof entry.after === 'string',
      'Invalid recovery content');
    const current = read(target);
    check(current === entry.before || current === entry.after, `Recovery blocked by divergent edits: ${entry.path}`);
  }
  if (apply) {
    restore(root, journal.entries, 'before');
    unlinkSync(path);
  }
  return { applied: apply, restore: journal.entries.map((entry) => entry.path) };
}

function saveModel(root, config, model, operation, details) {
  model.state.events.push({ operation, at: new Date().toISOString(), ...details });
  relationships(model);
  const changes = new Map([...model.records.values()].map((record) => [record.path, renderRecord(record)]));
  changes.set(config.state, json(model.state));
  for (const item of indexFiles(model, config)) changes.set(...item);
  return transaction(root, changes);
}

function execute(root, config, command, argument, options) {
  if (command === 'config') return config;
  if (command === 'template') return template(argument);
  if (command === 'recover') return recover(root, config, Boolean(options.apply));
  check(!existsSync(safePath(root, '.decision-records.pending.json')), 'Interrupted transaction: run recover before continuing');
  if (command === 'propose') {
    const draft = draftFromSource(resolve(root, argument), options.entry);
    const file = `${config.drafts}/${randomUUID()}.md`;
    const changed = transaction(root, new Map([[file, draftDocument(draft)]]));
    return { applied: true, draft: file, changed };
  }
  const model = load(root, config);
  const repaired = relationships(model, command === 'repair');
  if (command === 'validate') {
    validateIndexes(root, model, config);
    return { valid: true, records: model.records.size };
  }
  if (command === 'index' || command === 'repair') {
    const changes = indexFiles(model, config);
    if (!model.stateExists && !model.records.size) return { applied: false, changed: [], records: 0 };
    for (const id of repaired) {
      const record = model.records.get(id);
      changes.set(record.path, renderRecord(record));
    }
    if (repaired.length) {
      model.state.events.push({ operation: 'repair', at: new Date().toISOString(), ids: repaired });
      changes.set(config.state, json(model.state));
    }
    const changed = [...changes].filter(([path, content]) => read(safePath(root, path)) !== content).map(([path]) => path);
    if (options.apply) transaction(root, changes);
    return { applied: Boolean(options.apply), changed, repaired };
  }
  validateIndexes(root, model, config);
  if (command === 'accept' || command === 'supersede') {
    const draft = draftFromSource(resolve(root, argument), options.entry);
    const fingerprint = hash(draftDocument(draft));
    check(![...model.records.values()].some((record) => record.meta['content-sha256'] === fingerprint),
      'This exact draft is already accepted');
    if (command === 'supersede') check(draft.supersedes.length > 0, 'supersede requires at least one predecessor');
    for (const id of [...draft.supersedes, ...draft.related]) check(model.records.has(id), `Unknown relationship: ${id}`);
    for (const id of draft.supersedes) check(model.records.get(id).meta.status !== 'retired', `Cannot supersede retired record: ${id}`);
    const number = model.state.counters[draft.type] + 1;
    check(Number.isSafeInteger(number), 'Record sequence exhausted');
    const id = `${draft.type}-${String(number).padStart(4, '0')}`;
    const path = `${config[draft.type.toLowerCase()]}/${id}.md`;
    check(!existsSync(safePath(root, path)), `Target already exists: ${path}`);
    if (!options.apply) return { applied: false, id, path, sha256: fingerprint, draft: draftDocument(draft), predecessors: draft.supersedes };
    approval(options, fingerprint);
    const meta = {
      ...Object.fromEntries(draftKeys.map((key) => [key, draft[key]])),
      id, date: today(), status: 'accepted', 'superseded-by': [],
      approval: options.approval, 'content-sha256': fingerprint,
      'retirement-reason': '', 'retirement-approval': '',
    };
    model.records.set(id, { meta, draft, path });
    model.state.counters[draft.type] = number;
    model.state.records[id] = { sha256: fingerprint, date: meta.date, approval: meta.approval, retirement: null };
    for (const predecessor of draft.supersedes) {
      const record = model.records.get(predecessor);
      record.meta.status = 'superseded';
      record.meta['superseded-by'].push(id);
      record.meta['superseded-by'].sort();
    }
    const changed = saveModel(root, config, model, command, { id, sha256: fingerprint, approval: options.approval });
    return { applied: true, id, changed };
  }
  if (command === 'retire') {
    check(model.records.has(argument), `Unknown record: ${argument}`);
    const record = model.records.get(argument);
    check(record.meta.status === 'accepted', 'Only active accepted records can be retired');
    check(text(options.reason), 'A nonempty --reason is required');
    const fingerprint = hash(json({ id: argument, record: record.source, reason: options.reason }));
    if (!options.apply) return { applied: false, id: argument, reason: options.reason, sha256: fingerprint };
    approval(options, fingerprint);
    record.meta.status = 'retired';
    record.meta['retirement-reason'] = options.reason;
    record.meta['retirement-approval'] = options.approval;
    model.state.records[argument].retirement = { reason: options.reason, approval: options.approval };
    const changed = saveModel(root, config, model, 'retire', { id: argument, sha256: fingerprint, reason: options.reason, approval: options.approval });
    return { applied: true, id: argument, changed };
  }
  fail(`Unknown command: ${command}`);
}

export function main(args) {
  const { options, positional } = parseOptions(args);
  const [command = 'help', argument] = positional;
  const commands = {
    help: [], config: [], template: [], propose: ['entry'],
    accept: ['entry', 'apply', 'approval', 'approved-sha256'],
    supersede: ['entry', 'apply', 'approval', 'approved-sha256'],
    retire: ['reason', 'apply', 'approval', 'approved-sha256'],
    validate: [], index: ['apply'], repair: ['apply'], recover: ['apply'],
  };
  check(Object.hasOwn(commands, command), `Unknown command: ${command}`);
  check(Object.keys(options).every((key) => key === 'root' || commands[command].includes(key)),
    `Unsupported option for ${command}`);
  const needsArgument = ['template', 'propose', 'accept', 'supersede', 'retire'].includes(command);
  check(positional.length === (needsArgument ? 2 : command === 'help' && positional.length === 0 ? 0 : 1),
    `Unexpected or missing arguments for ${command}`);
  if (command === 'help') return 'decision-records: config | template ADR|DDR | propose FILE | accept FILE | supersede FILE | retire ID --reason TEXT | validate | index | repair | recover\nOptions: --root PROJECT, --entry N, --apply, --approved-sha256 HASH, --approval REFERENCE\nPreview before --apply. See references/cli.md for approval and recovery rules.\n';
  const root = resolve(options.root ?? process.cwd());
  check(existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Project root must be a real directory');
  const config = configuration(root);
  if (['template', 'config'].includes(command)) return execute(root, config, command, argument, options);
  const lock = safePath(root, '.decision-records.lock');
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('Decision-records lock exists; check its owning PID before removing a stale lock');
    throw error;
  }
  try {
    writeFileSync(descriptor, json({ pid: process.pid }));
    return execute(root, config, command, argument, options);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(typeof result === 'string' ? result : json(result));
  } catch (error) {
    const detail = error instanceof AggregateError
      ? `${error.message}: ${error.errors.map((cause) => cause.message).join('; ')}`
      : error.message;
    process.stderr.write(`decision-records: ${detail}\n`);
    process.exitCode = 1;
  }
}
