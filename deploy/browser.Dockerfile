# Браузер Ремонтника: служба врача и живой экран владельца. Только Chromium, прокси нет, пока не задан в профиле.
# Сборка из корня репозитория: docker build -f deploy/browser.Dockerfile -t remontnik-browser .
# Порт 7700 — только во внутреннюю сеть compose или на частный адрес (`-p 10.0.0.5:7700:7700`), не на все адреса хоста.
# Базовые образы закреплены по digest: тег можно перезаписать, digest — нет. Обновление — новый digest здесь.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /src
# pnpm — с проверкой хеша архива (deploy/install-pnpm.mjs), а не скачиванием corepack без проверки.
COPY deploy/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY . .
RUN pnpm install --frozen-lockfile --filter @ykurilov/remontnik-browser... \
 && pnpm --filter @ykurilov/remontnik-browser build \
 && pnpm --filter @ykurilov/remontnik-browser deploy --legacy --prod /app

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    REMONTNIK_BROWSER_DATA_DIR=/data \
    REMONTNIK_BROWSER_LISTEN=0.0.0.0:7700 \
    REMONTNIK_BROWSER_POLICY=/config/browser-policy.json
COPY --from=build /app /app
# Безголовый Chromium той же сборки, что ждёт закреплённый playwright-core, и системные библиотеки к нему.
RUN node /app/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 remontnik \
 && mkdir -p /data && chown remontnik /data
USER remontnik
VOLUME /data
EXPOSE 7700
CMD ["node", "/app/dist/cli/main.js", "serve"]
