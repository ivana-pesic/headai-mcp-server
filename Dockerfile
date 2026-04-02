FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# v2: force fresh build - removed express 4/5 conflict
RUN npx tsc

RUN npm prune --omit=dev

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/index.js"]
