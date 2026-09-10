// Ce que ces tests mesurent : un bloc collé depuis Excel arrive DANS LES BONNES
// CASES. Le défaut réparé n'était pas une perte — c'était un DÉCALAGE, et un
// décalage se lit comme une faute de saisie du métier, pas comme un défaut
// d'outil. Chaque cas ci-dessous nomme donc la forme des données réelles qui le
// produit, pas seulement la syntaxe.
import { describe, expect, it } from "vitest";
import { looksLikeBlock, parseTsv } from "../tsv";

describe("parseTsv", () => {
  it("découpe une grille simple", () => {
    expect(parseTsv("a\tb\tc\nd\te\tf")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("rend toujours au moins une ligne d'une cellule", () => {
    // « rien collé » et « une cellule vide collée » sont le même geste ; les
    // distinguer obligerait chaque appelant à traiter un cas qui n'existe pas.
    expect(parseTsv("")).toEqual([[""]]);
  });

  // LE CAS QUI CASSAIT. Un corps de mail multi-ligne dans une seule cellule.
  it("une cellule protégée contenant des sauts de ligne reste UNE cellule", () => {
    const colle = 'Subject\t"Ligne 1\nLigne 2\nLigne 3"\tPreheader\nSuivant\tx\ty';
    expect(parseTsv(colle)).toEqual([
      ["Subject", "Ligne 1\nLigne 2\nLigne 3", "Preheader"],
      ["Suivant", "x", "y"],
    ]);
  });

  it("CONTRÔLE POSITIF — le même contenu sans guillemets se découpe bien en trois lignes", () => {
    // Sans ce contrôle, le test précédent passerait aussi avec un parseur qui
    // ignore purement et simplement les sauts de ligne.
    expect(parseTsv("Subject\tLigne 1\nLigne 2\nLigne 3\tPreheader")).toHaveLength(3);
  });

  it("une tabulation dans une cellule protégée n'ouvre pas de colonne", () => {
    expect(parseTsv('a\t"x\ty"\tb')).toEqual([["a", "x\ty", "b"]]);
  });

  it("les guillemets doublés valent un guillemet littéral", () => {
    expect(parseTsv('"Il a dit ""oui"""\tb')).toEqual([['Il a dit "oui"', "b"]]);
  });

  it("un guillemet EN MILIEU de cellule reste un caractère ordinaire", () => {
    // `12" de large` : la mesure en pouces est fréquente dans les briefs
    // produit. Traiter ce guillemet comme une ouverture avalerait la fin de la
    // ligne dans une cellule qui ne se referme jamais.
    expect(parseTsv('largeur 12" nette\tb')).toEqual([['largeur 12" nette', "b"]]);
  });

  it("CRLF et CR seuls valent un saut de ligne, pas deux", () => {
    expect(parseTsv("a\tb\r\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTsv("a\rb")).toEqual([["a"], ["b"]]);
  });

  it("le saut de ligne FINAL d'Excel n'ajoute pas de ligne vide", () => {
    // Une ligne vide de trop n'est pas inerte : elle EFFACERAIT la case du
    // tableau située sous le bloc collé.
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
    expect(parseTsv("a\tb\r\n")).toEqual([["a", "b"]]);
  });

  it("deux lignes vides collées volontairement restent deux", () => {
    // On ne retire qu'UN saut final. Retirer tous les vides de queue changerait
    // « efface ces deux cases » en « efface celle du haut ».
    expect(parseTsv("a\n\n")).toEqual([["a"], [""]]);
  });

  it("les cellules vides du milieu sont conservées, elles portent l'alignement", () => {
    expect(parseTsv("a\t\tc")).toEqual([["a", "", "c"]]);
  });

  it("une cellule protégée non refermée rend quand même son contenu", () => {
    // Un presse-papier tronqué ne doit pas faire disparaître ce qu'on en a lu.
    expect(parseTsv('a\t"b\nc')).toEqual([["a", "b\nc"]]);
  });
});

describe("looksLikeBlock", () => {
  it("un mot seul n'est pas un bloc — le navigateur garde son insertion au curseur", () => {
    expect(looksLikeBlock("bonjour")).toBe(false);
    expect(looksLikeBlock('un mot avec des "guillemets"')).toBe(false);
  });

  it("une tabulation ou un saut de ligne fait un bloc", () => {
    expect(looksLikeBlock("a\tb")).toBe(true);
    expect(looksLikeBlock("a\nb")).toBe(true);
    expect(looksLikeBlock("a\rb")).toBe(true);
  });
});
