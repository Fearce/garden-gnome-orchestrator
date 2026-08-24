# The Online Office relay. Deliberately tiny: one runtime dependency (ws), no database, no native
# build — so it can be built ON the 4 GB Hetzner box without the OOM thrash that forced Sprogbroen's
# own images onto a GitHub runner.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# An empty named volume inherits this directory's ownership, so the unprivileged runtime user can
# actually write the member + history files it mounts here.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
