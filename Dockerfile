FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci && echo "deps-installed-v3"

COPY tsconfig.json ./
COPY src/ ./src/

RUN rm -rf dist && npx tsc && echo "compiled-v3"

RUN npm prune --omit=dev && echo "pruned-v3"

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/index.js"]
