// Sections of one large script: top-level comment headings such as "# Newsletter", "### Shops ###" or a
// title between "# =====" lines. New rules go into the matching section; the manager lists, moves and
// deletes rules per section. Pure text functions, shared by the add-on and the service.

import { otherLanguage, t } from './i18n.js';
import { lineOf, parseSieve } from './sieve-ast.js';
import { describeActions, sameEffect } from './sieve-rules.js';

const GUARD_TEXT = 'vnd.proton.spam-threshold';
const GUARD_COMMENT = 'Do not run this script on spam messages';
const DIVIDER = /^[\s=\-*#~_+]*$/;
const MAX_TITLE = 60;

const commentText = (line) => {
  const m = line.replace(/\r$/, '').match(/^[ \t]*(?:#(.*)|\/\*(.*)\*\/[ \t]*)$/);
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

/** Every top-level command on its own: an elsif is a rule of the section it sits in, not of its chain's. */
function links(text) {
  return parseSieve(text).commands.map((command) => {
    const isGuard = command.test && text.slice(command.test.start, command.test.end).includes(GUARD_TEXT);
    return { start: command.start, end: command.end, commands: [command], rule: Boolean(command.block) && !isGuard };
  });
}

/** Whether `c` belongs to the chain that continues at `next`: only elsif/else between them. */
const sameChain = (all, next, c) => !all.some((x) => x.start > next.start && x.start <= c.start && !['elsif', 'else'].includes(x.commands[0].name));

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
      // end before a CR, so text inserted after a heading lands before the line break
      const end = start + line.replace(/\r$/, '').length;
      if (!current) {
        current = { start, end, lines: [] };
        result.push(current);
      }
      current.end = end;
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
      // long lines are prose, not titles (and would make cleanTitle slow)
      if (titleLine === undefined || titleLine.length > 200) return null;
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
    chains = links(text);
  } catch {
    return [];
  }
  const heads = headings(text, chains);
  return heads.map((h, index) => {
    const end = heads[index + 1]?.start ?? text.length;
    const inside = chains.filter((c) => c.start >= h.headerEnd && c.start < end);
    // a comment on the same line after "}" stays with its rule when a block is inserted after it
    const tailEnd = (c) => c.end + (/^[ \t]*#[^\n]*/.exec(text.slice(c.end))?.[0].length ?? 0);
    const rules = inside.filter((c) => c.rule).map((c) => ({ ...c, line: lineOf(text, c.start), tailEnd: tailEnd(c) }));
    // require or the spam guard right under a heading: new blocks go after them
    const setupEnd = Math.max(h.headerEnd, ...inside.filter((c) => !c.rule && (!rules.length || c.start < rules[0].start)).map((c) => c.end));
    // inserting in the middle of an if/elsif chain: the new rule has to be an elsif too, or the chain breaks
    const offset = rules.length ? rules.at(-1).tailEnd : setupEnd;
    const next = chains.find((c) => c.start >= offset);
    const elsif = ['elsif', 'else'].includes(next?.commands[0].name);
    // what comes after the insertion point: the rest of the chain, then every later rule
    const later = chains.filter((c) => c.rule && c.start >= offset).map((c) => ({ command: c.commands[0], line: lineOf(text, c.start), chain: elsif && sameChain(chains, next, c) }));
    return { index, title: h.title, line: h.line, start: h.start, headerEnd: h.headerEnd, setupEnd, end, rules, elsif, later };
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
  // section titles are the user's own words: compare with the category in both languages
  const categoryWords = [...words(hints.category), ...words(otherLanguage(hints.category))];
  let best = null;
  for (const section of sections) {
    let score = 0;
    for (const r of section.rules) {
      const actions = r.commands[0].block && describeActions(r.commands[0].block);
      if (!actions) continue;
      if (sameEffect(actions, rule.actions)) score += 10;
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
  const elsif = Boolean(section.elsif);
  if (last) return { offset: last.tailEnd ?? last.end, sep: elsif ? '\n' : '\n\n', elsif };
  return section.setupEnd > section.headerEnd ? { offset: section.setupEnd, sep: '\n\n', elsif } : { offset: section.headerEnd, sep: '\n', elsif };
}

/**
 * Later rules that lose messages to a rule placed in this section as an elsif: it skips the rest of its chain.
 * Every link with an action counts, unless it does exactly what the new rule does. (A stop the planner adds on
 * its own is deliberate and already explained in its note.)
 * @returns {Array<{folder: string|null, line: number}>}
 */
export function displacedBy(section, rule) {
  return (section.later ?? [])
    .filter((l) => l.chain)
    .map((l) => ({ ...l, actions: l.command.block && describeActions(l.command.block) }))
    .filter((l) => !l.actions || !sameEffect(rule.actions ?? {}, l.actions) || !sameEffect(l.actions, rule.actions ?? {}))
    .map((l) => ({ folder: l.actions?.fileinto ?? null, line: l.line }));
}

/** The note for a section choice that skipped a section or takes messages from later rules, or null. */
export function sectionNote({ skipped, section, displaced }) {
  const list = (rules) => rules.map((r) => (r.folder ? t('“{s}” (line {line})', { s: r.folder, line: r.line }) : t('the rule in line {line}', { line: r.line }))).join(', ');
  if (skipped) {
    return t('Not in section “{title}”: there it would come before {rules}, and messages matching both would no longer reach them. Choose the section under “Where to add it?” to put it there anyway.', {
      title: skipped.title,
      rules: list(skipped.displaced),
    });
  }
  if (section && displaced?.length) {
    return t('In section “{title}” it comes before {rules}: messages matching both go to the new rule from now on.', { title: section.title, rules: list(displaced) });
  }
  return null;
}

/** Resolves a section choice: 'auto' | 'end' | title | index | {new: title}. */
export function resolveSection(text, choice, rule, hints) {
  if (choice && typeof choice === 'object' && choice.new) return { section: null, at: null, heading: String(choice.new).replace(/[\r\n]+/g, ' ').trim() };
  if (choice === 'end') return { section: null, at: null };
  const sections = findSections(text);
  if (!sections.length) return { section: null, at: null };
  const auto = choice === undefined || choice === null || choice === 'auto';
  const section = auto ? chooseSection(sections, rule, hints) : (sections.find((s) => s.title === choice || s.index === choice) ?? chooseSection(sections, rule, hints));
  if (!section) return { section: null, at: null };
  const displaced = displacedBy(section, rule);
  // the automatic choice never takes messages away from other rules; an explicit one may, with a warning
  if (auto && displaced.length) return { section: null, at: null, skipped: { title: section.title, displaced } };
  return { section, at: sectionInsertPoint(section), displaced };
}

// ---------- Rule units for the manager: list, move, delete ----------

/**
 * Headings and rules in file order. A rule's range covers whole lines, including comment lines directly
 * above it that are not a heading.
 * @returns {Array<{type: 'heading'|'rule', start: number, end: number, line: number, title?: string, commands?: object[]}>}
 */
export function ruleUnits(text) {
  const chains = topLevel(text);
  const rules = chains.filter((x) => x.rule);
  // a plain (undecorated) heading right above the only rule of its section is that rule's label
  const heads = headings(text, chains).filter((h, i, all) => {
    if (h.strong) return true;
    const next = all[i + 1]?.start ?? text.length;
    const own = rules.filter((c) => c.start > h.headerEnd && c.start < next);
    return !(own.length === 1 && lineStartOf(text, own[0].start) === h.headerEnd + 1);
  });
  const headStarts = new Set(heads.map((h) => h.start));
  const comments = paragraphs(text, chains).filter((p) => !headStarts.has(p.start));
  const units = heads.map((h) => ({ type: 'heading', title: h.title, start: h.start, end: h.headerEnd }));
  for (const c of rules) {
    const lineStart = lineStartOf(text, c.start);
    const lineEnd = lineEndOf(text, c.end);
    // whole lines, unless other code shares the line (then just the rule itself)
    let start = text.slice(lineStart, c.start).trim() ? c.start : lineStart;
    const tail = text.slice(c.end, lineEnd);
    const end = tail.trim() && !/^\s*#/.test(tail) ? c.end : lineEnd;
    // comment paragraph ending on the line right above belongs to the rule
    const attached = start === lineStart && comments.find((p) => p.end === lineStart - 1);
    if (attached) start = attached.start;
    units.push({ type: 'rule', start, end, commands: c.commands, ruleStart: c.start });
  }
  const sorted = units.sort((a, b) => a.start - b.start).map((u) => ({ ...u, line: lineOf(text, u.ruleStart ?? u.start) }));
  // several rules can start on one line: nth tells them apart
  return sorted.map((u, i) => ({ ...u, nth: sorted.slice(0, i).filter((x) => x.type === u.type && x.line === u.line).length }));
}

/** Runs a text edit on LF line endings and gives the result back in the script's own line endings. */
const withLf = (text, edit) => (text.includes('\r\n') ? edit(text.replace(/\r\n/g, '\n')).replace(/\n/g, '\r\n') : edit(text));
const startsWithComment = (s) => commentText(s.split('\n')[0]) !== null;
const endsWithComment = (s) => s.endsWith('\n') && !/\n[ \t]*\n$/.test(s) && commentText(s.slice(0, -1).split('\n').at(-1)) !== null;

/**
 * Moves the rule starting at `line` (the `nth` one there, see ruleUnits) one step up (-1) or down (+1).
 * Passing a heading moves the rule into the neighboring section. Returns the unchanged text when there is
 * nothing to swap with.
 */
export function moveRule(text, line, delta, nth = 0) {
  return withLf(text, (lf) => moveLf(lf, line, delta, nth));
}

function moveLf(text, line, delta, nth) {
  const units = ruleUnits(text);
  const i = units.findIndex((u) => u.type === 'rule' && u.line === line && u.nth === nth);
  if (i === -1) throw new Error(t('No rule starts at line {line}', { line }));
  const j = i + delta;
  if (j < 0 || j >= units.length) return text;
  const [a, b] = delta < 0 ? [units[j], units[i]] : [units[i], units[j]];
  const between = text.slice(a.end, b.start);
  // a heading above require stays there: no rule may move before require
  if (/^[ \t]*require\b/m.test(between)) return text;
  const head = text.slice(0, a.start);
  const [aText, bText] = [text.slice(a.start, a.end), text.slice(b.start, b.end)];
  if (a.type === 'rule' && b.type === 'rule') return head + bText + between + aText + text.slice(b.end);
  // across a heading the blank lines stay with the heading: "# H\nrule" stays tight, the gap before H stays a gap
  let after = text.slice(b.end).match(/^\n(?:[ \t]*\n)*/)?.[0] ?? '';
  const rest = text.slice(b.end + after.length);
  // comment lines that end up next to each other would merge into one paragraph (and one heading)
  const tight = (s) => !/\n[ \t]*\n/.test(s);
  const gap = (s, next) => (tight(s) && startsWithComment(next) ? '\n\n' : s);
  const lead = b.type === 'heading' && endsWithComment(head) ? `${head}\n` : head;
  if (!rest) return lead + bText + between + aText + after;
  if (b.type === 'heading') after = gap(after, aText);
  return lead + bText + after + aText + (a.type === 'heading' ? gap(between, rest) : between) + rest;
}

/** Removes the rule starting at `line` (the `nth` one there), with the blank lines that separated it. */
export function deleteRule(text, line, nth = 0) {
  return withLf(text, (lf) => deleteLf(lf, line, nth));
}

function deleteLf(text, line, nth) {
  const unit = ruleUnits(text).find((u) => u.type === 'rule' && u.line === line && u.nth === nth);
  if (!unit) throw new Error(t('No rule starts at line {line}', { line }));
  const before = text.slice(0, unit.start);
  // other code on the same line: cut only the rule and the space next to it
  if (before && !before.endsWith('\n')) return before.replace(/[ \t]+$/, '') + text.slice(unit.end);
  if (unit.end < text.length && text[unit.end] !== '\n') return before + text.slice(unit.end).replace(/^[ \t]+/, '');
  const after = text.slice(text[unit.end] === '\n' ? unit.end + 1 : unit.end);
  // keep a single blank line between the neighbors
  return before === '' || before.endsWith('\n\n') ? before + after.replace(/^([ \t]*\n)+/, '') : before + after;
}

/**
 * Suggests headings for a file without sections: one per run of consecutive rules with the same target,
 * without moving anything (order matters in Sieve). Returns the text with headings inserted.
 */
export function suggestSections(text) {
  return withLf(text, suggestLf);
}

function suggestLf(text) {
  const rules = ruleUnits(text).filter((u) => u.type === 'rule');
  const titleOf = (unit) => {
    const actions = unit.commands[0].block && describeActions(unit.commands[0].block);
    if (!actions) return t('Other');
    if (actions.fileinto) return actions.fileinto.replace(/[\r\n]+/g, ' ');
    if (actions.flagged) return t('Flag');
    if (actions.seen) return t('Marked as read');
    return t('Other');
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
