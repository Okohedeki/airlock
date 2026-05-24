FROM node:22-slim
WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev || npm install

COPY tsconfig.json ./
COPY src ./src

ENV PORT=3000
EXPOSE 3000
# tsx runs the TS entry point directly; swap for a compiled `node dist/server.js`
# build step if you prefer.
CMD ["npx", "-y", "tsx", "src/server.ts"]
