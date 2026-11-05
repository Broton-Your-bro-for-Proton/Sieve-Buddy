// Sections of one large script: top-level comment headings such as "# Newsletter", "### Shops ###" or a
// title between "# =====" lines. New rules go into the matching section; the manager lists, moves and
// deletes rules per section. Pure text functions, shared by the add-on and the service.

import { lineOf, parseSieve } from './sieve-ast.js';
import { describeActions, sameActions } from './sieve-rules.js';

const GUARD_TEXT = 'vnd.proton.spam-threshold';
const GUARD_COMMENT = 'Do not run this script on spam messages';
const DIVIDER = /^[\s=\-*#~_+]*$/;
const MAX_TITLE = 60;

const commentText = (line) => {
  const m = line.match(/^[ \t]*(?:#(.*)|\/\*(.*)\*\/[ \t]*)$/);
  return m ? (m[1] ?? m[2]) : null;
};
const cleanTitle = (raw) => raw.replace(/^[\s=\-*#~_+]+|[\s=\-*#~_+]+$/g, '').trim();
const isStrong = (raw) => /^#/.test(raw) || /[=\-*#~_+]{3,}/.test(raw);

/** Top-level rule chains (if + following elsif/else) and other commands, guard excluded. */
function topLevel(text) {
  const ast = parseSieve(text);
  const chains = [];
  for (const command of ast.commands) {
    if ((command.name === 'elsif' || command.name === 'else') && chains.at(-1)?.rule) {
      chains.at(-1).end = command.end;
      chains.at(-1).commands.push(command);
      continue;
    }
    const isGuard = command.test && text.slice(command.test.start, command.test.end).includes(GUARD_TEXT);
    chains.push({ start: command.start, end: command.end, commands: [command], rule: command.name === 'if' && !isGuard });
  }
  return chains;
}

const lineStartOf = (text, offset) => text.lastIndexOf('\n', offset - 1) + 1;
const lineEndOf = (text, offset) => {
  const i = text.indexOf('\n', offset);
  return i === -1 ? text.length : i;
};

/** Comment paragraphs in the gaps between top-level commands. */
function paragraphs(text, chains) {
  const gaps = [];
  let from = 0;
  for (const c of chains) {
    gaps.push([from, c.start]);
    from = c.end;
  }
  gaps.push([from, text.length]);
  const result = [];
  for (const [gs, ge] of gaps) {
    let offset = gs;
    let current = null;
    for (const line of text.slice(gs, ge).split('\n')) {
      const start = offset;
      offset += line.length + 1;
      // only whole lines: the first piece may be the rest of a command's line
      const whole = start === lineStartOf(text, start) && start + line.length === lineEndOf(text, start);
      const raw = whole ? commentText(line) : null;
      if (raw === null) {
        current = null;
        continue;
      }
      if (!current) {
        current = { start, end: start + line.length, lines: [] };
        result.push(current);
      }
      current.end = start + line.length;
      current.lines.push(raw);
    }
  }
  return result;
}

/** Comment paragraphs that act as headings, with their title. */
function headings(text, chains) {
  const found = paragraphs(text, chains)
    .filter((p) => !p.lines.some((l) => l.includes(GUARD_COMMENT)))
    .map((p) => {
      const titleLine = p.lines.find((l) => !DIVIDER.test(l));
      if (titleLine === undefined) return null;
      const strong = p.lines.some((l) => DIVIDER.test(l)) || isStrong(titleLine);
      return { title: cleanTitle(titleLine), start: p.start, headerEnd: p.end, line: lineOf(text, p.start), strong };
    })
    .filter((h) => h && h.title && h.title.length <= MAX_TITLE);
  // decorated headings win; plain comments only count when the file has no decorated ones
  return found.some((h) => h.strong) ? found.filter((h) => h.strong) : found;
}

/**
 * @returns {Array<{index: number, title: string, line: number, start: number, headerEnd: number, end: number,
 *   rules: Array<{start: number, end: number, line: number, commands: object[]}>}>}
 */
export function findSections(text) {
  let chains;
  try {
    chains = topLevel(text);
  } catch {
    return [];
  }
  const heads = headings(text, chains);
  return heads.map((h, index) => {
    const end = heads[index + 1]?.start ?? text.length;
    const rules = chains.filter((c) => c.rule && c.start >= h.headerEnd && c.start < end).map((c) => ({ ...c, line: lineOf(text, c.start) }));
    return { index, title: h.title, line: h.line, start: h.start, headerEnd: h.headerEnd, end, rules };
  });
}

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

/**
 * Picks the section a rule belongs to: the one whose rules already do the same (or file into the same
 * folder), else the one whose title matches the folder or the template category. null = end of the file.
 * @param {ReturnType<typeof findSections>} sections
 * @param {{actions: object}} rule
 * @param {{category?: string}} [hints]
 */
export function chooseSection(sections, rule, hints = {}) {
  const folderWords = words(rule.actions?.fileinto?.split('/').at(-1));
  const categoryWords = words(hints.category);
  let best = null;
  for (const section of sections) {
    let score = 0;
    for (const r of section.rules) {
      const actions = r.commands[0].block && describeActions(r.commands[0].block);
      if (!actions) continue;
      if (sameActions(actions, rule.actions)) score += 10;
      else if (rule.actions?.fileinto && actions.fileinto === rule.actions.fileinto) score += 6;
    }
    const title = words(section.title);
    const hit = (list) => list.some((w) => title.some((t) => t.startsWith(w) || w.startsWith(t)));
    if (hit(folderWords)) score += 5;
    if (hit(categoryWords)) score += 4;
    if (score > (best?.score ?? 0)) best = { section, score };
  }
  return best?.section ?? null;
}

/**
 * Where a new block goes in a section: after its last rule, or right below its heading.
 * @returns {{offset: number, sep: string}}
 */
export function sectionInsertPoint(section) {
  const last = section.rules.at(-1);
  return last ? { offset: last.end, sep: '\n\n' } : { offset: section.headerEnd, sep: '\n' };
}

/** Resolves a section choice: 'auto' | 'end' | title | index | {new: title}. */
export function resolveSection(text, choice, rule, hints) {
  if (choice && typeof choice === 'object' && choice.new) return { section: null, at: null, heading: String(choice.new).trim() };
  if (choice === 'end') return { section: null, at: null };
  const sections = findSections(text);
  if (!sections.length) return { section: null, at: null };
  const section =
    choice === undefined || choice === null || choice === 'auto'
      ? chooseSection(sections, rule, hints)
      : sections.find((s) => s.title === choice || s.index === choice) ?? chooseSection(sections, rule, hints);
  return section ? { section, at: sectionInsertPoint(section) } : { section: null, at: null };
}

// ---------- Rule units for the manager: list, move, delete ----------

/**
 * Headings and rules in file order. A rule's range covers whole lines, including comment lines directly
 * above it that are not a heading.
 * @returns {Array<{type: 'heading'|'rule', start: number, end: number, line: number, title?: string, commands?: object[]}>}
 */
export function ruleUnits(text) {
  const chains = topLevel(text);
  const heads = headings(text, chains);
  const headStarts = new Set(heads.map((h) => h.start));
  const comments = paragraphs(text, chains).filter((p) => !headStarts.has(p.start));
  const units = heads.map((h) => ({ type: 'heading', title: h.title, start: h.start, end: h.headerEnd }));
  for (const c of chains.filter((x) => x.rule)) {
    let start = lineStartOf(text, c.start);
    // comment paragraph ending on the line right above belongs to the rule
    const attached = comments.find((p) => p.end + 1 === start);
    if (attached) start = attached.start;
    units.push({ type: 'rule', start, end: lineEndOf(text, c.end), commands: c.commands, ruleStart: c.start });
  }
  return units.sort((a, b) => a.start - b.start).map((u) => ({ ...u, line: lineOf(text, u.ruleStart ?? u.start) }));
}

/**
 * Moves the rule starting at `line` one step up (-1) or down (+1). Passing a heading moves the rule into
 * the neighboring section. Returns the unchanged text when there is nothing to swap with.
 */
export function moveRule(text, line, delta) {
  const units = ruleUnits(text);
  const i = units.findIndex((u) => u.type === 'rule' && u.line === line);
  if (i === -1) throw new Error(`In Zeile ${line} beginnt keine Regel`);
  const j = i + delta;
  if (j < 0 || j >= units.length) return text;
  const [a, b] = delta < 0 ? [units[j], units[i]] : [units[i], units[j]];
  const between = text.slice(a.end, b.start);
  const head = text.slice(0, a.start);
  const [aText, bText] = [text.slice(a.start, a.end), text.slice(b.start, b.end)];
  if (a.type === 'rule' && b.type === 'rule') return head + bText + between + aText + text.slice(b.end);
  // across a heading the blank lines stay with the heading: "# H\nrule" stays tight, the gap before H stays a gap
  let after = text.slice(b.end).match(/^\n(?:[ \t]*\n)*/)?.[0] ?? '';
  const rest = text.slice(b.end + after.length);
  if (!rest) return head + bText + between + aText + after;
  // a rule's own comment right under a heading would read as part of the heading
  const tight = (s) => !/\n[ \t]*\n/.test(s);
  if (b.type === 'heading' && tight(after) && commentText(aText.split('\n')[0]) !== null) after = '\n\n';
  return head + bText + after + aText + between + rest;
}

/** Removes the rule starting at `line`, with the blank lines that separated it. */
export function deleteRule(text, line) {
  const unit = ruleUnits(text).find((u) => u.type === 'rule' && u.line === line);
  if (!unit) throw new Error(`In Zeile ${line} beginnt keine Regel`);
  const before = text.slice(0, unit.start);
  const after = text.slice(unit.end + 1);
  // keep a single blank line between the neighbors
  return before === '' || before.endsWith('\n\n') ? before + after.replace(/^([ \t]*\n)+/, '') : before + after;
}

/**
 * Suggests headings for a file without sections: one per run of consecutive rules with the same target,
 * without moving anything (order matters in Sieve). Returns the text with headings inserted.
 */
export function suggestSections(text) {
  const rules = ruleUnits(text).filter((u) => u.type === 'rule');
  const titleOf = (unit) => {
    const actions = unit.commands[0].block && describeActions(unit.commands[0].block);
    if (!actions) return 'Sonstiges';
    if (actions.fileinto) return actions.fileinto;
    if (actions.flagged) return 'Markieren';
    if (actions.seen) return 'Als gelesen';
    return 'Sonstiges';
  };
  const inserts = [];
  let previous = null;
  for (const unit of rules) {
    const title = titleOf(unit);
    if (title !== previous) inserts.push({ at: unit.start, title });
    previous = title;
  }
  let out = text;
  for (const { at, title } of inserts.reverse()) out = `${out.slice(0, at)}# ===== ${title} =====\n${out.slice(at)}`;
  return out;
}
