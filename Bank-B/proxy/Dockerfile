FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /workspace

# Build trust-agent first (required for file: dep resolution)
COPY trust-agent/package.json trust-agent/package-lock.json ./trust-agent/
RUN cd trust-agent && npm ci --ignore-scripts
COPY trust-agent/src ./trust-agent/src
COPY trust-agent/tsconfig.json ./trust-agent/
RUN cd trust-agent && npm run build

# Build Bank-B proxy
COPY Bank-B/proxy/package.json ./Bank-B/proxy/
# --install-links copies file: deps instead of symlinking (safe for multi-stage builds)
RUN cd Bank-B/proxy && npm install --install-links
COPY Bank-B/proxy/src ./Bank-B/proxy/src
COPY Bank-B/proxy/tsconfig.json ./Bank-B/proxy/
RUN cd Bank-B/proxy && npm run build

FROM node:20-alpine
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=builder /workspace/Bank-B/proxy/dist ./dist
COPY --from=builder /workspace/Bank-B/proxy/node_modules ./node_modules
COPY --from=builder /workspace/Bank-B/proxy/package.json ./package.json
EXPOSE 3002
CMD ["node", "dist/server.js"]
