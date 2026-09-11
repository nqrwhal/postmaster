FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    POSTMASTER_DB_PATH=/data/tracker.sqlite

WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/deploy ./deploy

RUN mkdir -p /data /backups && chown node:node /data /backups
USER node

EXPOSE 8765
VOLUME ["/data", "/backups"]
CMD ["node", "dist/server/index.js"]
