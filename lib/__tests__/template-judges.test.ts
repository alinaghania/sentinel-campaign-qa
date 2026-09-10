// Le template ÉDITÉ juge-t-il réellement ?
//
// Jusqu'au 04/09/2026 la réponse était non, et rien ne le disait. L'éditeur
// écrivait dans le stockage, `/api/brief-template/download` servait un classeur
// portant les champs ajoutés, `/api/brief-template/compose` composait avec la
// nouvelle géométrie — et `runCodeChecks` appelait `validateAgainstTemplate`
// avec `DEFAULT_TEMPLATE`, la constante de code, que l'édition ne touche
// jamais. Un champ ajouté depuis l'écran, téléchargé, rempli et réimporté
// revenait « non déclaré par le template de campagne » : un écart FABRIQUÉ,
// nommé, plausible, dans un rapport qui a exactement la forme d'une mesure
// réussie. Et la remédiation imprimée à côté — « ou marquez-le optionnel dans
// le template de campagne » — désignait une porte qui ne s'ouvrait pas.
//
// Ces cas testent une VALEUR (le verdict change), pas une ligne de code. Ils
// sont écrits dans les deux sens, parce qu'un seul aurait pu passer par
// accident : marquer un champ optionnel doit FAIRE DISPARAÎTRE un reproche, et
// ajouter un champ requis doit en FAIRE APPARAÎTRE un.
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { parseBriefGridDetailed } from "../brief-grid";
import { DEFAULT_TEMPLATE, templateRevision } from "../brief-template";
import type { BriefTemplate } from "../brief-template";
import { runCodeChecks } from "../checks-code";
import { parseEmailFacts } from "../parse-email";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name));

const FACTS = parseEmailFacts("<html><body><p>Hola</p></body></html>");

/** La grille du seul fixture qui est en ÉCART avec le template livré — donc le
 *  seul sur lequel un changement de référentiel peut se voir. */
async function mxGrid() {
  const { grid, telemetry } = await parseBriefGridDetailed(
    fixture("mx-guadalajara.xlsm")
  );
  expect(grid).not.toBeNull();
  return { grid: grid!, family: telemetry.family };
}

function judge(grid: Awaited<ReturnType<typeof mxGrid>>["grid"], family: Awaited<ReturnType<typeof mxGrid>>["family"], template?: BriefTemplate) {
  return runCodeChecks({
    facts: FACTS,
    linkResults: [],
    briefGrid: grid,
    briefFamily: family,
    detectedLanguage: { lang: "ES", confidence: "high" },
    ...(template ? { template } : {}),
  });
}

/** Les champs que le template livré déclare manquants sur ce brief. */
const missingKeys = (out: ReturnType<typeof runCodeChecks>) =>
  out.templateConformance?.state === "deviation"
    ? out.templateConformance.missing.map((m) => m.key)
    : [];

describe("le template passé à runCodeChecks est celui qui juge", () => {
  it("marquer un champ optionnel RETIRE le reproche — la remédiation imprimée devient vraie", async () => {
    const { grid, family } = await mxGrid();

    // Référence : le template livré. `body-copy-2` est reproché.
    const before = judge(grid, family);
    expect(missingKeys(before)).toContain("body-copy-2");
    expect(
      before.findings.some(
        (f) => f.ruleId === "template-structure" && f.evidence.includes(`"body-copy-2"`)
      ),
      "le finding de référence doit exister, sinon le test suivant ne prouve rien"
    ).toBe(true);

    // Le geste que la plateforme conseille : passer le champ en optionnel.
    const edited: BriefTemplate = {
      ...DEFAULT_TEMPLATE,
      label: "Kering EMAIL brief — édité à l'écran",
      fields: DEFAULT_TEMPLATE.fields.map((f) =>
        f.key === "body-copy-2" ? { ...f, required: false } : f
      ),
    };

    const after = judge(grid, family, edited);
    expect(missingKeys(after)).not.toContain("body-copy-2");
    expect(
      after.findings.some(
        (f) => f.ruleId === "template-structure" && f.evidence.includes(`"body-copy-2"`)
      )
    ).toBe(false);

    // Et le nom du référentiel qui a jugé est écrit à côté de son verdict : un
    // rapport ne doit pas laisser deviner contre quoi il a mesuré.
    const anyMissing = after.findings.find(
      (f) => f.ruleId === "template-structure" && f.evidence.startsWith("Template ")
    );
    expect(anyMissing?.evidence).toContain("édité à l'écran");
  });

  it("ajouter un champ requis FAIT APPARAÎTRE un reproche — le champ ajouté est mesuré", async () => {
    const { grid, family } = await mxGrid();

    const before = judge(grid, family);
    expect(missingKeys(before)).not.toContain("legal-mention");

    const edited: BriefTemplate = {
      ...DEFAULT_TEMPLATE,
      fields: [
        ...DEFAULT_TEMPLATE.fields,
        {
          key: "legal-mention",
          label: "Legal mention",
          description: "Ligne ajoutée depuis l'éditeur de template",
          master: DEFAULT_TEMPLATE.fields[0].master,
          rowOffset:
            Math.max(...DEFAULT_TEMPLATE.fields.map((f) => f.rowOffset)) + 1,
          kind: "text",
          required: true,
          translatable: true,
        },
      ],
    };

    const after = judge(grid, family, edited);
    expect(missingKeys(after)).toContain("legal-mention");
  });

  it("sans `template`, le comportement historique tient (les appelants existants n'ont rien à changer)", async () => {
    const { grid, family } = await mxGrid();
    const implicit = judge(grid, family);
    const explicit = judge(grid, family, DEFAULT_TEMPLATE);
    expect(missingKeys(implicit)).toEqual(missingKeys(explicit));
  });

  it("deux listes de LANGUES distinctes s'archivent séparément", async () => {
    // La vraie raison pour laquelle `languages` est entré dans l'empreinte, et
    // ce n'est pas « ça change un verdict » : mesuré, ça n'en change aucun
    // aujourd'hui. `Templates.archive` prend l'empreinte pour CLÉ D'IDENTITÉ et
    // ne réécrit jamais. Hors empreinte, éditer la table des langues laissait
    // l'archive répondre l'ANCIENNE liste à la question « que contenait le
    // référentiel qui a rendu ce verdict ? » — une attestation fausse, et qui
    // se cite.
    //
    // Testé sur le VRAI store, dans un répertoire jetable : une archive mockée
    // n'aurait testé que le mock, et c'est justement le « ne réécrit jamais »
    // du store réel qui produisait la falsification.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-tpl-"));
    const prevDir = process.env.DATA_DIR;
    const prevConn = process.env.AZURE_TABLES_CONNECTION_STRING;
    process.env.DATA_DIR = dir;
    delete process.env.AZURE_TABLES_CONNECTION_STRING;
    try {
      // `resetModules` et non une query de cache-busting : `lib/store` lit
      // DATA_DIR au CHARGEMENT du module. S'il a déjà été importé par un autre
      // fichier de la suite, un import ordinaire rendrait l'instance liée à
      // `.data` — le test écrirait alors dans le dépôt et passerait quand même.
      vi.resetModules();
      const { Templates } = await import("../store");
      const renamed: BriefTemplate = {
        ...DEFAULT_TEMPLATE,
        languages: DEFAULT_TEMPLATE.languages.map((l) =>
          l.code === "TH" ? { ...l, name: "Thai" } : l
        ),
      };
      const revA = await Templates.archive(DEFAULT_TEMPLATE, "default");
      const revB = await Templates.archive(renamed, "default");
      expect(revB, "deux listes de langues, deux clés d'archive").not.toBe(revA);

      const thNameOf = async (rev: string) => {
        const archived = await Templates.revision(rev);
        expect(archived, `révision ${rev} absente de l'archive`).not.toBeNull();
        return archived!.template.languages.find((l) => l.code === "TH")?.name;
      };
      expect(await thNameOf(revA)).toBe("Thailand");
      expect(await thNameOf(revB)).toBe("Thai");
    } finally {
      if (prevDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDir;
      if (prevConn !== undefined) process.env.AZURE_TABLES_CONNECTION_STRING = prevConn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deux templates qui jugent différemment ont deux RÉVISIONS différentes", () => {
    // Le sel de cache d'analyze.ts est bâti sur `templateRevision`. Si deux
    // référentiels qui rendent deux verdicts partageaient une révision, éditer
    // le template rejouerait le rapport de l'ancien : le verdict changerait
    // sans que l'écran change.
    const edited: BriefTemplate = {
      ...DEFAULT_TEMPLATE,
      fields: DEFAULT_TEMPLATE.fields.map((f) =>
        f.key === "body-copy-2" ? { ...f, required: false } : f
      ),
    };
    expect(templateRevision(edited)).not.toBe(templateRevision(DEFAULT_TEMPLATE));
  });
});
