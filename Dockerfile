FROM node:25-trixie-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Networking & Security
    curl wget nmap netcat-openbsd dnsutils iputils-ping traceroute tcpdump \
    whois openssh-client openssl socat \
    # Data Processing
    jq python3 python3-pip python3-venv \
    # System & File Tools
    git zip unzip tar file htop lsof procps cron \
    # GPU (Vulkan loader for NVIDIA Container Toolkit)
    libvulkan1 \
    # Native inference runtime (OpenMP for llama.cpp in node-omni-orcha)
    libgomp1 \
    # Browser Sandbox
    chromium xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts \
    && PLATFORM="$(node -p "process.platform+'-'+process.arch")" \
    && if [ ! -d "node_modules/@agent-orcha/node-omni-orcha-${PLATFORM}" ]; then \
         npm install --no-save --ignore-scripts "@agent-orcha/node-omni-orcha-${PLATFORM}" 2>/dev/null || true; \
       fi

# Build Svelte UI → public/
COPY ui/ ./ui/
RUN cd ui && npm ci && npm run build && cd .. && rm -rf ui

COPY lib/ ./lib/
COPY src/ ./src/
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
