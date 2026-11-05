// MCP server: exposes the operations as tools for agents such as Inbox Zero.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { t } from '../../addon/lib/i18n.js';

import * as ops from './ops.js';

const condition = z.object({
  kind: z.enum(['address', 'header', 'exists']).describe(t('address = Adress-Header (from/to/cc), header = beliebiger Header, exists = Header vorhanden')),
  header: z.string().describe(t('z. B. "from", "to", "subject", "list-id", "list-unsubscribe"')),
  part: z.enum(['all', 'domain', 'localpart']).optional().describe(t('nur bei kind=address; Standard all')),
  match: z.enum(['is', 'contains', 'matches']).optional().describe(t('Standard is; matches mit * und ?')),
  value: z.string().optional().describe(t('Vergleichswert (nicht bei exists)')),
});

const actions = z.object({
  fileinto: z.string().optional().describe(t('Zielordner oder Label (Name wie in list_folders; Proton zusätzlich inbox/archive/trash/spam, andere Server INBOX)')),
  seen: z.boolean().optional().describe(t('als gelesen markieren')),
  flagged: z.boolean().optional().describe(t('mit Stern markieren')),
  expireDays: z.number().int().min(1).max(730).optional().describe(t('nach n Tagen automatisch löschen (nur Proton)')),
  stop: z.boolean().optional().describe(t('danach keine weiteren Filter ausführen')),
});

const rule = z.object({
  conditions: z.array(condition).min(1),
  combine: z.enum(['anyof', 'allof']).optional().describe(t('anyof = ODER (Standard), allof = UND')),
  actions,
});

const headers = z
  .union([z.string(), z.record(z.string(), z.union([z.string(), z.array(z.string())]))])
  .describe(t('Header der Mail: Roh-Text ("From: …\\nSubject: …") oder Objekt {name: wert|[werte]}'));

const target = z.string().optional().describe(t('"auto" (beste Stelle, Standard), "new" (neuer Filter/neues Skript) oder eine Filter-/Skript-ID'));

const section = z
  .union([z.string(), z.object({ new: z.string() })])
  .optional()
  .describe(
    t('Abschnitt im Zielskript für einen neuen Block (Abschnitte = Kommentar-Überschriften, siehe list_filters): "auto" (passender Abschnitt, Standard), "end" (Ende der Datei), ein Abschnittstitel oder {new: "Titel"} für einen neuen Abschnitt'),
  );

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

export function createMcpServer(account) {
  const server = new McpServer({ name: 'sieve', version: '0.4.0' });

  const tool = (name, description, inputSchema, run, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        return json(await run(account, args ?? {}));
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });

  const read = { readOnlyHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  tool('sieve_status', t('Status des Sieve-Dienstes: Anbieter (proton/managesieve), angemeldet, Schreibzugriff, Fähigkeiten.'), {}, ops.status, read);
  tool('sieve_capabilities', t('Fähigkeiten des Servers: unterstützte Sieve-Erweiterungen, mehrere aktive Filter?, Reihenfolge?, Labels?'), {}, ops.capabilities, read);
  tool('list_filters', t('Alle Sieve-Filter (Proton) bzw. Skripte (ManageSieve) in Ausführungsreihenfolge, mit ihren Abschnitten (Kommentar-Überschriften); bei ManageSieve läuft nur das aktive.'), { includeSieve: z.boolean().optional() }, ops.listFilters, read);
  tool('get_filter', t('Einen Filter mit vollständigem Sieve-Skript und lokalen Prüfhinweisen.'), { id: z.string() }, ops.getFilter, read);
  tool('list_folders', t('Ordner und Labels des Kontos (gültige Ziele für fileinto).'), {}, ops.listFolders, read);
  tool('lint_sieve', t('Prüft ein Sieve-Skript lokal gegen den Dialekt des Servers; liefert ggf. ein Skript mit ergänztem require.'), { sieve: z.string() }, ops.lintSieve, read);
  tool('check_sieve', t('Lässt den Server selbst prüfen, ob er das Skript annehmen würde.'), { sieve: z.string() }, ops.checkSieve, read);
  tool('format_sieve', t('Rückt ein Sieve-Skript einheitlich ein (Spam-Schutz bleibt unverändert).'), { sieve: z.string() }, ops.formatSieve, { readOnlyHint: true });
  tool(
    'simulate_message',
    t('Zeigt, wo eine Mail mit den aktuellen Filtern landen würde und welche Regeln greifen. Optional mit geänderten Skripten (overrides).'),
    {
      headers,
      size: z.number().optional().describe(t('Größe in Bytes')),
      spamScore: z.number().optional(),
      overrides: z.array(z.object({ id: z.string(), sieve: z.string() })).optional(),
    },
    ops.simulateMessage,
    read,
  );
  tool('suggest_rule', t('Schlägt passende Bedingungen für eine Regel aus den Headern einer Mail vor (Liste, Absender, Domain, Betreff …).'), { headers }, ops.suggestRule, { readOnlyHint: true });
  tool(
    'plan_rule',
    t('Plant eine Regel, ohne zu speichern: findet die beste Stelle (in bestehende Liste einreihen, anyof erweitern oder neuer Block), liefert Diff, Konflikte und – mit headers – das simulierte Ergebnis.'),
    { rule, target, section, newName: z.string().optional(), headers: headers.optional(), size: z.number().optional() },
    ops.planRule,
    read,
  );
  tool(
    'apply_rule',
    t('Wie plan_rule, speichert das Ergebnis aber auf dem Server (nach dessen eigener Prüfung).'),
    { rule, target, section, newName: z.string().optional(), headers: headers.optional(), size: z.number().optional() },
    ops.applyRule,
    write,
  );
  tool('list_templates', t('Katalog der Regel-Vorlagen mit ihren Parametern.'), {}, ops.listTemplates, { readOnlyHint: true });
  tool(
    'plan_template',
    t('Baut eine Vorlage mit Parametern und plant sie wie plan_rule (ohne zu speichern).'),
    { templateId: z.string(), params: z.record(z.string(), z.any()).optional(), target, section, newName: z.string().optional() },
    ops.buildTemplate,
    read,
  );
  tool(
    'apply_template',
    t('Wie plan_template, speichert das Ergebnis aber auf dem Server.'),
    { templateId: z.string(), params: z.record(z.string(), z.any()).optional(), target, section, newName: z.string().optional() },
    ops.applyTemplate,
    write,
  );
  tool('create_filter', t('Legt einen neuen Filter/ein neues Skript an (nach Prüfung durch den Server). Bei ManageSieve wird es nur mit enabled=true aktiv – und ersetzt dann das bisher aktive.'), { name: z.string(), sieve: z.string(), enabled: z.boolean().optional() }, ops.createFilter, write);
  tool(
    'update_filter',
    t('Ändert Name, Sieve-Skript oder Status eines Filters. Liefert den Diff.'),
    { id: z.string(), name: z.string().optional(), sieve: z.string().optional(), enabled: z.boolean().optional() },
    ops.updateFilter,
    write,
  );
  tool('set_filter_enabled', t('Aktiviert oder deaktiviert einen Filter (ManageSieve: aktiviert genau dieses Skript).'), { id: z.string(), enabled: z.boolean() }, ops.setFilterEnabled, write);
  tool('reorder_filters', t('Setzt die Ausführungsreihenfolge der Filter (nur Proton; vollständige Liste der IDs).'), { ids: z.array(z.string()) }, ops.reorderFilters, write);
  tool('delete_filter', t('Löscht einen Filter endgültig.'), { id: z.string() }, ops.deleteFilter, { ...write, destructiveHint: true });

  return server;
}
