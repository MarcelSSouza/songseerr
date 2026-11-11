FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8788 DATA_DIR=/app/data
EXPOSE 8788
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
