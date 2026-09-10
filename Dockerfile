# syntax=docker/dockerfile:1
# Sentinel — image de production Azure Container Apps.
# Pattern multi-stage repris de Moliere (v0-moliere_vf/Dockerfile).

##########
# deps   #
##########
# Installe node_modules uniquement. PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD empêche le
# téléchargement de Chromium (~centaines de Mo) par la dépendance `playwright` :
# le rendu réel est désactivé sur Azure (RENDER_REAL=0).
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci

##########
# builder#
##########
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Pas de NEXT_PUBLIC_* : toute la config (Foundry, Google, access key) est
# résolue côté serveur au runtime via Key Vault. Rien à inliner au build.

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Produit .next/standalone (server.js + node_modules tracés, sans Playwright
# grâce à outputFileTracingExcludes) + .next/static
RUN npm run build

##########
# runner #
##########
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# CRITIQUE sur Azure Container Apps : le serveur standalone binde 127.0.0.1
# par défaut, ce qui rend l'ingress injoignable. On force toutes les interfaces.
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Point de montage Azure Files (.data) : créé et chowné AVANT le passage en
# user non-root, sinon EACCES au premier write si le volume n'est pas monté.
RUN mkdir -p /app/.data && chown nextjs:nodejs /app/.data

# Copie uniquement la sortie standalone — pas de node_modules complet,
# pas de Playwright/Chromium.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
