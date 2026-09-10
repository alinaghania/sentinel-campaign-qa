#!/usr/bin/env bash
#
# 02-deploy.sh — Build l'image dans l'ACR Molière (réutilisé) puis déploie
# le Container App sentinel-web (deployApp=true).
#
# Prérequis : socle provisionné (00), Key Vault peuplé (01), données migrées (03).
# Les credentials ACR sont lus en substitution — JAMAIS affichés.
#
set -euo pipefail

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?exporter SUBSCRIPTION_ID avant de lancer ce script}"
RG="${RG:-sentinel-rg}"
ACR_NAME="${ACR_NAME:?exporter ACR_NAME (registre de conteneurs cible)}"
IMAGE_NAME="${IMAGE_NAME:-sentinel-web}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BICEP_MAIN="${BICEP_MAIN:-${REPO_ROOT}/infra/azure/main.bicep}"

step() { echo ""; echo "==> [$(date +%H:%M:%S)] $*"; }
die()  { echo "ERREUR: $*" >&2; exit 1; }

command -v az >/dev/null 2>&1 || die "az CLI introuvable."
[[ -f "${BICEP_MAIN}" ]] || die "Bicep introuvable: ${BICEP_MAIN}"
[[ -f "${REPO_ROOT}/Dockerfile" ]] || die "Dockerfile introuvable dans ${REPO_ROOT}."

az account set --subscription "${SUBSCRIPTION_ID}"

ACR_LOGIN_SERVER="$(az acr show --name "${ACR_NAME}" --query loginServer -o tsv)"
FULL_IMAGE="${ACR_LOGIN_SERVER}/${IMAGE_NAME}:${IMAGE_TAG}"

step "Build + push ${FULL_IMAGE} via az acr build (linux/amd64, build côté serveur)"
az acr build \
  --registry "${ACR_NAME}" \
  --image "${IMAGE_NAME}:${IMAGE_TAG}" \
  --platform linux/amd64 \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}"

step "Résolution du domaine de l'environnement Container Apps"
DEFAULT_DOMAIN="$(az deployment group show -g "${RG}" -n sentinel-infra-socle \
  --query "properties.outputs.containerEnvDefaultDomain.value" -o tsv 2>/dev/null || true)"
if [[ -z "${DEFAULT_DOMAIN}" ]]; then
  DEFAULT_DOMAIN="$(az containerapp env show -g "${RG}" -n sentinel-env \
    --query "properties.defaultDomain" -o tsv)"
fi
[[ -n "${DEFAULT_DOMAIN}" ]] || die "Domaine de sentinel-env introuvable."
GOOGLE_REDIRECT_URI="${GOOGLE_REDIRECT_URI:-https://sentinel-web.${DEFAULT_DOMAIN}/api/auth/google/callback}"
echo "    GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI}"
echo "    (à enregistrer dans la Google Cloud Console si pas déjà fait)"

# operatorObjectId : sans lui, le paramètre retombe sur '' et l'access policy de
# l'opérateur humain DISPARAÎT du coffre à chaque redéploiement (le template
# réécrit accessPolicies en entier). C'est ce qui a rendu le vault illisible
# pour le compte d'Alina. On repasse donc systématiquement l'identité connectée.
OPERATOR_OID="${OPERATOR_OID:-$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)}"
if [[ -n "${OPERATOR_OID}" ]]; then
  echo "    operatorObjectId=${OPERATOR_OID} (accès Key Vault préservé)"
else
  echo "    ATTENTION: objectId opérateur introuvable (principal non-humain ?)." >&2
  echo "    Le déploiement va RETIRER l'accès Key Vault de l'opérateur." >&2
  echo "    Passe OPERATOR_OID=<objectId> pour l'éviter." >&2
fi

step "Déploiement complet (deployApp=true) — les creds ACR ne sont pas affichés"
az deployment group create \
  --resource-group "${RG}" \
  --name "sentinel-deploy-${IMAGE_TAG}" \
  --template-file "${BICEP_MAIN}" \
  --parameters \
      deployApp=true \
      operatorObjectId="${OPERATOR_OID}" \
      webImage="${FULL_IMAGE}" \
      registryLoginServer="${ACR_LOGIN_SERVER}" \
      registryUsername="$(az acr credential show --name "${ACR_NAME}" --query username -o tsv)" \
      registryPassword="$(az acr credential show --name "${ACR_NAME}" --query 'passwords[0].value' -o tsv)" \
      googleRedirectUri="${GOOGLE_REDIRECT_URI}" \
      qaExtended="${QA_EXTENDED:-1}" \
  -o json \
  --query "properties.outputs.{webUrl:webUrl.value}"

step "TERMINÉ. Vérifie la révision :"
echo "    az containerapp revision list -g ${RG} -n sentinel-web -o table"
echo "    curl https://sentinel-web.${DEFAULT_DOMAIN}/api/health"
