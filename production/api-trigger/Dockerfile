FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

COPY production/api-trigger/server.js ./server.js

CMD ["node", "server.js"]
