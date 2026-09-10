// Le brief d'une campagne ET le référentiel contre lequel il sera mesuré, sur
// un seul écran. Créer son template passe par la campagne, jamais par un écran
// d'administration séparé — c'est là que le brief arrive, donc là qu'on voit
// qu'il ne rentre pas.
//
// GARDE STRUCTURELLE — ce que le métier colle ici doit produire EXACTEMENT la
// même `BriefGrid` qu'un fichier Excel importé, et ce n'est pas une promesse
// tenue par de la discipline : il n'existe pas de second chemin d'import. Le
// tableau est composé en classeur .xlsx par /api/brief-template/compose, puis
// ce classeur est posté à /api/campaigns/[id]/brief comme n'importe quel
// fichier. Il traverse donc `parseBriefGridDetailed`, reçoit sa télémétrie, et
// c'est cette télémétrie — pas une valeur écrite ici — qui renseigne
// `briefFamily`. Un import « collé » qui construirait sa grille lui-même
// aurait sa propre façon d'échouer, et rouvrirait par une porte neuve le trou
// qu'on vient de fermer : une famille non mesurée qui se lit comme une famille
// connue.
//
// Cette page est un SERVEUR : elle lit le référentiel EFFECTIF de la campagne
// une fois, et mesure ce qu'un enregistrement ferait (éditer sur place, ou
// copier). Ce second point n'est pas déductible côté client — il dépend du
// nombre de campagnes épinglées sur le même référentiel.
import Link from "next/link";
import { notFound } from "next/navigation";
import { BRIEF_SHEET } from "@/lib/brief-template";
import { Campaigns } from "@/lib/store";
import { campaignTemplateOwnership, resolveTemplate } from "@/lib/template-resolve";
import BriefComposer from "./BriefComposer";

export const dynamic = "force-dynamic";

export default async function PasteBriefPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaign = await Campaigns.get(id);
  // Une campagne introuvable rendait auparavant le template livré et un tableau
  // parfaitement utilisable : on collait un brief entier avant d'apprendre, à
  // l'import, qu'il n'y avait pas de campagne où le poser.
  if (!campaign) notFound();

  const { template: tpl, revision } = await resolveTemplate(campaign.templateId ?? undefined);
  const ownership = await campaignTemplateOwnership(campaign);

  return (
    <div className="pb-10">
      <div className="mb-5 flex items-end justify-between gap-6">
        <div>
          <p className="eyebrow">{campaign.name}</p>
          <h1 className="doc-title text-[26px]">Brief &amp; template</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/brief-template" className="btn">
            Column reference
          </Link>
          <Link href={`/campaigns/${id}/brief`} className="btn btn-ghost">
            Skip
          </Link>
        </div>
      </div>

      <BriefComposer
        campaignId={id}
        sheet={BRIEF_SHEET}
        templateId={ownership.templateId}
        version={tpl.version}
        revision={revision}
        ownership={ownership}
        initial={{
          label: tpl.label,
          channel: tpl.channel,
          geometry: {
            headerRow: tpl.headerRow,
            fieldCol: tpl.fieldCol,
            descCol: tpl.descCol,
            valueCol: tpl.valueCol,
            firstLangCol: tpl.firstLangCol,
          },
          languageColumns: [...tpl.languageColumns],
          // `?? ""` : à l'écran le glossaire est TOUJOURS une chaîne. Un champ
          // contrôlé qui bascule entre `undefined` et `""` repasse non contrôlé
          // le temps d'un rendu, et React y perd la position du curseur.
          // L'absence est reconvertie en `undefined` au moment d'enregistrer.
          glossary: tpl.glossary ?? "",
          languages: tpl.languages.map((l) => ({ ...l })),
          fields: tpl.fields.map((f) => ({ ...f })),
        }}
      />
    </div>
  );
}
