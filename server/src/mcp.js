// MCP server: exposes the operations as tools for agents such as Inbox Zero.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { t } from '../../addon/lib/i18n.js';

import * as ops from './ops.js';

const condition = z.object({
  kind: z.enum(['address', 'header', 'exists']).describe(t('address = address header (from/to/cc), header = any header, exists = header is present')),
  header: z.string().describe(t('e.g. "from", "to", "subject", "list-id", "list-unsubscribe"')),
  part: z.enum(['all', 'domain', 'localpart']).optional().describe(t('only with kind=address; default all')),
  match: z.enum(['is', 'contains', 'matches']).optional().describe(t('default is; matches with * and ?')),
  value: z.string().optional().describe(t('Value to compare (not for exists)')),
});

const actions = z.object({
  fileinto: z.string().optional().describe(t('Target folder or label (name as in list_folders; Proton also accepts inbox/archive/trash/spam, other servers INBOX)')),
  seen: z.boolean().optional().describe(t('mark the mail as read')),
  flagged: z.boolean().optional().describe(t('flag with a star')),
  expireDays: z.number().int().min(1).max(730).optional().describe(t('delete automatically after n days (Proton only)')),
  stop: z.boolean().optional().describe(t('do not run any further filters afterwards')),
});

const rule = z.object({
  conditions: z.array(condition).min(1),
  combine: z.enum(['anyof', 'allof']).optional().describe(t('anyof = OR (default), allof = AND')),
  actions,
});

const headers = z
  .union([z.string(), z.record(z.string(), z.union([z.string(), z.array(z.string())]))])
  .describe(t('Headers of the mail: raw text ("From: …\\nSubject: …") or object {name: value|[values]}'));

const target = z.string().optional().describe(t('"auto" (best place, default), "new" (new filter/script) or a filter/script ID'));

const section = z
  .union([z.string(), z.object({ new: z.string() })])
  .optional()
  .describe(
  t('Section in the target script for a new block (sections = comment headings, see list_filters): "auto" (matching section, default), "end" (end of the file), a section title, or {new: "Title"} for a new section'),
);

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

const read = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** name → {description, input (zod shape), run, annotations}; the REST API uses the same table. */
export const TOOLS = new Map();
const tool = (name, description, input, run, annotations = {}) => TOOLS.set(name, { description, input, run, annotations });

tool('sieve_status', t('Status of the Sieve service: provider (proton/managesieve/jmap), signed in, write access, capabilities.'), {}, ops.status, read);
tool('sieve_capabilities', t('Capabilities of the server: supported Sieve extensions, multiple active filters?, ordering?, labels?'), {}, ops.capabilities, read);
tool('list_filters', t('All Sieve filters (Proton) or scripts (ManageSieve) in execution order, with their sections (comment headings); with ManageSieve only the active one runs.'), { includeSieve: z.boolean().optional() }, ops.listFilters, read);
tool('get_filter', t('One filter with its complete Sieve script and local check notes.'), { id: z.string() }, ops.getFilter, read);
tool('list_folders', t('Folders and labels of the account (valid targets for fileinto).'), {}, ops.listFolders, read);
tool('lint_sieve', t('Checks a Sieve script locally against the server’s dialect; if needed, returns a script with an added require.'), { sieve: z.string() }, ops.lintSieve, read);
tool('check_sieve', t('Has the server itself check whether it would accept the script.'), { sieve: z.string() }, ops.checkSieve, read);
tool('format_sieve', t('Indents a Sieve script consistently (the spam guard stays unchanged).'), { sieve: z.string() }, ops.formatSieve, { readOnlyHint: true });
tool(
  'simulate_message',
  t('Shows where a mail would end up with the current filters and which rules apply. Optionally with changed scripts (overrides).'),
  {
    headers,
    size: z.number().optional().describe(t('Size in bytes')),
    spamScore: z.number().optional(),
    overrides: z.array(z.object({ id: z.string(), sieve: z.string() })).optional(),
  },
  ops.simulateMessage,
  read,
);
tool('suggest_rule', t('Suggests suitable conditions for a rule from the headers of a mail (list, sender, domain, subject …).'), { headers }, ops.suggestRule, { readOnlyHint: true });
tool(
  'plan_rule',
  t('Plans a rule without saving: finds the best place (add to an existing list, extend anyof, or new block) and returns the diff, conflicts and, with headers, the simulated result.'),
  { rule, target, section, newName: z.string().optional(), headers: headers.optional(), size: z.number().optional() },
  ops.planRule,
  read,
);
tool(
  'apply_rule',
  t('Like plan_rule, but saves the result on the server (after its own check).'),
  { rule, target, section, newName: z.string().optional(), headers: headers.optional(), size: z.number().optional() },
  ops.applyRule,
  write,
);
tool('list_templates', t('Catalog of rule templates with their parameters.'), {}, ops.listTemplates, { readOnlyHint: true });
tool(
  'plan_template',
  t('Builds a template with parameters and plans it like plan_rule (without saving).'),
  { templateId: z.string(), params: z.record(z.string(), z.any()).optional(), target, section, newName: z.string().optional() },
  ops.buildTemplate,
  read,
);
tool(
  'apply_template',
  t('Like plan_template, but saves the result on the server.'),
  { templateId: z.string(), params: z.record(z.string(), z.any()).optional(), target, section, newName: z.string().optional() },
  ops.applyTemplate,
  write,
);
tool('create_filter', t('Creates a new filter/script (after the server checked it). With ManageSieve/JMAP it only becomes active with enabled=true (or when no script is active yet), and then replaces the active one.'), { name: z.string(), sieve: z.string(), enabled: z.boolean().optional() }, ops.createFilter, write);
tool(
  'update_filter',
  t('Changes the name, Sieve script or status of a filter. Returns the diff.'),
  {
    id: z.string(),
    name: z.string().optional(),
    sieve: z.string().optional(),
    enabled: z.boolean().optional(),
    expectedSieve: z.string().optional().describe(t('save only if the script still has exactly this text (protects against concurrent changes)')),
  },
  ops.updateFilter,
  write,
);
tool('set_filter_enabled', t('Enables or disables a filter (ManageSieve: activates exactly this script).'), { id: z.string(), enabled: z.boolean() }, ops.setFilterEnabled, write);
tool('reorder_filters', t('Sets the execution order of the filters (Proton only; complete list of IDs).'), { ids: z.array(z.string()) }, ops.reorderFilters, write);
tool('delete_filter', t('Deletes a filter permanently.'), { id: z.string() }, ops.deleteFilter, { ...write, destructiveHint: true });

export function createMcpServer(account) {
  const server = new McpServer({ name: 'sieve', version: '0.5.3' });
  for (const [name, { description, input, run, annotations }] of TOOLS) {
    server.registerTool(name, { description, inputSchema: input, annotations }, async (args) => {
      try {
        return json(await run(account, args ?? {}));
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
}
