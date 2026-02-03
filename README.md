# Top Draw

A real-time multiplayer collaborative drawing application. Multiple users can draw together simultaneously on a shared canvas with a simple chat.

![Vanilla JS](https://img.shields.io/badge/Vanilla-JavaScript-yellow)
![Vite](https://img.shields.io/badge/Vite-5.0-646CFF)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-green)

## Features

- **Real-time Collaboration** - Draw with others and see their cursors and strokes live
- **Multiple Drawing Tools**
  - Brush - Freehand drawing with adjustable size and spacing
  - Flow Pen - Pressure-sensitive circle stamping
  - Line - Straight lines
  - Rectangle & Circle - Shape tools
  - Text - Add text to canvas
  - Eraser - Remove content
  - Image Brush - GIMP brushes (.gbr/.gih) and standard images (.png/.jpg/.webp)
  - Select - Selection with perspective transformation
- **Canvas Controls** - Zoom, pan, mirror mode, save as image
- **Color Picker** - Full color selection with alpha channel
- **Chat System** - Real-time text chat between users
- **User Awareness** - See who's online and their activity status
- **Offline Mode** - Continue drawing when disconnected

## Quick Start

**Requirements:** Node.js >= 18.0.0

```bash
# Install dependencies
npm install

# Start development (frontend + server)
npm run dev
```

The app opens automatically at `http://localhost:3000`

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server and WebSocket server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm run server` | Start WebSocket server only |
| `npm start` | Production server |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_WS_SERVER_URL` | WebSocket server URL | Same host |
| `PORT` | Server port | 8000 |

### Ports

- **Dev server:** 3000
- **WebSocket server:** 8000

## Tech Stack

- **Frontend:** Vanilla JavaScript (ES6 modules), HTML5 Canvas
- **Build:** Vite
- **Real-time:** WebSocket with Protocol Buffers
- **Backend:** Node.js

## Project Structure

```
src/
├── main.js           # Entry point
├── App.js            # Main application orchestration
├── Board.js          # Canvas management, viewport
├── Tools.js          # Drawing tools
├── User.js           # User state model
├── WebSocketClient.js
├── Chat.js
└── utils/
    ├── drawing.js    # Drawing utilities
    └── parseGimp.js  # GIMP brush parser

server/
└── index.js          # WebSocket server

public/
├── messages.proto    # Protocol Buffer schema
└── brushes/          # GIMP brush files
```

## License

MIT
