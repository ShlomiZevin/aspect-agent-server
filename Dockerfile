# Pin a specific Node 22 patch. The floating node:22-slim tag drifted to a
# newer patch on the 2026-06-23 rebuilds, which broke gaxios HTTPS to several
# googleapis hosts (www.googleapis.com, iamcredentials, oauth2/v4/token) with
# "Premature close" — taking down Drive sync, DynamicKB and billing while
# storage.googleapis.com (a different client) kept working. Pinning to a
# known-good patch restores it. Bump deliberately after verifying.
FROM node:22.13.1-slim

# Headless Chromium, for HQ's HTML -> PNG rendering (hq/services/render.service.js).
#
# The image models render Hebrew well, so this is NOT a workaround for weak
# typography — it is for output that must be pixel-exact and repeatable: a logo,
# a real URL, a price, or the same template across thirty posts. Without a
# browser in the image that whole path is unavailable on Cloud Run, and the
# worker correctly refuses rather than failing obscurely.
#
# Debian's `chromium` package pulls its own font and library deps. The Hebrew
# font is not optional: without it every Hebrew glyph renders as a box, which
# looks like a code bug and is not one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-color-emoji \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# render.service probes this first; setting it explicitly avoids depending on
# where the distro happens to put the binary.
ENV CHROME_PATH=/usr/bin/chromium

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
