FROM node:24-slim

# No browser needed: Baileys talks to WhatsApp directly.
ENV NODE_ENV=production \
    SESSIONS_DIR=/data/sessions

# ffmpeg converts audio to WhatsApp voice notes for the API (type "voice").
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
