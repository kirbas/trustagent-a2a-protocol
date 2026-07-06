FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /workspace

# Build trust-agent first (required for file: dep resolution)
COPY trust-agent/package.json trust-agent/package-lock.json ./trust-agent/
RUN cd trust-agent && npm ci --ignore-scripts
COPY trust-agent/src ./trust-agent/src
COPY trust-agent/tsconfig.json ./trust-agent/
RUN cd trust-agent && npm run build

# Build trust-agent-cloud witness service
COPY trust-agent-cloud/package.json ./trust-agent-cloud/
# --install-links copies file: deps instead of symlinking (safe for multi-stage builds)
RUN cd trust-agent-cloud && npm install --install-links
COPY trust-agent-cloud/src ./trust-agent-cloud/src
COPY trust-agent-cloud/tsconfig.json ./trust-agent-cloud/
RUN cd trust-agent-cloud && npm run build

FROM node:20-alpine
RUN apk add --no-cache sqlite
WORKDIR /app
COPY --from=builder /workspace/trust-agent-cloud/dist ./dist
COPY --from=builder /workspace/trust-agent-cloud/node_modules ./node_modules
COPY --from=builder /workspace/trust-agent-cloud/package.json ./package.json
EXPOSE 3003
CMD ["node", "dist/server.js"]
