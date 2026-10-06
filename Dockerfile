FROM node:24-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && mkdir -p /app/data /private/upseller-profile && chown -R node:node /app/data /private
COPY apps ./apps
USER node
CMD ["npm", "run", "collect"]
