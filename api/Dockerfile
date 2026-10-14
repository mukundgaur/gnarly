FROM node:22-bookworm-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
COPY api/src ./src
COPY shared ./shared
ENV GNARLY_SCHEMA_DIR=/app/shared
ENV PORT=8080
ENV TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/main.ts"]
