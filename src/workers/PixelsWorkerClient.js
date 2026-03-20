// src/workers/PixelsWorkerClient.js
export class PixelsWorkerClient {
    constructor() {
        this.worker = new Worker(new URL('./pixels.worker.js', import.meta.url), { type: 'module' });
        this.promises = new Map();
        this.msgId = 0;

        this.worker.onmessage = (e) => {
            const { id, result } = e.data;
            if (this.promises.has(id)) {
                this.promises.get(id).resolve(result);
                this.promises.delete(id);
            }
        };
    }

    /**
     * Sends a blur request to the Rust worker.
     */
    blur(data, width, height, radius, useGlitch = false) {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.promises.set(id, { resolve, reject });

            // Transfer the buffer to the worker so it's lightning fast
            const pixelData = new Uint8Array(data.buffer); 
            this.worker.postMessage({
                type: 'BLUR',
                id, data: pixelData, width, height, radius, useGlitch
            }, [pixelData.buffer]);
        });
    }
}
