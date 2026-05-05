FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /workspace

# Build trust-agent first (required for file: dep resolution)
COPY trust-agent/package.json trust-agent/package-lock.json ./trust-agent/
RUN cd trust-agent && npm ci --ignore-scripts
COPY trust-agent/src ./trust-agent/src
COPY trust-agent/tsconfig.json ./trust-agent/
RUN cd trust-agent && npm run build

# Build Bank-A proxy
COPY Bank-A/proxy/package.json ./Bank-A/proxy/
# --install-links copies file: deps instead of symlinking (safe for multi-stage builds)
RUN cd Bank-A/proxy && npm install --install-links
COPY Bank-A/proxy/src ./Bank-A/proxy/src
COPY Bank-A/proxy/tsconfig.json ./Bank-A/proxy/
RUN cd Bank-A/proxy && npm run build

FROM node:20-alpine
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=builder /workspace/Bank-A/proxy/dist ./dist
COPY --from=builder /workspace/Bank-A/proxy/node_modules ./node_modules
COPY --from=builder /workspace/Bank-A/proxy/package.json ./package.json
EXPOSE 3001
CMD ["node", "dist/server.js"]
