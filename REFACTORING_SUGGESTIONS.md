# Refactoring Suggestions for `top-draw`

This document outlines potential refactoring opportunities to improve modularity, reduce file size, and clarify responsibilities within the codebase.

---

### 1. `src/tools/SelectTool.js`

- **Observation:** This file is currently over 2600 lines long and manages multiple distinct responsibilities: selection creation (lasso/rectangle), state management for the selection lifecycle (lifting, committing), rendering the selection UI (marching ants, transform handles), and handling complex transformations (drag, scale, rotate, perspective via homography).
- **Suggestion:** Break `SelectTool.js` into smaller, more focused modules:
    - **`SelectionManager.js`**: A core class to manage the selection's state (e.g., `selection`, `isDragging`, `floatingCanvas`). It would handle the data-oriented tasks like `liftSelection` and `commitSelection`.
    - **`SelectionUI.js`**: Responsible for all rendering tasks. This would include drawing the marching ants, the floating selection preview, and the various transform handles. It would read state from the `SelectionManager`.
    - **`TransformHandler.js`**: A dedicated module to contain the complex logic for scaling, rotating, and perspective transforms. It would listen for pointer events on the handles and calculate the resulting new corner positions.
    - **`SelectTool.js` (refactored):** The tool itself would become a much thinner coordinator, responsible for handling pointer events and delegating to the appropriate manager or handler (e.g., onPointerDown inside the selection calls the `TransformHandler`, onPointerDown outside starts a new selection via the `SelectionManager`).

---

### 2. `src/ui/RemoteUserUI.js`

- **Observation:** This file handles all UI elements related to remote users, including their cursors on the canvas, their entry in the user list panel, and the creation/management of their dedicated drawing canvases.
- **Suggestion:** Decouple the different UI responsibilities into separate classes:
    - **`UserList.js`**: Manage the user list panel exclusively. It would be responsible for creating, updating (name, color, role), and removing user entries from the DOM.
    - **`RemoteCursor.js`**: Focus solely on creating, positioning, and styling a single remote user's cursor on the main canvas. `RemoteUserUI` would manage a collection of `RemoteCursor` instances.
    - **`RemoteUserUI.js` (refactored):** This class would remain as a high-level coordinator, holding instances of `UserList` and managing the map of `RemoteCursor` objects, but its own code would be significantly simplified.

---

### 3. `src/canvas/Board.js`

- **Observation:** `Board.js` is a "God object" that acts as a central hub for almost everything. It initializes all canvases, manages the main rendering loop (`compositeAllLayers`), handles all top-level browser events (pointer, wheel), interacts with the `LayerManager`, and communicates with the active tool.
- **Suggestion:** This is a large undertaking, but the most impactful refactoring would be to extract key responsibilities:
    - **`Renderer.js`**: Create a dedicated renderer class responsible for the `compositeAllLayers` logic. Its job would be to take the `LayerManager`'s state and render it to the main canvas. This would separate rendering logic from the board's state management.
    - **`InputHandler.js`**: Consolidate all canvas-related event listeners (`pointerdown`, `wheel`, etc.) into a single class. This handler would then interpret the events and call the appropriate methods on the `Board` or the active `Tool`, cleaning up the `Board`'s constructor and methods.
    - **`Board.js` (refactored):** The `Board` would become a state container that owns the `Renderer`, `InputHandler`, and `LayerManager`, delegating tasks to them.

---

### 4. `server/index.js`

- **Observation:** The main server file likely handles WebSocket connection logic, message parsing, and routing of different message types to various handlers like `SyncCoordinator.js` and `SessionManager.js`.
- **Suggestion:** Create a more robust message handling and routing system.
    - **`MessageHandler.js` or a `handlers/` directory:** Similar to the client-side `src/handlers` directory, create a dedicated router on the server. When a message comes in, a central `MessageHandler` inspects its type and routes it to a specific, single-responsibility handler file (e.g., `DrawingMessageHandler.js`, `SyncMessageHandler.js`, `UserMessageHandler.js`). This would make `server/index.js` much cleaner and make it easier to add or modify server-side logic for specific message types.
