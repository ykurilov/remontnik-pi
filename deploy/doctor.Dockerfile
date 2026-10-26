# Врач Ремонтника (`start`): служба, зеркало реестра пакетов и прокси eval для контейнеров случая.
# Сборка из корня репозитория: docker build -f deploy/doctor.Dockerfile -t remontnik-doctor .
# В образе: Node, git (врачу — для веток и меток) и клиент Docker (контейнеры верстака через сокет хоста).
# Секретов в образе нет: всё — из окружения сервера при запуске (deploy/compose.remontnik.yml).
# Базовые образы закреплены по digest: тег можно перезаписать, digest — нет. Обновление — новый digest здесь.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /src
# pnpm — с проверкой хеша архива (deploy/install-pnpm.mjs), а не скачиванием corepack без проверки.
COPY deploy/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY . .
RUN pnpm install --frozen-lockfile --filter @ykurilov/remontnik-doctor... \
 && pnpm --filter @ykurilov/remontnik-doctor... build \
 && pnpm --filter @ykurilov/remontnik-doctor deploy --legacy --prod /app

# Клиент Docker и compose — готовые статические файлы; демон в образ не входит, он на хосте.
FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker-cli

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
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
