FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Shared Volume (ADR-0004) mountet hierhin — Ownership muss zum USER node passen,
# damit frische Named Volumes die Rechte aus dem Image übernehmen.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
CMD ["node", "dist/api/index.js"]
