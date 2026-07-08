import { parseServerFrame, type ServerFrame } from '@simple-showdown/protocol';

/** WebSocket wrapper: parses server frames and auto-reconnects. */
export class Connection {
  private ws: WebSocket | null = null;
  private url: string;
  onFrame: ((frame: ServerFrame) => void) | null = null;
  onOpen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onmessage = (ev) => {
      this.onFrame?.(parseServerFrame(String(ev.data)));
    };
    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 2000);
    };
  }

  /** Send `ROOMID|TEXT` (roomId '' = global). */
  send(roomId: string, text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`${roomId}|${text}`);
    }
  }
}
