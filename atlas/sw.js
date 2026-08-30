/* ============================================================================
   Service worker de la app de Atlas
   ============================================================================
   Hace dos cosas y ninguna es cachear datos:

   1. Existir. Sin un service worker registrado, iOS no ofrece "Añadir a
      pantalla de inicio" como app instalable, y sin instalarla no hay ni icono
      propio ni ventana propia.

   2. Guardar el CASCARON para que abra sin red. En Las Trancas la cobertura va
      y viene, y una pantalla en blanco no dice nada; el cascaron abierto con
      los datos de la ultima vez al menos dice cuando fue esa ultima vez.

   LO QUE NUNCA SE CACHEA SON LOS DATOS. Es deliberado y es la misma regla que
   sigue la app del huesped: un "Aquí estoy" guardado de ayer, mostrado hoy con
   el PC apagado, es peor que no mostrar nada — seria mentir justo en lo unico
   que esta pantalla existe para responder. Las llamadas a Supabase van siempre
   a la red y, si fallan, se ve el fallo.

   3. Mostrar los avisos de Atlas (desde el 30-ago-2026). El service worker es
      lo unico que sigue vivo con la app cerrada, asi que las notificaciones se
      muestran aqui o no se muestran.

      Aqui SOLO llegan los avisos de Atlas, y no porque se filtren: llegan los
      que la Edge Function manda a ESTA suscripcion, y desde
      `db/push-por-app.sql` solo le manda los de `destino = 'atlas'`. El panel
      tiene la suya aparte y recibe los suyos. */

const CACHE = "atlas-v3";

/* Solo lo propio y los dos archivos del panel de los que depende. Si alguno
   cambia, sube el numero de CACHE y se descarta el viejo entero. */
const CASCARON = [
  "./",
  "./index.html",
  "./estilos.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icono-192.png",
  "./icono-512.png",
  "./apple-touch-icon.png",
  "../tokens.css",
  "../config.js",
];

self.addEventListener("install", (e) => {
  // addAll falla entero si un solo archivo falla, y entonces no se instala
  // nada. Se piden de uno en uno y se ignora el que falte.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(CASCARON.map((u) => c.add(u).catch(() => {}))))
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
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Todo lo que sea datos va SIEMPRE a la red. Ver el encabezado.
  if (url.hostname.endsWith(".supabase.co")) return;

  // Red primero para que una version nueva entre sola; la cache es el respaldo
  // de cuando no hay cobertura.
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r && r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   Los avisos
   ═══════════════════════════════════════════════════════════════════════════
   Llegan cifrados desde la Edge Function `avisos` (RFC 8291). Se muestran con
   el mismo criterio que en el panel para que un aviso no se comporte distinto
   segun por que app entre. */

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: "Atlas", cuerpo: "" }; }

  const urgente = d.urgencia === "alta";

  e.waitUntil(self.registration.showNotification(d.titulo || "Atlas", {
    body: d.cuerpo || "",
    icon: "./icono-192.png",
    badge: "./icono-192.png",
    /* Agrupados salvo los urgentes. Aqui pesa mas que en el panel: si Atlas
       ingresa cuatro reservas de una tacada al ponerse al dia tras un apagon,
       son cuatro avisos del mismo hecho —"me puse al dia"— y apilarlos llena
       la pantalla de bloqueo. Un choque de fechas SI merece su propia linea,
       porque cada uno necesita que Jose decida algo distinto. */
    tag: urgente ? undefined : "atlas",
    renotify: urgente,
    requireInteraction: urgente,
    vibrate: urgente ? [200, 80, 200] : [100],
    data: { id: d.id },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    /* `includeUncontrolled` devuelve todas las ventanas del dominio, las del
       panel incluidas. Se filtra por el scope: un aviso de Atlas tiene que
       abrir la app de Atlas, no enfocar el panel que estuviera abierto detras
       y dejar al usuario mirando otra pantalla. */
    const raiz = self.registration.scope;
    const abiertas = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abiertas) {
      if (c.url.startsWith(raiz)) { await c.focus(); return; }
    }
    await clients.openWindow("./index.html");
  })());
});
