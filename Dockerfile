# Estágio de Build
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
# Usa o script "build" (não "npx tsc" direto) para também remover dist/__tests__
# do output — senão os testes iam parar dentro da imagem de produção à toa.
RUN npm run build

# Estágio de Produção
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public

ENV NODE_ENV=production

EXPOSE 3000

# Fase 6: healthcheck nativo do Docker/orquestrador via /health/live (não
# depende de curl/wget, que a imagem slim não tem por padrão).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
