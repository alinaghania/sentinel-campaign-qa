// GET : sonde de santé pour les probes Azure Container Apps
// (startup/liveness/readiness). Aucun accès disque ni dépendance : le share
// Azure Files peut être lent/indisponible sans faire redémarrer l'app.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true });
}
