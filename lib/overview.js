/**
 * RSI overview — read-only readers for a workspace `.rsi` tree.
 *
 * Boundary: this module only reads files under `<workspace>/.rsi`. It never
 * writes, never approves, never collects and never starts a run. Every reader
 * tolerates a missing file or directory and reports it through `diagnostics`,
 * because a partially initialised `.rsi` tree is a normal state.
 *
 * Layout this module understands (matching the rsi-toolkit writers):
 *   .rsi/runs/index.json      { runs: [{ runId, parent, repeats, archived, archivePath, ... }] }
 *   .rsi/runs/<id>/config.json  { runId, cwd, createdAt, variantCount, repeats?, minPassRate? }
 *   .rsi/runs/<id>/report.json  collect result (new and legacy shapes)
 *   .rsi/runs/<id>/report.md    rendered collect report
 *   .rsi/proposals/index.json { proposals: [{ id, title, status, hypothesis, evidence, changes, file }] }
 *   .rsi/evidence/*.jsonl       one failure record per line
 *   .rsi/memory/harness-lessons.md  `## ` blocks, one lesson per block
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const RUN_REPORT_MD_MAX = 5000;
const PROPOSAL_BODY_MAX = 3000;
const LESSON_BODY_MAX = 700;
const ERROR_TEXT_MAX = 400;
const MAX_RUNS = 20;
const MAX_EVIDENCE = 20;
const MAX_LESSONS = 30;
const MAX_EVIDENCE_FILES = 40;
const MAX_GLOBAL_RUNS = 60;
const MAX_GLOBAL_PROPOSALS = 60;
const MAX_GLOBAL_EVIDENCE = 60;
const MAX_GLOBAL_LESSONS = 90;
const LEDGER_DIR = join(homedir(), '.dsh', 'rsi');
const LEDGER_PATH = join(LEDGER_DIR, 'ledger.json');
const LEDGER_LESSONS_PATH = join(LEDGER_DIR, 'lessons.md');
const LEDGER_README_PATH = join(LEDGER_DIR, 'README.md');
const MAX_LEDGER_LESSONS = 500;
const MAX_LEDGER_PROPOSALS = 300;

/** True when `target` exists (any type). */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** `stat` that returns null instead of throwing. */
async function statOrNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/** Read a UTF-8 file, or null when it is missing or unreadable. */
async function readTextOrNull(target) {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** Read and parse JSON, or null. Never throws on malformed JSON. */
async function readJsonOrNull(target) {
  const text = await readTextOrNull(target);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Clip a string to `max` UTF-16 units. Non-strings become "". */
function clip(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A safe finite number, else null. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** ISO string for a millisecond timestamp, else null. */
function iso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Resolve the workspace the overview should read.
 *
 * Candidates arrive from the Client (plain hints, never trusted as authority)
 * and are validated here: each must be an absolute path to an existing
 * directory. A candidate that already holds `.rsi` wins; otherwise its
 * ancestors are checked, because a hint such as a session working directory can
 * sit below the workspace root.
 *
 * @param {string[]} candidates absolute path hints, most specific first
 * @returns {Promise<{workspace: string|null, via: string|null, tried: string[], rsiFound: boolean}>}
 */
export async function resolveWorkspace(candidates) {
  const tried = [];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value || value.length > 400) continue;
    if (!isAbsolute(value)) continue;
    let dir;
    try {
      dir = resolve(value);
    } catch {
      continue;
    }
    if (tried.includes(dir)) continue;
    tried.push(dir);
    const info = await statOrNull(dir);
    if (!info || !info.isDirectory()) continue;
    if (await exists(join(dir, '.rsi'))) {
      return { workspace: dir, via: 'direct', tried, rsiFound: true };
    }
    let cursor = dir;
    for (let step = 0; step < 8; step += 1) {
      const parent = dirname(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
      if (await exists(join(cursor, '.rsi'))) {
        return { workspace: cursor, via: 'ancestor', tried, rsiFound: true };
      }
    }
  }
  return { workspace: tried[0] ?? null, via: null, tried, rsiFound: false };
}

/** Repeat count a report states implicitly, through its per-repeat rows. */
function derivedRepeats(report) {
  let best = null;
  for (const variant of Array.isArray(report?.variants) ? report.variants : []) {
    const stated = num(variant?.repeats);
    const listed = Array.isArray(variant?.repeatRows)
      ? variant.repeatRows.length
      : Array.isArray(variant?.scores)
        ? variant.scores.length
        : null;
    const candidate = stated ?? listed;
    if (candidate !== null && candidate > 0 && (best === null || candidate > best)) best = candidate;
  }
  return best;
}

/** Variant pass rate that tolerates the legacy report shape (passed/score only). */
function variantPassRate(variant) {
  const direct = num(variant?.passRate);
  if (direct !== null) return direct;
  if (variant?.passed === true) return 1;
  if (variant?.passed === false) return 0;
  const score = num(variant?.score);
  const max = num(variant?.max);
  if (score !== null && max !== null && max > 0) return Math.round((score / max) * 1000) / 1000;
  return null;
}

/** Total line count of a file, without keeping it. */
function countLines(text) {
  if (!text) return 0;
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) total += 1;
  }
  return text.endsWith('\n') ? total : total + 1;
}

/** Summarize the `.rsi/runs` tree. */
async function readRuns(rsiDir, diagnostics) {
  const runsDir = join(rsiDir, 'runs');
  const index = await readJsonOrNull(join(runsDir, 'index.json'));
  if (index === null) diagnostics.push('runs/index.json 不可读，已按目录扫描');
  const indexed = new Map();
  for (const entry of Array.isArray(index?.runs) ? index.runs : []) {
    if (entry && typeof entry.runId === 'string') indexed.set(entry.runId, entry);
  }

  const liveEntries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const live = liveEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '_archive')
    .map((entry) => entry.name);

  const archivedEntries = await readdir(join(runsDir, '_archive'), { withFileTypes: true }).catch(() => []);
  const archivedLive = archivedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const runs = [];

  for (const runId of live) {
    const dir = join(runsDir, runId);
    runs.push(await readRun(runId, dir, indexEntryFor(indexed, runId), false));
  }

  for (const [runId, entry] of indexed) {
    if (live.includes(runId)) continue;
    const archivePath = typeof entry.archivePath === 'string' ? entry.archivePath : null;
    const dir = archivePath ? resolve(rsiDir, '..', archivePath) : null;
    runs.push(await readRun(runId, dir, entry, true));
  }

  // Archived runs that index.json does not describe: keep them visible by id.
  for (const name of archivedLive) {
    const runId = archivedRunId(name);
    if (indexed.has(runId) || live.includes(runId)) continue;
    runs.push(await readRun(runId, join(runsDir, '_archive', name), null, true));
  }

  runs.sort((left, right) => (right.sortAt ?? 0) - (left.sortAt ?? 0));
  const trimmed = runs.slice(0, MAX_RUNS);
  return {
    total: runs.length,
    active: live.length,
    archived: runs.length - live.length,
    items: trimmed,
    truncated: runs.length > trimmed.length,
  };
}

/** An index row for `runId`, tolerating a differently shaped index. */
function indexEntryFor(indexed, runId) {
  return indexed.get(runId) ?? null;
}

/** `.rsi/runs/_archive/<timestamp>-<runId>` → `<runId>`. */
function archivedRunId(name) {
  const match = /^\d{8}-\d+-(.+)$/.exec(name);
  return match ? match[1] : name;
}

/** Read one run directory (or an archived run without a readable directory). */
async function readRun(runId, dir, indexEntry, archived) {
  const diagnostics = [];
  let config = null;
  let report = null;
  let reportMd = null;
  let reportStat = null;

  if (dir) {
    config = await readJsonOrNull(join(dir, 'config.json'));
    report = await readJsonOrNull(join(dir, 'report.json'));
    const md = await readTextOrNull(join(dir, 'report.md'));
    reportMd = md === null ? null : clip(md, RUN_REPORT_MD_MAX);
    reportStat = (await statOrNull(join(dir, 'report.json'))) ?? (await statOrNull(dir));
    if (config === null && report === null && reportMd === null) {
      diagnostics.push('run 目录缺少 config.json / report.json / report.md');
    }
  } else {
    diagnostics.push('归档 run 缺少可读取的目录');
  }

  const variants = (Array.isArray(report?.variants) ? report.variants : []).map((variant) => ({
    label: typeof variant?.label === 'string' ? variant.label : '',
    passRate: variantPassRate(variant),
    score: num(variant?.score),
    max: num(variant?.max),
    mean: num(variant?.mean),
    executed: num(variant?.executed),
    repeats: num(variant?.repeats) ?? num(config?.repeats),
    passed: variant?.passed === true ? true : variant?.passed === false ? false : null,
    rows: (Array.isArray(variant?.rows) ? variant.rows : [])
      .slice(0, 40)
      .map((row) => ({
        label: clip(row?.label ?? row?.id ?? '', 160),
        kind: typeof row?.kind === 'string' ? row.kind : null,
        ok: row?.ok === true ? true : row?.ok === false ? false : null,
        detail: clip(row?.detail ?? '', 200),
      })),
  }));

  const plannedVariants = num(config?.variantCount);
  const variantCount = variants.length || plannedVariants || 0;
  const passedCount = variants.filter((variant) => variant.passed === true).length;
  const minPassRate = num(report?.minPassRate) ?? num(config?.minPassRate);
  const sumOf = (field) => {
    let total = null;
    for (const variant of variants) {
      if (variant[field] === null) continue;
      total = (total ?? 0) + variant[field];
    }
    return total;
  };
  const score = num(report?.total) ?? sumOf('score');
  const maxTotal = num(report?.maxTotal) ?? sumOf('max');
  const repeats = num(report?.repeats) ?? num(config?.repeats) ?? num(indexEntry?.repeats) ?? derivedRepeats(report);

  let passRate = null;
  if (report) {
    if (variantCount > 0) passRate = Math.round((passedCount / variantCount) * 1000) / 1000;
    else if (score !== null && maxTotal !== null && maxTotal > 0) passRate = Math.round((score / maxTotal) * 1000) / 1000;
  }

  let status = 'planned';
  if (report) {
    if (report.hasPassScore === false) status = 'unscored';
    else if (report.passed === true) status = 'passed';
    else if (report.passed === false) status = 'failed';
    else if (variantCount > 0 && passedCount === variantCount) status = 'passed';
    else status = 'failed';
  } else if (archived) {
    status = 'archived';
  }

  const createdAt = typeof config?.createdAt === 'string' ? config.createdAt : null;

  return {
    runId,
    archived,
    status,
    createdAt,
    updatedAt: iso(reportStat?.mtimeMs),
    sortAt: reportStat?.mtimeMs ?? 0,
    repeats,
    mode: typeof indexEntry?.mode === 'string' ? indexEntry.mode : null,
    parent: typeof indexEntry?.parent === 'string' ? indexEntry.parent : null,
    archivedAt: typeof indexEntry?.archivedAt === 'string' ? indexEntry.archivedAt : null,
    workspace: typeof config?.cwd === 'string' ? config.cwd : null,
    variantCount,
    passedCount,
    passRate,
    minPassRate,
    score,
    maxTotal,
    rubricHashVerified: report?.rubricHashVerified === true,
    variants,
    reportMd,
    diagnostics,
  };
}

/** Read `.rsi/proposals/index.json` when the proposal library exists. */
async function readProposals(rsiDir, diagnostics) {
  const proposalsDir = join(rsiDir, 'proposals');
  const indexPath = join(proposalsDir, 'index.json');
  const present = await exists(proposalsDir);
  if (!present) {
    return { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] };
  }
  const index = await readJsonOrNull(indexPath);
  if (index === null) {
    diagnostics.push('proposals/index.json 不可读，提案库按空处理');
    return { libraryExists: true, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] };
  }

  const raw = Array.isArray(index?.proposals) ? index.proposals : [];
  const items = [];
  const counts = { pending: 0, approved: 0, applied: 0, rejected: 0 };

  for (const entry of raw) {
    if (!entry || typeof entry.id !== 'string') continue;
    const status = normalizeProposalStatus(entry.status);
    if (status in counts) counts[status] += 1;
    let body = null;
    if (typeof entry.file === 'string' && entry.file) {
      const filePath = isAbsolute(entry.file) ? entry.file : resolve(rsiDir, '..', entry.file);
      const text = await readTextOrNull(filePath);
      body = text === null ? null : clip(text, PROPOSAL_BODY_MAX);
    }
    items.push({
      id: entry.id,
      title: clip(entry.title ?? entry.id, 200),
      status,
      rawStatus: typeof entry.status === 'string' ? entry.status : null,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : typeof entry.ts === 'string' ? entry.ts : null,
      hypothesis: clip(entry.hypothesis ?? '', 800),
      evidence: clip(typeof entry.evidence === 'string' ? entry.evidence : entry.basedOnEvidence ?? '', 1200),
      changes: (Array.isArray(entry.changes) ? entry.changes : []).slice(0, 20).map((change) => ({
        file: clip(change?.file ?? '', 200),
        description: clip(change?.description ?? '', 300),
      })),
      body,
    });
  }

  items.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  return { libraryExists: true, total: items.length, ...counts, items };
}

/** `draft` is the rsi-propose status for a proposal awaiting review. */
function normalizeProposalStatus(status) {
  if (status === 'draft' || status === 'pending') return 'pending';
  if (status === 'approved') return 'approved';
  if (status === 'applied') return 'applied';
  if (status === 'rejected') return 'rejected';
  return 'unknown';
}

/** Read the newest failure evidence records from `.rsi/evidence`. */
async function readEvidence(rsiDir, diagnostics) {
  const evidenceDir = join(rsiDir, 'evidence');
  const entries = await readdir(evidenceDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name);
  if (files.length === 0) return { count: 0, files: 0, items: [] };

  const measured = [];
  for (const name of files) {
    const info = await statOrNull(join(evidenceDir, name));
    measured.push({ name, mtimeMs: info?.mtimeMs ?? 0 });
  }
  measured.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const readable = measured.slice(0, MAX_EVIDENCE_FILES);
  if (measured.length > readable.length) {
    diagnostics.push(`证据文件超过 ${MAX_EVIDENCE_FILES} 个，仅统计最近的部分`);
  }

  let count = 0;
  const records = [];
  for (const file of readable) {
    const text = await readTextOrNull(join(evidenceDir, file.name));
    if (text === null) continue;
    count += countLines(text);
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines.slice(-40)) {
      try {
        const record = JSON.parse(line);
        records.push({
          ts: typeof record?.ts === 'string' ? record.ts : null,
          source: typeof record?.source === 'string' ? record.source : null,
          tool: typeof record?.tool === 'string' ? record.tool : null,
          error: clip(record?.error ?? '', ERROR_TEXT_MAX),
          args: clip(typeof record?.args === 'string' ? record.args : '', 200),
          file: file.name,
        });
      } catch {
        /* a truncated tail line is not evidence */
      }
    }
  }

  records.sort((left, right) => String(right.ts ?? '').localeCompare(String(left.ts ?? '')));
  return { count, files: files.length, items: records.slice(0, MAX_EVIDENCE) };
}

/** Read `## ` blocks from `.rsi/memory/harness-lessons.md`. */
async function readLessons(rsiDir) {
  const path = join(rsiDir, 'memory', 'harness-lessons.md');
  const text = await readTextOrNull(path);
  if (text === null) return { count: 0, items: [] };
  const parts = text.split(/^## /m);
  const blocks = parts.slice(1);
  const items = blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const title = clip(lines[0]?.trim() ?? '', 200);
    const body = clip(lines.slice(1).join('\n').trim(), LESSON_BODY_MAX);
    return { title, body };
  });
  return { count: items.length, items: items.slice(0, MAX_LESSONS) };
}

/**
 * Build the complete overview payload for a workspace.
 *
 * @param {string|null} workspace absolute workspace directory, or null when unknown
 * @returns {Promise<object>} the JSON payload served to the Client
 */
export async function readOverview(workspace) {
  const generatedAt = new Date().toISOString();
  if (!workspace) {
    return {
      generatedAt,
      exists: false,
      workspace: null,
      reason: 'no-workspace',
      summary: emptySummary(),
      runs: [],
      proposals: { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] },
      evidence: { count: 0, files: 0, items: [] },
      lessons: { count: 0, items: [] },
      diagnostics: [],
    };
  }

  const rsiDir = join(workspace, '.rsi');
  if (!(await exists(rsiDir))) {
    return {
      generatedAt,
      exists: false,
      workspace,
      rsiDir,
      reason: 'no-rsi',
      summary: emptySummary(),
      runs: [],
      proposals: { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] },
      evidence: { count: 0, files: 0, items: [] },
      lessons: { count: 0, items: [] },
      diagnostics: [],
    };
  }

  const diagnostics = [];
  const runs = await readRuns(rsiDir, diagnostics);
  const proposals = await readProposals(rsiDir, diagnostics);
  const evidence = await readEvidence(rsiDir, diagnostics);
  const lessons = await readLessons(rsiDir);

  const withReport = runs.items.filter((run) => run.status !== 'planned' && run.status !== 'archived');
  const latest = withReport[0] ?? null;

  return {
    generatedAt,
    exists: true,
    workspace,
    rsiDir,
    reason: null,
    summary: {
      runs: { total: runs.total, active: runs.active, archived: runs.archived },
      lastCollect: latest
        ? {
            runId: latest.runId,
            passRate: latest.passRate,
            passedCount: latest.passedCount,
            variantCount: latest.variantCount,
            passed: latest.status === 'passed',
            status: latest.status,
            minPassRate: latest.minPassRate,
            updatedAt: latest.updatedAt,
            archived: latest.archived,
          }
        : null,
      proposals: {
        libraryExists: proposals.libraryExists,
        total: proposals.total,
        pending: proposals.pending,
        approved: proposals.approved,
        applied: proposals.applied,
        rejected: proposals.rejected,
      },
      evidence: { count: evidence.count, files: evidence.files },
      lessons: { count: lessons.count },
    },
    runs: runs.items.map(({ sortAt, ...rest }) => rest),
    runsTruncated: runs.truncated,
    proposals,
    evidence,
    lessons,
    diagnostics,
  };
}

/** The zero summary used when no workspace or no `.rsi` is available. */
function emptySummary() {
  return {
    runs: { total: 0, active: 0, archived: 0 },
    lastCollect: null,
    proposals: { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0 },
    evidence: { count: 0, files: 0 },
    lessons: { count: 0 },
  };
}

/** A stable clock value for sorting ISO strings, with 0 for missing values. */
function timeOf(value) {
  const ms = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Build one payload across every resolvable workspace.
 *
 * Each candidate is resolved independently; only directories that really hold
 * `.rsi` are kept, and duplicates collapse to one workspace. The merged shape
 * mirrors `readOverview` so the Client can render it with the same components;
 * every run, proposal, evidence record and lesson carries a `workspace` tag.
 *
 * @param {string[]} candidates absolute path hints, in Client order
 * @returns {Promise<object>} the global overview payload
 */
export async function readGlobalOverview(candidates) {
  const generatedAt = new Date().toISOString();
  const ledger = await readLedger();
  const tried = [];
  const overviews = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const resolved = await resolveWorkspace([candidate]);
    for (const path of resolved.tried) {
      if (!tried.includes(path)) tried.push(path);
    }
    if (!resolved.rsiFound || !resolved.workspace || seen.has(resolved.workspace)) continue;
    seen.add(resolved.workspace);
    overviews.push(await readOverview(resolved.workspace));
  }

  if (overviews.length === 0) {
    return {
      generatedAt,
      scope: 'global',
      exists: ledger.exists,
      workspace: null,
      reason: ledger.exists ? null : 'no-global-workspace',
      summary: { ...emptySummary(), workspaces: 0 },
      workspaces: [],
      runs: [],
      runsTruncated: false,
      proposals: { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] },
      evidence: { count: 0, files: 0, items: [] },
      lessons: { count: 0, items: [] },
      ledger,
      diagnostics: [],
      resolution: { tried },
    };
  }

  const tagged = overviews.map((overview) => ({
    overview,
    workspace: overview.workspace,
    name: basename(overview.workspace) || overview.workspace,
  }));

  const summary = emptySummary();
  summary.workspaces = tagged.length;
  let lastCollect = null;
  let runsTruncated = false;
  const runs = [];
  const proposals = { libraryExists: false, total: 0, pending: 0, approved: 0, applied: 0, rejected: 0, items: [] };
  const evidence = { count: 0, files: 0, items: [] };
  const lessons = { count: 0, items: [] };
  const diagnostics = [];

  for (const { overview, workspace, name } of tagged) {
    summary.runs.total += overview.summary.runs.total;
    summary.runs.active += overview.summary.runs.active;
    summary.runs.archived += overview.summary.runs.archived;
    summary.proposals.libraryExists = summary.proposals.libraryExists || overview.summary.proposals.libraryExists;
    summary.proposals.total += overview.summary.proposals.total;
    summary.proposals.pending += overview.summary.proposals.pending;
    summary.proposals.approved += overview.summary.proposals.approved;
    summary.proposals.applied += overview.summary.proposals.applied;
    summary.proposals.rejected += overview.summary.proposals.rejected;
    summary.evidence.count += overview.summary.evidence.count;
    summary.evidence.files += overview.summary.evidence.files;
    summary.lessons.count += overview.summary.lessons.count;

    const candidateLast = overview.summary.lastCollect;
    if (candidateLast && (!lastCollect || timeOf(candidateLast.updatedAt) > timeOf(lastCollect.updatedAt))) {
      lastCollect = { ...candidateLast, workspace, workspaceName: name };
    }

    if (overview.runsTruncated) runsTruncated = true;
    for (const run of overview.runs) runs.push({ ...run, workspace, workspaceName: name });
    for (const proposal of overview.proposals.items ?? []) {
      proposals.items.push({ ...proposal, workspace, workspaceName: name });
    }
    for (const record of overview.evidence.items ?? []) {
      evidence.items.push({ ...record, workspace, workspaceName: name });
    }
    for (const lesson of overview.lessons.items ?? []) {
      lessons.items.push({ ...lesson, workspace, workspaceName: name });
    }
    for (const message of overview.diagnostics ?? []) {
      diagnostics.push(`${name}: ${message}`);
    }
  }

  summary.lastCollect = lastCollect;
  proposals.libraryExists = summary.proposals.libraryExists;
  proposals.total = summary.proposals.total;
  proposals.pending = summary.proposals.pending;
  proposals.approved = summary.proposals.approved;
  proposals.applied = summary.proposals.applied;
  proposals.rejected = summary.proposals.rejected;
  evidence.count = summary.evidence.count;
  evidence.files = summary.evidence.files;
  lessons.count = summary.lessons.count;

  runs.sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt));
  proposals.items.sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt));
  evidence.items.sort((left, right) => timeOf(right.ts) - timeOf(left.ts));
  runsTruncated = runsTruncated || runs.length > MAX_GLOBAL_RUNS;
  runs.splice(MAX_GLOBAL_RUNS);
  proposals.items.splice(MAX_GLOBAL_PROPOSALS);
  evidence.items.splice(MAX_GLOBAL_EVIDENCE);
  lessons.items.splice(MAX_GLOBAL_LESSONS);

  return {
    generatedAt,
    scope: 'global',
    exists: true,
    workspace: null,
    reason: null,
    summary,
    workspaces: tagged.map(({ overview, workspace, name }) => ({
      workspace,
      name,
      exists: overview.exists,
      reason: overview.reason,
      summary: overview.summary,
      diagnostics: overview.diagnostics,
    })),
    runs,
    runsTruncated,
    proposals,
    evidence,
    lessons,
    ledger,
    diagnostics,
    resolution: { tried },
  };
}

/** Short stable hash used to deduplicate ledger entries. */
function shortHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

/** Keep every workspace path that contributed a ledger entry. */
function addSource(entry, workspace) {
  if (!Array.isArray(entry.sources)) entry.sources = [];
  if (workspace && !entry.sources.includes(workspace)) entry.sources.push(workspace);
}

/** Render the human-readable half of the global ledger. */
function renderLedgerLessons(lessons) {
  const lines = ['# 全局 RSI 经验账本', '', '由 rsi-overview 同步生成；每条经验保留来源工作区。', ''];
  for (const lesson of lessons) {
    if (!lesson || typeof lesson.title !== 'string') continue;
    lines.push('## ' + lesson.title);
    const body = typeof lesson.body === 'string' ? lesson.body.trim() : '';
    if (body) lines.push('', body);
    if (Array.isArray(lesson.sources) && lesson.sources.length > 0) {
      lines.push('', '<!-- sources: ' + lesson.sources.join(' | ') + ' -->');
    }
    lines.push('');
  }
  return lines.join('\n');
}

const LEDGER_README = [
  '# 全局 RSI 经验账本',
  '',
  '这个目录由 `rsi-overview` 页面维护，用来跨工作区汇总实验得到的经验与提案。',
  '',
  '- `ledger.json`：机器可读索引',
  '- `lessons.md`：人类可读的经验合集',
  '',
  '页面里的「账本」标签可以手动同步；同步只读取各工作区的 `.rsi`，写入本目录。',
  '',
].join('\n');

/** Read the global ledger without creating it. */
export async function readLedger() {
  const raw = await readJsonOrNull(LEDGER_PATH);
  if (!raw || !Array.isArray(raw.lessons) || !Array.isArray(raw.proposals)) {
    return {
      exists: false,
      path: LEDGER_DIR,
      updatedAt: null,
      lessons: [],
      proposals: [],
      summary: { lessons: 0, proposals: 0, workspaces: 0 },
    };
  }
  return {
    exists: true,
    path: LEDGER_DIR,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    lessons: raw.lessons,
    proposals: raw.proposals,
    summary: {
      lessons: raw.lessons.length,
      proposals: raw.proposals.length,
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.length : 0,
    },
  };
}

/**
 * Merge every reachable workspace `.rsi` into `~/.dsh/rsi/ledger.json`.
 *
 * Read-only with respect to workspaces: it only reads `.rsi` and only writes
 * inside the global ledger directory. Duplicate lessons are merged by content
 * hash; proposals are keyed by workspace + id and refreshed in place.
 */
export async function syncGlobalLedger(candidates) {
  const tried = [];
  const inputs = [];
  const seen = new Set();

  for (const candidate of candidates ?? []) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const resolved = await resolveWorkspace([candidate]);
    for (const path of resolved.tried) {
      if (!tried.includes(path)) tried.push(path);
    }
    if (!resolved.rsiFound || !resolved.workspace || seen.has(resolved.workspace)) continue;
    seen.add(resolved.workspace);
    inputs.push({
      workspace: resolved.workspace,
      name: basename(resolved.workspace) || resolved.workspace,
      overview: await readOverview(resolved.workspace),
    });
  }

  if (inputs.length === 0) {
    return {
      ok: false,
      error: 'no-global-workspace',
      path: LEDGER_DIR,
      addedLessons: 0,
      addedProposals: 0,
      summary: { lessons: 0, proposals: 0, workspaces: 0 },
      tried,
    };
  }

  const previous = await readJsonOrNull(LEDGER_PATH);
  const ledger = previous && typeof previous === 'object' ? previous : {};
  ledger.version = 1;
  ledger.lessons = Array.isArray(ledger.lessons) ? ledger.lessons : [];
  ledger.proposals = Array.isArray(ledger.proposals) ? ledger.proposals : [];
  ledger.workspaces = Array.isArray(ledger.workspaces) ? ledger.workspaces : [];

  const now = new Date().toISOString();
  const lessons = new Map();
  for (const entry of ledger.lessons) {
    if (entry && typeof entry.key === 'string') lessons.set(entry.key, entry);
  }
  const proposals = new Map();
  for (const entry of ledger.proposals) {
    if (entry && typeof entry.key === 'string') proposals.set(entry.key, entry);
  }
  const workspaces = new Map();
  for (const entry of ledger.workspaces) {
    if (entry && typeof entry.path === 'string') workspaces.set(entry.path, entry);
  }

  let addedLessons = 0;
  let addedProposals = 0;

  for (const input of inputs) {
    const { workspace, name, overview } = input;
    for (const lesson of overview.lessons.items ?? []) {
      const title = typeof lesson.title === 'string' ? lesson.title : '';
      const body = typeof lesson.body === 'string' ? lesson.body : '';
      if (!title && !body) continue;
      const key = shortHash('lesson\n' + title + '\n' + body);
      const existing = lessons.get(key);
      if (existing) {
        addSource(existing, workspace);
        existing.lastSeenAt = now;
      } else {
        lessons.set(key, { key, title, body, sources: [workspace], firstSeenAt: now, lastSeenAt: now });
        addedLessons += 1;
      }
    }

    for (const proposal of overview.proposals.items ?? []) {
      if (!proposal || typeof proposal.id !== 'string') continue;
      const key = shortHash('proposal\n' + workspace + '\n' + proposal.id);
      const existing = proposals.get(key);
      if (existing) {
        if (proposal.title) existing.title = proposal.title;
        if (proposal.status) existing.status = proposal.status;
        if (proposal.hypothesis !== undefined) existing.hypothesis = proposal.hypothesis;
        if (proposal.evidence !== undefined) existing.evidence = proposal.evidence;
        if (proposal.changes !== undefined) existing.changes = proposal.changes;
        if (proposal.body !== undefined) existing.body = proposal.body;
        addSource(existing, workspace);
        existing.lastSeenAt = now;
      } else {
        proposals.set(key, {
          key,
          id: proposal.id,
          title: proposal.title ?? proposal.id,
          status: proposal.status ?? 'unknown',
          createdAt: proposal.createdAt ?? null,
          hypothesis: proposal.hypothesis ?? '',
          evidence: proposal.evidence ?? '',
          changes: proposal.changes ?? [],
          body: proposal.body ?? null,
          sources: [workspace],
          firstSeenAt: now,
          lastSeenAt: now,
        });
        addedProposals += 1;
      }
    }

    workspaces.set(workspace, {
      path: workspace,
      name,
      runs: overview.summary.runs.total,
      evidence: overview.summary.evidence.count,
      lessons: overview.summary.lessons.count,
      lastSeenAt: now,
    });
  }

  ledger.updatedAt = now;
  ledger.lessons = Array.from(lessons.values()).slice(-MAX_LEDGER_LESSONS);
  ledger.proposals = Array.from(proposals.values()).slice(-MAX_LEDGER_PROPOSALS);
  ledger.workspaces = Array.from(workspaces.values()).sort((left, right) => String(left.name).localeCompare(String(right.name)));

  await mkdir(LEDGER_DIR, { recursive: true });
  const temporary = LEDGER_PATH + '.tmp';
  await writeFile(temporary, JSON.stringify(ledger, null, 2), 'utf8');
  await rename(temporary, LEDGER_PATH);
  await writeFile(LEDGER_LESSONS_PATH, renderLedgerLessons(ledger.lessons), 'utf8');
  if (!(await exists(LEDGER_README_PATH))) {
    await writeFile(LEDGER_README_PATH, LEDGER_README, 'utf8');
  }

  return {
    ok: true,
    path: LEDGER_DIR,
    updatedAt: now,
    addedLessons,
    addedProposals,
    summary: {
      lessons: ledger.lessons.length,
      proposals: ledger.proposals.length,
      workspaces: ledger.workspaces.length,
    },
    tried,
  };
}
