# Stage 1: Build Frontend & Install Node Dependencies
FROM node:20-slim as builder

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy the rest of the app — including the prebuilt WASM in src/wasm/, which is
# committed to the repo (see `npm run wasm` to regenerate it).
#
# There used to be a rust:1.82-slim `wasm-builder` stage here that installed
# wasm-pack and compiled wasm_src/. Its output was copied to ./src/wasm/ and was
# then immediately overwritten by this `COPY . .`, so the image has always
# shipped the committed artifacts and the stage was pure waste — a full Rust
# toolchain pull and compile on every build, plus the apt-get that was failing
# the build. To make the image compile WASM for real, that stage has to be
# restored *and* copied in after this line — a real behaviour change, since
# production would start running freshly built wasm instead of the committed
# files.
COPY . .

# Build the frontend
RUN npm run build

# Stage 2: Final Production Image
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
