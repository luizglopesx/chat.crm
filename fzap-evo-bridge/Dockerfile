FROM node:20-alpine

LABEL org.opencontainers.image.source=https://github.com/luizglopesx/chat.crm
LABEL org.opencontainers.image.description="FZAP/Wuzapi <-> EvoCRM bridge"

WORKDIR /app
COPY bridge.js .

EXPOSE 3000
CMD ["node", "bridge.js"]
