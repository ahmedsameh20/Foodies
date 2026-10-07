# Production image. SQLite lives on a mounted volume (/data); uploads on /uploads.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY Images ./Images
ENV DATABASE_PATH=/data/app.db UPLOAD_DIR=/uploads PORT=3000
RUN mkdir -p /data /uploads && chown -R node:node /data /uploads /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migrations run (with an automatic backup of the DB file) before the server starts
CMD ["sh", "-c", "node server/migrate.js && node server/index.js"]
