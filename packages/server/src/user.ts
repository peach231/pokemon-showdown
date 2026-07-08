import { WebSocket } from 'ws';
import { serializeServerFrame, toID, GLOBAL_ROOM } from '@simple-showdown/protocol';

/** A connected identity: one user may have several sockets (tabs/devices). */
export class User {
  name: string;
  id: string;
  /** Chosen trainer avatar (sprite name from the PS trainer set). */
  avatar = '';
  readonly sockets = new Set<WebSocket>();
  rooms = new Set<string>();

  constructor(name: string) {
    this.name = name;
    this.id = toID(name);
  }

  send(frame: string): void {
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  sendRoom(roomId: string, lines: string[]): void {
    this.send(serializeServerFrame(roomId, lines));
  }

  sendGlobal(lines: string[]): void {
    this.send(serializeServerFrame(GLOBAL_ROOM, lines));
  }

  get isGuest(): boolean {
    return this.name.startsWith('Guest ');
  }
}
