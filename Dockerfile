FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 bookrpg \
  && useradd --system --uid 10001 --gid bookrpg --home-dir /app bookrpg

COPY --from=build --chown=bookrpg:bookrpg /app/package.json /app/package-lock.json ./
COPY --from=build --chown=bookrpg:bookrpg /app/node_modules ./node_modules
COPY --from=build --chown=bookrpg:bookrpg /app/dist/src ./dist/src
COPY --chown=bookrpg:bookrpg public ./public

USER bookrpg
EXPOSE 8787

CMD ["npm", "start"]
