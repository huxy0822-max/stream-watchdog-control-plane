FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY config/watcher.example.json ./config/watcher.example.json
COPY docs ./docs
COPY .env.example ./
COPY README.md ./

RUN mkdir -p /app/data /app/config

ENV NODE_ENV=production
EXPOSE 3030

CMD ["node", "src/index.js"]
