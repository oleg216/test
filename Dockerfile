FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false
RUN npx playwright install chrome

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY fixtures/ ./fixtures/

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
