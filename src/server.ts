import { listen } from 'colyseus';
import { config } from './config.js';
import { createServer } from './app.js';
import { voiceOffReason } from './services/voiceToken.js';

await listen(createServer(), config.port);
console.log(`Call Break server listening on :${config.port}`);
const voiceOff = voiceOffReason();
console.log(voiceOff ? `Voice chat: OFF (${voiceOff})` : 'Voice chat: ON');
