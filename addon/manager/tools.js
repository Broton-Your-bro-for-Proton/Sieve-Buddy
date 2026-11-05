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
import { messageFromThunderbird, parseHeaderBlock } from '../lib/mail.js';
import { $, asScripts, describeSimulation, el, getHistory, openModal, renderDiff, storage, toast } from '../shared/env.js';

/** Asks for confirmation with a diff of what changes. */
export async function confirmDiff(before, after, title, confirmLabel = 'Speichern') {
  const box = el('div', { class: 'diff' });
  const stats = renderDiff(box, before, after);
  return openModal({
    title,
    wide: true,
    body: [el('p', { class: 'muted' }, `+${stats.added} / −${stats.removed} Zeilen`), box],
    actions: [
      { label: 'Abbrechen', class: 'ghost', value: false },
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
      [a.fileinto && `→ ${a.fileinto}`, a.seen && 'gelesen', a.flagged && 'Stern', a.expireDays && `löschen nach ${a.expireDays} T.`, a.stop && 'stop']
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
      box.replaceChildren(el('div', { class: 'muted small' }, `Gliederung nicht verfügbar: ${error.message}`));
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
          button('↑', 'Eine Stelle nach oben (über eine Überschrift: in den Abschnitt davor)', () => move(-1)),
          button('↓', 'Eine Stelle nach unten (über eine Überschrift: in den Abschnitt danach)', () => move(+1)),
          button('✕', 'Regel löschen', () => {
            if (!confirm(`Regel in Zeile ${u.line} löschen?\n\n${c.name} ${test}`)) return;
            replaceText(deleteRule(editor.getValue(), u.line));
            toast('Regel gelöscht – zum Übernehmen speichern (Strg+Z macht es rückgängig)');
          }),
        ),
      );
    });
    const hasSections = units.some((u) => u.type === 'heading');
    box.replaceChildren(
      rules.length ? el('ul', {}, items) : el('div', { class: 'muted small' }, 'Noch keine Regeln'),
      rules.length > 2 && !hasSections
        ? el(
            'button',
            {
              class: 'ghost small',
              type: 'button',
              title: 'Überschriften nach Zielordner einfügen, ohne Regeln umzustellen',
              onclick: async () => {
                const current = editor.getValue();
                const next = suggestSections(current);
                if (await confirmDiff(current, next, 'Abschnitte vorschlagen', 'In den Editor übernehmen')) {
                  replaceText(next);
                  toast('Abschnitte eingefügt – Namen anpassen und speichern');
                }
              },
            },
            'Abschnitte vorschlagen',
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
    const t = hoverTokens.find((x) => x.start <= index && index < x.end);
    if (!t) return null;
    if (t.type === 'identifier' && COMMANDS[t.value]) {
      const c = COMMANDS[t.value];
      return `${t.value} — ${c.doc}${c.ext ? `\n(require "${c.ext}")` : ''}`;
    }
    if (t.type === 'tag' && TAGS[t.value]) {
      const tag = TAGS[t.value];
      return `${t.value} — ${tag.doc}${tag.ext ? `\n(require "${tag.ext}")` : ''}`;
    }
    if (t.type === 'string' && EXTENSIONS[t.value]) return `Erweiterung ${t.value} — ${EXTENSIONS[t.value]}`;
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
      toast('Bereits ordentlich formatiert');
      return;
    }
    const cursor = editor.getCursor();
    editor.setValue(formatted);
    editor.setCursor(cursor);
    toast('Formatiert');
  });

  // ---------- history ----------

  $('history').addEventListener('click', async () => {
    const versions = await getHistory(state.selectedId);
    if (!versions.length) {
      toast('Für diesen Filter gibt es noch keine gespeicherten Versionen');
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
          new Date(v.at).toLocaleString('de-DE'),
          el('span', { class: 'muted small' }, ` ${v.name}`),
        ),
      ),
    );
    renderDiff(diffBox, editor.getValue(), chosen.sieve);
    const restore = await openModal({
      title: 'Verlauf',
      wide: true,
      body: el(
        'div',
        { class: 'split' },
        list,
        el('div', {}, el('p', { class: 'muted small' }, 'Änderungen gegenüber dem Editor, wenn du diese Version übernimmst:'), diffBox),
      ),
      actions: [
        { label: 'Schließen', class: 'ghost', value: false },
        { label: 'In den Editor übernehmen', value: true },
      ],
    });
    if (restore) {
      editor.setValue(chosen.sieve);
      toast('Version übernommen – zum Übernehmen bei Proton speichern');
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
        result.replaceChildren(el('div', { class: 'muted' }, 'Header einer Mail einfügen oder aus Thunderbird übernehmen.'));
        return;
      }
      const message = { headers: parseHeaderBlock(raw), size: Number(sizeInput.value || 0) * 1024 };
      const scripts = asScripts(state.filters);
      const current = {
        id: state.selectedId ?? 'editor',
        name: $('filter-name').value || 'Editor',
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
              `↳ „${f.script}“ Zeile ${f.line}: ${f.test}`,
            ),
          ),
        r.stoppedBy ? el('div', { class: 'muted small' }, `Verarbeitung endet in „${r.stoppedBy.script}“ (${r.stoppedBy.reason})`) : '',
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
            if (!msg) throw new Error('In Thunderbird ist keine Mail ausgewählt');
            const full = await browser.messages.getFull(msg.id);
            input.value = headersToText(messageFromThunderbird(full, { size: msg.size }).headers);
            sizeInput.value = Math.round((msg.size ?? 0) / 1024);
            run();
          } catch (error) {
            toast(error.message, true);
          }
        },
      },
      'Ausgewählte Mail übernehmen',
    );
    run();
    await openModal({
      title: 'Mail gegen die Filter testen',
      wide: true,
      body: [
        el('p', { class: 'muted small' }, 'Proton-Filter sehen nur die Header einer Mail. Getestet werden alle aktiven Filter in ihrer Reihenfolge – der aktuelle Filter mit dem Stand im Editor.'),
        el('div', { class: 'row tight' }, fromMail, el('label', { class: 'inline' }, 'Größe (KB)', sizeInput), el('label', { class: 'inline' }, 'Spam-Score', spamInput)),
        input,
        result,
      ],
      actions: [{ label: 'Schließen', class: 'ghost' }],
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
      el('option', { value: '' }, '— nicht verschieben —'),
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
      el('option', { value: 'auto' }, sections.length ? 'Automatisch – passenden Abschnitt finden' : 'Automatisch – beste Stelle'),
      ...sections.map((x) => el('option', { value: `s:${x.title}` }, `In Abschnitt „${x.title}“`)),
      el('option', { value: 'end' }, 'Ans Ende'),
      el('option', { value: 'new' }, 'Neuer Abschnitt …'),
    );
    const sectionName = el('input', { placeholder: 'Name des neuen Abschnitts', hidden: true });
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
        if (section === null) throw new Error('Bitte einen Namen für den neuen Abschnitt angeben.');
        const where = (s) => (s ? (s.new ? ` im neuen Abschnitt „${s.title}“` : ` in Abschnitt „${s.title}“`) : '');
        if (built.code) {
          const r = resolveSection(current, section, { actions: {} }, { category: template.category });
          result = insertBlockAt(current, built.code, r.at, r.heading);
          const placed = r.heading ? { title: r.heading, new: true } : r.section;
          info.replaceChildren(el('div', {}, `Wird als neuer Block${where(placed) || ' am Ende'} eingefügt.`));
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
          info.replaceChildren(
            el('div', {}, `${plan.steps.length} Bedingung(en): ${merges} in bestehende Blöcke eingereiht, ${covered} schon vorhanden, ${fresh} neu${fresh ? where(plan.section) : ''}.`),
          );
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
          else if (/eine pro Zeile|Stichwörter/.test(p.label)) input = el('textarea', { rows: 4, value: defaults[p.id] ?? '', placeholder: p.placeholder ?? '' });
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
      title: 'Regel-Assistent',
      wide: true,
      body: el(
        'div',
        { class: 'tpl-layout' },
        list,
        el('div', { class: 'tpl-main' }, form, el('label', { class: 'inline' }, 'Wo eintragen?', sectionSelect, sectionName), info, preview),
      ),
      actions: [
        { label: 'Abbrechen', class: 'ghost', value: false },
        { label: 'In den Editor übernehmen', value: true },
      ],
    });
    if (insert && result) {
      editor.setValue(result);
      toast('Regel übernommen – prüfen und speichern');
    }
  });

  return { renderOutline };
}
