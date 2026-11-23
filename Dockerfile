FROM node:24-slim

# No browser needed: Baileys talks to WhatsApp directly.
ENV NODE_ENV=production \
    SESSIONS_DIR=/data/sessions

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
