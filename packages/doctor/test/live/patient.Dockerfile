# «Пациент» живой группы: сторож Ремонтника и присмотр за процессом (patient/runner.mjs). Код самого «Пациента»
# в образ не входит: процесс берёт его из папки выкаток ($PATIENT_DEPLOY_ROOT/current), куда выкатывает врач.
# Сборка из корня репозитория: docker build -f packages/doctor/test/live/patient.Dockerfile -t remontnik-live-patient .
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /src
COPY deploy/install-pnpm.mjs /tmp/install-pnpm.mjs
RUN node /tmp/install-pnpm.mjs
COPY . .
RUN pnpm install --frozen-lockfile --filter @ykurilov/remontnik-watch... \
 && pnpm --filter @ykurilov/remontnik-watch... build \
 && pnpm --filter @ykurilov/remontnik-watch deploy --legacy --prod /runner

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
COPY --from=build /runner /runner
COPY packages/doctor/test/live/patient/runner.mjs /runner/runner.mjs
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/runner/runner.mjs"]
