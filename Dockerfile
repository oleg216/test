FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production=false
RUN npx playwright install chrome

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY fixtures/ ./fixtures/
COPY data/ ./data/

RUN npm run build
RUN mkdir -p /app/logs

EXPOSE 3000

CMD ["node", "dist/index.js"]
