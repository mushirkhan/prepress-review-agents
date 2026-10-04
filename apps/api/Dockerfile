# Build context is the repository root (npm workspaces):
#   docker build -f apps/api/Dockerfile -t prepress-api .

# ---- build: install all deps and compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build -w @prepress/api

# ---- runtime: production deps only, non-root ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --no-audit --no-fund -w @prepress/api && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist

# The image's built-in "node" user has UID 1000, matching /srv/prepress/data on the VM.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
