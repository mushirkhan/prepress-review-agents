# Build context is the repository root (npm workspaces):
#   docker build -f apps/web/Dockerfile -t prepress-web .

FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @prepress/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w @prepress/web

FROM nginx:stable-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
