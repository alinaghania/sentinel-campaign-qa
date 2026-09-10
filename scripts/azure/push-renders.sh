#!/usr/bin/env bash
#
# push-renders.sh — pousse les SCREENSHOTS de rendu réel capturés EN LOCAL
# (vrai Gmail web, obtenus via `npm run render:login` puis une analyse locale)
# vers le partage Azure Files de Sentinel. L'app cloud les sert alors comme si
# elle les avait produits (onglet Email + export Excel « Screenshots »).
#
# POURQUOI : le vrai rendu Gmail exige une session Google connectée dans un
# navigateur — impossible sur un conteneur Azure headless (anti-bot Google).
# On capture donc en local (où la session existe) et on PUSH le résultat.
#
# USAGE :
#   ./scripts/azure/push-renders.sh                 # tout .data/renders
#   ./scripts/azure/push-renders.sh <versionId>     # une seule version
#
# Pré-requis : az CLI loggé, avoir lancé une analyse locale (qui remplit
# .data/renders/<versionId>/<provider>-desktop.png + -mobile-*.png).
set -euo pipefail

RG="${RG:-sentinel-rg}"
SHARE="${SHARE:-sentinel-data}"
DATA_DIR="${DATA_DIR:-.data}"
SRC_ROOT="${DATA_DIR}/renders"
ONLY_VERSION="${1:-}"

die() { echo "ERREUR: $*" >&2; exit 1; }

[[ -d "${SRC_ROOT}" ]] || die "Aucun dossier ${SRC_ROOT} — lance d'abord une analyse locale (rendu réel activé)."

echo "==> Résolution du storage account dans ${RG}"
SA="$(az storage account list -g "${RG}" --query "[0].name" -o tsv)"
[[ -n "${SA}" ]] || die "Storage account introuvable dans ${RG}."
KEY="$(az storage account keys list -n "${SA}" -g "${RG}" --query "[0].value" -o tsv)"
echo "    storage=${SA} share=${SHARE}"

# Chemin cible dans le share = renders/ (le share est monté sur /app/.data,
# donc renders/<versionId>/ correspond à .data/renders/<versionId>/ côté app).
if [[ -n "${ONLY_VERSION}" ]]; then
  SRC="${SRC_ROOT}/${ONLY_VERSION}"
  [[ -d "${SRC}" ]] || die "Version ${ONLY_VERSION} absente de ${SRC_ROOT}."
  DEST_PATH="renders/${ONLY_VERSION}"
  echo "==> Push de la version ${ONLY_VERSION}"
else
  SRC="${SRC_ROOT}"
  DEST_PATH="renders"
  N=$(find "${SRC}" -name '*.png' | wc -l | tr -d ' ')
  echo "==> Push de TOUS les renders (${N} PNG) — peut prendre quelques minutes"
fi

az storage file upload-batch \
  --account-name "${SA}" --account-key "${KEY}" \
  --destination "${SHARE}" \
  --destination-path "${DEST_PATH}" \
  --source "${SRC}" \
  --pattern '*.png' \
  --no-progress \
  --output none

echo "==> TERMINÉ. Les screenshots sont visibles dans l'app Azure (onglet Email + export Excel)."
