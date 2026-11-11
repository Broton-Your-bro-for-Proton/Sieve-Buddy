// Turns a simulation result into what Thunderbird should do with the message right now, and finds the
// Thunderbird folder a Sieve folder name stands for. Sending actions (redirect, vacation, reject) are never run.

import { t } from './i18n.js';

// Proton's system folders and the Thunderbird special use they correspond to
const SPECIAL_USE = { inbox: 'inbox', archive: 'archive', trash: 'trash', spam: 'junk' };

/**
 * @param {ReturnType<import('./sieve-sim.js').simulate>} result
 * @returns {{move: string|null, copies: string[], trash: boolean, read: boolean, flagged: boolean, skipped: string[]}}
 */
export function mailActions(result) {
  const skipped = [];
  if (result.rejected) skipped.push(t('reject'));
  if (result.redirects?.length) skipped.push(t('redirect'));
  if (result.vacation) skipped.push(t('vacation'));
  if (result.rejected) return { move: null, copies: [], trash: false, read: false, flagged: false, skipped };

  const flags = result.flags.map((f) => f.toLowerCase());
  const labels = result.labels.filter((l) => l !== 'Markiert');
  // Proton: one folder; RFC: every stored copy, the first one outside the inbox is where the message goes
  const folders = (result.folders ?? []).filter((f) => f.toLowerCase() !== 'inbox');
  return {
    move: result.discarded ? null : folders[0] ?? null,
    copies: [...folders.slice(1), ...labels],
    trash: result.discarded,
    read: flags.includes('\\seen'),
    flagged: flags.includes('\\flagged') || result.labels.includes('Markiert'),
    skipped,
  };
}

/**
 * @param {Array<{path: string, name: string, specialUse?: string[]}>} folders all folders of the message's account
 * @param {string} name folder name as written in the Sieve script
 */
export function findFolder(folders, name) {
  const special = SPECIAL_USE[name.toLowerCase()];
  if (special) {
    const hit = folders.find((f) => f.specialUse?.includes(special));
    if (hit) return hit;
  }
  // ManageSieve servers separate with "." or "/"; Proton Bridge puts folders under "Folders/" and labels under "Labels/"
  const norm = (s) => s.replace(/^\/+/, '').replace(/[./]/g, '/').toLowerCase();
  const wanted = norm(name);
  const candidates = [wanted, `folders/${wanted}`, `labels/${wanted}`, `inbox/${wanted}`];
  for (const c of candidates) {
    const hit = folders.find((f) => norm(f.path) === c);
    if (hit) return hit;
  }
  return null;
}
