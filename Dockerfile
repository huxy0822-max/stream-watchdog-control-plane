FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY config ./config
COPY docs ./docs
COPY .env.example ./
COPY README.md ./

RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3030

CMD ["node", "src/index.js"]
