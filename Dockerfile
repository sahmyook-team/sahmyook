FROM node:20-slim
WORKDIR /app
COPY . .
ENV PORT=8080
CMD ["node", "server.js"]
