FROM node:20-alpine

WORKDIR /app

# Copy application files
COPY package.json server.js ./

# Create data directory for volume persistence
RUN mkdir -p /data

ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
