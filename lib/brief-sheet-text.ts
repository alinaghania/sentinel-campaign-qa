// Sérialisation d'un classeur Excel pour le structure scout LLM.
// Format "grille adressée" (recos SpreadsheetLLM adaptées aux petits classeurs) :
// - adresses A1 1-based, numéro de ligne "R<n>:" répété (jamais laisser le
//   modèle compter les lignes lui-même) ;
// - cellules vides OMISES (déclaré une fois en tête) ;
// - fusions listées par feuille ; hyperliens "->url" tronqués ; \n échappés ;
// - 2 niveaux de détail : feuilles candidates (en-tête FIELD/VALUE ou colonnes
//   langue) complètes, autres en aperçu 5 lignes ;
// - toute troncature est EXPLICITE avec ses bornes (une coupe silencieuse fait
//   raisonner le modèle sur un fichier qui n'existe pas).

const MAX_ROWS_PER_SHEET = 120;
const MAX_PREVIEW_ROWS = 5;
const MAX_CELL_CHARS = 200;
const MAX_URL_CHARS = 80;
const MAX_TOTAL_CHARS = 50_000;

type CellObj = { v?: unknown; w?: string; l?: { Target?: string } };

function colLetter(c: number): string {
  let s = "";
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function esc(v: string): string {
  return v.replace(/\r?\n/g, "\\n").replace(/"/g, '\\"');
}

export async function workbookDigest(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  let wb: ReturnType<typeof XLSX.read>;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    return "(classeur illisible)";
  }

  const parts: string[] = [
    "Convention : adresses A1 Excel 1-based (mêmes numéros que le plan attendu). Cellules vides omises. Valeurs entre guillemets, \\n = retour à la ligne. \"->url\" = hyperlien porté par la cellule.",
  ];

  const sheets = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const rows = ws
      ? (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false }) as unknown[][])
      : [];
    // Candidate = grille de contenu potentielle : en-tête FIELD/VALUE, ou une
    // ligne dense en textes courts (langues) — heuristique volontairement large.
    const head = rows.slice(0, 25).map((r) => (r ?? []).map((c) => String(c ?? "").trim().toUpperCase()));
    const isCandidate =
      head.some((r) => r.includes("FIELD") && r.includes("VALUE")) ||
      head.some((r) => r.filter((c) => c && c.length <= 12).length >= 4);
    return { name, ws, rows, isCandidate, index: i };
  });

  for (const { name, ws, rows, isCandidate, index } of sheets) {
    const limit = isCandidate ? MAX_ROWS_PER_SHEET : MAX_PREVIEW_ROWS;
    const lines: string[] = [];
    lines.push(`## Feuille ${index + 1}/${sheets.length} : "${name}" (${rows.length} lignes)`);
    const merges = (ws?.["!merges"] ?? []) as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
    if (merges.length > 0) {
      const list = merges
        .slice(0, 20)
        .map((m) => `${colLetter(m.s.c)}${m.s.r + 1}:${colLetter(m.e.c)}${m.e.r + 1}`)
        .join(", ");
      lines.push(`Fusions : ${list}${merges.length > 20 ? ` (+${merges.length - 20})` : ""} (valeur sur la cellule haut-gauche)`);
    }
    for (let r = 0; r < Math.min(rows.length, limit); r++) {
      const row = rows[r] ?? [];
      const cells: string[] = [];
      for (let c = 0; c < row.length; c++) {
        const text = String(row[c] ?? "").trim();
        const addr = `${colLetter(c)}${r + 1}`;
        const cell = ws?.[addr] as CellObj | undefined;
        const link = cell?.l?.Target;
        if (!text && !link) continue;
        let out = `${colLetter(c)}="${esc(text.slice(0, MAX_CELL_CHARS))}${text.length > MAX_CELL_CHARS ? "…[tronqué]" : ""}"`;
        if (link) out += `->${link.slice(0, MAX_URL_CHARS)}${link.length > MAX_URL_CHARS ? "…" : ""}`;
        cells.push(out);
      }
      if (cells.length > 0) lines.push(`R${r + 1}: ${cells.join(" | ")}`);
    }
    if (rows.length > limit) {
      lines.push(
        `… [lignes R${limit + 1} à R${rows.length} omises (${rows.length - limit} lignes) — ${isCandidate ? "feuille tronquée" : "aperçu seulement"}]`
      );
    }
    parts.push(lines.join("\n"));
    if (parts.join("\n\n").length > MAX_TOTAL_CHARS) {
      parts.push(`… [feuilles suivantes omises : ${sheets.slice(index + 1).map((s) => `"${s.name}"`).join(", ")}]`);
      break;
    }
  }

  return parts.join("\n\n").slice(0, MAX_TOTAL_CHARS + 2_000);
}
