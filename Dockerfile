FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js gladys-assistant-integration.json ./
COPY src ./src
COPY fonts ./fonts
ENV NODE_ENV=production
VOLUME ["/data"]
USER node
CMD ["node", "index.js"]
