FROM node:20-slim

# ffmpeg is the only external dependency now — used to mux video+audio
# streams together and to convert audio to mp3. No more yt-dlp, no Deno,
# no cookies: RapidAPI supplies direct, ready-to-download CDN links.
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]