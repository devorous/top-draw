/**
 * Server entry point
 * Express + WebSocket server for the drawing app
 */

const express = require('express');
const path = require('path');
const { WebSocketServer } = require('./WebSocketServer');

// Create Express app
const app = express();

// Determine if we're in development mode
const isDev = process.env.NODE_ENV === 'development';

// Serve static files
if (isDev) {
  // In development, Vite handles static files
  // Only serve the server's static assets
  app.use('/images', express.static(path.join(__dirname, '../public/images')));
  app.use('/css', express.static(path.join(__dirname, '../public/css')));
} else {
  // In production, serve the built files from dist
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));

  // Also serve public assets not handled by Vite
  app.use(express.static(path.join(__dirname, '../public')));
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start HTTP server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Mode: ${isDev ? 'development' : 'production'}`);
});

// Create WebSocket server attached to HTTP server
const wsServer = new WebSocketServer(server);

// Log connection stats periodically
setInterval(() => {
  const count = wsServer.clientCount;
  if (count > 0) {
    console.log(`Active connections: ${count}`);
  }
}, 60000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

module.exports = { app, server, wsServer };
