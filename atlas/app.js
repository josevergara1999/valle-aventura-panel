/* ============================================================================
   Atlas — la app
   ============================================================================
   Que es: una pantalla que responde dos preguntas, ¿sigue vivo? y ¿que ha
   hecho? Nada mas. Todo lo que se configura o se toca vive en el panel.

   POR QUE LEE DE SUPABASE Y NO DEL PC DE JOSE
   -------------------------------------------
   Atlas corre en el PC (LiveKit, la voz, el detector de reservas) y ese PC no
   es alcanzable desde internet. Pero todo lo que hace lo va dejando escrito en
   Supabase, que si es publico. Asi que esta app no habla con Atlas: lee su
   rastro. La consecuencia buena es que funciona desde cualquier sitio y sin
   tuneles; la mala es que si el PC esta apagado, aqui se ve — que es
   exactamente lo que queremos que se vea.

   LOS AVISOS SON SUYOS DESDE EL 30-AGO-2026
   -----------------------------------------
   Al nacer, esta app no pedia permiso de notificaciones: el panel ya estaba
   suscrito y la Edge Function repartia cada aviso a TODOS los dispositivos sin
   mirar de que app venia la suscripcion, asi que suscribirse aqui habria hecho
   sonar el telefono dos veces por el mismo hecho.

   Ya no. `push_dispositivos` tiene una columna `app` y la funcion reparte por
   ella: aqui llegan los avisos de Atlas (los de destino 'atlas') y solo esos;
   el resto sigue yendo al panel. Ver `db/push-por-app.sql`.

   Y si esta app no esta instalada en ningun telefono, sus avisos siguen
   llegando por el panel, como antes. Instalarla es lo que los mueve aqui. */

const $ = (s) => document.querySelector(s);
const CFG = window.CONFIG || {};

/* ------------------------------------------------------------- Sesion --- */
/* Se comparte con el panel a proposito: misma clave de localStorage, mismo
   origen, misma cuenta. Iniciar sesion dos veces en el mismo telefono para ver
   los mismos datos seria una molestia sin ninguna ganancia. */
const SESION = "va_sesion";
let sesion = null;
try { sesion = JSON.parse(localStorage.getItem(SESION) || "null"); } catch (e) { sesion = null; }

const guardarSesion = (s) => { sesion = s; localStorage.setItem(SESION, JSON.stringify(s)); };
const borrarSesion = () => { sesion = null; localStorage.removeItem(SESION); };

async function entrar(correo, clave) {
  const r = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: correo, password: clave }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.msg || "No se pudo entrar");
  guardarSesion(d);
}

async function refrescar() {
  if (!sesion || !sesion.refresh_token) return false;
  const r = await fetch(`${CFG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: sesion.refresh_token }),
  });
  if (!r.ok) { borrarSesion(); return false; }
  guardarSesion(await r.json());
  return true;
}

/* Un 401 se reintenta UNA vez tras renovar el token. El tope importa: sin el,
   un token que no se puede renovar deja la app llamando en bucle. */
async function api(ruta, opciones = {}, reintento = false) {
  if (!sesion) throw new Error("sin sesion");
  const r = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${ruta}`, {
    ...opciones,
    headers: {
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sesion.access_token}`,
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });
  if (r.status === 401 && !reintento && await refrescar()) return api(ruta, opciones, true);

  /* Se lee el cuerpo como texto y solo se interpreta si hay algo. Mirar el 204
     no basta: un INSERT correcto en PostgREST responde 201 con el cuerpo VACIO
     salvo que se le pida representacion, y `r.json()` sobre eso lanza. El
     efecto era el peor posible — la fila quedaba escrita y la app decia que
     habia fallado. Mientras esto solo leia no se notaba; desde que registra la
     suscripcion de avisos, si. Es el mismo criterio que usa el panel. */
  const txt = await r.text();
  const d = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error((d && (d.message || d.hint)) || txt || `Error ${r.status}`);
  return d;
}

/* --------------------------------------------------------------- Texto --- */

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* "hace 4 h" dice mas de un vistazo que una hora exacta cuando lo que importa
   es si fue recien o hace mucho. */
function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return "hace " + min + " min";
  const h = Math.round(min / 60);
  if (h < 24) return "hace " + h + " h";
  const d = Math.round(h / 24);
  return "hace " + d + (d === 1 ? " día" : " días");
}

/* ------------------------------------------------------------- Pintar --- */

const PROBLEMAS = ["atlas_choque", "atlas_desconocido", "atlas_fallo"];

async function cargar() {
  let latido = null, avisos = [];

  /* El latido va aparte de los avisos: si su tabla falla, la lista se pinta
     igual. Un fallo de una consulta no puede dejar la pantalla en blanco. */
  try {
    const f = await api("atlas_latido?select=visto_at,nota&id=eq.atlas");
    latido = (f && f[0]) || null;
  } catch (e) { latido = null; }

  try {
    avisos = await api(
      "avisos?select=id,tipo,titulo,cuerpo,urgencia,creado_at,leido"
      + "&or=(tipo.like.atlas*,tipo.eq.reserva_atlas,categoria.eq.atlas)"
      + "&order=creado_at.desc&limit=60") || [];
  } catch (e) {
    $("#feed").innerHTML = '<p class="vacio">No pude leer: ' + esc(e.message) + "</p>";
  }

  pintarEstado(latido);
  pintarFeed(avisos);
  /* Aparte y tragandose el fallo, igual que el latido: esto es un ajuste, y un
     ajuste que no se pueda pintar no puede tapar lo que la pantalla existe para
     ensenar. */
  try { await pintarAvisos(); } catch (e) { /* se vera al recargar */ }
}

function pintarEstado(latido) {
  /* Doce minutos son dos vueltas y pico del detector, que revisa cada cinco.
     Asi una vuelta lenta por una consulta de correo pesada no lo da por
     muerto. */
  const min = latido
    ? Math.round((Date.now() - new Date(latido.visto_at).getTime()) / 60000)
    : null;
  const clase = min === null ? "desconocido" : (min < 12 ? "vivo" : "caido");

  $("#estado").className = "tarjeta-estado " + clase;
  $("#estado-punto").className = "punto " + clase;
  $("#estado-titulo").textContent =
    clase === "vivo" ? "Aquí estoy" : (clase === "caido" ? "Desconectado" : "No lo sé");
  $("#estado-sub").textContent =
    clase === "vivo"
      ? "Reviso el correo cada 5 minutos. Última vuelta " + hace(latido.visto_at) + "."
      : (clase === "caido"
          ? "Sin señales desde " + hace(latido.visto_at)
            + ". Mientras esté así no estoy ingresando reservas: revisa que el PC esté encendido."
          : "Todavía no he podido comprobarlo.");
}

function pintarFeed(avisos) {
  const caja = $("#feed");
  if (!avisos.length) {
    caja.innerHTML = '<p class="vacio">Nada todavía. Cuando ingrese una reserva '
      + 'de Airbnb, o cuando algo me falle, aparecerá aquí.</p>';
    $("#nota").textContent = "";
    return;
  }

  caja.innerHTML = avisos.map((a) => {
    const esProblema = PROBLEMAS.indexOf(a.tipo) !== -1;
    const clases = "msg" + (esProblema ? " problema" : "") + (a.leido ? " visto" : "");
    return `
      <div class="${clases}">
        <div class="msg-cab">
          <b>${esc(a.titulo)}</b>
          <span class="cuando">${hace(a.creado_at)}</span>
        </div>
        <p class="sub">${esc(a.cuerpo)}</p>
        ${esProblema && !a.leido
          ? `<button type="button" data-visto="${a.id}">Visto</button>` : ""}
      </div>`;
  }).join("");

  const pendientes = avisos.filter((a) => PROBLEMAS.indexOf(a.tipo) !== -1 && !a.leido).length;
  $("#nota").textContent = pendientes
    ? "Hay " + pendientes + " que no pude resolver yo. Las de reservas se arreglan desde el panel."
    : "Ingreso las reservas de Airbnb solo, sin preguntar. Quedan con origen manual, "
      + "así que puedes editarlas o borrarlas desde el panel como cualquier otra.";

  caja.querySelectorAll("[data-visto]").forEach((b) =>
    b.addEventListener("click", () => marcarVisto(b.dataset.visto)));
}

/* "Visto" marca leido, no borra. El registro de que fallo y cuando es lo que
   evita repetir el mismo problema dentro de un mes. */
async function marcarVisto(id) {
  try {
    await api("avisos?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ leido: true }),
    });
  } catch (e) { /* se vera al recargar */ }
  await cargar();
}

/* -------------------------------------------------------- Avisos aqui --- */
/* La misma clave publica que el panel, y tiene que serlo: identifica al
   servidor que firma los envios, no a la app. Con otra distinta, Apple
   rechazaria los avisos de esta suscripcion. */
const VAPID_PUBLICA = "BOOBabMlwesyBFQKK-PjtuoVwaceAeIWYbf6vfw7iLNsXExXQCVs8ASzw-xRcHdvBEB72DsevGsw27znNvk-cEY";

/* La clave publica viaja como bytes, no como texto. */
function claveABytes(base64) {
  const relleno = "=".repeat((4 - (base64.length % 4)) % 4);
  const limpia = (base64 + relleno).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(limpia);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* Un nombre reconocible para saber que telefono es cual mirando la tabla. No
   dice de que app viene: para eso esta la columna `app`, y repetir el dato en
   dos sitios es garantizar que algun dia se contradigan. */
function nombreDispositivo() {
  const ua = navigator.userAgent;
  const so = /iPhone|iPad/.test(ua) ? "iPhone"
           : /Android/.test(ua) ? "Android"
           : /Mac/.test(ua) ? "Mac"
           : /Windows/.test(ua) ? "Windows" : "Dispositivo";
  const quien = ((sesion && sesion.user && sesion.user.email) || "").split("@")[0];
  return quien ? so + " de " + quien : so;
}

async function avisosEstado() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "no-soportado";
  // En iOS, Safari sin instalar no trae PushManager, asi que casi siempre se
  // sale por la linea de arriba. Esta comprueba lo otro por separado: la linea
  // siguiente lee `Notification` y si no existiera lanzaria un ReferenceError
  // que dejaria la tarjeta sin pintar.
  if (typeof Notification === "undefined") return "no-soportado";
  if (!window.isSecureContext) return "sin-https";
  if (Notification.permission === "denied") return "bloqueado";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub ? "activo" : "inactivo";
}

async function avisosActivar() {
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") { await pintarAvisos(); return; }

  /* `ready` y no `getRegistration`: recien instalada la app el worker puede
     estar todavia activandose, y suscribirse contra un registro a medias falla
     con un error que no dice nada. */
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      // Obligatorio en todos los navegadores: no hay push silencioso, siempre
      // hay que mostrar algo. Aqui nos viene bien.
      userVisibleOnly: true,
      applicationServerKey: claveABytes(VAPID_PUBLICA),
    });
  }

  const j = sub.toJSON();
  try {
    /* `on_conflict` sobre el endpoint: si esta suscripcion ya estaba registrada
       se actualiza en vez de duplicarse. */
    await api("push_dispositivos?on_conflict=endpoint", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates, return=minimal" },
      body: JSON.stringify({
        endpoint: j.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
        etiqueta: nombreDispositivo(),
        // Lo que hace que este telefono reciba los avisos de Atlas por aqui y
        // deje de recibirlos por el panel. Ver `db/push-por-app.sql`.
        app: "atlas",
        activo: true,
        fallos: 0,
      }),
    });
  } catch (e) {
    /* Si el registro falla hay que deshacer la suscripcion del navegador. Si no,
       queda una suscripcion viva que la base no conoce: el estado diria
       "activo" y no llegaria nunca nada. */
    try { await sub.unsubscribe(); } catch (_) {}
    alert("No se pudo activar: " + e.message);
  }
  await pintarAvisos();
}

async function avisosDesactivar() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) {
    try {
      await api("push_dispositivos?endpoint=eq." + encodeURIComponent(sub.endpoint), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ activo: false }),
      });
    } catch (e) { /* da igual: lo que importa es cancelarla en el navegador */ }
    await sub.unsubscribe();
  }
  await pintarAvisos();
}

/* Hablando en primera persona como el resto de la pantalla: quien avisa es
   Atlas, no "el sistema". */
const AVISOS_TEXTO = {
  "activo":       ["Te aviso en este telefono",
                   "Cuando ingrese una reserva o algo se me atasque, suena aqui."],
  "inactivo":     ["Aqui no te aviso todavia",
                   "Activalo y lo mio sonara en esta app en vez de en el panel."],
  "bloqueado":    ["No me dejas avisarte",
                   "Bloqueaste las notificaciones para este sitio. Hay que permitirlas en los ajustes."],
  "sin-https":    ["No puedo avisarte desde aqui",
                   "Abreme en panel.valleaventura-chile.com para poder activarlo."],
  "no-soportado": ["Este navegador no admite avisos",
                   "En el iPhone hay que anadirme a la pantalla de inicio primero."],
};

async function pintarAvisos() {
  const estado = await avisosEstado();
  const texto = AVISOS_TEXTO[estado];

  $("#avisos-titulo").textContent = texto[0];
  $("#avisos-sub").textContent = texto[1];

  const boton = $("#avisos-boton");
  boton.hidden = (estado !== "activo" && estado !== "inactivo");
  boton.textContent = estado === "activo" ? "Desactivar" : "Activar";
  $("#avisos").className = "tarjeta-avisos " + estado;
  $("#avisos").hidden = false;
}

/* -------------------------------------------------------------- Arranque - */

function mostrar(cual) {
  $("#cargando").hidden = cual !== "cargando";
  $("#entrar").hidden = cual !== "entrar";
  $("#app").hidden = cual !== "app";
}

$("#entrar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#error-entrar");
  err.hidden = true;
  try {
    await entrar($("#correo").value.trim(), $("#clave").value);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    return;
  }
  mostrar("app");
  await cargar();
});

async function arrancar() {
  if (!CFG.SUPABASE_URL) {
    $("#cargando").textContent = "Falta la configuración.";
    return;
  }
  if (!sesion) { mostrar("entrar"); return; }
  mostrar("app");
  try {
    await cargar();
  } catch (e) {
    // Sesion muerta: se pide entrar en vez de dejar una pantalla rota.
    borrarSesion();
    mostrar("entrar");
  }
}

arrancar();

/* Al volver a la app se recarga: es lo que se hace al abrirla, mirar si hay
   algo nuevo. Y cada minuto mientras este delante, que es barato. */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sesion) cargar();
});
setInterval(() => { if (!document.hidden && sesion) cargar(); }, 60000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* Un solo oyente, puesto una vez. `pintarAvisos` corre en cada carga —cada
   minuto mientras la app este delante— y engancharlo ahi apilaria un oyente por
   vuelta, hasta que un solo toque activara y desactivara a la vez. */
$("#avisos-boton").addEventListener("click", async () => {
  const boton = $("#avisos-boton");
  boton.disabled = true;
  try {
    if (await avisosEstado() === "activo") await avisosDesactivar();
    else await avisosActivar();
  } finally { boton.disabled = false; }
});
