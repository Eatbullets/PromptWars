FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Build the Vite frontend
RUN npm run build

# Expose the Cloud Run port
EXPOSE 8080

# Start the Node Express backend in production mode
CMD ["npm", "start"]
