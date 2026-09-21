FROM node:24-alpine

ENV TZ=Asia/Taipei \
    DATA_DIR=/data \
    PORT=8080 \
    REFRESH_AT=17:30 \
    NODE_ENV=production

RUN apk add --no-cache tzdata \
 && mkdir -p /data \
 && chown node:node /data

WORKDIR /app
# 內建圖表函式庫，儀表板不依賴外部 CDN
ADD --chown=node:node https://cdnjs.cloudflare.com/ajax/libs/echarts/5.6.0/echarts.min.js vendor/echarts.min.js
COPY --chown=node:node fetch.mjs server.mjs index.html ./

USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.mjs"]
