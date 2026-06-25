# syntax=docker/dockerfile:1
# Production targets linux/amd64 (Canon EDSDK: server/vendor/esdk/linux/x86_64/).
ARG TARGETPLATFORM=linux/amd64
FROM --platform=$TARGETPLATFORM oven/bun:1-debian AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY . .
RUN bun run build

FROM --platform=$TARGETPLATFORM oven/bun:1-debian

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libvips42 \
    libusb-1.0-0 \
    udev \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.output ./.output
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
COPY docker/canon-bridge-entrypoint.sh /usr/local/bin/canon-bridge-entrypoint.sh
RUN chmod +x /usr/local/bin/canon-bridge-entrypoint.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV BUN_BIN=/usr/local/bin/bun

EXPOSE 3000

CMD ["bun", ".output/server/index.mjs"]
