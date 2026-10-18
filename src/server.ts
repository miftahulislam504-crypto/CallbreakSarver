import { listen } from 'colyseus';
import { config } from './config.js';
import { createServer } from './app.js';

await listen(createServer(), config.port);
console.log(`Call Break server listening on :${config.port}`);
