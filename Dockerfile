FROM node:24-alpine AS build
RUN apk add --no-cache g++ make python3
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml biome.json ./
RUN pnpm --version \
    && gyp_main="$(find /root/.cache/node/corepack -type f -path '*/node-gyp/gyp/gyp_main.py' -print -quit)" \
    && test -n "$gyp_main" \
    && chmod 0755 "$gyp_main"
COPY apps/server/package.json apps/server/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY packages/contracts packages/contracts
RUN pnpm --filter @discord-music/server... build

FROM node:24-alpine AS runtime
ARG BUILD_SHA=0000000000000000000000000000000000000000
ARG BUILD_TREE=0000000000000000000000000000000000000000
LABEL org.opencontainers.image.revision=$BUILD_SHA \
      io.discord-music.source-tree=$BUILD_TREE
RUN apk add --no-cache ffmpeg tini yt-dlp
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/server/dist/main.js"]
