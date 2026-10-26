# Браузер Ремонтника: служба врача и живой экран владельца. Только Chromium, прокси нет, пока не задан в профиле.
# Сборка из корня репозитория: docker build -f deploy/browser.Dockerfile -t remontnik-browser .
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @ykurilov/remontnik-browser... \
 && pnpm --filter @ykurilov/remontnik-browser build \
 && pnpm --filter @ykurilov/remontnik-browser deploy --legacy --prod /app

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    REMONTNIK_BROWSER_DATA_DIR=/data \
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
