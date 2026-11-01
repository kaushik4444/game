'use strict';
/**
 * Replace a person's name everywhere inside a game's state (players, log lines, last-trick records, anything else that
 * holds text). Used when an account is deleted during a running game, so the real name cannot reach a later state
 * broadcast or the saved match. A name only matches as a whole word: deleting "Sam" must not touch "Samantha".
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nameRegex(name) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc(name)}(?![\\p{L}\\p{N}_])`, 'gu');
}

/** Returns the string with every whole-word occurrence of each name in `names` replaced by `to`. */
function scrubText(text, names, to) {
  let out = text;
  for (const n of names) if (n && n !== to) out = out.replace(nameRegex(n), () => to);
  return out;
}

/** Rewrites strings in place inside plain objects and arrays (Sets and Maps hold only numbers and ids here). */
function scrubDeep(root, names, to) {
  const wanted = [...new Set([].concat(names).filter(Boolean))].filter((n) => n !== to);
  if (!wanted.length) return;
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node instanceof Set || node instanceof Map) return;
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === 'string') node[key] = scrubText(v, wanted, to);
      else walk(v);
    }
  };
  walk(root);
}

module.exports = { scrubText, scrubDeep };
