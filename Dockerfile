# Use Node.js 20 LTS (Debian-based)
FROM node:20-bookworm-slim

# Install Git (required for repository cloning and Git operations)
RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally (required for manager.sh to generate PRDs)
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Switched from 'npm ci' to 'npm install' to fix missing lockfile error
RUN npm install --only=production

# Copy application files
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /app/data /app/logs && \
    chmod -R 755 /app/data /app/logs

# Define volume for persistent data
VOLUME /app/data

# Set environment variable for repositories
ENV REPOS_DIR=/app/data/repos

# Expose port (Railway will override this with PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-3000}/api/repos', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["npm", "start"]