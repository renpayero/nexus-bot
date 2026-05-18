FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/data/session /app/data/logs /app/data/screenshots

CMD ["node", "src/index.js"]
