# hadrontool-ms-exchange — Microsoft Exchange email tool.
#
# Built by Komodo from this repo's `main`, pushed to GHCR, deployed on the
# `komodo_default` network. The operations plane is INTERNAL-ONLY —
# hadron-server reaches it by container name at http://hadrontool-ms-exchange:8080.
# UNLIKE hadrontool-pdf, ONE route needs public ingress: a Traefik router +
# Cloudflare DNS must expose <WEBHOOK_BASE_URL>/webhooks/msgraph so Microsoft
# Graph can deliver change notifications. Route ONLY that path publicly.
#
# Secrets are injected at runtime by Doppler (`doppler run --`), matching the
# other Hadron services — Komodo sets only DOPPLER_TOKEN.
FROM node:22-slim

WORKDIR /app

# openssl: required by Prisma's query engine on slim images.
# Doppler CLI for runtime secret injection (same pattern as the other services).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl \
  && curl -sLf --retry 3 --tlsv1.2 --proto '=https' 'https://cli.doppler.com/install.sh' | sh \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

# Reproducible install from the committed lockfile, then compile and drop dev
# deps. --include=dev because NODE_ENV=production would otherwise skip
# typescript/prisma and the build would fail.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node

EXPOSE 8080
# Doppler injects MS_EXCHANGE_TOOL_TOKEN / DATABASE_URL / TOKEN_ENCRYPTION_KEY /
# MICROSOFT_* / WEBHOOK_* / CORE_EVENTS_* via DOPPLER_TOKEN.
CMD ["doppler", "run", "--", "node", "dist/index.js"]
