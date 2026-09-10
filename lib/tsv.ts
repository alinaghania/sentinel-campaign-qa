// Découpage d'un presse-papier de tableur.
//
// POURQUOI CE FICHIER EXISTE. Le tableau collable découpait le presse-papier
// avec `text.split("\n")` puis `line.split("\t")`. Ça marche tant qu'aucune
// cellule ne contient de saut de ligne — et le brief Kering en contient : un
// corps de mail, une adresse postale, une liste de bullet points. Excel, lui,
// respecte la convention : une cellule qui contient une tabulation, un saut de
// ligne ou un guillemet est ENTOURÉE de guillemets, et les guillemets internes
// sont doublés. Découper naïvement transforme donc UNE cellule de trois lignes
// en TROIS lignes d'une cellule, et tout ce qui suit dans le bloc collé glisse
// d'une ligne. Le résultat n'est pas vide, il est DÉCALÉ : le sujet atterrit
// dans le préheader, le préheader dans le CTA. Un décalage se relit comme une
// faute de saisie du métier, jamais comme un défaut d'outil.
//
// Module pur, sans dépendance : il se teste sans navigateur et sans réseau.

/**
 * Rend le bloc collé sous forme de lignes × cellules, en respectant les
 * guillemets d'Excel.
 *
 * Deux règles, et elles suffisent :
 *  - un guillemet n'OUVRE une cellule protégée qu'en tout début de cellule
 *    (Excel n'en produit pas d'autres) ; ailleurs il est un caractère comme un
 *    autre, ce qui évite de casser sur un `il fait 12" de large` ;
 *  - à l'intérieur, `""` vaut un guillemet littéral.
 *
 * Le retour a toujours au moins une ligne, même sur une chaîne vide : rendre un
 * tableau vide obligerait chaque appelant à distinguer « rien collé » de « une
 * cellule vide collée », alors que le geste est le même.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        // `""` : un guillemet littéral, pas la fin de la cellule.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }

  row.push(cell);
  rows.push(row);

  // Un bloc copié depuis Excel se termine par un saut de ligne. Le garder
  // ajouterait une ligne d'une cellule vide, qui EFFACERAIT la ligne suivante
  // du tableau — un collage qui vide la case d'en dessous est pire qu'un
  // collage qui déborde. Une seule ligne est retirée, et seulement si elle est
  // réellement vide : deux lignes vides collées volontairement restent deux.
  if (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }

  return rows;
}

/** Le collage vaut-il un collage de BLOC ? Une cellule seule (ni tabulation, ni
 *  saut de ligne, ni guillemet ouvrant) suit le chemin normal du navigateur :
 *  intercepter tout ferait perdre l'insertion au curseur, donc la correction
 *  d'un mot au milieu d'une phrase. */
export function looksLikeBlock(text: string): boolean {
  return text.includes("\t") || text.includes("\n") || text.includes("\r");
}
