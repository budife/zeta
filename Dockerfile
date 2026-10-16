FROM node:26-alpine AS base

WORKDIR /app

# Dependencies
FROM base AS deps
COPY package*.json ./
COPY scripts ./scripts
COPY public ./public
RUN npm ci

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public ./public
COPY . .
RUN npm run build

# Production runner
FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
# Next standalone binds to $HOSTNAME (container ID by default); bind all interfaces so localhost healthcheck works
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
