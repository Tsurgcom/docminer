import { parentPort } from "node:worker_threads";

type MessageEventLike<T> = {
  data: T;
};

type WebWorkerGlobal = typeof globalThis & {
  postMessage?: (message: unknown) => void;
  onmessage?: ((event: MessageEventLike<unknown>) => void) | null;
};

const webWorkerGlobal = globalThis as WebWorkerGlobal;
const hasWebWorker = typeof webWorkerGlobal.postMessage === "function";

export const createWorkerMessenger = <Incoming, Outgoing>() => {
  const post = (message: Outgoing): void => {
    if (parentPort) {
      parentPort.postMessage(message);
      return;
    }

    if (hasWebWorker && webWorkerGlobal.postMessage) {
      webWorkerGlobal.postMessage(message);
    }
  };

  const onMessage = (handler: (message: Incoming) => void): void => {
    if (parentPort) {
      parentPort.on("message", (message) => {
        handler(message as Incoming);
      });
      return;
    }

    if (hasWebWorker) {
      webWorkerGlobal.onmessage = (event) => {
        handler(event.data as Incoming);
      };
    }
  };

  return { post, onMessage };
};
