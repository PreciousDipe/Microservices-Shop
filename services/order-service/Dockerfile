# ===========================================================================
# Stage 1: build - install production dependencies with npm
# ===========================================================================
FROM alpine:3.24.2 AS build

RUN apk add --no-cache nodejs~24 npm

WORKDIR /app

# Dependencies first: this layer is reused until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# ===========================================================================
# Stage 2: runtime - plain Alpine + Node.js, no npm
# ===========================================================================
FROM alpine:3.24.2 AS runtime

LABEL org.opencontainers.image.title="Microservices-Shop-Order-Service" \
      org.opencontainers.image.description="Order service (PostgreSQL)"

# Node.js only (npm never enters this stage), latest Alpine patches, and a non-root user.
RUN apk add --no-cache nodejs~24 \
 && apk upgrade --no-cache \
 && addgroup -S -g 1001 app \
 && adduser  -S -u 1001 -G app -H -h /app -s /sbin/nologin app

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=192" \
    PORT=3000

# Files stay owned by root, so the app cannot modify its own code.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER app:app

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

STOPSIGNAL SIGTERM

# Exec form: node runs as PID 1 and receives SIGTERM directly.
CMD ["node", "src/server.js"]
