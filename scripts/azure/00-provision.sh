#!/usr/bin/env bash
#
# 00-provision.sh — Provisionne le SOCLE Azure de Sentinel (sans l'app).
#
# Crée : resource group + identity + Key Vault + Log Analytics + storage
# (share sentinel-data) + Container Apps env (deployApp=false).
# L'app est déployée ensuite par 02-deploy.sh, APRÈS le seed du Key Vault
# (01-seed-keyvault.sh) et la migration des données (03-migrate-data.sh).
#
# Prérequis : az CLI loggé sur la subscription cible.
#
set -euo pipefail

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:?exporter SUBSCRIPTION_ID avant de lancer ce script}"
RG="${RG:-sentinel-rg}"
LOCATION="${LOCATION:-francecentral}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BICEP_MAIN="${BICEP_MAIN:-${REPO_ROOT}/infra/azure/main.bicep}"

step() { echo ""; echo "==> [$(date +%H:%M:%S)] $*"; }
die()  { echo "ERREUR: $*" >&2; exit 1; }

command -v az >/dev/null 2>&1 || die "az CLI introuvable."
[[ -f "${BICEP_MAIN}" ]] || die "Bicep introuvable: ${BICEP_MAIN}"

step "Sélection de la subscription ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

step "Resource group ${RG} (${LOCATION})"
az group create --name "${RG}" --location "${LOCATION}" --tags product=sentinel -o none

# Sans operatorObjectId, le template réécrit accessPolicies sans l'opérateur
# humain : le coffre devient illisible pour lui (01-seed-keyvault.sh échoue en
# Forbidden juste après). On repasse donc l'identité connectée.
OPERATOR_OID="${OPERATOR_OID:-$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)}"
[[ -n "${OPERATOR_OID}" ]] \
  && echo "    operatorObjectId=${OPERATOR_OID} (accès Key Vault préservé)" \
  || echo "    ATTENTION: objectId opérateur introuvable, l'accès Key Vault ne sera PAS accordé." >&2

step "Déploiement du socle (deployApp=false)"
az deployment group create \
  --resource-group "${RG}" \
  --name "sentinel-infra-socle" \
  --template-file "${BICEP_MAIN}" \
  --parameters deployApp=false \
      operatorObjectId="${OPERATOR_OID}" \
  -o json \
  --query "properties.outputs.{kv:keyVaultName.value, storage:storageAccountName.value, share:shareName.value, domain:containerEnvDefaultDomain.value}"

step "TERMINÉ. Étapes suivantes :"
echo "    1. ./01-seed-keyvault.sh ${REPO_ROOT}/.env.local"
echo "    2. ./03-migrate-data.sh"
echo "    3. ./02-deploy.sh"
