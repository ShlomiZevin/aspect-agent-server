# Pin a specific Node 22 patch. The floating node:22-slim tag drifted to a
# newer patch on the 2026-06-23 rebuilds, which broke gaxios HTTPS to several
# googleapis hosts (www.googleapis.com, iamcredentials, oauth2/v4/token) with
# "Premature close" — taking down Drive sync, DynamicKB and billing while
# storage.googleapis.com (a different client) kept working. Pinning to a
# known-good patch restores it. Bump deliberately after verifying.
FROM node:22.13.1-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy app source
COPY . .

# Expose port (App Engine Flexible uses PORT env variable)
ENV PORT=8080
EXPOSE 8080

# Start the server
CMD ["node", "server.js"]
