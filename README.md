# Call Break server

Call Break (কল ব্রেক) real-time multiplayer server: Node.js + TypeScript + Colyseus.
সব নিয়ম, শাফল, বিড, চাল যাচাই, স্কোর, টাইমার আর বট এই server-এ চলে (server-authoritative)। app শুধু ছবি দেখায়।

## দ্রুত শুরু
```
npm install
npm run dev          # http://localhost:2567  (health: /health)
```
Node.js 20 বা তার বেশি লাগবে।

## কমান্ড
| কমান্ড | কাজ |
|---|---|
| `npm run dev` | ডেভেলপমেন্ট server (কোড বদলালে আপনা-আপনি restart) |
| `npm run build` | `dist/`-এ JavaScript বানায় |
| `npm start` | `dist/server.js` চালায় (production) |
| `npm run typecheck` | টাইপ যাচাই |
| `npm test` | game engine-এর test |
| `npm run test:all` | engine + room (real WebSocket) + auth, সব test (~১ মিনিট) |

## ফোল্ডার
```
src/
  server.ts            এন্ট্রি
  app.ts               Express + Colyseus: /health, /rooms (পাবলিক রুমের তালিকা)
  config.ts            সব সেটিং (env দিয়ে বদলানো যায়)
  engine/              খাঁটি game logic: cards, rules, game (state machine), bot
  rooms/CallBreakRoom  রুম: লবি, বট, টাইমার, reconnect, মেসেজ
  auth/verifyIdToken   Firebase ID token যাচাই
  services/matchStore  শেষ হওয়া ম্যাচ কোথায় যাবে (এখন শুধু log; Phase 5-এ Firestore)
  services/voiceToken  ভয়েস চ্যাটের Agora টোকেন বানানো (injectable, test-এ নকল বসানো যায়)
test/                  engine, room, auth test
render.yaml            Render (ফ্রি) deploy
DEPLOY.md              deploy-এর ধাপ (বাংলায়)
```

## Environment variables
| নাম | ডিফল্ট | মানে |
|---|---|---|
| `PORT` | 2567 | পোর্ট (Render নিজে দেয়) |
| `FIREBASE_PROJECT_ID` | খালি | সেট করলে ঢুকতে Firebase ID token লাগে। **deploy-এ অবশ্যই সেট করো।** খালি থাকলে dev মোড: যে কেউ যেকোনো পরিচয় দাবি করতে পারে |
| `CB_BID_SECONDS` | 20 | বিডের সময় (পরে server নিজে বিড দেয়; মানুষ প্লেয়ার বিড না দিলে সর্বনিম্ন কল ২ ধরা হয়) |
| `CB_PLAY_SECONDS` | 30 | চালের সময় |
| `CB_RECONNECT_SECONDS` | 60 | connection কাটলে সিট ধরে রাখার সময় |
| `CB_BOT_MIN_MS` / `CB_BOT_MAX_MS` | 700 / 1500 | বটের "ভাবার" সময় |
| `CB_ROUND_END_MS` | 6000 | রাউন্ড শেষের সামারি কতক্ষণ দেখাবে |
| `CB_DISCONNECTED_PLAY_MS` | 2500 | disconnect হলে কতক্ষণ পরে বট চাল দেবে |
| `CB_FAST` | খালি | `1` দিলে সব বিলম্ব বন্ধ (শুধু test-এর জন্য) |
| `AGORA_APP_ID` | খালি | Agora প্রজেক্টের App ID (৩২ অক্ষরের hex) |
| `AGORA_APP_CERTIFICATE` | খালি | Agora App Certificate (৩২ অক্ষরের hex)। **গোপন: শুধু Render env-এ রাখো, GitHub বা app-এ নয়।** খালি থাকলে ভয়েস বন্ধ |
| `VOICE_ENABLED` | চালু | `0` দিলে ভয়েস বন্ধ (জরুরি কিল-সুইচ; key বদলাতে হয় না, গেম স্বাভাবিক চলে) |
| `CB_VOICE_TOKEN_SECONDS` | 3600 | ভয়েস টোকেনের মেয়াদ (সেকেন্ড; কাজে ৬০ থেকে ৮৬৪০০-এর মধ্যে ধরা হয়) |
| `CB_VOICE_TOKEN_MIN_GAP_MS` | 5000 | এক ক্লায়েন্ট কত ঘন ঘন টোকেন চাইতে পারবে |

server চালু হলে log-এ একটা লাইন আসে: `Voice chat: ON` অথবা `Voice chat: OFF (কারণ)`। Render env ঠিক বসেছে কিনা এখান থেকেই বোঝা যায় (key-এর মান কখনো log হয় না)।

## খেলার নিয়ম (সংক্ষেপে)
- ৪ জন, ৫২ কার্ড, স্পেড = ট্রাম্প। প্রতি রাউন্ডে ১৩টা করে।
- বিড ১–৮। স্কোর: বিড পূরণ হলে `বিড + (বেশি ট্রিক × ০.১)`, না হলে `−বিড`।
- চাল: আগে একই suit (পারলে আগের চেয়ে বড়), না থাকলে স্পেড (পারলে আগের স্পেডের চেয়ে বড়), না থাকলে যেকোনো।
- হাতে স্পেড না থাকলে, বা ১০-এর নিচের কার্ড ছাড়া কিছু না থাকলে আবার ডিল।
- খেলা শেষ হয় টার্গেট স্কোরে (29/49/99/কাস্টম ১০–৫০০)। টার্গেট পার হলে সবচেয়ে বেশি স্কোরের একজন জেতে; শীর্ষে সমান হলে খেলা চলে।

## Client protocol (app যা পাঠায়/পায়)
Room name: `callbreak`। ঢোকার options: `{ name, uid, idToken?, roomName?, isPrivate?, targetScore? }`।
server → client: `state` (পুরো `RoomView`, প্রতি পরিবর্তনে) আর `error` (`{code, message}`)।

প্রথম রাউন্ড বিড ছাড়া খেলা হয় (`CB_NO_BID_ROUNDS`, ডিফল্ট ১; `0` দিলে বন্ধ)। ওই রাউন্ডে স্কোর = জেতা হাতের সংখ্যা (বিড = হাত ধরা হয়)।

client → server: `sync`, `setTarget`, `addBot`, `removeBot`, `start {fillBots}`, `ready`, `bid {bid}`, `play {suit, rank}`, `rematch`, `voiceToken`।

### ভয়েস চ্যাট (Agora)
client `voiceToken` পাঠায় (কোনো payload নেই); server সবসময় ঠিক একটা `voice` মেসেজ ফেরত দেয়:
```
voice {
  enabled: boolean,
  appId?: string,        // enabled হলে
  channel?: string,      // "cb-<roomCode>"
  uid?: number,          // সিট + 1 (1 থেকে 4)
  token?: string,
  expiresAt?: number,    // epoch ms
  reason?: 'disabled' | 'not_seated' | 'rate_limited'   // enabled=false হলে
}
```
- `not_seated`: এই রুমে বসা মানুষ নয় (বটের তো client-ই নেই)। `disabled`: key নেই, `VOICE_ENABLED=0`, অথবা Agora key নিতে পারেনি। `rate_limited`: `CB_VOICE_TOKEN_MIN_GAP_MS`-এর আগেই আবার চেয়েছে।
- ভয়েসের কোনো সমস্যা গেমে প্রভাব ফেলে না: `voice` মেসেজ আলাদা, `state`-এ কিছু বদলায় না।
- App Certificate কখনো client-এ যায় না; client শুধু তৈরি-করা টোকেন পায়।
- রিনিউ: টোকেনের মেয়াদ শেষের প্রায় ৫ মিনিট আগে app নিজে আবার `voiceToken` পাঠায়। সার্ভার রুমে বসা মানুষকেই নতুন টোকেন দেয় (একই channel ও uid), আর app সেটা চলতি কলে SDK-কে দেয়, কল থামে না। খুব তাড়াতাড়ি চাইলে `rate_limited` আসে, app ৬ সেকেন্ড পরে আবার চায়। সার্ভার `disabled` বললে app ভয়েস শেষ করে ছোট বার্তা দেখায়, গেম চলে।

## খেলার নিয়ম (স্কোরিং ও রাউন্ড শুরু)
- **স্কোর** (`engine/rules.ts` → `roundScore10`): হাত < কল হলে **−কল**; কল ≤ হাত < কলের ডাবল হলে **+কল** (বাড়তি হাতের বোনাস নেই); হাত ≥ কলের ডাবল হলে **−কল**। স্কোর পূর্ণ সংখ্যা। প্রথম রাউন্ডে (বিড ছাড়া) যত হাত তত পয়েন্ট।
- **কার্ড বাটা**: প্রতি রাউন্ডে আগে `dealing` ধাপ আসে (`CB_DEAL_MS` = বাটার অ্যানিমেশন, `CB_VIEW_MS` = কার্ড দেখার সময়; ডিফল্ট 3000 / 60000 ms — সব মানুষ প্লেয়ার `ready` চাপলে আগেই শেষ হয়), তারপর বিড (বা প্রথম রাউন্ডে সরাসরি খেলা)।
