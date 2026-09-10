#!/usr/bin/env bash
#
# 03-migrate-data.sh — Migre .data local vers le share Azure Files sentinel-data.
#
# EXCLUS (décision Devil's Advocate) :
#   - renders/ : screenshots Playwright, régénérables, lourds, et le rendu réel
#     est désactivé sur Azure (RENDER_REAL=0) ;
#   - jobs/    : états de jobs transients, sans valeur après redéploiement.
#
# INCLUS : campaigns, brands, reports, inbox, briefs, tokens, connections
# (+ tout autre sous-dossier hors exclusions).
#
# La clé du compte de stockage est lue en substitution — JAMAIS affichée.
#
set -euo pipefail

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?exporter SUBSCRIPTION_ID avant de lancer ce script}"
RG="${RG:-sentinel-rg}"
SHARE_NAME="${SHARE_NAME:-sentinel-data}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DATA_DIR="${DATA_DIR:-${REPO_ROOT}/.data}"
EXCLUDES=("renders" "jobs")

step() { echo ""; echo "==> [$(date +%H:%M:%S)] $*"; }
die()  { echo "ERREUR: $*" >&2; exit 1; }

command -v az >/dev/null 2>&1 || die "az CLI introuvable."
[[ -d "${DATA_DIR}" ]] || die "Dossier données introuvable: ${DATA_DIR}"

az account set --subscription "${SUBSCRIPTION_ID}"

step "Résolution du compte de stockage dans ${RG}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-$(az storage account list -g "${RG}" --query "[0].name" -o tsv)}"
[[ -n "${STORAGE_ACCOUNT}" ]] || die "Compte de stockage introuvable dans ${RG}."
echo "    Compte: ${STORAGE_ACCOUNT} / share: ${SHARE_NAME}"

# Clé en variable d'environnement uniquement (pas d'argv, pas d'écho).
export AZURE_STORAGE_ACCOUNT="${STORAGE_ACCOUNT}"
AZURE_STORAGE_KEY="$(az storage account keys list -g "${RG}" -n "${STORAGE_ACCOUNT}" --query "[0].value" -o tsv)"
export AZURE_STORAGE_KEY

TOTAL=0
for dir in "${DATA_DIR}"/*/; do
  name="$(basename "${dir}")"
  skip=0
  for ex in "${EXCLUDES[@]}"; do
    [[ "${name}" == "${ex}" ]] && skip=1
  done
  if [[ "${skip}" == "1" ]]; then
    echo "    [skip] ${name}/ (exclu)"
    continue
  fi
  count="$(find "${dir}" -type f | wc -l | tr -d ' ')"
  step "Upload ${name}/ (${count} fichiers)"
  az storage file upload-batch \
    --destination "${SHARE_NAME}" \
    --destination-path "${name}" \
    --source "${dir}" \
    --output none
  TOTAL=$((TOTAL + count))
done

step "TERMINÉ. ${TOTAL} fichiers uploadés vers ${SHARE_NAME}."
