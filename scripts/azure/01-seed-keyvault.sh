#!/usr/bin/env bash
#
# 01-seed-keyvault.sh — Peuple le Key Vault Sentinel depuis .env.local.
#
# Secrets écrits (JAMAIS affichés — passage par stdin, pas d'écho) :
#   FOUNDRY-API-KEY      <- FOUNDRY_API_KEY      (.env.local)
#   GOOGLE-CLIENT-SECRET <- GOOGLE_CLIENT_SECRET (.env.local)
#   SENTINEL-ACCESS-KEY  <- généré (openssl rand -hex 16) si absent du vault ;
#                           s'il existe déjà, il est conservé (rotation via
#                           `az keyvault secret set`, cf. README-AZURE.md).
#   IMAP-APP-PASSWORD    <- IMAP_PASSWORD (.env.local), OPTIONNEL. Mot de passe
#                           d'application Google pour la relève IMAP. Absent du
#                           .env.local => secret non touché (ni créé, ni effacé),
#                           l'app reste sur la voie OAuth. Cf.
#                           le README (section Boîte de réception).
#
# USAGE : ./01-seed-keyvault.sh /chemin/vers/.env.local
#
set -euo pipefail

ENV_FILE="${1:-}"
RG="${RG:-sentinel-rg}"
KV_NAME="${KV_NAME:-}"

step() { echo ""; echo "==> $*"; }
die()  { echo "ERREUR: $*" >&2; exit 1; }

command -v az >/dev/null 2>&1 || die "az CLI introuvable."
command -v openssl >/dev/null 2>&1 || die "openssl introuvable."
[[ -n "${ENV_FILE}" ]] || die "Usage: $0 <chemin .env> (ex: ./.env.local)"
[[ -f "${ENV_FILE}" ]] || die "Fichier .env introuvable: ${ENV_FILE}"

if [[ -z "${KV_NAME}" ]]; then
  step "Résolution du Key Vault dans ${RG}"
  KV_NAME="$(az keyvault list --resource-group "${RG}" --query "[0].name" -o tsv 2>/dev/null || true)"
fi
[[ -n "${KV_NAME}" ]] || die "Key Vault introuvable. Passe KV_NAME=... ou lance 00-provision.sh d'abord."
echo "    Key Vault: ${KV_NAME}"

# Lit une variable du .env sans sourcer le fichier ni écho de la valeur.
read_env() {
  local var="$1"
  local line
  line="$(grep -E "^[[:space:]]*${var}=" "${ENV_FILE}" | head -n1 || true)"
  [[ -z "${line}" ]] && { echo ""; return 0; }
  local val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "${val}"
}

# set_secret <NOM_KV> <valeur> — valeur passée via stdin (jamais en argv/écho).
# printf (PAS de here-string <<<) : le here-string ajoute un \n final que
# `az keyvault secret set --file` stockerait VERBATIM → un \n dans
# FOUNDRY_API_KEY casse les headers HTTP, dans SENTINEL_ACCESS_KEY casse le
# hash du cookie. printf '%s' n'émet aucune newline.
set_secret() {
  local kv_secret="$1" value="$2"
  [[ -n "${value}" ]] || die "Valeur manquante pour le secret requis ${kv_secret}."
  printf '%s' "${value}" | az keyvault secret set \
    --vault-name "${KV_NAME}" \
    --name "${kv_secret}" \
    --file /dev/stdin \
    -o none
  echo "    [set ] ${kv_secret}"
}

step "Lecture des secrets depuis ${ENV_FILE} (valeurs non affichées)"
V_FOUNDRY="$(read_env FOUNDRY_API_KEY)"
V_GOOGLE="$(read_env GOOGLE_CLIENT_SECRET)"

step "Écriture des secrets dans ${KV_NAME}"
set_secret "FOUNDRY-API-KEY"      "${V_FOUNDRY}"
set_secret "GOOGLE-CLIENT-SECRET" "${V_GOOGLE}"

# SENTINEL-ACCESS-KEY : généré une seule fois, jamais affiché.
if az keyvault secret show --vault-name "${KV_NAME}" --name "SENTINEL-ACCESS-KEY" -o none 2>/dev/null; then
  echo "    [keep] SENTINEL-ACCESS-KEY (déjà présent, conservé)"
else
  set_secret "SENTINEL-ACCESS-KEY" "$(openssl rand -hex 16 | tr -d '\n')"
  echo "    [gen ] SENTINEL-ACCESS-KEY généré (récupération : voir README-AZURE.md)"
fi

# IMAP-APP-PASSWORD : optionnel. Les blancs sont retirés — Google affiche le mot
# de passe en 4 blocs de 4, mais les espaces ne font pas partie du secret et le
# serveur IMAP rejette le login si on les transmet.
V_IMAP="$(read_env IMAP_PASSWORD | tr -d '[:space:]')"
if [[ -n "${V_IMAP}" ]]; then
  set_secret "IMAP-APP-PASSWORD" "${V_IMAP}"
else
  echo "    [skip] IMAP-APP-PASSWORD (IMAP_PASSWORD absent de ${ENV_FILE})"
fi

step "TERMINÉ. Contrôle :"
az keyvault secret list --vault-name "${KV_NAME}" --query "[].name" -o tsv
