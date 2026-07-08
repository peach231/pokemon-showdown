import { GameServer } from './server.js';

const PORT = Number(process.env['PORT'] ?? 8000);

new GameServer(PORT);
