# Estágio de Build
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx tsc

# Estágio de Produção
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
