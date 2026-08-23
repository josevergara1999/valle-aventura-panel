/* Valle Aventura — service worker.
   Solo existe para que el panel se instale como app y abra aunque haya mala
   señal. NO cachea datos: precios y bloqueos se piden siempre a la red, porque
   un precio viejo servido desde caché es peor que un error.

   Estrategia: red primero con tope de 3 s, caché como respaldo. Al revés
   —caché primero— el teléfono seguiría abriendo la versión vieja después de
   cada despliegue, que es exactamente el problema que ya apareció en Inmersia. */

const CACHE = "valle-panel-v6";
const SHELL = [
  "./index.html", "./tokens.css", "./styles.css", "./app.js",
  "./luces.js", "./config.js", "./manifest.webmanifest",
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

/* ═══════════════════════════════════════════════════════════════════════════
   Avisos al teléfono
   ═══════════════════════════════════════════════════════════════════════════
   Llegan cifrados desde la Edge Function `avisos`. El service worker es lo
   único que sigue vivo con la app cerrada, así que es aquí donde se muestran. */

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: "Valle Aventura", cuerpo: "" }; }

  const urgente = d.urgencia === "alta";

  e.waitUntil(self.registration.showNotification(d.titulo || "Valle Aventura", {
    body: d.cuerpo || "",
    icon: "./icono-192.png",
    badge: "./icono-192.png",
    /* Agrupar por destino: tres pedidos seguidos de la misma cabaña actualizan
       un aviso en vez de apilar tres. Los urgentes NO se agrupan — cada avería
       merece su propia línea. */
    tag: urgente ? undefined : (d.destino || "valle"),
    renotify: urgente,
    /* `requireInteraction` mantiene el aviso en pantalla hasta que se toca.
       Solo para lo urgente: si se aplicara a todo, la pantalla de bloqueo
       acabaría llena y dejaría de mirarse. */
    requireInteraction: urgente,
    vibrate: urgente ? [200, 80, 200] : [100],
    data: { destino: d.destino || "calendario", id: d.id },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.destino) || "calendario";
  e.waitUntil((async () => {
    const abiertas = await clients.matchAll({ type: "window", includeUncontrolled: true });
    /* Si el panel ya está abierto se reutiliza esa ventana y se le dice a qué
       pestaña ir. Abrir una segunda copia deja al usuario con dos paneles
       desincronizados. */
    for (const c of abiertas) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        c.postMessage({ tipo: "ir", destino });
        return;
      }
    }
    await clients.openWindow("./index.html#" + destino);
  })());
});
