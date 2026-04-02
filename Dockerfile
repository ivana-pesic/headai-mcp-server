FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Cache-bust: force tsc rebuild when source changes
ARG CACHEBUST=1
RUN npx tsc

RUN npm prune --omit=dev

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/index.js"]
