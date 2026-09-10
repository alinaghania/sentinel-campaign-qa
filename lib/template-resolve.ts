// Ce que le stockage sait des templates : résoudre le référentiel EFFECTIF et
// composer ce que l'API en sert. Séparé de lib/template-edit.ts parce que ce
// dernier est importé côté CLIENT — y laisser un import de `./store` ferait
// entrer `fs` dans le bundle du navigateur.
import { BRIEF_SHEET, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, layout, templateRevision } from "./brief-template";
import type { BriefTemplate } from "./brief-template";
import { Campaigns, Templates, uid, updateCampaign, updateTemplate } from "./store";
import {
  buildStoredTemplate,
  checkTemplateCoherence,
  isBlocking,
  withAcknowledgedRemovals,
  type TemplateProblem,
  type TemplateWrite,
} from "./template-edit";
import type { Campaign } from "./types";

/** D'où vient le template qui va juger. Trois états, jamais deux — et le
 *  troisième est le seul qui compte vraiment. */
export type TemplateSource =
  /** Édition enregistrée, valide. */
  | "stored"
  /** Rien d'enregistré : le template livré avec le code. Situation normale. */
  | "code"
  /** Une édition EXISTE mais ne peut pas mesurer. On retombe sur le code et on
   *  le DIT. Sans ce troisième état, un template cassé se lirait « on utilise le
   *  template par défaut » — c'est-à-dire comme une situation normale, alors que
   *  quelqu'un croit avoir enregistré une politique qui ne s'applique pas. */
  | "stored_invalid"
  /** Un id NON-`default` a été demandé et n'existe pas dans le stockage. On
   *  retombe sur le template du code et on le DIT. Sans ce quatrième état, une
   *  campagne épinglée sur un template supprimé rendait `"code"` : exactement ce
   *  que rend une campagne qui n'a jamais rien épinglé. Deux situations opposées
   *  — « rien n'a été choisi » et « ce qui a été choisi a disparu » — sous une
   *  seule étiquette, et la seconde qui se lit comme la première. */
  | "pinned_missing";

export interface ResolvedTemplate {
  readonly template: BriefTemplate;
  readonly source: TemplateSource;
  readonly revision: string;
  /** Renseigné pour `stored_invalid` : pourquoi l'édition a été écartée. */
  readonly problems: readonly TemplateProblem[];
}

/** Le template EFFECTIF pour un id donné, avec la provenance.
 *
 *  Revalide à la lecture et pas seulement à l'écriture. Ce n'est pas de la
 *  paranoïa : le stockage est un fichier JSON en dev et une table en prod, tous
 *  deux éditables hors de l'application, et surtout les contrôles eux-mêmes
 *  évoluent — un template enregistré avant l'ajout du contrôle n°6 n'a jamais
 *  été soumis au contrôle n°6. Valider seulement à l'écriture, c'est valider
 *  contre les règles d'hier.
 */
export async function resolveTemplate(
  id: string = DEFAULT_TEMPLATE_ID
): Promise<ResolvedTemplate> {
  const stored = await Templates.get(id).catch(() => null);
  if (!stored) {
    return {
      template: DEFAULT_TEMPLATE,
      source: id === DEFAULT_TEMPLATE_ID ? "code" : "pinned_missing",
      revision: templateRevision(DEFAULT_TEMPLATE),
      problems: [],
    };
  }
  const check = checkTemplateCoherence(stored);
  if (isBlocking(check)) {
    return {
      template: DEFAULT_TEMPLATE,
      source: "stored_invalid",
      revision: templateRevision(DEFAULT_TEMPLATE),
      problems: check.problems,
    };
  }
  return {
    template: stored,
    source: "stored",
    revision: templateRevision(stored),
    problems: check.problems,
  };
}

/** Id du DERNIER template CRÉÉ, ou l'id du template livré si personne n'en a
 *  créé. C'est la règle de défaut demandée : « par défaut le template c'est le
 *  dernier qui a été créé ».
 *
 *  Trois précisions, chacune parce que l'inverse serait faux en silence :
 *
 *  1. Le tri est sur `createdAt`, JAMAIS sur `updatedAt`. « Dernier créé » et
 *     « dernier modifié » se ressemblent tant qu'on ne corrige pas une faute de
 *     frappe dans un vieux template : ce jour-là, trier sur `updatedAt` ferait
 *     basculer le référentiel par défaut de toutes les campagnes suivantes sur
 *     un geste qui ne visait que ce template.
 *  2. Un template sans `createdAt` (enregistré avant l'existence du champ)
 *     compte comme le plus ANCIEN. Il ne reçoit pas de date inventée : « je ne
 *     sais pas quand » n'est pas « maintenant », et se tromper vers l'ancien
 *     laisse le défaut où il est.
 *  3. L'id `default` est écarté du classement même s'il est enregistré : c'est
 *     l'édition du template livré, il est le REPLI, pas une création. Il n'a
 *     d'ailleurs pas de `createdAt` (cf. buildStoredTemplate).
 *
 *  Cette fonction ne sert qu'à CHOISIR à la création d'une campagne. Une fois
 *  choisi, l'id est ÉPINGLÉ sur la campagne (`Campaign.templateId`) : une
 *  campagne ne doit pas changer de référentiel parce que quelqu'un en a créé un
 *  autre entre-temps — ses rapports déjà rendus l'ont été contre l'ancien. */
export async function latestTemplateId(): Promise<string> {
  const stored = (await Templates.list().catch(() => [])).filter(
    (t) => t.id !== DEFAULT_TEMPLATE_ID && typeof t.createdAt === "string"
  );
  if (stored.length === 0) return DEFAULT_TEMPLATE_ID;
  // Tri par date PUIS par id : deux templates créés dans la même milliseconde
  // rendraient sinon un défaut qui dépend de l'ordre de listage du stockage,
  // c'est-à-dire du système de fichiers. Un défaut non déterministe est pire
  // qu'un mauvais défaut : il ne se reproduit pas.
  stored.sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : (a.createdAt as string) < (b.createdAt as string)
        ? -1
        : 1
  );
  return stored[stored.length - 1].id;
}


// Vit ICI et non dans app/api/brief-template/route.ts, où on l'avait d'abord
// écrite : un fichier de route App Router n'a le droit d'exporter que ses verbes
// HTTP et sa configuration. Un export de plus fait échouer le build sur un
// message qui ne parle pas de ça.
/** Représentation servie pour UN template. Partagée par les deux routes pour
 *  que la page de doc et l'éditeur lisent exactement la même chose — deux
 *  sérialisations parallèles divergent, et la divergence se voit le jour où
 *  l'une des deux affiche une adresse de cellule périmée. */
export async function templatePayload(id: string) {
  const resolved = await resolveTemplate(id);
  const tpl = resolved.template;
  return {
    id,
    // Ordinal LISIBLE, pour l'œil et pour les mails. Ne décide de rien.
    version: tpl.version,
    // Empreinte TECHNIQUE de la déclaration. C'est elle qui date un verdict.
    revision: resolved.revision,
    label: tpl.label,
    channel: tpl.channel,
    sheet: BRIEF_SHEET,
    updatedAt: tpl.updatedAt,
    updatedBy: tpl.updatedBy,
    // D'où viennent les FAITS (le classeur d'origine), pour que la page ne
    // présente pas ce référentiel comme une norme sans auteur.
    source: tpl.source,
    // D'où vient le template SERVI — trois états. `stored_invalid` est le seul
    // qui compte : quelqu'un a enregistré une politique qui ne s'applique pas,
    // et sans ce champ l'écran afficherait sereinement le template du code.
    origin: resolved.source,
    problems: resolved.problems,
    languages: tpl.languages,
    languageColumns: tpl.languageColumns,
    // La géométrie brute, que l'éditeur doit pouvoir modifier. La page de doc,
    // elle, ne lit que `layout`.
    geometry: {
      headerRow: tpl.headerRow,
      fieldCol: tpl.fieldCol,
      descCol: tpl.descCol,
      valueCol: tpl.valueCol,
      firstLangCol: tpl.firstLangCol,
    },
    fields: tpl.fields,
    layout: layout(tpl),
    // Le téléchargement est exposé ici plutôt que reconstruit côté client :
    // une URL écrite à la main dans un composant se périme en silence.
    downloadUrl: "/api/brief-template/download",
  };
}

// ── Le référentiel VU DEPUIS UNE CAMPAGNE ────────────────────────────────────
//
// « Pour chaque campagne tu crées le template » : le référentiel se compose là
// où l'on colle le brief, pas dans un écran d'administration séparé. Ça ouvre
// une question que l'écran d'administration n'avait pas — celle-ci :
//
//   Deux campagnes peuvent être épinglées au MÊME template. Enregistrer une
//   colonne de plus depuis la campagne A changerait alors ce contre quoi la
//   campagne B est jugée, sans que personne n'ouvre B. Pire, ses rapports déjà
//   rendus citeraient une révision qui n'existe plus telle quelle : ils ne
//   deviendraient pas faux, ils deviendraient ININTERPRÉTABLES, ce qui est plus
//   difficile à remarquer.
//
// D'où la COPIE SUR ÉCRITURE. Un template partagé — ou le template livré, qui
// est partagé par construction — n'est jamais modifié depuis une campagne : il
// est dupliqué, la copie est épinglée à cette campagne-là, et l'original
// continue de juger les autres exactement comme avant.
//
// Le mode n'est pas deviné à la sauvegarde puis subi : il est MESURÉ avant
// (`campaignTemplateOwnership`) et affiché, pour que « je modifie le mien » et
// « je crée le mien » ne se ressemblent pas au moment du clic.

export interface CampaignTemplateOwnership {
  /** Le référentiel actuellement épinglé à la campagne. */
  readonly templateId: string;
  /** Combien de campagnes sont épinglées dessus, celle-ci comprise. */
  readonly campaignsPinned: number;
  /** Ce qu'un enregistrement FERA. Jamais recalculé côté client. */
  readonly mode: "in-place" | "copy";
  /** Pourquoi, en une phrase affichable. */
  readonly reason: string;
}

export async function campaignTemplateOwnership(
  campaign: Pick<Campaign, "id" | "templateId">
): Promise<CampaignTemplateOwnership> {
  const templateId = campaign.templateId ?? DEFAULT_TEMPLATE_ID;
  const all = await Campaigns.list().catch(() => [] as Campaign[]);
  const pinned = all.filter((c) => (c.templateId ?? DEFAULT_TEMPLATE_ID) === templateId);
  // `campaignsPinned` compte au minimum 1 : la campagne courante peut ne pas
  // figurer dans la liste (elle vient d'être créée, le stockage n'a pas encore
  // rendu la main). Compter 0 afficherait « personne n'utilise ce template »
  // sur l'écran de quelqu'un qui l'utilise.
  const campaignsPinned = Math.max(pinned.length, 1);
  const others = campaignsPinned - 1;

  if (templateId === DEFAULT_TEMPLATE_ID) {
    return {
      templateId,
      campaignsPinned,
      mode: "copy",
      reason:
        "This campaign uses the built-in reference, which judges every campaign that has not made its own. Saving creates a template for this campaign only; the built-in one does not change.",
    };
  }
  if (others > 0) {
    return {
      templateId,
      campaignsPinned,
      mode: "copy",
      reason: `${others} other ${others === 1 ? "campaign uses" : "campaigns use"} this template. Saving creates a copy for this campaign only; ${others === 1 ? "the other one keeps" : "the others keep"} the current one.`,
    };
  }
  return {
    templateId,
    campaignsPinned,
    mode: "in-place",
    reason: "This template belongs to this campaign alone, so saving edits it in place.",
  };
}

export interface CampaignTemplateSaved {
  readonly templateId: string;
  /** Un nouveau référentiel a-t-il été créé et épinglé ? */
  readonly created: boolean;
  readonly version: number;
  readonly revision: string;
  /** La révision qui jugeait AVANT. Deux verdicts qui portent des révisions
   *  différentes n'ont pas été mesurés contre le même référentiel, même quand
   *  les deux disent « conforme ». */
  readonly previousRevision: string;
  readonly warnings: readonly TemplateProblem[];
}

export type CampaignTemplateSaveResult =
  | { readonly ok: true; readonly saved: CampaignTemplateSaved }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly problems?: readonly TemplateProblem[];
      readonly currentVersion?: number;
    };

/** Enregistre le référentiel d'UNE campagne, en copiant si nécessaire.
 *
 *  Le contrôle de renommage de clé (contrôle 9) est opposé au template
 *  EFFECTIF d'avant — y compris lors d'une copie. C'est délibéré : l'objet de
 *  stockage est neuf, mais l'HISTOIRE de la campagne, elle, est continue. Ses
 *  rapports d'hier citent les anciennes clés, et une clé qui s'évapore les
 *  laisse orphelins que le template ait changé d'id ou non.
 */
export async function saveTemplateForCampaign(
  campaignId: string,
  write: TemplateWrite
): Promise<CampaignTemplateSaveResult> {
  const campaign = await Campaigns.get(campaignId);
  if (!campaign) {
    return { ok: false, status: 404, error: `No campaign "${campaignId}".` };
  }
  const own = await campaignTemplateOwnership(campaign);
  const from = await resolveTemplate(own.templateId);
  const prevForCheck = withAcknowledgedRemovals(from.template, write.removedFieldKeys);
  const check = checkTemplateCoherence(write, prevForCheck);
  if (isBlocking(check)) {
    return {
      ok: false,
      status: 400,
      error: "This template cannot measure anything yet.",
      problems: check.problems,
    };
  }

  if (own.mode === "copy") {
    const id = `tpl-${uid()}`;
    // `prev = null` : c'est une naissance, avec sa propre date et sa version 1.
    // `copiedFrom` fait traverser ce qui n'est pas un fait d'enregistrement —
    // le préambule du classeur et la provenance des faits.
    const tpl = buildStoredTemplate(id, write, null, from.template);
    await Templates.put(tpl);
    await Templates.archive(tpl, id);
    // Épinglé APRÈS l'écriture. Épingler d'abord laisserait, en cas d'échec du
    // put, une campagne pointant sur un référentiel qui n'existe pas — état que
    // `resolveTemplate` sait dire (`pinned_missing`) mais qu'on n'a aucune
    // raison de fabriquer soi-même.
    await updateCampaign(campaignId, (c) => {
      c.templateId = id;
    });
    return {
      ok: true,
      saved: {
        templateId: id,
        created: true,
        version: tpl.version,
        revision: templateRevision(tpl),
        previousRevision: from.revision,
        warnings: check.problems,
      },
    };
  }

  // Édition sur place : même verrou de version que /api/brief-template/[id], et
  // pour la même raison — l'accès est partagé sous un seul mot de passe, deux
  // onglets ouverts sur le même écran sont la situation normale.
  return updateTemplate(own.templateId, async (prev) => {
    const base = prev ?? (own.templateId === DEFAULT_TEMPLATE_ID ? DEFAULT_TEMPLATE : null);
    if (!base) {
      return {
        ok: false,
        status: 404,
        error: `No template "${own.templateId}".`,
      } satisfies CampaignTemplateSaveResult;
    }
    if (write.baseVersion !== undefined && write.baseVersion !== base.version) {
      return {
        ok: false,
        status: 409,
        error: `Someone else saved this template while you were editing (you started from v${write.baseVersion}, it is now v${base.version}). Reload to see their changes.`,
        currentVersion: base.version,
      } satisfies CampaignTemplateSaveResult;
    }
    const tpl = buildStoredTemplate(own.templateId, write, prev);
    await Templates.put(tpl);
    // La révision SORTANTE est archivée elle aussi : c'est elle que citent les
    // rapports déjà rendus, donc elle qui deviendrait illisible.
    await Templates.archive(base, own.templateId);
    await Templates.archive(tpl, own.templateId);
    return {
      ok: true,
      saved: {
        templateId: own.templateId,
        created: false,
        version: tpl.version,
        revision: templateRevision(tpl),
        previousRevision: templateRevision(base),
        warnings: check.problems,
      },
    } satisfies CampaignTemplateSaveResult;
  });
}
