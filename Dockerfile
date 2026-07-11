FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server.js ./
COPY public ./public
EXPOSE 80
# root yerine hazır "node" kullanıcısı — Docker 20.10+ container içinde ayrıcalıksız
# kullanıcıya 80 portunu bağlamaya izin verir (ip_unprivileged_port_start=0).
# Dikkat: /data volume'unun sahibi de node (uid 1000) olmalı.
USER node
CMD ["node", "server.js"]
