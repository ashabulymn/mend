// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and order/atomicity (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: a file as lines ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---- Section 5: matching lines ----

function tierCmp(tier: number): (a: string, b: string) => boolean {
  if (tier === 0) return (a, b) => a === b;
  if (tier === 1) {
    const t = (s: string): string => s.replace(/[ \t]+$/, '');
    return (a, b) => t(a) === t(b);
  }
  const t = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return (a, b) => t(a) === t(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const cmp = tierCmp(tier);
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!cmp(lines[i + j]!, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Section 5 re-indentation at tier 2: the leading P of the line is replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// ---- Shared body lines (unified hunks and V4A chunks) ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

function parseBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '', raw: l };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1), raw: l };
  if (c === '-') return { kind: 'old', text: l.slice(1), raw: l };
  if (c === '+') return { kind: 'new', text: l.slice(1), raw: l };
  return { kind: 'bs', text: l.slice(1), raw: l };
}

/** O is the context and old lines, N the context and new lines, each in body order. */
function splitON(body: BodyLine[]): { o: string[]; n: string[] } {
  const o: string[] = [];
  const n: string[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push(b.text);
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or new line. */
function bsAfterLast(body: BodyLine[]): boolean {
  let r = false;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b.kind === 'ctx' || b.kind === 'new') r = body[i + 1]?.kind === 'bs';
  }
  return r;
}

/** The replacement lines: context lines are the file's own matched lines, other new lines re-indented at tier 2. */
function buildReplacement(body: BodyLine[], lines: string[], pos: number, tier: number, p: string, f: string): string[] {
  const rep: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      rep.push(lines[pos + oi]!);
      oi += 1;
    } else if (b.kind === 'old') {
      oi += 1;
    } else if (b.kind === 'new') {
      rep.push(tier === 2 ? reindent(b.text, p, f) : b.text);
    }
  }
  return rep;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseDiffGit(l: string, ln: number): [string, string] {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${ln}`);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) throw new Exit2(`error: parse ${ln}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${ln}`);
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(l: string, ln: number): number {
  const m = HUNK_RE.exec(l);
  if (m === null) throw new Exit2(`error: parse ${ln}`);
  return Number(m[1]);
}

function parseUnified(lines: string[]): UniSection[] {
  interface Raw {
    gitOld: string | null;
    gitNew: string | null;
    hdrOld: string | null;
    hdrNew: string | null;
    renOld: string | null;
    renNew: string | null;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let inHunks = false;
  const n = lines.length;
  const newSection = (gitOld: string | null, gitNew: string | null): Raw => {
    const r: Raw = { gitOld, gitNew, hdrOld: null, hdrNew: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    raws.push(r);
    cur = r;
    inHunks = false;
    return r;
  };
  const headerPath = (l: string): string => {
    let p = l.slice(4);
    const t = p.indexOf('\t');
    if (t >= 0) p = p.slice(0, t);
    return p.trim();
  };
  const stripPrefix = (p: string): string | null => {
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
    return p;
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    const ln = i + 1;
    if (l.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(l, ln);
      newSection(x, y);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const a = parseHunkHeader(l, ln);
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(parseBodyLine(b));
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push({ a, body });
      inHunks = true;
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.hdrOld = stripPrefix(headerPath(l));
        cur.hdrNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
      } else {
        throw new Exit2(`error: parse ${ln + 1}`);
      }
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('+++ ')) {
      cur.hdrNew = stripPrefix(headerPath(l));
      i += 1;
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('rename from ')) {
      cur.renOld = l.slice(12).trim();
      i += 1;
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('rename to ')) {
      cur.renNew = l.slice(10).trim();
      i += 1;
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('new file mode')) {
      cur.create = true;
      i += 1;
      continue;
    }
    if (cur !== null && !inHunks && l.startsWith('deleted file mode')) {
      cur.del = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const r = newSection(null, null);
      r.hdrOld = stripPrefix(headerPath(l));
      r.hdrNew = stripPrefix(headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    i += 1;
  }
  return raws.map((r) => {
    const oldPath = r.hdrOld ?? r.renOld ?? r.gitOld;
    const newPath = r.hdrNew ?? r.renNew ?? r.gitNew;
    return {
      oldPath,
      newPath,
      create: r.create || oldPath === null,
      del: r.del || newPath === null,
      hunks: r.hunks,
    };
  });
}

/** Apply one hunk to a file model; `d` is the running line offset of this section. */
function applyHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): { model: FileModel; delta: number } {
  const { o, n } = splitON(hunk.body);
  const bs = bsAfterLast(hunk.body);
  const lines = model.lines;
  if (o.length === 0) {
    let at = hunk.a + d;
    if (at < 0) at = 0;
    if (at > lines.length) at = lines.length;
    const out = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    const fin = at === lines.length ? !bs : model.final;
    return { model: { br: model.br, lines: out, final: fin }, delta: n.length };
  }
  const found = findTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const j of found.occ) {
    const dist = Math.abs(j - target);
    if (dist < best) {
      pos = j;
      best = dist;
    }
  }
  const p = leadingWs(o[0]!);
  const f = leadingWs(lines[pos]!);
  const rep = buildReplacement(hunk.body, lines, pos, found.tier, p, f);
  const atEnd = pos + o.length === lines.length;
  const out = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
  const fin = atEnd ? !bs : model.final;
  return { model: { br: model.br, lines: out, final: fin }, delta: n.length - o.length };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    if (sec.create && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            lastPlusBs = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (sec.del && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(model, h, d, strict, oldP);
      model = r.model;
      d += r.delta;
    }
    const content = serializeFile(model);
    if (oldP !== newP) {
      tree.now.set(newP, content);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, content);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs = parseUnified(lines);
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${sIdx + 1}`);
    blocks.push({ path, old: lines.slice(sIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      const found = findTier(model.lines, b.old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const pfx = leadingWs(b.old[0]!);
      const f = leadingWs(model.lines[pos]!);
      const rep = b.nw.map((l) => (found.tier === 2 ? reindent(l, pfx, f) : l));
      const out = [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + b.old.length)];
      tree.now.set(p, serializeFile({ br: model.br, lines: out, final: model.final }));
    };
  });
}

// ---- Section 8: V4A patches ----

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

const V4A_ADD = '*** Add File:';
const V4A_DELETE = '*** Delete File:';
const V4A_UPDATE = '*** Update File:';
const V4A_MOVE = '*** Move to:';

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (l.startsWith(V4A_ADD)) {
      kind = 'add';
      prefix = V4A_ADD;
    } else if (l.startsWith(V4A_DELETE)) {
      kind = 'delete';
      prefix = V4A_DELETE;
    } else if (l.startsWith(V4A_UPDATE)) {
      kind = 'update';
      prefix = V4A_UPDATE;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const path = l.slice(prefix.length).trim();
    const startLine = i + 1;
    i += 1;
    const raw: string[] = [];
    const rawNo: number[] = [];
    while (i < last) {
      const b = lines[i]!;
      if (b.startsWith(V4A_ADD) || b.startsWith(V4A_DELETE) || b.startsWith(V4A_UPDATE)) break;
      raw.push(b);
      rawNo.push(i + 1);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
      raw.pop();
      rawNo.pop();
    }
    if (kind === 'add') {
      const fl: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r === '') fl.push('');
        else if (r[0] === '+') fl.push(r.slice(1));
        else throw new Exit2(`error: parse ${rawNo[k]}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fl, chunks: [] });
    } else if (kind === 'delete') {
      const bad = rawNo.find((_, k) => !blank(raw[k]!));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad}`);
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let j = 0;
      if (j < raw.length && raw[j]!.startsWith(V4A_MOVE)) {
        moveTo = raw[j]!.slice(V4A_MOVE.length).trim();
        j += 1;
      }
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const no = rawNo[j]!;
        if (cur === null && blank(r) && chunks.length > 0) continue;
        if (r.startsWith('@@')) {
          const anchor = r.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (!r.startsWith(' ') && r.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${no}`);
            }
          }
          cur.body.push(parseBodyLine(r));
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      let model = parseFile(before);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const a = findTier(model.lines, [chunk.anchor], strict, cursor);
          if (a === null) throw new Fail('no-match', p);
          cursor = a.occ[0]! + 1;
        }
        const { o, n } = splitON(chunk.body);
        if (o.length === 0) {
          const at = chunk.eof ? model.lines.length : cursor;
          model = { ...model, lines: [...model.lines.slice(0, at), ...n, ...model.lines.slice(at)] };
          cursor = at + n.length;
          continue;
        }
        const found = findTier(model.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let pos = -1;
        for (const k of found.occ) {
          if (chunk.eof) {
            if (k + o.length === model.lines.length) {
              pos = k;
              break;
            }
          } else {
            pos = k;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', p);
        const pfx = leadingWs(o[0]!);
        const f = leadingWs(model.lines[pos]!);
        const rep = buildReplacement(chunk.body, model.lines, pos, found.tier, pfx, f);
        model = { ...model, lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + o.length)] };
        cursor = pos + rep.length;
      }
      const content = serializeFile(model);
      if (sec.moveTo !== null) {
        tree.now.set(sec.moveTo, content);
        tree.now.set(p, null);
        tree.moves.push([p, sec.moveTo]);
      } else {
        tree.now.set(p, content);
      }
    };
  });
}

// ---- Section 9: JSON edits ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPairs: Array<{ old: string; nw: string }> = [];
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rPairs.push({ old, nw });
    }
  }
  const rOld = new Set(rPairs.map((r) => r.old));
  const rNew = new Set(rPairs.map((r) => r.nw));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of rPairs) rows.push({ key: r.nw, line: `R ${r.old} -> ${r.nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
