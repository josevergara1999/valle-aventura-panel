/* Valle Aventura — service worker.
   Solo existe para que el panel se instale como app y abra aunque haya mala
   señal. NO cachea datos: precios y bloqueos se piden siempre a la red, porque
   un precio viejo servido desde caché es peor que un error.

   Estrategia: red primero con tope de 3 s, caché como respaldo. Al revés
   —caché primero— el teléfono seguiría abriendo la versión vieja después de
   cada despliegue, que es exactamente el problema que ya apareció en Inmersia. */

const CACHE = "valle-panel-v1";
const SHELL = [
  "./index.html", "./tokens.css", "./styles.css", "./app.js",
  "./config.js", "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  // Un archivo que falte (p. ej. config.js todavía sin crear) no debe tumbar
  // la instalación completa: se cachea lo que haya.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Todo lo que va a Supabase pasa directo, sin tocar la caché.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const red = await Promise.race([
        fetch(e.request),
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("lento")), 3000)),
      ]);
      if (red && red.ok) {
        const c = await caches.open(CACHE);
        c.put(e.request, red.clone());
      }
      return red;
    } catch {
      const guardado = await caches.match(e.request);
      return guardado || caches.match("./index.html");
    }
  })());
});
