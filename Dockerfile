# rbooking - Dockerfile

# Use Node.js LTS Alpine for smaller image
FROM node:22-alpine

# Create app directory
WORKDIR /app

# Production mode: enables the app's fail-fast guards (AUTH_PASS, ADMIN_PASS, SMTP config)
# and Express's concise error handling
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install dependencies. better-sqlite3 normally downloads a prebuilt binary;
# the build tools are only a fallback and are removed afterwards.
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && \
    apk del .build-deps

# Copy app source
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S booking -u 1001

# Create uploads and data (bookings database) directories and set permissions
RUN mkdir -p uploads data && chown -R booking:nodejs /app
USER booking

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "app.js"]