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

   POR QUE TODAVIA NO PIDE PERMISO DE NOTIFICACIONES
   --------------------------------------------------
   Porque hoy sonaria dos veces. El panel ya esta suscrito al push y la Edge
   Function `avisos` reparte cada aviso a TODOS los dispositivos de
   `push_dispositivos`, sin distinguir de que app vino la suscripcion. Si esta
   app se suscribiera tambien, el mismo aviso llegaria por partida doble al
   mismo telefono.

   Para separarlos hace falta una columna `app` en `push_dispositivos` y que la
   Edge Function filtre por ella. Es poco codigo, pero esa funcion es el UNICO
   camino de entrega de todos los avisos del sistema: romperla deja a Jose sin
   ninguno y sin enterarse. Se hace despierto y comprobando, no de madrugada.

   Mientras tanto NO se pierde nada: el aviso de que Atlas ingreso una reserva
   llega igual, lo muestra la app del panel, y al tocarlo lleva a su pantalla de
   Atlas. Ver `db/atlas-avisa-en-su-nombre.sql`. */

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
  if (!r.ok) throw new Error((await r.text()) || `Error ${r.status}`);
  return r.status === 204 ? null : r.json();
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
    caja.innerHTML = '<p class="vacio">Nada todavía.</p>';
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
