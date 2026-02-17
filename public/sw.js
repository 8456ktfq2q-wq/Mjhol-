// Service Worker لمجهول+

const CACHE_NAME = "majhool-cache-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest"
];

// تثبيت
self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// تفعيل
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// جلب الملفات (مهم جداً عشان السوكت يشتغل)
self.addEventListener("fetch", event => {

  // لا تلمس طلبات socket.io ابداً
  if (event.request.url.includes("/socket.io/")) return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );

});
