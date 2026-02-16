# مجهول — Anonymous Chat

دردشة مجهولة حقيقية بين مستخدمين.

## التقنيات
- **Node.js** + **Express**
- **Socket.io** (دردشة فورية)
- **Helmet** (حماية HTTP)
- **Rate Limiting** (منع السبام)

## الحماية
- ✅ HTTPS تلقائي عند النشر
- ✅ WebSocket مشفر (WSS)
- ✅ لا تُخزن أي رسائل
- ✅ لا يُكشف IP المستخدمين
- ✅ Rate Limiting: 60 رسالة/دقيقة
- ✅ حد أقصى 500 حرف للرسالة

---

## التشغيل المحلي

```bash
# 1. تثبيت الحزم
npm install

# 2. نسخ ملف الإعدادات
cp .env.example .env

# 3. التشغيل
npm start

# الموقع يعمل على:
# http://localhost:3000
```

---

## النشر على Railway (مجاني)

1. **أنشئ حساب** على [railway.app](https://railway.app)
2. **أنشئ مشروع جديد** ← New Project ← Deploy from GitHub
3. **ارفع الكود على GitHub** أولاً:
   ```bash
   git init
   git add .
   git commit -m "first commit"
   git remote add origin https://github.com/USERNAME/majhool.git
   git push -u origin main
   ```
4. **اربط Railway بالـ repo**
5. Railway يبني ويشغل تلقائياً ✅
6. اذهب لـ Settings ← Domains ← Generate Domain
7. ستحصل على رابط مثل: `https://majhool-production.up.railway.app`

---

## بعد النشر

في Railway → Variables أضف:
```
CLIENT_URL = https://your-domain.com
```

---

## هيكل المشروع

```
majhool-server/
├── server.js          ← السيرفر الرئيسي
├── public/
│   └── index.html     ← الواجهة الأمامية
├── package.json
├── railway.toml       ← إعدادات النشر
└── .env.example       ← نموذج المتغيرات
```
