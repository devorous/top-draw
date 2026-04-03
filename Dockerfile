# Stage 1: Build WASM
FROM rust:1.80-slim as wasm-builder

# Install wasm-pack
RUN apt-get update && apt-get install -y curl pkg-config libssl-dev && \
    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /app
COPY wasm_src/ wasm_src/
COPY package.json .

# Build WASM (we need a dummy src/wasm for the output)
RUN mkdir -p src/wasm && \
    wasm-pack build wasm_src --target web --out-dir ../src/wasm/

# Stage 2: Build Frontend & Install Node Dependencies
FROM node:20-slim as builder

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy WASM from previous stage
COPY --from=wasm-builder /app/src/wasm/ ./src/wasm/

# Copy the rest of the app
COPY . .

# Run the brushes script and build the frontend
RUN npm run brushes && npm run vite build

# Stage 3: Final Production Image
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

# Copy node_modules and built frontend from builder stage
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/wasm ./src/wasm
COPY --from=builder /app/data ./data

EXPOSE 8000

# Start the server
CMD ["node", "server/index.js"]
