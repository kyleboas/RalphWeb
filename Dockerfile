# Use Node.js 20 LTS (Debian-based)
FROM node:20-bookworm-slim

# Install Git and clean up to keep image small
RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install --only=production

# Copy application files
COPY . .

# Create directories (Railway Volume UI will mount over /tmp/repos if configured)
RUN mkdir -p /tmp/repos /app/logs && \
    chmod -R 755 /tmp/repos /app/logs

# Expose port (Railway overrides this via PORT env var, but good for documentation)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-3000}/api/repos', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["npm", "start"]