FROM node:22-alpine

# Install openssl for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package.json package-lock.json* ./

# Install ALL dependencies (including devDependencies required for build)
RUN npm ci

# Copy the rest of the application code
COPY . .

# Generate Prisma client and build the app
RUN npm run build

# Start the application
CMD ["npm", "run", "docker-start"]
