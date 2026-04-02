FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "dist/index.js"]
