# Refactoring Analysis

This document contains an analysis of JavaScript files for potential refactoring opportunities.

## General Recommendations

*   **Code Duplication:** Identify and abstract duplicated code into reusable functions or classes.
*   **Large Functions/Classes:** Break down large components into smaller, single-responsibility modules.
*   **Clarity and Readability:** Improve variable names, add comments for complex logic, and ensure a consistent coding style.
*   **Error Handling:** Implement more robust error handling and provide clearer user feedback.
*   **Performance:** Optimize performance-critical sections, especially in rendering and data processing loops.

## File-Specific Analysis

### `src/tools/SelectTool.js`

*   **God Class:** `SelectTool` is a massive class (over 2900 lines) responsible for too many concerns, including selection (lasso, rectangle), moving, rotating, transforming (scale, perspective), context menu management, clipboard operations, network throttling, and rendering.
    *   **Suggestion:** Decompose the class into smaller, more focused modules:
        *   `SelectionManager`: To handle the creation and state of the selection area (rectangle or lasso).
        *   `TransformManager`: To manage transform state (corners, rotation) and handle manipulation logic.
        *   `SelectionRenderer`: To be responsible for all rendering, including the "marching ants" border, transform handles, and previews.
        *   `SelectionMenu`: To encapsulate all DOM interaction and logic for the context menu.
        *   `ClipboardManager`: To abstract the copy, cut, and paste functionality.
*   **Overly Complex State Management:** The class has over 40 state properties, making it difficult to track state transitions and prone to errors.
    *   **Suggestion:** Group related state properties into objects (e.g., `rotationState`, `transformState`, `lassoState`) to better organize the component's internal state.
*   **Code Duplication:** The rendering logic for the "marching ants" effect is duplicated in multiple methods (`drawLassoPreview`, `drawMarchingAntsOnly`, `_drawMirrorGhost`, `drawSelectionBox`, `drawTransformOutline`).
    *   **Suggestion:** Create a single, reusable utility function `drawMarchingAnts(ctx, pathOrRect)` to handle the rendering of the animated border.
*   **Magic Numbers:** The code is littered with magic numbers for UI elements, animation parameters, and interaction logic (e.g., `handleSize = 8`, `handleHitArea = 20`, `throttleRate = 30`).
    *   **Suggestion:** Define these values as named constants at the top of the file or in a shared configuration object to improve readability and ease of maintenance.
*   **Complex Pointer Handlers:** The `onPointerDown`, `onPointerMove`, and `onPointerUp` methods are extremely long and contain deeply nested conditional logic to manage the various interaction states.
    *   **Suggestion:** Implement a state pattern. The pointer handlers could delegate to a current state object (e.g., `IdleState`, `SelectingState`, `DraggingState`), simplifying the main methods and making the logic easier to follow.
*   **Direct DOM Manipulation:** The tool directly queries and manipulates DOM elements for its context menu, mixing UI rendering logic with tool functionality.
    *   **Suggestion:** This should be fully encapsulated within a dedicated UI component (`SelectionMenu`). The tool should communicate with this component through a well-defined API (methods and events) rather than touching the DOM itself.
*   **Custom Throttling Implementation:** The class implements custom throttling logic for network broadcasts.
    *   **Suggestion:** Use a standard, well-tested throttling function from a library like Lodash or create a reusable throttle utility to ensure reliability and reduce boilerplate code.

### `src/ui/Chat.js`

*   **Monolithic UI Component:** The `Chat` class is a large, monolithic component handling multiple concerns: state management for messages, full DOM manipulation for chat UI, event handling, emoji picker logic (including data loading and localStorage interaction), file/image upload and preview, draggable window functionality, and toast notifications.
    *   **Suggestion:** Decompose this into smaller, focused UI components, ideally leveraging a framework like Svelte (already present in the project for `Gallery.svelte`). This would involve:
        *   A main `ChatWindow.svelte` component to orchestrate.
        *   `MessageList.svelte` for rendering messages.
        *   `ChatInput.svelte` for input and send functionality.
        *   `ChatTabs.svelte` for managing tab switching.
        *   `EmojiPicker.svelte` as a standalone component.
        *   `UserList.svelte` for DM user selection.
        *   `ImagePreview.svelte` for managing file uploads.
        *   `ToastNotification.svelte` for notifications.
*   **Tight Coupling with DOM:** The class is heavily dependent on specific HTML structure and `document.getElementById` calls. This makes the UI brittle, difficult to test, and hard to reuse without modifying the underlying HTML.
    *   **Suggestion:** Transition to a component-based UI framework (e.g., Svelte) where DOM structure and interactions are managed declaratively within the component definition.
*   **Manual DOM Construction:** Methods extensively use `document.createElement` and manual appending/setting of `innerHTML`. This is verbose, error-prone, and can be less performant than framework-managed DOM updates.
    *   **Suggestion:** Utilize a UI framework's templating capabilities to define the structure and allow the framework to handle efficient DOM updates.
*   **Redundant Event Listener Setup:** Event listeners are often re-attached within rendering methods (e.g., `renderDMConversation` for `chatBackBtn`). This can lead to memory leaks and inefficient behavior.
    *   **Suggestion:** Employ event delegation (attaching listeners to a common parent) or rely on UI frameworks which manage event lifecycles more effectively.
*   **Mixed Concerns in Methods:** Methods like `handleSend` contain logic for both public and direct messages, increasing complexity.
    *   **Suggestion:** Separate concerns into distinct methods or sub-components that are responsible for either public chat or DM specific actions.
*   **Emoji Picker Logic Embedded:** The entire emoji picker functionality, including data fetching (`loadEmojiData`), rendering, and recent emoji persistence, is embedded within the `Chat` class.
    *   **Suggestion:** Extract this into a dedicated, reusable `EmojiPicker` component. This component could manage its own state, data loading, and expose an event when an emoji is selected.
*   **Custom Draggable Implementation:** The `makeDraggable` method implements a custom drag-and-drop mechanism for the chat window, attaching listeners directly to `document`.
    *   **Suggestion:** Abstract this into a reusable utility or a custom Svelte action for draggable elements, promoting code reuse and better encapsulation.

### `src/App.js`

*   **The Coordinator/God Class:** `DrawingApp` acts as the central coordinator for the entire application, creating and managing almost every other major component (`Board`, `ToolManager`, `UI`, `Chat`, `WebSocketClient`, `Auth`, etc.). This creates tight coupling and makes the class overwhelmingly large.
    *   **Suggestion:** Refactor towards a more modular, service-oriented architecture. Instead of `App` creating everything, have dedicated services or factories that manage specific domains (e.g., `UIService`, `ToolService`, `ConnectionService`). Use dependency injection to provide components with the services they need.
*   **Massive `init` and `setupEventListeners` Methods:** The initialization and event listener setup are performed in huge, monolithic methods that are difficult to read and maintain. The `setupEventListeners` method manually attaches listeners to dozens of individual DOM elements, which is brittle.
    *   **Suggestion:** Break down initialization into smaller, domain-specific methods (e.g., `initUI`, `initBoard`). Delegate UI event handling to the UI components themselves, which can then emit higher-level application events for `App` to handle.
*   **Scattered State Management:** Critical application state (e.g., user state, connection status, current room) is scattered across numerous properties on the `DrawingApp` instance and other components.
    *   **Suggestion:** Centralize core application state into a structured store. Given the project's use of Svelte, Svelte stores would be a natural fit for managing reactive state that multiple components can subscribe to.
*   **Global Singleton (`window.app`):** The application sets `window.app = this`, making the `DrawingApp` instance a global singleton. This is an anti-pattern that can lead to unpredictable behavior and makes testing difficult.
    *   **Suggestion:** Remove the global singleton. Pass dependencies explicitly through constructors or module imports.
*   **Mixed Concerns in Pointer Handlers:** The `handlePointerDown`, `handlePointerMove`, and `handlePointerUp` methods contain a complex mix of logic for different tools, pressure sensitivity, input buffering, and panning.
    *   **Suggestion:** This logic should be more cleanly delegated. The `App` pointer handlers should primarily be responsible for identifying the input source and passing it to a dedicated `InputManager` or directly to the `ToolManager`, which then routes it to the currently active tool.
*   **Deeply Nested Logic:** Business logic is often buried deep within event handlers. For example, `performSave` has complex logic for handling different save types (local vs. gallery, selection vs. full canvas) inside an event listener callback.
    *   **Suggestion:** Extract business logic into dedicated service methods. For example, a `SaveService` could have methods like `saveSelectionLocally(canvas)` and `uploadToGallery(canvas)`, which can then be called from the UI event handlers.

### `src/canvas/Board.js`

*   **Coordinator for Canvas Operations:** The `Board` class is a central coordinator for everything related to the canvas, viewport, and rendering. It manages multiple canvas layers (`main`, `top`, `upperLayers`, `selectionOverlay`), handles transformations (pan, zoom, rotate), and orchestrates the compositing process.
*   **Complex Compositing Logic:** The `compositeAllLayers` method is very complex, handling intricate logic for different rendering paths based on the current tool (e.g., eraser), active selections, and blend modes. This makes it difficult to understand and maintain.
    *   **Suggestion:** Decompose `compositeAllLayers` into smaller, more focused helper methods, each handling a specific compositing scenario (e.g., `_compositeNormalDrawing`, `_compositeEraseAll`, `_compositeWithActiveSelection`). A strategy pattern could also be used to dynamically select the appropriate compositing strategy.
*   **Split-Layer Rendering for Selections:** The logic involving `activeSelectionLayer` to split rendering for selections is effective but adds significant complexity.
    *   **Suggestion:** While necessary for the feature, this logic could benefit from extensive comments and possibly a clear state machine diagram to explain its intricacies.
*   **Custom Dirty Rect and Tiling System:** The class implements a bespoke dirty rectangle merging system and interacts with `TileGrid` and `TileOwnershipManager`.
    *   **Suggestion:** Centralize all dirty region management within the `TileGrid` class, removing the `_dirtyRects` array from `Board` to consolidate this optimization logic.
*   **Direct Dependency on `app`:** Frequent access to `this.app` for user information, active tool, and WebSocket client creates tight coupling and a circular dependency.
    *   **Suggestion:** Implement dependency injection. Pass only the necessary services or data to the `Board` (e.g., the current `User` object, a `WebSocketService`) rather than the entire `app` instance.
*   **Manual Transform Calculations:** `getBoardRelativePos` and `setRotationAround` manually implement complex matrix transformation logic.
    *   **Suggestion:** Utilize a dedicated 2D graphics library or a custom `MatrixTransform` utility class to encapsulate and simplify these calculations, improving readability and robustness.
*   **Rendering Loop Logic:** The class contains logic for both one-shot `requestAnimationFrame` updates and a persistent, FPS-capped rendering loop.
    *   **Suggestion:** This feature is well-implemented for performance tuning. Ensure it remains well-documented, as it is a critical part of the rendering pipeline.
