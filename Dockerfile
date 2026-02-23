FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lib/ ./lib/
COPY src/ ./src/
COPY public/ ./public/
COPY templates/ ./templates/

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3000
ENV HOST=0.0.0.0

VOLUME ["/data"]

EXPOSE 3000

WORKDIR /data

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "/app/src/cli/index.ts", "start"]
