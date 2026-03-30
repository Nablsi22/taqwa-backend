FROM node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npx prisma generate
RUN npx tsc -p tsconfig.build.json
RUN ls -la dist/ && test -f dist/main.js || (echo "BUILD FAILED: dist/main.js not found" && exit 1)

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]