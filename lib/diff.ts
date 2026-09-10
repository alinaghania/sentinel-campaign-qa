// Diff de textes pour l'affichage Attendu (brief) ↔ Reçu (email) — module PUR
// (client-safe). Tokenisation universelle : mots latins entiers, caractères
// CJK un par un (pas d'espaces en japonais/chinois), ponctuation isolée.
// LCS classique sur tokens, puis fusion en segments contigus same/changed.

export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** Une URL http(s) "pure" (aucun espace) — active la tokenisation par
 *  segments d'URL dans diffSegments et le rendu mono dans l'UI. */
export const IS_URL_RE = /^https?:\/\/\S+$/;

/** Mots latins/chiffres entiers, runs d'espaces, sinon caractère par caractère
 *  (couvre CJK et ponctuation). */
function tokenize(s: string): string[] {
  return s.match(/[A-Za-zÀ-ÿ0-9']+|\s+|./gu) ?? [];
}

/** Tokenisation d'URL en unités SÉMANTIQUES : host entier
 *  ("https://www.balenciaga.com"), chaque segment de path avec son "/" de tête
 *  ("/storelocator"), chaque paramètre de query ENTIER avec son séparateur
 *  ("?utm_source=X", "&utm_campaign=Y"), hash "#frag" — un paramètre qui change
 *  est surligné en bloc au lieu de miettes caractère par caractère. */
export function tokenizeUrl(s: string): string[] {
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
  if (!m) return tokenize(s);
  const tokens: string[] = [m[1]];
  for (const seg of m[2].match(/\/[^/]*/g) ?? []) tokens.push(seg);
  if (m[3]) {
    m[3]
      .slice(1)
      .split("&")
      .forEach((p, i) => tokens.push(`${i === 0 ? "?" : "&"}${p}`));
  }
  if (m[4]) tokens.push(m[4]);
  return tokens;
}

/** Segments de a et b, où changed=true marque ce qui n'est pas commun aux deux
 *  (suppressions côté a, ajouts côté b). Textes plafonnés pour rester O(n·m) raisonnable. */
export function diffSegments(
  a: string,
  b: string
): { a: DiffSegment[]; b: DiffSegment[] } {
  const MAX = 1200; // tokens — au-delà on tronque (affichage, pas d'analyse)
  // Deux URLs pures → diff par segments d'URL (host / path / paramètres),
  // sinon tokenisation texte classique.
  const urlMode = IS_URL_RE.test(a.trim()) && IS_URL_RE.test(b.trim());
  const ta = (urlMode ? tokenizeUrl(a.trim()) : tokenize(a)).slice(0, MAX);
  const tb = (urlMode ? tokenizeUrl(b.trim()) : tokenize(b)).slice(0, MAX);
  const n = ta.length;
  const m = tb.length;

  // LCS — table (n+1)×(m+1) en Uint16 (longueurs de textes d'email : ok).
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        ta[i] === tb[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const segsA: DiffSegment[] = [];
  const segsB: DiffSegment[] = [];
  const push = (arr: DiffSegment[], text: string, changed: boolean) => {
    if (!text) return;
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      push(segsA, ta[i], false);
      push(segsB, tb[j], false);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      push(segsA, ta[i], true);
      i++;
    } else {
      push(segsB, tb[j], true);
      j++;
    }
  }
  while (i < n) push(segsA, ta[i++], true);
  while (j < m) push(segsB, tb[j++], true);
  return { a: segsA, b: segsB };
}

/** Similarité Dice sur bigrammes de caractères (0..1) — pour décider entre
 *  "texte différent" (proche) et "bloc absent" (rien de ressemblant). */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const map = new Map<string, number>();
    for (let k = 0; k < s.length - 1; k++) {
      const g = s.slice(k, k + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, ca] of ga) inter += Math.min(ca, gb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}
