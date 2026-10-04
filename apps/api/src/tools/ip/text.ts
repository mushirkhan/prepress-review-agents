// Look-alike characters used to disguise words ("N1KE", "AD!DAS").
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', $: 's', '@': 'a', '!': 'i', '|': 'i' };

/**
 * Normalises text for matching: lower case, accents removed, apostrophes
 * dropped, look-alike characters mapped back to letters (only inside words
 * that also contain letters, so "2026" stays a number), punctuation to spaces.
 */
export function normalize(text: string): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '');
  return base
    .split(/\s+/)
    // Trim edge punctuation first so a trailing "!" is not read as an "i".
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .map((word) => (/[a-z]/.test(word) ? [...word].map((c) => LEET[c] ?? c).join('') : word))
    .join(' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(normalized: string): string[] {
  return normalized.split(' ').filter(Boolean);
}

/** Levenshtein edit distance, with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** True if `phrase` appears in `text` as whole words. Both must be normalised. */
export function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}
