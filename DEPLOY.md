# Server deploy: Render (ফ্রি)

## যা লাগবে
- GitHub account আর Render account (https://render.com)
- তোমার Firebase **projectId** (Firebase console → Project settings → General)

## ১. GitHub-এ push করো
`callbreak-server` ফোল্ডারে terminal খুলে (আগে GitHub-এ একটা খালি repo বানাও, private হলেও চলবে):
```
git init
git add .
git commit -m "Call Break server"
git branch -M main
git remote add origin https://github.com/<তোমার-নাম>/callbreak-server.git
git push -u origin main
```
`package-lock.json` অবশ্যই push হতে হবে (build-এ `npm ci` লাগে)। `.gitignore` আগে থেকেই `node_modules`, `dist`, `.env` বাদ দেয়।

## ২. Render-এ deploy
1. Render dashboard → **New → Blueprint** → GitHub connect করে repo বেছে নাও।
2. Render `render.yaml` পড়ে একটা **Free** web service (Singapore) দেখাবে।
3. `FIREBASE_PROJECT_ID`-এর ঘরে তোমার Firebase projectId বসাও → **Apply**।
4. Build শেষে Logs-এ `Call Break server listening` দেখা যাবে।

## ৩. যাচাই
Render service-এর URL হবে `https://callbreak-server-xxxx.onrender.com`। browser-এ `/health` খোলো:
`https://callbreak-server-xxxx.onrender.com/health` → `{"ok":true,...}` আসলে ঠিক আছে।

## ৪. app-এ বসাও
`https` এর জায়গায় `wss` দিয়ে (app-এর `SETUP.md` দেখো):
```
EXPO_PUBLIC_SERVER_URL=wss://callbreak-server-xxxx.onrender.com
```

## ফ্রি plan-এর সীমা (জেনে রাখো)
- **১৫ মিনিট কেউ না খেললে server ঘুমায়।** প্রথম জন ঢুকলে জাগতে ৩০–৬০ সেকেন্ড লাগতে পারে। app নিজে অপেক্ষা করে আর "সার্ভার জাগছে…" দেখায়। খেলা চলার সময় WebSocket মেসেজ আসতে থাকে বলে ঘুমায় না।
- **Render যেকোনো সময় restart করতে পারে।** রুম server-এর memory-তে থাকে, তাই restart হলে চলমান রুম হারাবে। app জানিয়ে দেয় ("রুমের সংযোগ হারিয়ে গেছে")।
- **মাসে ৭৫০ ঘণ্টা ফ্রি** (সব ফ্রি service মিলিয়ে)। ঘণ্টা শেষ হলে মাসের বাকি সময় service বন্ধ থাকে।
- বাইরের ping সার্ভিস দিয়ে জাগিয়ে রাখা যায়, কিন্তু Render এটাকে অফিসিয়ালি সমর্থন করে না।

## নিরাপত্তা
`FIREBASE_PROJECT_ID` না দিলে server "dev মোডে" চলে: যে কেউ যেকোনো নাম/uid দাবি করতে পারে। বন্ধুদের জন্য deploy করলে অবশ্যই এটা সেট করো।

## আপডেট করা
কোড বদলে `git push` করলে Render নতুন করে deploy করে (না করলে dashboard-এ **Manual Deploy**)।

## ঐচ্ছিক সেটিং (Render → Environment)
`CB_BID_SECONDS` (ডিফল্ট ২০), `CB_PLAY_SECONDS` (৩০), `CB_RECONNECT_SECONDS` (৬০)। app এই সময়গুলো server থেকেই পায়।
