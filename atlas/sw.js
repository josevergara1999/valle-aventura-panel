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

   El push NO se maneja aqui todavia. Ver el encabezado de app.js: mientras la
   Edge Function `avisos` reparta cada aviso a todos los dispositivos sin
   distinguir de que app vino la suscripcion, suscribirse aqui haria sonar el
   telefono dos veces por el mismo hecho. */

const CACHE = "atlas-v2";

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
