// Editor tools of the manager: diff before saving, outline, hover help, formatter, version history,
// simulator and the rule assistant. Wired up by manager.js through installTools().

import { fixRequire, tokenize } from '../lib/sieve-analyzer.js';
import { formatSieve, parseSieve } from '../lib/sieve-ast.js';
import { COMMANDS, EXTENSIONS, TAGS } from '../lib/sieve-dialect.js';
import { describeActions, mergeRuleIntoScript } from '../lib/sieve-rules.js';
import { simulate } from '../lib/sieve-sim.js';
import { RULE_TEMPLATES, TEMPLATE_CATEGORIES, buildTemplate, templateDefaults } from '../lib/sieve-templates.js';
import { messageFromThunderbird, parseHeaderBlock } from '../lib/mail.js';
import { $, asScripts, describeSimulation, el, getHistory, openModal, renderDiff, storage, toast } from '../shared/env.js';

/** Asks for confirmation with a diff of what changes. */
export async function confirmDiff(before, after, title) {
  const box = el('div', { class: 'diff' });
  const stats = renderDiff(box, before, after);
  return openModal({
    title,
    wide: true,
    body: [el('p', { class: 'muted' }, `+${stats.added} / −${stats.removed} Zeilen gegenüber der gespeicherten Version`), box],
    actions: [
      { label: 'Abbrechen', class: 'ghost', value: false },
      { label: 'Speichern', value: true },
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

  function renderOutline() {
    const box = $('outline');
    const text = editor.getValue();
    let ast;
    try {
      ast = parseSieve(text);
    } catch (error) {
      box.replaceChildren(el('div', { class: 'muted small' }, `Gliederung nicht verfügbar: ${error.message}`));
      return;
    }
    const items = ast.commands
      .filter((c) => c.block && c.test && !text.slice(c.test.start, c.test.end).includes('vnd.proton.spam-threshold'))
      .map((c) => {
        const test = text.slice(c.test.start, c.test.end).replace(/\s+/g, ' ');
        const line = editor.posFromIndex(c.start).line;
        return el(
          'li',
          {
            title: test,
            onclick: () => {
              editor.focus();
              editor.setCursor({ line, ch: 0 });
              editor.scrollIntoView({ line, ch: 0 }, 80);
            },
          },
          el('span', { class: 'outline-test' }, `${c.name} ${test}`),
          el('span', { class: 'outline-actions' }, summarizeActions(c.block)),
        );
      });
    box.replaceChildren(items.length ? el('ul', {}, items) : el('div', { class: 'muted small' }, 'Noch keine Regeln'));
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

    const refresh = () => {
      try {
        const params = values();
        if (!state.dialect.proton) delete params.expireDays;
        const built = buildTemplate(template, params);
        const current = editor.getValue();
        if (built.code) {
          result = fixRequire(`${current.replace(/\s+$/, '')}\n\n${built.code}\n`);
          info.replaceChildren(el('div', {}, 'Wird als neuer Block am Ende angehängt.'));
        } else {
          const merged = mergeRuleIntoScript({ id: 'editor', name: 'Editor', sieve: current }, built.rule);
          result = merged.sieve;
          const merges = merged.steps.filter((x) => x.kind !== 'new-block' && x.kind !== 'covered').length;
          const covered = merged.steps.filter((x) => x.kind === 'covered').length;
          const fresh = merged.steps.length - merges - covered;
          info.replaceChildren(
            el('div', {}, `${merged.steps.length} Bedingung(en): ${merges} in bestehende Blöcke eingereiht, ${covered} schon vorhanden, ${fresh} neu.`),
          );
        }
        renderDiff(preview, current, result);
      } catch (error) {
        result = null;
        info.replaceChildren(el('div', { class: 'warn' }, error.message));
        preview.replaceChildren();
      }
    };

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
      body: el('div', { class: 'tpl-layout' }, list, el('div', { class: 'tpl-main' }, form, info, preview)),
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
