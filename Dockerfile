FROM oven/bun:latest

# Set the working directory to the volume mount point
WORKDIR /data

# Create a data directory for the volume mount (redundant but safe)
RUN mkdir -p /data

# Set WORKSPACE to the volume mount point
ENV WORKSPACE=/data

# Run agent-orcha using bunx
ENTRYPOINT ["bunx", "-y", "agent-orcha"]
