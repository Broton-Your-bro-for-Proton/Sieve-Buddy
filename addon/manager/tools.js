// Editor tools of the manager: diff before saving, outline, hover help, formatter, version history,
// simulator and the rule assistant. Wired up by manager.js through installTools().

import { fixRequire, tokenize } from '../lib/sieve-analyzer.js';
import { formatSieve, parseSieve } from '../lib/sieve-ast.js';
import { COMMANDS, EXTENSIONS, TAGS } from '../lib/sieve-dialect.js';
import { describeActions, insertBlockAt } from '../lib/sieve-rules.js';
import { planRule } from '../lib/rule-planner.js';
import { simulate } from '../lib/sieve-sim.js';
import { deleteRule, findSections, moveRule, resolveSection, ruleUnits, suggestSections } from '../lib/sieve-sections.js';
import { RULE_TEMPLATES, TEMPLATE_CATEGORIES, buildTemplate, templateDefaults } from '../lib/sieve-templates.js';
import { dateLocale, t } from '../lib/i18n.js';
import { messageFromThunderbird, parseHeaderBlock } from '../lib/mail.js';
import { $, asScripts, describeSimulation, el, getHistory, openModal, renderDiff, storage, toast } from '../shared/env.js';

/** Asks for confirmation with a diff of what changes. */
export async function confirmDiff(before, after, title, confirmLabel = t('Save')) {
  const box = el('div', { class: 'diff' });
  const stats = renderDiff(box, before, after);
  return openModal({
    title,
    wide: true,
    key: 'diff',
    body: [el('p', { class: 'muted' }, t('+{added} / −{removed} lines', { added: stats.added, removed: stats.removed })), box],
    actions: [
      { label: t('Cancel'), class: 'ghost', value: false },
      { label: confirmLabel, value: true },
    ],
  });
}

/**
 * @param {object} editor CodeMirror instance
 * @param {object} state  manager state (filters, folders, labels, selectedId, offline)
 * @returns {{renderOutline: () => void}}
 */
export function installTools(editor, state) {
  // ---------- outline ----------

  const summarizeActions = (block) => {
    const a = describeActions(block);
    if (!a) return block.commands.map((c) => c.name).join(', ') || '–';
    return (
      [a.fileinto && `→ ${a.fileinto}`, a.seen && t('read'), a.flagged && t('star'), a.expireDays && t('delete after {days} d.', { days: a.expireDays }), a.stop && 'stop']
        .filter(Boolean)
        .join(' · ') || '–'
    );
  };

  /** Replaces the whole text as one undoable change, keeping the scroll position. */
  function replaceText(next, line) {
    const scroll = editor.getScrollInfo();
    editor.replaceRange(next, { line: 0, ch: 0 }, editor.posFromIndex(editor.getValue().length));
    editor.scrollTo(scroll.left, scroll.top);
    if (line) editor.setCursor({ line: line - 1, ch: 0 });
    // right away: the outline's buttons hold line numbers of the old text
    renderOutline();
  }

  const jumpTo = (line) => {
    editor.focus();
    editor.setCursor({ line: line - 1, ch: 0 });
    editor.scrollIntoView({ line: line - 1, ch: 0 }, 80);
  };

  function renderOutline() {
    const box = $('outline');
    const text = editor.getValue();
    let units;
    try {
      units = ruleUnits(text);
    } catch (error) {
      box.replaceChildren(el('div', { class: 'muted small' }, t('Outline unavailable: {message}', { message: error.message })));
      return;
    }
    const rules = units.filter((u) => u.type === 'rule');
    const items = units.map((u) => {
      if (u.type === 'heading') {
        const count = findSections(text).find((x) => x.line === u.line)?.rules.length ?? 0;
        return el('li', { class: 'outline-section', onclick: () => jumpTo(u.line) }, el('span', {}, u.title), el('span', { class: 'muted small' }, ` ${count}`));
      }
      const c = u.commands[0];
      const test = text.slice(c.test.start, c.test.end).replace(/\s+/g, ' ');
      const chain = u.commands.length > 1 ? ` (+${u.commands.length - 1} elsif/else)` : '';
      const button = (label, title, fn) =>
        el('button', {
          class: 'ghost tiny',
          type: 'button',
          title,
          onclick: (e) => {
            e.stopPropagation();
            fn();
          },
        }, label);
      // the outline is redrawn with a delay: after an edit the line may hold another rule
      const stale = () => editor.getValue().slice(u.start, u.end) !== text.slice(u.start, u.end) && (renderOutline(), true);
      const move = (delta) => {
        if (stale()) return;
        const next = moveRule(editor.getValue(), u.line, delta, u.nth);
        if (next === editor.getValue()) return;
        const moved = ruleUnits(next).find((x) => x.type === 'rule' && next.slice(x.start, x.end) === text.slice(u.start, u.end));
        replaceText(next, moved?.line);
      };
      return el(
        'li',
        { title: test, onclick: () => jumpTo(u.line) },
        el('span', { class: 'outline-test' }, `${c.name} ${test}${chain}`),
        el('span', { class: 'outline-actions' }, summarizeActions(c.block)),
        el(
          'span',
          { class: 'outline-tools' },
          button('↑', t('Move up one position (past a heading: into the previous section)'), () => move(-1)),
          button('↓', t('Move down one position (past a heading: into the next section)'), () => move(+1)),
          button('✕', t('Delete rule'), () => {
            if (stale()) return;
            if (!confirm(t('Delete the rule on line {line}?\n\n{rule}', { line: u.line, rule: `${c.name} ${test}` }))) return;
            replaceText(deleteRule(editor.getValue(), u.line, u.nth));
            toast(t('Rule deleted: save to apply (Ctrl+Z undoes it)'));
          }),
        ),
      );
    });
    const hasSections = units.some((u) => u.type === 'heading');
    box.replaceChildren(
      rules.length ? el('ul', {}, items) : el('div', { class: 'muted small' }, t('No rules yet')),
      rules.length > 2 && !hasSections
        ? el(
            'button',
            {
              class: 'ghost small',
              type: 'button',
              title: t('Insert headings by target folder without reordering rules'),
              onclick: async () => {
                const current = editor.getValue();
                const next = suggestSections(current);
                if (await confirmDiff(current, next, t('Suggest sections'), t('Apply to editor'))) {
                  replaceText(next);
                  toast(t('Sections inserted: adjust the names and save'));
                }
              },
            },
            t('Suggest sections'),
          )
        : '',
    );
  }

  let outlineTimer;
  editor.on('change', () => {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 300);
  });

  // ---------- hover help ----------

  let hoverTokens = null;
  editor.on('change', () => (hoverTokens = null));
  const tooltip = $('hover-tip');
  let hoverTimer;

  function docFor(text, index) {
    hoverTokens ??= tokenize(text).tokens;
    const tok = hoverTokens.find((x) => x.start <= index && index < x.end);
    if (!tok) return null;
    if (tok.type === 'identifier' && COMMANDS[tok.value]) {
      const c = COMMANDS[tok.value];
      return `${tok.value}: ${c.doc}${c.ext ? `\n(require "${c.ext}")` : ''}`;
    }
    if (tok.type === 'tag' && TAGS[tok.value]) {
      const tag = TAGS[tok.value];
      return `${tok.value}: ${tag.doc}${tag.ext ? `\n(require "${tag.ext}")` : ''}`;
    }
    if (tok.type === 'string' && EXTENSIONS[tok.value]) return t('Extension {name}: {doc}', { name: tok.value, doc: EXTENSIONS[tok.value] });
    return null;
  }

  const wrapper = editor.getWrapperElement();
  wrapper.addEventListener('mousemove', (e) => {
    clearTimeout(hoverTimer);
    tooltip.hidden = true;
    hoverTimer = setTimeout(() => {
      const pos = editor.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
      const doc = docFor(editor.getValue(), editor.indexFromPos(pos));
      if (!doc) return;
      tooltip.textContent = doc;
      tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 340)}px`;
      tooltip.style.top = `${e.clientY + 16}px`;
      tooltip.hidden = false;
    }, 450);
  });
  wrapper.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    tooltip.hidden = true;
  });

  // ---------- formatter ----------

  $('format').addEventListener('click', () => {
    const formatted = formatSieve(editor.getValue());
    if (formatted === editor.getValue()) {
      toast(t('Already formatted'));
      return;
    }
    const cursor = editor.getCursor();
    editor.setValue(formatted);
    editor.setCursor(cursor);
    toast(t('Formatted'));
  });

  // ---------- history ----------

  $('history').addEventListener('click', async () => {
    const versions = await getHistory(state.selectedId);
    if (!versions.length) {
      toast(t('There are no saved versions for this filter yet'));
      return;
    }
    const diffBox = el('div', { class: 'diff' });
    let chosen = versions[0];
    const list = el(
      'ul',
      { class: 'version-list' },
      versions.map((v, i) =>
        el(
          'li',
          {
            class: i === 0 ? 'selected' : '',
            onclick: (e) => {
              chosen = v;
              for (const li of list.children) li.classList.remove('selected');
              e.currentTarget.classList.add('selected');
              renderDiff(diffBox, editor.getValue(), v.sieve);
            },
          },
          new Date(v.at).toLocaleString(dateLocale()),
          el('span', { class: 'muted small' }, ` ${v.name}`),
        ),
      ),
    );
    renderDiff(diffBox, editor.getValue(), chosen.sieve);
    const restore = await openModal({
      title: t('History'),
      wide: true,
      key: 'history',
      body: el(
        'div',
        { class: 'split' },
        list,
        el('div', {}, el('p', { class: 'muted small' }, t('Changes compared to the editor if you restore this version:')), diffBox),
      ),
      actions: [
        { label: t('Close'), class: 'ghost', value: false },
        { label: t('Apply to editor'), value: true },
      ],
    });
    if (restore) {
      editor.setValue(chosen.sieve);
      toast(t('Version restored: save to apply it at Proton'));
    }
  });

  // ---------- simulator ----------

  const headersToText = (headers) =>
    Object.entries(headers)
      .flatMap(([name, values]) => values.map((v) => `${name}: ${v}`))
      .join('\n');

  $('simulate').addEventListener('click', async () => {
    const input = el('textarea', {
      class: 'headers-input',
      rows: 9,
      placeholder: 'From: Jane <jane@example.com>\nTo: ich@proton.me\nSubject: …\nList-Id: <liste.example.com>',
    });
    input.value = (await storage.get('simHeaders')) ?? '';
    const result = el('div', { class: 'sim-result' });
    const sizeInput = el('input', { type: 'number', min: 0, value: 20, class: 'days' });
    const spamInput = el('input', { type: 'number', min: 0, value: 0, class: 'days' });

    const run = () => {
      const raw = input.value.trim();
      storage.set('simHeaders', raw);
      if (!raw) {
        result.replaceChildren(el('div', { class: 'muted' }, t('Paste the headers of a mail or take them from Thunderbird.')));
        return;
      }
      const message = { headers: parseHeaderBlock(raw), size: Number(sizeInput.value || 0) * 1024 };
      const scripts = asScripts(state.filters);
      const current = {
        id: state.selectedId ?? 'editor',
        name: $('filter-name').value || t('Editor'),
        sieve: editor.getValue(),
        enabled: $('filter-enabled').checked,
      };
      const idx = scripts.findIndex((x) => x.id === current.id);
      if (idx === -1) scripts.push(current);
      else scripts[idx] = current;
      // on servers with a single active script only one runs: test the one in the editor as if it were active
      const runnable = state.caps.multipleActive ? scripts : [{ ...current, enabled: true }];
      const r = simulate(runnable, message, { labels: state.labels, spamScore: Number(spamInput.value || 0), semantics: state.caps.semantics ?? 'proton' });
      result.replaceChildren(
        el('div', { class: 'sim-headline' }, describeSimulation(r)),
        ...r.fired
          .filter((f) => !f.test.includes('vnd.proton.spam-threshold'))
          .map((f) =>
            el(
              'div',
              {
                class: `sim-fired${f.scriptId === current.id ? ' jump' : ''}`,
                onclick: () => {
                  if (f.scriptId !== current.id) return;
                  editor.focus();
                  editor.setCursor({ line: f.line - 1, ch: 0 });
                },
              },
              t('↳ “{script}” line {line}: {test}', { script: f.script, line: f.line, test: f.test }),
            ),
          ),
        r.stoppedBy ? el('div', { class: 'muted small' }, t('Processing ends in “{script}” ({reason})', { script: r.stoppedBy.script, reason: r.stoppedBy.reason })) : '',
        ...r.notes.map((n) => el('div', { class: 'muted small' }, `ℹ ${n}`)),
      );
    };
    for (const node of [input, sizeInput, spamInput]) node.addEventListener('input', run);

    const fromMail = el(
      'button',
      {
        class: 'ghost',
        type: 'button',
        hidden: !globalThis.browser?.mailTabs,
        onclick: async () => {
          try {
            const selected = await browser.mailTabs.getSelectedMessages();
            const msg = selected.messages?.[0];
            if (!msg) throw new Error(t('No mail is selected in Thunderbird'));
            const full = await browser.messages.getFull(msg.id);
            input.value = headersToText(messageFromThunderbird(full, { size: msg.size }).headers);
            sizeInput.value = Math.round((msg.size ?? 0) / 1024);
            run();
          } catch (error) {
            toast(error.message, true);
          }
        },
      },
      t('Use selected mail'),
    );
    run();
    await openModal({
      title: t('Test a mail against the filters'),
      wide: true,
      key: 'simulate',
      body: [
        el('p', { class: 'muted small' }, t('Proton filters only see the headers of a mail. All active filters are tested in order, the current filter as it is in the editor.')),
        el('div', { class: 'row tight' }, fromMail, el('label', { class: 'inline' }, t('Size (KB)'), sizeInput), el('label', { class: 'inline' }, t('Spam score'), spamInput)),
        input,
        result,
      ],
      actions: [{ label: t('Close'), class: 'ghost' }],
    });
  });

  // ---------- rule assistant ----------

  function folderInput(value) {
    const system = state.dialect.proton ? ['inbox', 'archive', 'trash', 'spam'] : ['INBOX'];
    const options = [...new Set([...state.folders, ...state.labels, ...system])];
    if (state.offline || !state.folders.length) {
      const id = `folders-${Math.random().toString(36).slice(2)}`;
      const input = el('input', { value: value ?? '' });
      input.setAttribute('list', id);
      return el('span', { class: 'field' }, input, el('datalist', { id }, options.map((o) => el('option', { value: o }))));
    }
    return el(
      'select',
      {},
      el('option', { value: '' }, t("(don't move)")),
      options.map((o) => el('option', { value: o, selected: o === value }, o)),
    );
  }

  $('assistant').addEventListener('click', async () => {
    const templates = RULE_TEMPLATES.filter((t) => state.dialect.proton || !t.protonOnly);
    let template = templates[0];
    let inputs = {};
    let result = null;
    const form = el('div', { class: 'tpl-form' });
    const preview = el('div', { class: 'diff' });
    const info = el('div', { class: 'plan small' });

    const fieldOf = (node) => (node.matches('input, select, textarea') ? node : node.querySelector('input, select, textarea'));
    const values = () =>
      Object.fromEntries(
        Object.entries(inputs).map(([id, node]) => {
          const field = fieldOf(node);
          return [id, field.type === 'checkbox' ? field.checked : field.value];
        }),
      );

    // same section choice as "Sieve rule from mail"
    const sections = findSections(editor.getValue());
    const sectionSelect = el(
      'select',
      {},
      el('option', { value: 'auto' }, sections.length ? t('Automatic: find a matching section') : t('Automatic: best position')),
      ...sections.map((x) => el('option', { value: `s:${x.title}` }, t('In section “{title}”', { title: x.title }))),
      el('option', { value: 'end' }, t('At the end')),
      el('option', { value: 'new' }, t('New section …')),
    );
    const sectionName = el('input', { placeholder: t('Name of the new section'), hidden: true });
    const sectionChoice = () => {
      sectionName.hidden = sectionSelect.value !== 'new';
      if (sectionSelect.value === 'new') return sectionName.value.trim() ? { new: sectionName.value.trim() } : null;
      return sectionSelect.value.startsWith('s:') ? sectionSelect.value.slice(2) : sectionSelect.value;
    };

    const refresh = () => {
      try {
        const params = values();
        if (!state.dialect.proton) delete params.expireDays;
        const built = buildTemplate(template, params);
        const current = editor.getValue();
        const section = sectionChoice();
        if (section === null) throw new Error(t('Please enter a name for the new section.'));
        if (built.code) {
          const r = resolveSection(current, section, { actions: {} }, { category: template.category });
          result = insertBlockAt(current, built.code, r.at, r.heading);
          const placed = r.heading ? { title: r.heading, new: true } : r.section;
          const text = !placed
            ? t('Will be inserted as a new block at the end.')
            : placed.new
              ? t('Will be inserted as a new block in the new section “{title}”.', { title: placed.title })
              : t('Will be inserted as a new block in section “{title}”.', { title: placed.title });
          info.replaceChildren(el('div', {}, text));
        } else {
          const { plan } = planRule({
            scripts: [{ id: 'editor', name: 'Editor', sieve: current }],
            rule: built.rule,
            target: 'editor',
            section,
            category: template.category,
            dialect: state.dialect,
          });
          result = plan.sieve;
          const merges = plan.steps.filter((x) => x.kind !== 'new-block' && x.kind !== 'covered').length;
          const covered = plan.steps.filter((x) => x.kind === 'covered').length;
          const fresh = plan.steps.length - merges - covered;
          const counts = { steps: plan.steps.length, merges, covered, fresh };
          const where = fresh ? plan.section : null;
          const text = !where
            ? t('{steps} condition(s): {merges} merged into existing blocks, {covered} already present, {fresh} new.', counts)
            : where.new
              ? t('{steps} condition(s): {merges} merged into existing blocks, {covered} already present, {fresh} new in the new section “{title}”.', { ...counts, title: where.title })
              : t('{steps} condition(s): {merges} merged into existing blocks, {covered} already present, {fresh} new in section “{title}”.', { ...counts, title: where.title });
          info.replaceChildren(el('div', {}, text));
        }
        renderDiff(preview, current, result);
      } catch (error) {
        result = null;
        info.replaceChildren(el('div', { class: 'warn' }, error.message));
        preview.replaceChildren();
      }
    };
    sectionSelect.addEventListener('change', refresh);
    sectionName.addEventListener('input', refresh);

    const list = el('ul', { class: 'tpl-list' });
    const showTemplate = (t) => {
      template = t;
      inputs = {};
      const defaults = templateDefaults(t);
      form.replaceChildren(
        el('h3', {}, t.name),
        el('p', { class: 'muted small' }, t.description),
        ...t.params.filter((p) => state.dialect.proton || p.id !== 'expireDays').map((p) => {
          let input;
          if (p.type === 'bool') input = el('input', { type: 'checkbox', checked: Boolean(defaults[p.id]) });
          else if (p.type === 'folder') input = folderInput(defaults[p.id]);
          else if (p.type === 'number') input = el('input', { type: 'number', value: defaults[p.id] ?? '', min: 1 });
          // one value per line (the label is translated, so decide by the parameter)
          else if (['addresses', 'domains', 'ids', 'words'].includes(p.id)) input = el('textarea', { rows: 4, value: defaults[p.id] ?? '', placeholder: p.placeholder ?? '' });
          else input = el('input', { value: defaults[p.id] ?? '', placeholder: p.placeholder ?? '' });
          inputs[p.id] = input;
          input.addEventListener('input', refresh);
          input.addEventListener('change', refresh);
          return p.type === 'bool' ? el('label', { class: 'switch' }, input, ` ${p.label}`) : el('label', {}, p.label, input);
        }),
      );
      for (const li of list.querySelectorAll('li[data-id]')) li.classList.toggle('selected', li.dataset.id === t.id);
      refresh();
    };
    list.append(
      ...TEMPLATE_CATEGORIES.flatMap((cat) => [
        el('li', { class: 'tpl-cat' }, cat),
        ...templates.filter((t) => t.category === cat).map((t) => {
          const li = el('li', { onclick: () => showTemplate(t) }, t.name);
          li.dataset.id = t.id;
          return li;
        }),
      ]),
    );
    showTemplate(template);

    const insert = await openModal({
      title: t('Rule assistant'),
      wide: true,
      key: 'assistant',
      body: el(
        'div',
        { class: 'tpl-layout' },
        list,
        el('div', { class: 'tpl-main' }, form, el('label', { class: 'inline' }, t('Where to add it?'), sectionSelect, sectionName), info, preview),
      ),
      actions: [
        { label: t('Cancel'), class: 'ghost', value: false },
        { label: t('Apply to editor'), value: true },
      ],
    });
    if (insert && result) {
      editor.setValue(result);
      toast(t('Rule applied: review and save'));
    }
  });

  return { renderOutline };
}
