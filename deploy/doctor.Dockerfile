# Врач Ремонтника и прокси выхода верстака: один образ, разные команды (`start`, `egress-proxy`).
# Сборка из корня репозитория: docker build -f deploy/doctor.Dockerfile -t remontnik-doctor .
# В образе: Node, git (врачу — для веток и меток) и клиент Docker (контейнеры верстака через сокет хоста).
# Секретов в образе нет: всё — из окружения сервера при запуске (deploy/compose.remontnik.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @ykurilov/remontnik-doctor... \
 && pnpm --filter @ykurilov/remontnik-doctor... build \
 && pnpm --filter @ykurilov/remontnik-doctor deploy --legacy --prod /app

# Клиент Docker и compose — готовые статические файлы; демон в образ не входит, он на хосте.
FROM docker:29-cli AS docker-cli

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 remontnik
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=build /app /app
ENV NODE_ENV=production
USER remontnik
ENTRYPOINT ["node", "/app/dist/cli/remontnik-doctor.js"]
CMD ["start"]
