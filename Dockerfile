FROM node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npx prisma generate
RUN rm -rf dist tsconfig.build.tsbuildinfo
RUN npm run build
RUN ls -la dist/

EXPOSE 3000

CMD ["node", "dist/main.js"]