# Rotman AV Event Booking System - Dockerfile

# Use Node.js LTS Alpine for smaller image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Production mode: enables the app's fail-fast guards (AUTH_PASS, SMTP config)
# and Express's concise error handling
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S booking -u 1001

# Create uploads directory and set permissions
RUN mkdir -p uploads && chown -R booking:nodejs /app
USER booking

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "app.js"]