FROM node:20-slim

# yt-dlp needs python3 + pip, and ffmpeg for merging/converting
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    pip3 install --break-system-packages -U yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno — required so yt-dlp can solve YouTube's signature/"n" JS challenge
# when using cookies (the android client, which needs no JS solving, does
# not support cookie auth, so we need a real JS runtime for the web client)
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]