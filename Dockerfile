FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY favicon.ico favicon-32x32.png favicon-192x192.png apple-touch-icon.png ./

RUN npx tsc

RUN npm prune --omit=dev

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/index.js"]
