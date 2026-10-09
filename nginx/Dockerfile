# ===========================================================================
# Stage 1: validate nginx configuration
# ===========================================================================
FROM nginxinc/nginx-unprivileged:1.31.6-alpine AS validate

COPY nginx.conf /tmp/default.conf.template

# Render the template with sample values and run `nginx -t` against it.
RUN mkdir -p /tmp/conf.d \
 && NGINX_PORT=8080 GATEWAY_HOST=api-gateway GATEWAY_PORT=3000 \
    envsubst '${NGINX_PORT} ${GATEWAY_HOST} ${GATEWAY_PORT}' \
      < /tmp/default.conf.template > /tmp/conf.d/default.conf \
 && sed 's#/etc/nginx/conf.d/#/tmp/conf.d/#' /etc/nginx/nginx.conf > /tmp/nginx.conf \
 && nginx -t -c /tmp/nginx.conf

# ===========================================================================
# Stage 2: runtime - unprivileged nginx
# ===========================================================================
FROM nginxinc/nginx-unprivileged:1.31.6-alpine AS runtime

LABEL org.opencontainers.image.title="Microservices-Shop-nginx" \
      org.opencontainers.image.description="Reverse proxy and single entry point for the shop microservices"

ENV NGINX_PORT=8080 \
    GATEWAY_HOST=api-gateway \
    GATEWAY_PORT=3000

USER root
RUN apk upgrade --no-cache

COPY --from=validate /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY html/index.html /usr/share/nginx/html/index.html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${NGINX_PORT}/nginx-health" || exit 1

STOPSIGNAL SIGQUIT
