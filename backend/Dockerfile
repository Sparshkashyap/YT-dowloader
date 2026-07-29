FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl unzip && \
    pip3 install --break-system-packages -U "yt-dlp[default]" && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno — lets yt-dlp solve YouTube's signature/"n" JS challenge
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]