declare const self: Worker;
self.onmessage = (event: MessageEvent) => {
  self.postMessage({ echo: event.data, bun: Bun.version });
};
