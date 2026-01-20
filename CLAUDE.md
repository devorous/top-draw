# CLAUDE.md - Top Draw Development Guide

## Project Overview

Top Draw is a real-time multiplayer collaborative drawing application using vanilla JavaScript (ES6 modules) with WebSocket communication. Despite the repo name containing "react", this is NOT a React application.

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6 modules), HTML5 Canvas API
- **Build Tool**: Vite 5.0
- **Real-time Communication**: WebSocket (ws library)
- **Backend**: Node.js
- **Styling**: CSS3 with CSS variables

## Project Structure

```
src/
├── main.js              # Entry point, initializes DrawingApp
├── App.js               # Main application class (event handling, WebSocket coordination)
├── Board.js             # Canvas management, viewport, zoom/pan
├── User.js              # User state model (position, tools, brush settings)
├── Tools.js             # Drawing tools (Brush, Text, Eraser, GIMP)
├── WebSocketClient.js   # WebSocket abstraction for server communication
├── Chat.js              # Chat UI and functionality
├── UI.js                # DOM element management
└── utils/
    ├── drawing.js       # Drawing utilities (curves, mirroring)
    └── parseGimp.js     # GIMP brush file parser (.gbr/.gih)

server/
└── index.js             # WebSocket server (Node.js)

public/
├── css/style.css        # Styles
├── images/              # Icons and assets
└── brushes/             # GIMP brush files
```

## Commands

```bash
# Development
npm run dev              # Start Vite dev server (port 3000)
npm run server           # Start WebSocket server (port 8000)

# For local development, run both commands in separate terminals

# Production
npm run build            # Build to dist/
npm run preview          # Preview production build
npm start                # Run WebSocket server
```

## Configuration

- **Vite proxy**: `/ws` proxies to `ws://localhost:3001` in dev mode (vite.config.js)
- **Server port**: Defaults to 8000 (server/index.js), uses `PORT` env var
- **WebSocket URL**: Set `VITE_WS_SERVER_URL` env var for production

## WebSocket Message Protocol

### Client to Server
- `connect`: Initial connection with user data
- `broadcast`: Relay drawing events (type field determines action)

### Broadcast Types
| Type | Data | Description |
|------|------|-------------|
| `Mm` | x, y, lastx, lasty | Mouse move |
| `Md` | - | Mouse down |
| `Mu` | - | Mouse up |
| `ChT` | tool | Tool change (brush/text/erase/gimp) |
| `ChC` | color | Color change [r,g,b,a] |
| `ChSi` | size | Brush size |
| `ChSp` | spacing | Brush spacing |
| `ChP` | pressure | Pen pressure |
| `ChNa` | name | Username |
| `kp` | key | Key press |
| `clear` | - | Clear canvas |
| `mirror` | - | Toggle mirror mode |
| `chat` | message | Chat message |
| `gimp` | gimpData | GIMP brush data |

## Key Architecture Concepts

1. **Dual Canvas System**: `mainCanvas` for persistent drawing, `topCanvas` for live previews
2. **User State Sync**: Each drawing action broadcasts to server, which relays to all clients
3. **Tool System**: `ToolManager` handles tool activation, each tool class implements `onPointerDown/Move/Up`
4. **AFK Detection**: Server marks users AFK after 2 minutes of inactivity

## Common Issues

### WebSocket Connection
- Ensure server is running on correct port (check `PORT` env var)
- For local dev: server runs on 8000, Vite dev server on 3000 with proxy at `/ws`
- Production: Set `VITE_WS_SERVER_URL` to your WebSocket server URL

### Drawing Not Syncing
- `broadcastMouseMove` must include `lastx`, `lasty` for proper line interpolation
- Check browser console for WebSocket connection errors

### CSS Selectors for User Elements
- User IDs are numeric, but CSS class selectors can't start with a digit
- All user-specific classes use `u` prefix (e.g., `u1234567` instead of `1234567`)
- When querying user elements, always use the prefixed form: `.cursor.u${userId}`

## Code Style

- ES6 module syntax (`import`/`export`)
- Classes for major components (DrawingApp, Board, User, Tools, etc.)
- Event-driven architecture with callback handlers
- Canvas coordinates are raw pixel values (720x1280 canvas dimensions)
