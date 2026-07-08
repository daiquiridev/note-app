FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server.js ./
COPY public ./public
EXPOSE 80
CMD ["node", "server.js"]
