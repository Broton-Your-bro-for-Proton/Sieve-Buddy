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
export async function confirmDiff(before, after, title, confirmLabel = t('Speichern')) {
  const box = el('div', { class: 'diff' });
  const stats = renderDiff(box, before, after);
  return openModal({
    title,
    wide: true,
    body: [el('p', { class: 'muted' }, t('+{added} / −{removed} Zeilen', { added: stats.added, removed: stats.removed })), box],
    actions: [
      { label: t('Abbrechen'), class: 'ghost', value: false },
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
    if (!a) return block.commands.map((c) => c.name).join(', ') || '—';
    return (
      [a.fileinto && `→ ${a.fileinto}`, a.seen && t('gelesen'), a.flagged && t('Stern'), a.expireDays && t('löschen nach {days} T.', { days: a.expireDays }), a.stop && 'stop']
        .filter(Boolean)
        .join(' · ') || '—'
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
      box.replaceChildren(el('div', { class: 'muted small' }, t('Gliederung nicht verfügbar: {message}', { message: error.message })));
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
      const move = (delta) => {
        const next = moveRule(editor.getValue(), u.line, delta);
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
          button('↑', t('Eine Stelle nach oben (über eine Überschrift: in den Abschnitt davor)'), () => move(-1)),
          button('↓', t('Eine Stelle nach unten (über eine Überschrift: in den Abschnitt danach)'), () => move(+1)),
          button('✕', t('Regel löschen'), () => {
            if (!confirm(t('Regel in Zeile {line} löschen?\n\n{rule}', { line: u.line, rule: `${c.name} ${test}` }))) return;
            replaceText(deleteRule(editor.getValue(), u.line));
            toast(t('Regel gelöscht – zum Übernehmen speichern (Strg+Z macht es rückgängig)'));
          }),
        ),
      );
    });
    const hasSections = units.some((u) => u.type === 'heading');
    box.replaceChildren(
      rules.length ? el('ul', {}, items) : el('div', { class: 'muted small' }, t('Noch keine Regeln')),
      rules.length > 2 && !hasSections
        ? el(
            'button',
            {
              class: 'ghost small',
              type: 'button',
              title: t('Überschriften nach Zielordner einfügen, ohne Regeln umzustellen'),
              onclick: async () => {
                const current = editor.getValue();
                const next = suggestSections(current);
                if (await confirmDiff(current, next, t('Abschnitte vorschlagen'), t('In den Editor übernehmen'))) {
                  replaceText(next);
                  toast(t('Abschnitte eingefügt – Namen anpassen und speichern'));
                }
              },
            },
            t('Abschnitte vorschlagen'),
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
      return `${tok.value} — ${c.doc}${c.ext ? `\n(require "${c.ext}")` : ''}`;
    }
    if (tok.type === 'tag' && TAGS[tok.value]) {
      const tag = TAGS[tok.value];
      return `${tok.value} — ${tag.doc}${tag.ext ? `\n(require "${tag.ext}")` : ''}`;
    }
    if (tok.type === 'string' && EXTENSIONS[tok.value]) return t('Erweiterung {name} — {doc}', { name: tok.value, doc: EXTENSIONS[tok.value] });
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
      toast(t('Bereits ordentlich formatiert'));
      return;
    }
    const cursor = editor.getCursor();
    editor.setValue(formatted);
    editor.setCursor(cursor);
    toast(t('Formatiert'));
  });

  // ---------- history ----------

  $('history').addEventListener('click', async () => {
    const versions = await getHistory(state.selectedId);
    if (!versions.length) {
      toast(t('Für diesen Filter gibt es noch keine gespeicherten Versionen'));
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
      title: t('Verlauf'),
      wide: true,
      body: el(
        'div',
        { class: 'split' },
        list,
        el('div', {}, el('p', { class: 'muted small' }, t('Änderungen gegenüber dem Editor, wenn du diese Version übernimmst:')), diffBox),
      ),
      actions: [
        { label: t('Schließen'), class: 'ghost', value: false },
        { label: t('In den Editor übernehmen'), value: true },
      ],
    });
    if (restore) {
      editor.setValue(chosen.sieve);
      toast(t('Version übernommen – zum Übernehmen bei Proton speichern'));
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
        result.replaceChildren(el('div', { class: 'muted' }, t('Header einer Mail einfügen oder aus Thunderbird übernehmen.')));
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
              t('↳ „{script}“ Zeile {line}: {test}', { script: f.script, line: f.line, test: f.test }),
            ),
          ),
        r.stoppedBy ? el('div', { class: 'muted small' }, t('Verarbeitung endet in „{script}“ ({reason})', { script: r.stoppedBy.script, reason: r.stoppedBy.reason })) : '',
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
            if (!msg) throw new Error(t('In Thunderbird ist keine Mail ausgewählt'));
            const full = await browser.messages.getFull(msg.id);
            input.value = headersToText(messageFromThunderbird(full, { size: msg.size }).headers);
            sizeInput.value = Math.round((msg.size ?? 0) / 1024);
            run();
          } catch (error) {
            toast(error.message, true);
          }
        },
      },
      t('Ausgewählte Mail übernehmen'),
    );
    run();
    await openModal({
      title: t('Mail gegen die Filter testen'),
      wide: true,
      body: [
        el('p', { class: 'muted small' }, t('Proton-Filter sehen nur die Header einer Mail. Getestet werden alle aktiven Filter in ihrer Reihenfolge – der aktuelle Filter mit dem Stand im Editor.')),
        el('div', { class: 'row tight' }, fromMail, el('label', { class: 'inline' }, t('Größe (KB)'), sizeInput), el('label', { class: 'inline' }, t('Spam-Score'), spamInput)),
        input,
        result,
      ],
      actions: [{ label: t('Schließen'), class: 'ghost' }],
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
      el('option', { value: '' }, t('— nicht verschieben —')),
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

    // same section choice as "Sieve-Regel aus Mail"
    const sections = findSections(editor.getValue());
    const sectionSelect = el(
      'select',
      {},
      el('option', { value: 'auto' }, sections.length ? t('Automatisch – passenden Abschnitt finden') : t('Automatisch – beste Stelle')),
      ...sections.map((x) => el('option', { value: `s:${x.title}` }, t('In Abschnitt „{title}“', { title: x.title }))),
      el('option', { value: 'end' }, t('Ans Ende')),
      el('option', { value: 'new' }, t('Neuer Abschnitt …')),
    );
    const sectionName = el('input', { placeholder: t('Name des neuen Abschnitts'), hidden: true });
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
        if (section === null) throw new Error(t('Bitte einen Namen für den neuen Abschnitt angeben.'));
        if (built.code) {
          const r = resolveSection(current, section, { actions: {} }, { category: template.category });
          result = insertBlockAt(current, built.code, r.at, r.heading);
          const placed = r.heading ? { title: r.heading, new: true } : r.section;
          const text = !placed
            ? t('Wird als neuer Block am Ende eingefügt.')
            : placed.new
              ? t('Wird als neuer Block im neuen Abschnitt „{title}“ eingefügt.', { title: placed.title })
              : t('Wird als neuer Block in Abschnitt „{title}“ eingefügt.', { title: placed.title });
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
            ? t('{steps} Bedingung(en): {merges} in bestehende Blöcke eingereiht, {covered} schon vorhanden, {fresh} neu.', counts)
            : where.new
              ? t('{steps} Bedingung(en): {merges} in bestehende Blöcke eingereiht, {covered} schon vorhanden, {fresh} neu im neuen Abschnitt „{title}“.', { ...counts, title: where.title })
              : t('{steps} Bedingung(en): {merges} in bestehende Blöcke eingereiht, {covered} schon vorhanden, {fresh} neu in Abschnitt „{title}“.', { ...counts, title: where.title });
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
      title: t('Regel-Assistent'),
      wide: true,
      body: el(
        'div',
        { class: 'tpl-layout' },
        list,
        el('div', { class: 'tpl-main' }, form, el('label', { class: 'inline' }, t('Wo eintragen?'), sectionSelect, sectionName), info, preview),
      ),
      actions: [
        { label: t('Abbrechen'), class: 'ghost', value: false },
        { label: t('In den Editor übernehmen'), value: true },
      ],
    });
    if (insert && result) {
      editor.setValue(result);
      toast(t('Regel übernommen – prüfen und speichern'));
    }
  });

  return { renderOutline };
}
