FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production MEDIA_DIR=/media DATA_DIR=/data PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
