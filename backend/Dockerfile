#syntax=docker/dockerfile:1

FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Full deps (incl. dev) for compiling TypeScript.
FROM base AS deps
RUN npm ci

# Prod-only deps for the runtime image.
FROM base AS prod-deps
RUN npm ci --omit=dev

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Tectonic is a statically-linked (musl) single binary — no LaTeX
# distribution install needed, just fetch and unpack the release.
FROM node:22-slim AS tectonic-bin
ARG TECTONIC_VERSION=0.16.9
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL \
    "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin tectonic \
    && chmod +x /usr/local/bin/tectonic

# Compile a fixture document at build time so the image ships with a warm
# resource cache — otherwise the first real compile a user runs pays a
# one-time ~60-90s cost downloading fonts/packages from the network.
FROM tectonic-bin AS warm-cache
ENV TECTONIC_CACHE_DIR=/var/cache/tectonic
COPY docker/warmup.tex /warm/main.tex
RUN mkdir -p /var/cache/tectonic \
    && tectonic -X compile /warm/main.tex --outdir /warm --untrusted

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=tectonic-bin /usr/local/bin/tectonic /usr/local/bin/tectonic
COPY --from=warm-cache /var/cache/tectonic /var/cache/tectonic

RUN groupadd -r appuser \
    && useradd -r -g appuser -m -d /home/appuser appuser \
    && mkdir -p /app/workspaces \
    && chown -R appuser:appuser /app /var/cache/tectonic

USER appuser
ENV WORKSPACES_ROOT=/app/workspaces \
    TECTONIC_PATH=/usr/local/bin/tectonic \
    TECTONIC_CACHE_DIR=/var/cache/tectonic \
    PORT=4000

EXPOSE 4000
CMD ["node", "dist/server.js"]
