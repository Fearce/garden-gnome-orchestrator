# The Online Office relay. Deliberately tiny: one runtime dependency (ws), no database, no native
# build — so it builds directly on a small (4 GB) VPS without the out-of-memory thrash that heavier
# images hit there.
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
