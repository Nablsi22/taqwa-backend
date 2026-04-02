FROM node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npx prisma generate
RUN rm -rf dist
RUN npx tsc -p tsconfig.build.json
RUN ls dist/main.js || (echo "BUILD CHECK: main.js not at dist/" && ls dist/ && exit 1)

EXPOSE 3000

CMD ["node", "dist/main.js"]