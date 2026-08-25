FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
COPY server/package.json server/package-lock.json ./server/
COPY web/package.json web/package-lock.json ./web/

RUN npm ci --prefix server
RUN npm ci --prefix web

COPY . .

RUN npm run build --prefix web
RUN npm run build --prefix server

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --global @openai/codex@0.146.0

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist

ENV HOME=/home/node
ENV CODEX_BIN_JS=/usr/local/lib/node_modules/@openai/codex/bin/codex.js
ENV CODEX_SOURCE_HOME=/home/node/.codex

USER node

EXPOSE 4317

CMD ["node", "server/dist/index.js"]