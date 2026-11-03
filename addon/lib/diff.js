// Line diff (LCS) with context hunks, for "what changes when I save" previews.

/** @returns {Array<{type: 'same'|'add'|'del', text: string, oldLine?: number, newLine?: number}>} */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  // trim common prefix/suffix so the quadratic table stays small for typical one-line changes
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  for (let k = 0; k < start; k++) out.push({ type: 'same', text: a[k], oldLine: k + 1, newLine: k + 1 });
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ type: 'same', text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
      i++;
      j++;
    } else if (j < midB.length && (i === midA.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ type: 'add', text: midB[j], newLine: start + j + 1 });
      j++;
    } else {
      out.push({ type: 'del', text: midA[i], oldLine: start + i + 1 });
      i++;
    }
  }
  for (let k = endA; k < a.length; k++) out.push({ type: 'same', text: a[k], oldLine: k + 1, newLine: endB + (k - endA) + 1 });
  return out;
}

/** Groups a diff into hunks with `context` unchanged lines around each change. */
export function diffHunks(diff, context = 2) {
  const changed = diff.map((d, i) => (d.type === 'same' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const hunks = [];
  let current = null;
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(diff.length - 1, idx + context);
    if (current && from <= current.to + 1) current.to = to;
    else hunks.push((current = { from, to }));
  }
  return hunks.map((h) => diff.slice(h.from, h.to + 1));
}

export function diffStats(diff) {
  return { added: diff.filter((d) => d.type === 'add').length, removed: diff.filter((d) => d.type === 'del').length };
}
