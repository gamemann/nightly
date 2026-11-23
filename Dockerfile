# The nightly panel. docker compose up -d builds this and starts it next to ClickHouse.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NIGHTLY_DB=/data/nightly.db
COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/nightly-entrypoint
RUN chmod +x /usr/local/bin/nightly-entrypoint && mkdir -p /data
VOLUME /data
EXPOSE 3010
ENTRYPOINT ["tini", "--", "nightly-entrypoint"]
CMD ["npm", "run", "start"]
