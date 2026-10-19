// Must be the FIRST import of every integration test: config reads these on load.
process.env.CB_FAST = '1';
process.env.CB_NO_BID_ROUNDS = '0'; // existing room tests expect round 1 to start with bidding
process.env.CB_BID_SECONDS = '1';
process.env.CB_PLAY_SECONDS = '1';
process.env.CB_RECONNECT_SECONDS = '5';
export {};
