# Use Node.js 20 LTS (Debian-based)
FROM node:20-bookworm-slim

# Install Git (required for repository cloning and Git operations)
RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /tmp/repos /app/logs && \
    chmod -R 755 /tmp/repos /app/logs

# Expose port (Railway will override this with PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-3000}/api/repos', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["npm", "start"]
