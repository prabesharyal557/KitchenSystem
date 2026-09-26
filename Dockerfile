FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV HOST=0.0.0.0
ENV PORT=10000
ENV DATA_DIR=/var/data
ENV SECURE_COOKIE=1

EXPOSE 10000

CMD ["npm", "start"]
