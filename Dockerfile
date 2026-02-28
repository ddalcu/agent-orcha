FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Networking & Security
    curl wget nmap netcat-openbsd dnsutils iputils-ping traceroute tcpdump \
    whois openssh-client openssl socat arp-scan masscan \
    # Data Processing
    jq python3 python3-pip python3-venv \
    # System & File Tools
    git zip unzip tar file htop lsof procps cron \
    # Browser Sandbox
    chromium xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lib/ ./lib/
COPY src/ ./src/
COPY public/ ./public/
COPY templates/ ./templates/

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && groupadd -g 10000 sandbox \
    && useradd -u 10000 -g 10000 -M -s /bin/sh sandbox

ENV PORT=3000
ENV HOST=0.0.0.0
ENV BROWSER_SANDBOX=true

VOLUME ["/data"]

EXPOSE 3000

WORKDIR /data

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]
