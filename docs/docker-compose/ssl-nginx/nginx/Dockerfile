FROM nginx:stable

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates cron openssl \
    && rm -rf /var/lib/apt/lists/*

ARG ACME_EMAIL=admin@example.com
RUN curl -fsSL https://get.acme.sh | sh -s email=${ACME_EMAIL} \
 && /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt

COPY default.conf.template /etc/nginx/conf.d/default.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
