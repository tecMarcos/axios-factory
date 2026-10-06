FROM node:24-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY apps ./apps
USER node
CMD ["npm", "run", "collect"]
