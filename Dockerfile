FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

COPY . .

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000

CMD ["node", "server.js"]
