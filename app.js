/* ============================================================================
   Valle Aventura - panel
   ============================================================================
   Sin framework y sin paso de compilacion: se abre el archivo y funciona. Es
   deliberado - este panel tiene que arrancar en un telefono, con senal mala,
   en la cabana. Cada kilobyte y cada dependencia se pagan ahi.

   Habla directo con Supabase por HTTP. Usa la clave ANONIMA y las politicas de
   acceso de la base; nunca la clave de servicio (esa se salta todos los
   permisos y aqui vive en el navegador, a la vista de cualquiera).
   ============================================================================ */

(() => {
"use strict";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CONFIG || {};
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.body.innerHTML =
    '<div class="login"><div class="aviso error">Falta <b>config.js</b>. ' +
    'Copia <code>config.example.js</code> como <code>config.js</code> y pon ahi ' +
    'la URL y la clave anonima de tu proyecto de Supabase.</div></div>';
  return;
}

/* ---------------------------------------------------------------- Sesion -- */
/* El token de acceso caduca en una hora. Se guarda tambien el de refresco para
   renovarlo en silencio: si no, a la hora el panel te echa en mitad de una
   reserva y hay que volver a escribir la contrasena. */
const SESION = "va_sesion";
let sesion = JSON.parse(localStorage.getItem(SESION) || "null");

const guardarSesion = (s) => { sesion = s; localStorage.setItem(SESION, JSON.stringify(s)); };
const borrarSesion  = () => { sesion = null; localStorage.removeItem(SESION); };

async function login(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.msg || "No se pudo entrar");
  guardarSesion(d);
  return d;
}

async function refrescar() {
  if (!sesion?.refresh_token) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: sesion.refresh_token }),
  });
  if (!r.ok) { borrarSesion(); return false; }
  guardarSesion(await r.json());
  return true;
}

/* Todas las llamadas a datos pasan por aqui. Un 401 se reintenta UNA vez tras
   renovar el token; si vuelve a fallar, se cierra la sesion. Sin ese tope, un
   token muerto genera un bucle infinito de reintentos. */
async function api(ruta, opciones = {}, reintento = true) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...opciones,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sesion?.access_token || SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });

  if (r.status === 401 && reintento && (await refrescar())) return api(ruta, opciones, false);
  if (r.status === 401) { borrarSesion(); mostrarLogin(); throw new Error("Sesion vencida"); }

  const txt = await r.text();
  const d = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error(d?.message || d?.hint || `Error ${r.status}`);
  return d;
}

/* --------------------------------------------------- Comprobantes (fotos) -- */
/* La foto se achica ANTES de subir. Una captura de pantalla de la app del banco
   pesa 3-5 MB, y esto se usa con la señal de la montaña: subir el original es
   la diferencia entre dos segundos y un minuto largo, y no se gana nada — el
   comprobante solo hay que poder leerlo. */
async function achicarImagen(file, lado = 1400, calidad = 0.82) {
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, lado / Math.max(bitmap.width, bitmap.height));
  const lienzo = document.createElement("canvas");
  lienzo.width  = Math.round(bitmap.width  * escala);
  lienzo.height = Math.round(bitmap.height * escala);
  lienzo.getContext("2d").drawImage(bitmap, 0, 0, lienzo.width, lienzo.height);
  bitmap.close?.();
  return new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", calidad));
}

async function subirComprobante(file, reservaId, n) {
  const blob = await achicarImagen(file);
  /* La ruta lleva la fecha para que dos comprobantes de la misma reserva y el
     mismo pago no se pisen si hay que reemplazar uno. */
  const ruta = `${reservaId}/pago${n}-${Date.now()}.jpg`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/comprobantes/${ruta}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sesion?.access_token || SUPABASE_ANON_KEY}`,
      "Content-Type": "image/jpeg",
    },
    body: blob,
  });
  if (!r.ok) throw new Error("No se pudo subir el comprobante");
  return ruta;
}

/* El bucket es privado: para ver la foto hay que pedir una URL firmada, que
   caduca. Por eso se guarda la ruta y no la URL. */
async function urlComprobante(ruta, segundos = 3600) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/comprobantes/${ruta}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sesion?.access_token || SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: segundos }),
  });
  if (!r.ok) throw new Error("No se pudo abrir el comprobante");
  const d = await r.json();
  const firmada = d.signedURL || d.signedUrl || "";
  // El simulador devuelve una URL de blob ya completa; Supabase, una ruta.
  return firmada.startsWith("|SIM|")
    ? firmada.slice(5) : `${SUPABASE_URL}/storage/v1${firmada}`;
}

/* ------------------------------------------------------------ Utilidades -- */
const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clp = (n) => "$" + Math.round(n).toLocaleString("es-CL");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* La rueda del raton sobre un campo numerico enfocado le cambia el valor. Al
   desplazarse por la pagina se termina alterando el numero de personas sin
   darse cuenta, y con el el precio. Se desactiva. */
document.addEventListener("wheel", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === "number"
      && document.activeElement === e.target) e.target.blur();
}, { passive: true });

/* Fechas SIN zona horaria. Todo lo de aqui son dias de calendario, no
   instantes: usar Date con hora provoca que en Chile un bloqueo del dia 20 se
   guarde como 19. Se trabaja con 'YYYY-MM-DD' y se compara como texto. */
const iso = (a, m, d) => `${a}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const hoyISO = () => { const h = new Date(); return iso(h.getFullYear(), h.getMonth(), h.getDate()); };
const sumarDias = (s, n) => {
  const [a, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const nochesEntre = (a, b) => (new Date(b) - new Date(a)) / 86400000;
/* La semana parte en lunes. getDay() devuelve 0 para domingo, de ahi el +6 %7. */
const lunesDe = (f) => sumarDias(f, -((new Date(f + "T00:00:00").getDay() + 6) % 7));
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
/* Sin fecha devuelven cadena vacia en vez de reventar. Las dos se llaman desde
   dentro de plantillas largas, y ahi una excepcion no deja un dato en blanco:
   se lleva por delante la ficha entera y no se abre nada. */
const fechaCorta = (s) => { if (!s) return ""; const p = s.split("-").map(Number); return `${p[2]} ${MESES[p[1] - 1]}`; };
/* Con dia de la semana: mirando un dia suelto, "viernes 22" ubica mucho mas
   rapido que "22 ago" — la pregunta del cliente casi siempre viene en fines de
   semana, no en numeros. */
const fechaLarga = (s) => {
  if (!s) return "";
  const p = s.split("-").map(Number);
  const t = new Date(p[0], p[1] - 1, p[2])
    .toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/* Vista de conjunto. Que una cabana este ocupada no significa que no haya
   disponibilidad: son tres inventarios independientes, y la pregunta real
   ("me queda algo ese fin de semana?") no se responde mirando una sola. */
const TODAS = "__todas";

/* Canales de venta. Los iconos van embebidos en el archivo, no traidos de un
   CDN: el panel se usa en la montana y una imagen que no carga deja la lista
   sin la informacion que mas rapido se lee. */
const ICONO = {
  whatsapp: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 004.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.8 14.16c-.24.68-1.42 1.31-1.97 1.39-.5.07-1.14.1-1.84-.12-.42-.13-.97-.31-1.67-.61-2.94-1.27-4.86-4.23-5-4.43-.15-.2-1.2-1.59-1.2-3.03s.76-2.15 1.03-2.45c.27-.29.58-.36.78-.36h.56c.18 0 .42-.07.66.5.24.59.83 2.03.9 2.18.07.15.12.32.02.51-.1.2-.15.32-.29.49l-.44.51c-.15.15-.3.31-.13.6.17.29.76 1.25 1.63 2.03 1.12 1 2.06 1.31 2.35 1.46.29.15.46.12.63-.07.17-.2.73-.85.92-1.14.2-.29.39-.24.66-.15.27.1 1.7.8 1.99.95.29.15.49.22.56.34.07.12.07.71-.17 1.4z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.2" fill="#fff" stroke="none"/></svg>',
  airbnb: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-1 0-1.6.7-2.1 1.7C8.3 7.6 5 14 4 16.6c-.5 1.3.4 2.6 1.8 2.6 1.4 0 2.9-1 3.9-2.2l2.3-2.8 2.3 2.8c1 1.2 2.5 2.2 3.9 2.2 1.4 0 2.3-1.3 1.8-2.6C19 14 15.7 7.6 14.1 4.7 13.6 3.7 13 3 12 3z"/></svg>',
  directo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  /* Un globo y no un carrito ni una tarjeta: el canal es "entro por la pagina",
     no "pago con tarjeta". El medio de pago es otro eje. */
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3a14 14 0 000 18 14 14 0 000-18z"/></svg>',
  otro: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 113.2 2.4c-.5.2-.7.6-.7 1.1v.5"/><circle cx="12" cy="17" r=".6" fill="#fff"/></svg>',
};
/* Escoba, dibujada aqui y no traida de una libreria de iconos: es un solo trazo
   y una silueta, y a 11px un icono con detalle se convierte en una mancha.
   Mango a trazo, cabeza rellena — el relleno es lo que se lee a ese tamaño. */
const ESCOBA = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 2v8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
  '<path d="M7.5 10h9l2.5 5.5h-14z" fill="currentColor"/>' +
  '<path d="M8 17v4.5M12 17v4.5M16 17v4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>' +
  '</svg>';

/* `web` es el que reserva y PAGA solo, sin que nadie conteste nada. La base ya
   lo guardaba —`solicitar_reserva` escribe canal='web'— pero no estaba en esta
   lista, y como el bloque de canales filtra por ella, esas reservas
   desaparecian del panel sin dejar rastro: ni en "Otro" salian. Justo el canal
   que mas interesa vigilar era el unico invisible. */
const CANALES = [
  { id: "web",       nombre: "Web" },
  { id: "whatsapp",  nombre: "WhatsApp" },
  { id: "instagram", nombre: "Instagram" },
  { id: "airbnb",    nombre: "Airbnb" },
  { id: "directo",   nombre: "Directo" },
];
/* Los que se pueden marcar a mano al anotar una reserva. `web` queda fuera a
   proposito: lo escribe `solicitar_reserva` cuando el cliente reserva y paga
   solo desde la pagina. Si se pudiera elegir a mano, alguien acabaria marcando
   "Web" una reserva que entro por telefono, y el canal dejaria de servir para
   lo unico para lo que existe: saber que trae clientes de verdad. */
const CANALES_A_MANO = CANALES.filter((c) => c.id !== "web");

const insignia = (canal) => canal
  ? `<span class="insignia ${canal}" title="${canal}">${ICONO[canal] || ICONO.otro}</span>` : "";

/* Cuanto le queda a una reserva pendiente antes de soltar las fechas.
   Se calcula al pintar y no se guarda: un minuto guardado envejece. */
function minutosPara(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

/* La etiqueta que distingue lo pagado de lo que todavia no lo esta. Es la
   diferencia entre una fecha vendida y una que puede volver a estar libre en
   media hora, y sin verla rechazarias a un cliente por una reserva que no
   existe. */
function avisoPendiente(b) {
  if (!b || b.estado !== "pendiente") return "";
  const min = minutosPara(b.expira_at);
  const texto = min === null ? "sin pagar"
    : min <= 0 ? "pago no llego"
    : `sin pagar &middot; ${min} min`;
  return ` <span class="etiqueta-pendiente">${texto}</span>`;
}

/* ---------------------------------------------------------------- Estado -- */
const st = {
  cabanas: [], reglas: null, tarifaBase: null,
  cabanaSel: null,
  vista: "mes",               // "mes" (cuadricula) o "semana" (lista vertical)
  anio: new Date().getFullYear(),
  mes:  new Date().getMonth(),
  semanaIni: lunesDe(hoyISO()),   // lunes de la semana a la vista
  bloqueos: [],
  hoy: [],                    // movimiento del dia, independiente del mes a la vista
  pellet: [], lugares: [],    // sacos y los lugares que los consumen (incluye la casa)
  hoyAbierta: null,           // id de la fila desplegada en "Hoy"
  desde: null, hasta: null,   // seleccion de fechas en el calendario
  modo: "ver",                // "ver" = mirando el dia; "reservar" = eligiendo rango
  eleccion: null,             // cabana elegida en el paso 1
  canal: null,                // canal al EDITAR una reserva existente
  nueva: null,                // datos del alta en curso, paso a paso
  paso: 0,
  /* Precios ya cotizados, para el gráfico del año. La clave lleva todo lo que
     mueve el precio, así que editar una reserva invalida solo la suya. Los
     PAGOS no entran en la clave a propósito: se releen enteros cada vez. */
  cotiz: new Map(),
};

/* ----------------------------------------------------------------- Datos -- */
async function cargarBase() {
  const [cabanas, reglas, tarifas] = await Promise.all([
    /* Solo lo ARRENDABLE. La casa del anfitrión existe en `cabanas` porque
       consume pellet como cualquier otra, pero no se vende: si entrara aquí
       aparecería en el calendario, en el cotizador y en el conteo de "cuántas
       quedan libres". El pellet la pide aparte. */
    api("cabanas?select=*&activa=eq.true&arrienda=eq.true&order=orden"),
    api("reglas?select=*&id=eq.1"),
    api("tarifas?select=*&activa=eq.true&desde=is.null&hasta=is.null&limit=1"),
  ]);
  st.cabanas    = cabanas;
  st.reglas     = reglas[0];
  st.tarifaBase = tarifas[0];
  st.cabanaSel  = st.cabanaSel || TODAS;
}

/* Las columnas se piden explicitas y en un solo sitio: con `select=*` una
   columna nueva en la base entra sola, y una que se renombre rompe en silencio
   una de las dos consultas y no la otra. */
const COLUMNAS = "id,cabana_id,desde,hasta,origen,tipo,canal,nombre,telefono,email," +
  // `tinaja_fecha` viaja pegada a `tinaja_hora`: una estadia de varias noches
  // no dice por si sola que noche se usa la tinaja. Sin pedirla, la reserva
  // llegaba con `tinaja` en true y sin fecha — el turno no salia en Finanzas y
  // la ficha reventaba al intentar pintarlo.
  "adultos,ninos,mascotas,tinaja,tinaja_fecha,tinaja_hora,nota," +
  // Una reserva que entro por la web nace 'pendiente' y ocupa el calendario
  // solo hasta `expira_at`, mientras el cliente paga. Sin traer estas dos
  // columnas, el panel la mostraria igual que una pagada y contarias con una
  // reserva que puede evaporarse en media hora.
  "estado,expira_at,pago_medio,pago_ref," +
  "pago1_at,pago1_monto,pago1_comprobante," +
  "pago2_at,pago2_monto,pago2_comprobante";

async function cargarBloqueos() {
  /* Se piden con margen a cada lado: un bloqueo que empieza el 28 de un mes y
     termina el 3 del siguiente tiene que pintarse en los dos. */
  const ini = iso(st.anio, st.mes, 1);
  const desde = sumarDias(ini, -40), hasta = sumarDias(ini, 70);
  const filtro = st.cabanaSel === TODAS
    ? "" : `&cabana_id=eq.${encodeURIComponent(st.cabanaSel)}`;
  st.bloqueos = await api(
    "bloqueos?select=" + COLUMNAS +
    filtro + `&desde=lt.${hasta}&hasta=gt.${desde}&order=desde`);
}

/* El movimiento de hoy se pide aparte del mes. Si dependiera de `st.bloqueos`,
   bastaria con adelantar el calendario dos meses para que la seccion de hoy se
   vaciara sin que pase nada raro en pantalla — y es justo la que no puede
   mentir. `hasta=gte` incluye a los que se van hoy: ya no duermen, pero todavia
   estan en la cabana hasta las 11. */
async function cargarHoy() {
  const hoy = hoyISO();
  st.hoy = await api(
    "bloqueos?select=" + COLUMNAS + `&desde=lte.${hoy}&hasta=gte.${hoy}&order=desde`);
}

const bloqueosDe = (dia) => st.bloqueos.filter((b) => dia >= b.desde && dia < b.hasta);
const bloqueoDe  = (dia) => bloqueosDe(dia)[0];

/* Cuantas de las 3 quedan libres ese dia. Solo tiene sentido en la vista de
   conjunto; con una cabana seleccionada la respuesta es 0 o 1 y no aporta. */
const libresEn = (dia) => st.cabanas.length - new Set(bloqueosDe(dia).map((b) => b.cabana_id)).size;
const nombreCabana = (id) => st.cabanas.find((c) => c.id === id)?.nombre || id;
/* "4 adultos, 2 niños y 1 mascota". Estaba escrito a mano en cuatro sitios y
   cada vez que se agrega algo —los niños primero, ahora las mascotas— habia que
   acordarse de los cuatro. */
const textoHuespedes = (b) => {
  const p = [];
  if (b.adultos)  p.push(`${b.adultos} adulto${b.adultos === 1 ? "" : "s"}`);
  if (b.ninos)    p.push(`${b.ninos} niño${b.ninos === 1 ? "" : "s"}`);
  if (b.mascotas) p.push(`${b.mascotas} mascota${b.mascotas === 1 ? "" : "s"}`);
  if (!p.length) return "";
  return p.length === 1 ? p[0] : p.slice(0, -1).join(", ") + " y " + p[p.length - 1];
};

/* Como la conoce el personal de aseo. Es un dato de la cabaña, no una etiqueta
   de la vista, y no coincide con el orden en que se muestran. */
const numeroCabana = (id) => {
  const n = st.cabanas.find((c) => c.id === id)?.numero;
  return n ? `Cabaña ${n}` : nombreCabana(id);
};

/* ------------------------------------------------------------------ Hoy -- */
/* Tres grupos, en el orden en que importan durante el dia: primero quien llega
   (hay que tener la cabana lista), despues quien se va (hay que limpiarla), y
   al final quien sigue alojado. */
function pintarHoy() {
  const hoy = hoyISO();
  $("#titulo-hoy").textContent = `Hoy · ${fechaLarga(hoy)}`;

  const llegan   = st.hoy.filter((b) => b.desde === hoy);
  const sevan    = st.hoy.filter((b) => b.hasta === hoy);
  const sequedan = st.hoy.filter((b) => b.desde < hoy && b.hasta > hoy);
  const ocupadas = new Set(st.hoy.filter((b) => b.hasta > hoy).map((b) => b.cabana_id)).size;

  if (!llegan.length && !sevan.length && !sequedan.length) {
    $("#movimiento-hoy").innerHTML =
      `<div class="tarjeta"><p class="ninguna">Sin movimiento hoy.` +
      ` Las ${st.cabanas.length} cabañas libres.</p></div>`;
    return;
  }

  /* Cada grupo es su propia caja, con su color en el canto. Quien llega y quien
     se va son dos tareas distintas del dia: en una sola lista corrida hay que
     releer el encabezado para saber en cual se esta. */
  const grupo = (clave, titulo, lista, hora) => lista.length ? `
    <div class="tarjeta grupo-hoy ${clave}">
    <p class="titulo-ocupadas">${titulo}${hora ? ` &middot; ${hhmm(hora)}` : ""}</p>
    ${lista.map((b) => {
      const canal = b.canal || (b.origen === "airbnb" ? "airbnb" : null);
      const quien = b.tipo === "bloqueo"
        ? '<span style="color:var(--tx-2)">Bloqueo</span>'
        : esc(b.nombre || "Reserva");
      const gente = textoHuespedes(b) || null;
      /* Aqui NO se abre ventana: la fila se despliega hacia abajo. Es la
         seccion que se consulta de pasada, muchas veces al dia, y una ventana
         que hay que cerrar para seguir mirando estorba mas de lo que muestra. */
      const abierta = st.hoyAbierta === b.id;
      return `<button type="button" class="fila-reserva${abierta ? " abierta" : ""}"
                      data-desplegar="${b.id}" aria-expanded="${abierta}"
                      data-pagos="${b.tipo === "bloqueo" ? 0 : mitadesPagadas(b)}">
        <span>
          ${insignia(canal)}<b>${quien}</b>
          <br><span style="font-size:12.5px">${esc(nombreCabana(b.cabana_id))}</span>
          ${gente ? `<br><span style="color:var(--tx-3);font-size:12px">${gente}</span>` : ""}
          ${b.nota ? `<br><span style="color:var(--tx-3);font-size:12px">${esc(b.nota)}</span>` : ""}
        </span>
        <span class="flecha">&rsaquo;</span>
      </button>
      ${abierta ? `<div class="detalle-hoy">
        ${detalleReserva(b, `precio-hoy-${b.id}`, { sinCabana: true, sinNota: true })}
        ${b.origen === "airbnb" ? "" :
          `<button type="button" class="editar-hoy" data-editar="${b.id}">Editar</button>`}
      </div>` : ""}`;
    }).join("")}</div>` : "";

  $("#movimiento-hoy").innerHTML =
    grupo("llegan",   "Llegan hoy", llegan,   st.reglas?.check_in) +
    grupo("sevan",    "Se van hoy", sevan,    st.reglas?.check_out) +
    grupo("sequedan", "Se quedan",  sequedan) +
    `<p class="pie-hoy">${ocupadas} de ${st.cabanas.length} cabañas ocupadas esta noche</p>`;

  /* El precio se pide despues de pintar, y solo de la fila abierta. */
  const abierta = st.hoy.find((b) => b.id === st.hoyAbierta);
  if (abierta && abierta.tipo !== "bloqueo" && abierta.adultos)
    cotizarFicha(abierta, `#precio-hoy-${abierta.id}`);
}

$("#movimiento-hoy").addEventListener("click", (e) => {
  if (accionReserva(e)) return;
  const id = e.target.closest("[data-desplegar]")?.dataset.desplegar;
  if (!id) return;
  st.hoyAbierta = st.hoyAbierta === id ? null : id;   // volver a tocarla la pliega
  pintarHoy();
});

/* ---------------------------------------------------------------- Aseos -- */
/* La lista de quien cuida las cabañas. No es un calendario: es lo que hay que
   limpiar y cuando, de hoy en adelante.

   Solo se destaca una cosa: la cabaña que ese mismo dia tiene salida Y entrada.
   No es un problema, es una CONDICION del dia — se van a las 11, llegan a las
   16, y el aseo entra en esa ventana. Los demas dias no llevan marca ninguna:
   marcar todo es no marcar nada, y una lista de avisos que siempre avisan deja
   de leerse a la semana. */
const DIAS_ASEO = 30;

function pintarAseos() {
  pintarTimelineAseos();
  pintarListaAseos();
}

/* La misma rejilla de la agenda, con otra pregunta encima. Aqui las reservas no
   son el tema —van en gris, solo situan— y lo que se destaca son los dias de
   aseo: marcados los que hay, y mas marcados los que ademas tienen entrada ese
   mismo dia.

   Es un segundo timeline y no un parametro del primero a proposito: comparten
   la rejilla (las clases `tl-*`) pero no el contenido, y meterlos en una sola
   funcion con un modo terminaria en una maraña de condicionales para dos vistas
   que responden preguntas distintas. */
function pintarTimelineAseos() {
  const hoy = hoyISO();
  const ini = hoy;
  const total = DIAS_ASEO;
  const dias = Array.from({ length: total }, (_, i) => sumarDias(ini, i));
  const finExcl = sumarDias(dias[total - 1], 1);
  const cabanas = st.cabanas;

  const aseoDe = (cab, dia) => {
    const sale  = st.bloqueos.some((b) => b.cabana_id === cab && b.hasta === dia);
    if (!sale) return null;
    const entra = st.bloqueos.some((b) => b.cabana_id === cab && b.desde === dia);
    return entra ? "doble" : "simple";
  };

  const cabecera = `
    <div class="tl-fila tl-cabecera">
      <div class="tl-rotulo"></div>
      ${dias.map((f) => {
        const d = new Date(f + "T00:00:00");
        const hay = cabanas.map((c) => aseoDe(c.id, f)).filter(Boolean);
        const cl = ["tl-dia"];
        if (f === hoy) cl.push("es-hoy");
        if (hay.includes("doble")) cl.push("aseo-doble");
        else if (hay.length)       cl.push("aseo-hay");
        if (d.getDate() === 1) cl.push("cambia-mes");
        return `<div class="${cl.join(" ")}">
          <span class="tl-dow">${d.getDate() === 1
            ? d.toLocaleDateString("es-CL", { month: "short" }).replace(".", "")
            : d.toLocaleDateString("es-CL", { weekday: "short" }).slice(0, 3)}</span>
          <span class="tl-num">${d.getDate()}</span>
        </div>`;
      }).join("")}
    </div>`;

  const filas = cabanas.map((c) => {
    const suyas = st.bloqueos.filter((b) =>
      b.cabana_id === c.id && b.desde < finExcl && b.hasta > ini);

    const marcas = dias.map((f, i) => {
      const tipo = aseoDe(c.id, f);
      if (!tipo) return "";
      return `<div class="aseo-marca ${tipo}" style="grid-column:${i + 2}"
                   title="${tipo === "doble" ? "Aseo el mismo día" : "Hay que limpiarla"}">${ESCOBA}</div>`;
    }).join("");

    /* El rotulo lleva el nombre, igual que en la agenda: es el mismo rotulo de
       la misma rejilla y cambiarlo aqui obligaria a traducir entre dos vistas.
       El numero va en las barras, que es donde hace falta. */
    return `<div class="tl-fila tl-datos">
      <div class="tl-rotulo"><span>${esc(c.nombre.replace(/^Cabaña /, ""))}</span></div>
      ${suyas.map((b) => {
        const cortadaIni = b.desde < ini;
        const cortadaFin = b.hasta > finExcl;
        const arranca = cortadaIni ? ini : b.desde;
        const ter = cortadaFin ? finExcl : b.hasta;
        const col = nochesEntre(ini, arranca) + 2;
        const tramo = Math.max(1, nochesEntre(arranca, ter) + (cortadaFin ? 0 : 1));
        const cl = ["tl-barra", "gris"];
        if (cortadaIni) cl.push("viene");
        if (cortadaFin) cl.push("sigue");
        /* Sin nombres de huéspedes: a quien limpia no le sirve saber quién es,
           le sirve saber qué cabaña y cuándo. La barra dice la cabaña. */
        return `<div class="${cl.join(" ")}" style="grid-column:${col} / span ${tramo}">
          <span class="tl-nombre">${b.tipo === "bloqueo" ? "Bloqueo" : esc(numeroCabana(c.id))}</span>
        </div>`;
      }).join("")}
      ${marcas}
    </div>`;
  }).join("");

  $("#tl-aseos").innerHTML =
    `<div class="tl"><div class="tl-cuerpo" style="--n-dias:${total}">${cabecera}${filas}</div></div>
     <div class="leyenda tl-leyenda">
       <span><i class="aseo-m simple">${ESCOBA}</i>Hay que limpiar</span>
       <span><i class="aseo-m doble">${ESCOBA}</i>Ese mismo día</span>
     </div>`;
}

function pintarListaAseos() {
  const hoy = hoyISO();
  const limite = sumarDias(hoy, DIAS_ASEO);
  const salidas = st.bloqueos
    .filter((b) => b.hasta >= hoy && b.hasta <= limite)
    .sort((a, b) => a.hasta.localeCompare(b.hasta));

  if (!salidas.length) {
    $("#lista-aseos").innerHTML =
      `<div class="tarjeta"><p class="lista-vacia">Sin salidas en los próximos ${DIAS_ASEO} días.</p></div>`;
    return;
  }

  /* Agrupadas por dia: un dia con dos salidas es una sola ida a limpiar. */
  const porDia = {};
  for (const b of salidas) (porDia[b.hasta] ||= []).push(b);

  const ci = hhmm(st.reglas?.check_in  || "16:00");
  const co = hhmm(st.reglas?.check_out || "11:00");

  $("#lista-aseos").innerHTML = Object.entries(porDia).map(([dia, lista]) => {
    const urgentes = lista.filter((b) =>
      st.bloqueos.some((x) => x.cabana_id === b.cabana_id && x.desde === dia));

    return `<div class="tarjeta aseo-dia${urgentes.length ? " urgente" : ""}">
      <div class="aseo-cabecera">
        <b>${fechaLarga(dia)}</b>
      </div>
      ${lista.map((b) => {
        const entra = st.bloqueos.some((x) => x.cabana_id === b.cabana_id && x.desde === dia);
        /* Ni un nombre de huésped en toda la sección: quien limpia necesita la
           cabaña y la hora, y saber quién dormía ahí no cambia nada de su
           trabajo. Además evita pasear los datos del cliente por una pantalla
           que abre otra persona. */
        return `<div class="aseo-linea${entra ? " aprieta" : ""}">
          <b>${esc(numeroCabana(b.cabana_id))}</b>
          <span class="aseo-cab">${esc(nombreCabana(b.cabana_id).replace(/^Cabaña /, ""))}</span>
          <span class="aseo-mov">Sale a las ${co}${entra ? ` &middot; entra a las ${ci}` : ""}</span>
          ${entra ? `<p class="aseo-aviso">Hay que limpiarla este mismo día</p>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  }).join("");
}

/* -------------------------------------------------------------- Finanzas -- */
/* Cuanto entro y por donde. Dos cifras distintas que la mayoria de los paneles
   mezclan en una: lo que YA esta en la cuenta y lo que todavia falta cobrar.
   Confundirlas es lo que hace creer que un mes fue bueno cuando la mitad
   todavia no llega.

   Una reserva se cuenta en el mes de su ENTRADA. Es la convencion habitual y la
   unica que no parte una estadia que cruza de mes. */
/* Los doce meses del año, cotizados. Se piden aparte de `st.bloqueos`, que
   solo cubre una ventana de ~110 días alrededor del mes a la vista: con esa
   ventana el gráfico mentiría en todos los meses salvo tres.
   Las filas se releen SIEMPRE (un pago nuevo tiene que verse al instante); lo
   que se cachea es la cotización, que es la parte cara. */
/* La clave de `st.cotiz`. Vive aqui fuera y no dentro de `totalesDelAnio`
   porque la usan dos sitios: el que llena la cache y el que la lee. Con una
   copia en cada lado, cambiar los campos en uno solo dejaria de encontrar las
   cotizaciones sin dar ningun error: los totales apareceran en cero. */
const claveCotiz = (b) =>
  [b.id, b.cabana_id, b.desde, b.hasta, b.adultos, b.ninos, b.tinaja].join("|");

/* Lo efectivamente cobrado de una reserva. Un monto sin su fecha NO cuenta:
   `pago1_monto` puede estar escrito mientras `pago1_at` sigue vacio —el panel
   deja anotar el monto antes de marcarlo pagado— y sumarlo diria que entro
   plata que nadie ha visto. */
const pagado = (b) =>
  (b.pago1_at ? b.pago1_monto || 0 : 0) + (b.pago2_at ? b.pago2_monto || 0 : 0);

async function totalesDelAnio(anio) {
  const filtro = st.cabanaSel === TODAS
    ? "" : `&cabana_id=eq.${encodeURIComponent(st.cabanaSel)}`;
  const reservas = await api(
    "bloqueos?select=" + COLUMNAS + filtro +
    `&tipo=neq.bloqueo&desde=gte.${anio}-01-01&desde=lte.${anio}-12-31&order=desde`);

  /* De a seis, no las cien de golpe: cotizar es una llamada por reserva y un
     teléfono con datos móviles no aguanta esa avalancha. */
  const faltan = reservas.filter((b) => !st.cotiz.has(claveCotiz(b)));
  for (let i = 0; i < faltan.length; i += 6) {
    await Promise.all(faltan.slice(i, i + 6).map(async (b) => {
      try {
        const c = await api("rpc/cotizar", { method: "POST", body: JSON.stringify({
          p_cabana: b.cabana_id, p_entrada: b.desde, p_salida: b.hasta,
          p_adultos: b.adultos || 1, p_ninos: b.ninos || 0, p_tinaja: !!b.tinaja })});
        st.cotiz.set(claveCotiz(b), c?.ok ? c.total : null);
      } catch { st.cotiz.set(claveCotiz(b), null); }
    }));
  }

  const meses = Array.from({ length: 12 }, () =>
    ({ total: 0, cobrado: 0, pendiente: 0, reservas: 0, sinCotizar: 0 }));
  for (const b of reservas) {
    const m = meses[+b.desde.slice(5, 7) - 1];
    const t = st.cotiz.get(claveCotiz(b));
    m.reservas++;
    if (t == null) { m.sinCotizar++; continue; }   // sin precio no suma: mejor faltar que mentir
    m.total   += t;
    m.cobrado += (b.pago1_at ? b.pago1_monto || 0 : 0) + (b.pago2_at ? b.pago2_monto || 0 : 0);
  }
  for (const m of meses) m.pendiente = Math.max(0, m.total - m.cobrado);
  return meses;
}

const MES_CORTO = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

/* Techo redondo por encima del mes más alto. Sin esto la línea de arriba cae
   en cifras como $4.742.797, que no se leen de un vistazo. */
function techoBonito(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) if (v <= k * p) return k * p;
  return 10 * p;
}
const clpCorto = (n) =>
  n >= 1e6 ? `$${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

/* El año en barras. Solo el mes elegido enseña el corte entre lo cobrado y lo
   que falta: doce barras partidas a la vez no se comparan, se descifran.
   La barra tiene SIEMPRE la misma geometría, seleccionada o no —lo pendiente
   está dibujado igual, solo transparente—, y así elegir otro mes no reconstruye
   nada: se desvanece un recorte y aparece otro. Es lo que permite animarlo. */
const altoBarra = (m, tope) => (tope ? (m.total / tope) * 100 : 0).toFixed(2);
const altoPend  = (m) => (m.total ? (m.pendiente / m.total) * 100 : 0).toFixed(2);

function graficoAnual(meses, anio, mesSel) {
  const tope = techoBonito(Math.max(...meses.map((m) => m.total)));

  const cols = meses.map((m, i) => {
    const sel = i === mesSel;
    const nombre = new Date(anio, i, 1).toLocaleDateString("es-CL", { month: "long" });
    return `<button type="button" class="gr-col${sel ? " es" : ""}" data-mes="${i}"
              aria-pressed="${sel}" aria-label="${nombre}: ${clp(m.total)}">
        <span class="gr-barra" aria-hidden="true">
          <span class="gr-cuerpo" style="height:${altoBarra(m, tope)}%">
            <span class="gr-pend" style="height:${altoPend(m)}%"></span>
          </span>
        </span>
        <span class="gr-mes">${MES_CORTO[i]}</span>
      </button>`;
  }).join("");

  return `<div class="gr" data-anio="${anio}">
      <div class="gr-cab"><span>${anio}</span><span>${clpCorto(tope)}</span></div>
      <div class="gr-pista">
        <div class="gr-lienzo">
          <div class="gr-rejilla" aria-hidden="true"></div>
          <div class="gr-cols" role="group" aria-label="Ingresos por mes">${cols}</div>
        </div>
      </div>
    </div>`;
}

/* Actualiza el gráfico ya dibujado en vez de rehacerlo. Rehacerlo era lo que
   hacía que cambiar de mes fuera un corte seco: un nodo nuevo no tiene estado
   anterior desde el que interpolar, así que el navegador no puede animar nada. */
function actualizarGrafico(gr, meses, mesSel) {
  const tope = techoBonito(Math.max(...meses.map((m) => m.total)));
  gr.querySelector(".gr-cab span:last-child").textContent = clpCorto(tope);
  gr.querySelectorAll(".gr-col").forEach((col) => {
    const i = +col.dataset.mes, m = meses[i];
    const sel = i === mesSel;
    col.classList.toggle("es", sel);
    col.setAttribute("aria-pressed", String(sel));
    col.querySelector(".gr-cuerpo").style.height = `${altoBarra(m, tope)}%`;
    col.querySelector(".gr-pend").style.height   = `${altoPend(m)}%`;
  });
}

function fichaHTML(m, titulo) {
  return `<div class="gr-ficha">
      <h3>${titulo}</h3>
      <div class="linea-detalle"><span><i class="pt cobrado"></i>Pagado</span><b>${clp(m.cobrado)}</b></div>
      <div class="linea-detalle"><span><i class="pt pendiente"></i>Por cobrar</span><b>${clp(m.pendiente)}</b></div>
      <div class="linea-detalle gr-total"><span>Total</span><b>${clp(m.total)}</b></div>
      <p class="cifra-pie">${m.reservas} reserva${m.reservas === 1 ? "" : "s"} este mes</p>
      ${m.sinCotizar ? `<p class="aseo-aviso">${m.sinCotizar} reserva(s) sin cotización válida: no suman al total.</p>` : ""}
    </div>`;
}

async function pintarFinanzas() {
  const ini = iso(st.anio, st.mes, 1);
  const fin = iso(st.anio, st.mes, new Date(st.anio, st.mes + 1, 0).getDate());
  const mes = new Date(st.anio, st.mes, 1).toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  const mesTitulo = mes.charAt(0).toUpperCase() + mes.slice(1);
  /* "agosto de 2026" -> "agosto 2026": cabe en un titulo de telefono. */
  const mesCorto = mes.replace(" de ", " ");
  $("#titulo-finanzas").textContent = "Resumen";

  /* CADA seccion dice de QUE MES habla. Antes ponia "este mes" a secas, y
     estar en el mes equivocado se veia exactamente igual que haber perdido el
     dato: Jose anoto una entrega de pellet, la vio guardada, y al volver le
     parecio que se habia borrado — estaba mirando otro mes. Un titulo que no
     se puede contrastar con nada es un titulo que miente a medias. */
  $("#titulo-pellet-mes").textContent = `Pellet por cabaña · ${mesCorto}`;
  $("#titulo-canales").textContent    = `Por dónde entró · ${mesCorto}`;
  $("#titulo-tinaja").textContent     = `Tinaja · ${mesCorto}`;

  const reservas = st.bloqueos.filter((b) =>
    b.tipo !== "bloqueo" && b.desde >= ini && b.desde <= fin);

  /* El pellet no depende de que haya reservas: la casa consume igual. */
  if (!st.pellet.length && !st.lugares.length) await cargarPellet().catch(() => {});
  pintarPellet(ini, fin, mesCorto);

  $("#tinaja-finanzas").innerHTML  = reservas.length
    ? '<p class="lista-vacia">Calculando...</p>'
    : `<p class="lista-vacia">Ningún turno de tinaja en ${mesCorto}.</p>`;
  /* Un bloque en blanco no se distingue de uno roto. Si el mes no tiene
     reservas hay que decirlo, que es un dato, no una averia. */
  if (!reservas.length) {
    $("#canales-finanzas").innerHTML =
      `<p class="lista-vacia">Ninguna reserva en ${mesCorto}.</p>`;
  }

  /* El gráfico se dibuja aunque el mes esté vacío: un mes sin reservas es un
     dato, y verlo al lado de los llenos es justamente para lo que sirve. */
  if (!$("#resumen-finanzas").querySelector(".gr"))
    $("#resumen-finanzas").innerHTML = '<p class="lista-vacia">Calculando...</p>';

  let anual;
  try {
    anual = await totalesDelAnio(st.anio);
  } catch (err) {
    $("#resumen-finanzas").innerHTML =
      `<p class="lista-vacia">No se pudo cargar el año: ${esc(err.message)}</p>`;
    anual = null;
  }

  if (anual) {
    const cont = $("#resumen-finanzas");
    const gr = cont.querySelector(`.gr[data-anio="${st.anio}"]`);
    if (gr) {
      /* Ya está dibujado: se toca lo que cambió y el resto sigue vivo. La
         ficha sí se reemplaza —son cifras distintas, no las mismas movidas—
         y entra con su propia animación. */
      actualizarGrafico(gr, anual, st.mes);
      cont.querySelector(".gr-ficha").outerHTML = fichaHTML(anual[st.mes], mesTitulo);
    } else {
      cont.innerHTML = graficoAnual(anual, st.anio, st.mes) + fichaHTML(anual[st.mes], mesTitulo);
      // el mes elegido queda a la vista sin que haya que arrastrar la pista
      cont.querySelector(".gr-col.es")?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }

  if (!reservas.length) return;

  /* La tinaja se cuenta por la FECHA DEL TURNO, no por el mes de entrada de la
     reserva: una estadia que empieza el 31 de agosto y usa la tinaja el 2 de
     septiembre generó ese ingreso en septiembre. Es la unica base que no
     atribuye una plata al mes equivocado. */
  const turnos = st.bloqueos.filter((b) =>
    b.tinaja && b.tinaja_fecha && b.tinaja_fecha >= ini && b.tinaja_fecha <= fin)
    .sort((a, b) => (a.tinaja_fecha + a.tinaja_hora).localeCompare(b.tinaja_fecha + b.tinaja_hora));
  const precioTinaja = st.reglas?.precio_tinaja ?? 0;

  $("#tinaja-finanzas").innerHTML = turnos.length
    ? `<div class="cifra-mes">${clp(turnos.length * precioTinaja)}</div>
       <p class="cifra-pie">${turnos.length} turno${turnos.length === 1 ? "" : "s"} este mes
          &middot; ${clp(precioTinaja)} cada uno</p>
       <div class="turnos-tinaja">
         ${turnos.map((b) => `<div class="linea-detalle">
           <span>${fechaCorta(b.tinaja_fecha)} &middot; ${hhmm(b.tinaja_hora)}</span>
           <span>${esc(nombreCabana(b.cabana_id))}</span>
         </div>`).join("")}
       </div>`
    : `<p class="lista-vacia">Ningún turno de tinaja en ${mesCorto}.</p>`;

  /* Por canal: cuantas y cuanta plata. El conteo es el dato por el que existe
     todo esto —saber que anuncio trae clientes— y el monto es el que dice si
     ese canal ademas trae los buenos.

     ESTO NO SE VEIA NUNCA. `conTotal` se usaba sin haberlo declarado en ningun
     sitio, asi que la funcion reventaba con un ReferenceError justo aqui: el
     pellet y la tinaja alcanzaban a pintarse —van antes— y el bloque de canales
     se quedaba en blanco para siempre. Un bloque vacio no se distingue de uno
     que no tiene datos, y por eso el fallo aguanto sin que nadie lo mirara.

     El total sale de `st.cotiz`, la cache que llena el grafico anual unas
     lineas mas arriba. Las que no tengan cotizacion se quedan fuera en vez de
     contarse como cero: una reserva sin precio no es una reserva gratis. */
  const conTotal = reservas
    .map((b) => ({ b, total: st.cotiz.get(claveCotiz(b)) }))
    .filter((x) => x.total != null);

  const porCanal = {};
  for (const x of conTotal) {
    const k = x.b.canal || (x.b.origen === "airbnb" ? "airbnb" : "otro");
    (porCanal[k] ||= { n: 0, total: 0, cobrado: 0 });
    porCanal[k].n++;
    porCanal[k].total += x.total;
    porCanal[k].cobrado += pagado(x.b);
  }

  const orden = ["web", "whatsapp", "instagram", "airbnb", "directo", "otro"];
  if (!conTotal.length) {
    $("#canales-finanzas").innerHTML = reservas.length
      ? '<p class="lista-vacia">No se pudieron cotizar las reservas del mes. Reintenta en un momento.</p>'
      : `<p class="lista-vacia">Ninguna reserva en ${mesCorto}.</p>`;
    return;
  }

  $("#canales-finanzas").innerHTML = orden
    .filter((k) => porCanal[k])
    .map((k) => {
      const c = porCanal[k];
      const nombre = CANALES.find((x) => x.id === k)?.nombre || "Otro";
      return `<div class="canal-fila">
        <div class="canal-cab">
          <span>${insignia(k)}<b>${nombre}</b></span>
          <span class="canal-n">${c.n} reserva${c.n === 1 ? "" : "s"} &middot; ${clp(c.total)}</span>
        </div>
        ${barraPlata(c.cobrado, Math.max(0, c.total - c.cobrado))}
      </div>`;
    }).join("");
}

/* ------------------------------------------------------- Anotar el pellet -- */
/* Dos ventanas separadas y no un formulario con un selector de tipo: llevar
   sacos a una cabaña y contar la bodega son dos gestos distintos —uno se hace
   al pasar, el otro cuando algo no cuadra— y juntarlos obliga a elegir un modo
   antes de poder escribir nada. */
function ventanaMoverPellet() {
  const lugares = st.lugares.length ? st.lugares : st.cabanas;
  abrirModal("Anotar sacos", "Pellet", `
    <div class="segmentado" id="pl-tipo">
      <button type="button" data-tipo="entrega" aria-selected="true">Llevé a una cabaña</button>
      <button type="button" data-tipo="compra"  aria-selected="false">Compré</button>
    </div>
    <div class="campo" id="pl-caja-destino">
      <label for="pl-destino">¿A cuál?</label>
      <select id="pl-destino">
        ${lugares.map((l) => `<option value="${l.id}">${esc(l.nombre)}</option>`).join("")}
      </select>
    </div>
    <div class="fila">
      <div class="campo">
        <label for="pl-sacos">Sacos</label>
        <input type="number" id="pl-sacos" inputmode="numeric" min="1" value="1">
      </div>
      <div class="campo">
        <label for="pl-fecha">Fecha</label>
        <input type="date" id="pl-fecha" value="${hoyISO()}">
      </div>
    </div>
    <div class="campo">
      <label for="pl-nota">Nota</label>
      <input type="text" id="pl-nota" placeholder="Opcional">
    </div>
    <div class="fila" style="margin-top:var(--e4)">
      <button type="button" class="secundario" data-cerrar>Cancelar</button>
      <button type="button" id="pl-guardar">Guardar</button>
    </div>`);

  $("#pl-tipo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tipo]");
    if (!b) return;
    $("#pl-tipo").querySelectorAll("button")
      .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("#pl-caja-destino").hidden = b.dataset.tipo === "compra";
  });

  $("#pl-guardar").addEventListener("click", async () => {
    const tipo = $("#pl-tipo [aria-selected='true']").dataset.tipo;
    const sacos = Number($("#pl-sacos").value) || 0;
    if (sacos < 1) { avisar("¿Cuántos sacos?", "error"); return; }
    await guardarPellet({
      tipo, sacos,
      destino: tipo === "entrega" ? $("#pl-destino").value : null,
      fecha: $("#pl-fecha").value || hoyISO(),
      nota: $("#pl-nota").value.trim() || null,
    }, tipo === "entrega"
      ? `${sacos} saco(s) a ${nombreLugar($("#pl-destino").value)}.`
      : `${sacos} saco(s) comprados.`);
  });
}

function ventanaContarPellet() {
  const { stock } = stockPellet();
  abrirModal("Contar la bodega", "Pellet", `
    <div class="aviso info">Anota lo que hay <b>de verdad</b> en la bodega. Desde ese
      número se vuelve a contar, así que corrige cualquier saco que se llevó sin anotar.</div>
    <div class="fila">
      <div class="campo">
        <label for="pl-hay">Sacos que hay</label>
        <input type="number" id="pl-hay" inputmode="numeric" min="0" value="${Math.max(0, stock)}">
      </div>
      <div class="campo">
        <label for="pl-hay-fecha">Fecha</label>
        <input type="date" id="pl-hay-fecha" value="${hoyISO()}">
      </div>
    </div>
    <p class="lista-vacia" style="padding:0 0 var(--e3);text-align:left">
      La cuenta actual dice ${stock}. Si no cuadra, manda lo que contaste.</p>
    <div class="fila">
      <button type="button" class="secundario" data-cerrar>Cancelar</button>
      <button type="button" id="pl-guardar-conteo">Guardar recuento</button>
    </div>`);

  $("#pl-guardar-conteo").addEventListener("click", async () => {
    const sacos = Number($("#pl-hay").value);
    if (!Number.isFinite(sacos) || sacos < 0) { avisar("Número no válido.", "error"); return; }
    await guardarPellet({
      tipo: "ajuste", sacos, destino: null,
      fecha: $("#pl-hay-fecha").value || hoyISO(), nota: null,
    }, `Bodega contada: ${sacos} saco(s).`);
  });
}

async function guardarPellet(fila, mensaje) {
  const btn = $("#pl-guardar") || $("#pl-guardar-conteo");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando..."; }
  try {
    await api("pellet", { method: "POST", body: JSON.stringify(fila) });
    await cargarPellet();
    cerrarModal();
    pintarFinanzas();
    avisar(mensaje, "ok");
  } catch (err) {
    avisar(err.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
  }
}

/* Tocar un mes del gráfico mueve TODO el panel a ese mes, no solo la ficha:
   si el calendario se quedara en agosto mientras finanzas habla de octubre,
   la siguiente decisión se toma sobre el mes equivocado. */
$("#resumen-finanzas").addEventListener("click", async (e) => {
  const col = e.target.closest(".gr-col");
  if (!col) return;
  const m = +col.dataset.mes;
  if (m === st.mes) return;

  /* La selección se mueve YA, antes de pedir nada. Esperar a que vuelva la
     consulta para mover la píldora es lo que hace que un panel se sienta
     lento aunque tarde exactamente lo mismo. */
  col.closest(".gr").querySelectorAll(".gr-col.es").forEach((x) => {
    x.classList.remove("es"); x.setAttribute("aria-pressed", "false");
  });
  col.classList.add("es"); col.setAttribute("aria-pressed", "true");
  col.scrollIntoView({ block: "nearest", inline: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  st.mes = m;
  st.semanaIni = lunesDe(iso(st.anio, st.mes, 1));
  st.desde = st.hasta = null; st.modo = "ver";
  await cargarBloqueos();
  pintarCalendario();
  pintarFinanzas();
});

$("#btn-mover-pellet").addEventListener("click", ventanaMoverPellet);
$("#btn-contar-pellet").addEventListener("click", ventanaContarPellet);

/* ---------------------------------------------------------------- Pellet -- */
/* Tres movimientos: compra (entra), entrega (sale a una cabaña) y ajuste (se
   conto la bodega y hay N). El stock se calcula desde el ultimo recuento hacia
   adelante — lo anterior ya esta incorporado en ese numero.

   Sin el recuento esto no seria usable: un stock hecho solo de sumas y restas
   se despega de la realidad al primer saco que alguien llevo sin anotar, y una
   vez despegado ya no se puede volver a creer. */
async function cargarPellet() {
  const [movs, lugares] = await Promise.all([
    api("pellet?select=id,tipo,destino,fecha,sacos,nota,creado_at&order=fecha.desc,creado_at.desc"),
    api("cabanas?select=id,nombre,arrienda,orden&activa=eq.true&order=orden"),
  ]);
  /* Se reordena aquí y no se confía en el `order` de la consulta: el cálculo
     del stock depende de cuál es el ÚLTIMO recuento, así que un orden distinto
     al esperado no da un número raro, da uno creíble y equivocado. Es la clase
     de error que no se nota hasta que la bodega no cuadra. */
  st.pellet = (movs || []).sort((a, b) =>
    (b.fecha + (b.creado_at || "")).localeCompare(a.fecha + (a.creado_at || "")));
  st.lugares = lugares || [];
}

function stockPellet() {
  const movs = st.pellet;
  const ancla = movs.find((m) => m.tipo === "ajuste");   // ya vienen ordenados desc
  const clave = (m) => `${m.fecha}|${m.creado_at || ""}`;
  const posteriores = ancla
    ? movs.filter((m) => clave(m) > clave(ancla))
    : movs;
  const suma = (t) => posteriores.filter((m) => m.tipo === t)
    .reduce((s, m) => s + m.sacos, 0);
  return {
    stock: (ancla?.sacos || 0) + suma("compra") - suma("entrega"),
    contado: ancla?.fecha || null,
  };
}

const nombreLugar = (id) => st.lugares.find((l) => l.id === id)?.nombre || id;

function pintarPellet(ini, fin, mesCorto) {
  const { stock, contado } = stockPellet();
  const cap = st.reglas?.sacos_por_pallet ?? 70;
  const precio = st.reglas?.precio_saco_pellet ?? 0;

  $("#pellet-bodega").innerHTML =
    (typeof palletHTML === "function" ? palletHTML(Math.max(0, stock), cap) : "") +
    `<div class="pellet-cifra">
       <div class="cifra-mes">${stock}</div>
       <p class="cifra-pie">saco${stock === 1 ? "" : "s"} en bodega
         &middot; ${clp(stock * precio)}${contado ? ` &middot; contada el ${fechaCorta(contado)}` : ""}</p>
     </div>`;

  /* Del mes, y solo las ENTREGAS: una compra es plata que entra a la bodega,
     no gasto de una cabaña. Mezclarlas inflaria el consumo el mes que se
     compra y lo dejaria en cero los demas. */
  const delMes = st.pellet.filter((m) =>
    m.tipo === "entrega" && m.fecha >= ini && m.fecha <= fin);

  if (!delMes.length) {
    $("#pellet-cabanas").innerHTML =
      `<p class="lista-vacia">Sin entregas en ${mesCorto || "este mes"}.</p>`;
    return;
  }

  const porLugar = {};
  for (const m of delMes) porLugar[m.destino] = (porLugar[m.destino] || 0) + m.sacos;
  const total = delMes.reduce((s, m) => s + m.sacos, 0);
  const mayor = Math.max(...Object.values(porLugar));

  $("#pellet-cabanas").innerHTML =
    `<div class="cifra-mes">${clp(total * precio)}</div>
     <p class="cifra-pie">${total} sacos entregados &middot; ${clp(precio)} cada uno</p>` +
    st.lugares.filter((l) => porLugar[l.id]).map((l) => {
      const n = porLugar[l.id];
      return `<div class="pellet-fila">
        <div class="pellet-cab">
          <span><b>${esc(l.nombre)}</b>${l.arrienda === false ? ' <span class="pellet-host">no se arrienda</span>' : ""}</span>
          <span class="canal-n">${n} saco${n === 1 ? "" : "s"} &middot; ${clp(n * precio)}</span>
        </div>
        <!-- Barra relativa a la cabaña que más gastó, no al total: con cuatro
             lugares, contra el total todas quedan cortas y no se comparan. -->
        <div class="pellet-barra"><span style="width:${Math.round((n / mayor) * 100)}%"></span></div>
      </div>`;
    }).join("");
}

/* La barra: lleno lo que esta en la cuenta, rayado lo que falta. Es la misma
   lectura que las barras de la linea de tiempo —lleno es pagado— para no tener
   que aprender dos codigos distintos. */
function barraPlata(cobrado, pendiente) {
  const t = cobrado + pendiente;
  const p = t > 0 ? Math.round((cobrado / t) * 100) : 0;
  return `<div class="barra-plata" role="img"
            aria-label="${p}% cobrado, ${100 - p}% por cobrar">
    <div class="parte cobrado" style="width:${p}%"></div>
    <div class="parte pendiente" style="width:${100 - p}%"></div>
  </div>`;
}

/* ------------------------------------------------------------ Calendario -- */
/* Dos vistas de lo mismo. La cuadricula del mes responde "que queda el 22"; la
   lista vertical de la semana responde "como viene esta semana", que es lo que
   se mira cuando hay que organizar limpiezas y llegadas. Ninguna reemplaza a la
   otra, por eso conviven en vez de elegir una. */
function pintarCalendario() {
  const semanal = st.vista === "semana";

  $("#grilla-dow").hidden   = semanal;
  $("#grilla-dias").hidden  = semanal;
  $("#lista-semana").hidden = !semanal;
  $$("[data-cal]").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.cal === st.vista)));

  if (semanal) pintarSemana(); else pintarMes();
  pintarBarra();
}

function pintarMes() {
  /* Solo la primera letra en mayuscula: `text-transform: capitalize` pondria
     "Agosto De 2026". */
  const mes = new Date(st.anio, st.mes, 1)
    .toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  $("#mes-titulo").textContent = mes.charAt(0).toUpperCase() + mes.slice(1);

  $("#grilla-dow").innerHTML =
    ["L","M","M","J","V","S","D"].map((d) => `<div class="dow">${d}</div>`).join("");

  // getDay() devuelve 0 para domingo; aca la semana parte en lunes.
  const offset = (new Date(st.anio, st.mes, 1).getDay() + 6) % 7;
  const dias   = new Date(st.anio, st.mes + 1, 0).getDate();
  const hoy    = hoyISO();
  const conjunto = st.cabanaSel === TODAS;

  let html = "";
  for (let i = 0; i < offset; i++) html += '<div class="dia vacio"></div>';

  for (let d = 1; d <= dias; d++) {
    const f = iso(st.anio, st.mes, d);
    const clases = ["dia"];
    let interior = String(d);

    if (f < hoy)   clases.push("pasado");
    if (f === hoy) clases.push("hoy");

    if (conjunto) {
      /* Tres estados, no dos: libre, algunas tomadas, todas tomadas. Pintar
         "ocupado" en cuanto cae una seria mentir: quedan dos por vender. */
      const libres = libresEn(f);
      clases.push("multi");
      if (libres === 0) clases.push("ocupado");
      else if (libres < st.cabanas.length) clases.push("parcial");
      if (libres < st.cabanas.length)
        interior = `${d}<span class="libres">${libres} libre${libres === 1 ? "" : "s"}</span>`;
      /* El rango se marca con borde, no con fondo: pintarlo taparia justo el
         dato que se esta mirando. */
      if (st.desde && st.hasta && f >= st.desde && f < st.hasta) clases.push("rango-multi");
    } else {
      const b = bloqueoDe(f);
      if (b) clases.push(b.origen === "airbnb" ? "airbnb" : "ocupado");
      if (st.desde && st.hasta && f >= st.desde && f < st.hasta) clases.push("rango");
    }

    if (st.desde && !st.hasta && f === st.desde) clases.push("sel");
    html += `<button type="button" class="${clases.join(" ")}" data-f="${f}">${interior}</button>`;
  }
  $("#grilla-dias").innerHTML = html;

  $("#leyenda-una").hidden      = conjunto;
  $("#leyenda-conjunto").hidden = !conjunto;
}

/* Linea de tiempo: una fila por cabaña, una columna por dia, y cada estadia es
   una barra que abarca sus noches. Reemplazo la lista vertical anterior porque
   dice lo mismo en un quinto del alto y ademas muestra algo que la lista no
   podia: la CONTINUIDAD. Ver que Carol Rios ocupa del 13 al 16 de un vistazo no
   es lo mismo que leerla repetida en tres dias sueltos.

   Las columnas van anchas y la fila se desplaza en horizontal. Apretadas a
   ancho de pantalla darian 45px por dia, donde no cabe un nombre; el
   desplazamiento nativo ya trae inercia y rebote en el borde, asi que no hay
   nada que reimplementar.

   El recorrido es CONTINUO por todo el mes, no de semana en semana. Cortarlo en
   semanas obligaba a saltar justo donde suele caer una estadia —un fin de
   semana largo cruza el corte— y partia la barra en dos vistas. Se dibuja el
   mes entero, completado hasta lunes y domingo por los dos extremos para que no
   empiece a mitad de semana, y las flechas mueven de mes. */
const COL_PX = 76;

function pintarSemana() {
  const hoy = hoyISO();
  const cabanas = st.cabanaSel === TODAS
    ? st.cabanas : st.cabanas.filter((c) => c.id === st.cabanaSel);

  /* Ventana: del lunes de la semana del dia 1 al domingo de la semana del
     ultimo dia. Asi el mes entra completo y el recorrido no se corta. */
  const primero = iso(st.anio, st.mes, 1);
  const ultimo  = iso(st.anio, st.mes, new Date(st.anio, st.mes + 1, 0).getDate());
  const ini     = lunesDe(primero);
  const fin     = sumarDias(lunesDe(ultimo), 6);
  const total   = nochesEntre(ini, fin) + 1;
  const dias    = Array.from({ length: total }, (_, i) => sumarDias(ini, i));
  const finExcl = sumarDias(fin, 1);

  const mes = new Date(st.anio, st.mes, 1)
    .toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  $("#mes-titulo").textContent = mes.charAt(0).toUpperCase() + mes.slice(1);

  const cabecera = `
    <div class="tl-fila tl-cabecera">
      <div class="tl-rotulo"></div>
      ${dias.map((f) => {
        const d = new Date(f + "T00:00:00");
        const cl = ["tl-dia"];
        if (f === hoy) cl.push("es-hoy");
        if (f < hoy)   cl.push("pasado");
        /* Los dias de relleno de los meses vecinos van apagados: la ventana los
           incluye para no empezar a mitad de semana, no porque sean del mes. */
        if (f < primero || f > ultimo) cl.push("de-otro-mes");
        if (d.getDate() === 1) cl.push("cambia-mes");
        if (st.desde && !st.hasta && f === st.desde) cl.push("sel");
        if (st.desde && st.hasta && f >= st.desde && f < st.hasta) cl.push("en-rango");
        return `<button type="button" class="${cl.join(" ")}" data-f="${f}">
          <span class="tl-dow">${d.getDate() === 1
            ? d.toLocaleDateString("es-CL", { month: "short" }).replace(".", "")
            : d.toLocaleDateString("es-CL", { weekday: "short" }).slice(0, 3)}</span>
          <span class="tl-num">${d.getDate()}</span>
        </button>`;
      }).join("")}
    </div>`;

  const filas = cabanas.map((c) => {
    /* Solo lo que toca la ventana visible, y recortado a ella: una reserva que
       empieza el mes pasado tiene que dibujarse desde el borde izquierdo, no
       desaparecer ni desbordar la grilla. */
    const suyas = st.bloqueos.filter((b) =>
      b.cabana_id === c.id && b.desde < finExcl && b.hasta > ini);

    /* Sin celdas vacias: las lineas de la reticula son un fondo. Con celdas
       reales, la colocacion automatica de la rejilla las hace ESQUIVAR a las
       barras —que si tienen posicion explicita— y cada fila terminaba abriendo
       una segunda fila fantasma debajo. */
    return `<div class="tl-fila tl-datos">
      <div class="tl-rotulo"><span>${esc(c.nombre.replace(/^Cabaña /, ""))}</span></div>
      ${suyas.map((b) => {
        const cortadaIni = b.desde < ini;
        const cortadaFin = b.hasta > finExcl;
        const arranca = cortadaIni ? ini : b.desde;
        const ter = cortadaFin ? finExcl : b.hasta;
        const col = nochesEntre(ini, arranca) + 2;      // +1 rotulo, +1 base-1
        /* MEDIOS DIAS. La barra ocupa tambien la columna del dia de salida, y
           el CSS la recorta media columna por cada extremo. Resultado: empieza
           a mitad del dia de entrada y termina a mitad del de salida, que es
           exactamente lo que pasa —se van a las 11, entran a las 16— y deja la
           otra mitad libre para la reserva que toma esa misma cabaña ese mismo
           dia. Las dos barras se encuentran justo en el medio.
           Si esta cortada por el borde de la ventana no se suma la columna:
           tiene que llegar al canto, no quedarse a medias. */
        const tramo = Math.max(1, nochesEntre(arranca, ter) + (cortadaFin ? 0 : 1));
        const canal = b.canal || (b.origen === "airbnb" ? "airbnb" : null);
        const quien = b.tipo === "bloqueo" ? "Bloqueo" : esc(b.nombre || "Reserva");
        /* Se marca si la barra esta cortada, para no leer un tramo recortado
           como si la estadia empezara o terminara ahi. */
        const cl = ["tl-barra"];
        if (cortadaIni) cl.push("viene");
        if (cortadaFin) cl.push("sigue");
        if (b.tipo === "bloqueo")   cl.push("es-bloqueo");
        return `<button type="button" class="${cl.join(" ")}" data-ficha="${b.id}"
                  data-pagos="${b.tipo === "bloqueo" ? 0 : mitadesPagadas(b)}"
                  style="grid-column:${col} / span ${tramo}">
          ${insignia(canal)}<span class="tl-nombre">${quien}</span>
        </button>`;
      }).join("")}
    </div>`;
  }).join("");

  /* La linea de hoy cruza todas las filas: es el unico elemento que une la
     rejilla en vertical y lo que responde "¿en que dia estamos parados?". */
  const iHoy = dias.indexOf(hoy);
  /* Va posicionada, no en una celda: tiene que cruzar TODAS las filas, y cada
     fila es su propia rejilla. */
  const marcaHoy = iHoy >= 0 ? `<div class="tl-hoy" style="--i:${iHoy}"><i></i></div>` : "";

  /* Que el relleno signifique "cuanto pagaron" no se adivina mirando: una barra
     vacia se lee igual de bien como "sin datos". Se dice. */
  const leyenda = `
    <div class="leyenda tl-leyenda">
      <span><i class="m0"></i>Sin pagar</span>
      <span><i class="m1"></i>Anticipo</span>
      <span><i class="m2"></i>Pagado</span>
    </div>`;

  $("#lista-semana").innerHTML =
    `<div class="tl"><div class="tl-cuerpo" style="--n-dias:${total}">` +
    `${cabecera}${filas}${marcaHoy}</div></div>${leyenda}`;

  /* Se posiciona en hoy, o en el dia que se este mirando si hay uno marcado.
     Arrancar siempre en el dia 1 obliga a desplazar antes de leer nada, y en un
     mes de 42 columnas eso es medio recorrido. */
  const tl = $(".tl");
  const foco = st.desde && dias.includes(st.desde) ? dias.indexOf(st.desde) : iHoy;
  if (tl && foco > 2) tl.scrollLeft = (foco - 2) * COL_PX;

  $("#leyenda-una").hidden = $("#leyenda-conjunto").hidden = true;
}

/* Cambiar de vista no mueve la fecha: la semana que se abre es la del dia que
   se estaba mirando, o la de hoy si no habia ninguno. Saltar a otra fecha al
   cambiar de vista obliga a volver a buscar donde uno estaba. */
$$("[data-cal]").forEach((btn) => btn.addEventListener("click", async () => {
  if (st.vista === btn.dataset.cal) return;
  st.vista = btn.dataset.cal;
  if (st.vista === "semana") {
    st.semanaIni = lunesDe(st.desde || (st.mes === new Date().getMonth() &&
      st.anio === new Date().getFullYear() ? hoyISO() : iso(st.anio, st.mes, 1)));
    await cargarBloqueos();
  } else {
    const ref = new Date(sumarDias(st.semanaIni, 3) + "T00:00:00");
    st.anio = ref.getFullYear(); st.mes = ref.getMonth();
    await cargarBloqueos();
  }
  pintarCalendario();
}));

$("#lista-semana").addEventListener("click", (e) => {
  const id = e.target.closest("[data-ficha]")?.dataset.ficha;
  if (id) verReserva(id);
});

/* La barra solo muestra las fechas y el boton. Los datos del cliente y el
   numero de personas se piden despues, cada cosa en su paso: verlo todo de
   entrada convierte una tarea de dos toques en un formulario. */
function pintarBarra() {
  const caja = $("#caja-seleccion");
  if (!st.desde) { caja.hidden = true; return; }
  caja.hidden = false;

  const mirando = st.modo === "ver";

  /* En modo "ver" la barra informa de ese dia y nada mas. Reservar es un acto
     aparte, con su boton: tocar el calendario para revisar como viene la semana
     no puede meter a nadie a medio formulario de reserva. */
  if (mirando) {
    const libres = libresEn(st.desde);
    const estado = libres === 0
      ? "Sin cabañas libres"
      : `${libres} de ${st.cabanas.length} libres`;
    $("#texto-seleccion").innerHTML =
      `<b>${fechaLarga(st.desde)}</b><br><span class="sub">${estado} esa noche</span>`;
  } else {
    $("#texto-seleccion").innerHTML = st.hasta
      ? `<b>${fechaCorta(st.desde)} a ${fechaCorta(st.hasta)}</b>` +
        `<span class="sub"> &middot; ${nochesEntre(st.desde, st.hasta)} noche(s)</span>` +
        `<br><span class="sub">El dia de salida queda libre para otra reserva.</span>`
      : `Entrada el <b>${fechaCorta(st.desde)}</b>.` +
        `<br><span class="sub">Ahora toca en el calendario el dia de <b>salida</b>.</span>`;
  }

  $("#btn-modo-reserva").hidden  = !mirando;
  $("#acciones-sel").hidden      = mirando;
  $("#btn-buscar-disp").disabled = !st.hasta;
  pintarOcupadas();

  /* La barra vive debajo del calendario, asi que en un telefono la respuesta a
     "toque el 22" caia fuera de pantalla y parecia que no habia pasado nada.
     Se trae a la vista, y solo si hace falta (`nearest` no mueve nada si ya se
     esta viendo, para no dar un tiron en cada toque). */
  if (st.desde !== ultimoDiaVisto) {
    ultimoDiaVisto = st.desde;
    /* Instantaneo y no suave: en iOS un desplazamiento suave pedido desde JS
       deja atras la barra de pestanas, que es fija, y se queda clavada a media
       pantalla. Con `nearest` el salto es de unos pocos pixeles o ninguno, asi
       que no se pierde casi nada. */
    caja.scrollIntoView({ block: "nearest" });
  }
}
let ultimoDiaVisto = null;

/* Entrar y salir del modo reserva. Salir no borra el dia: se vuelve a mirar el
   calendario donde se estaba, que es de donde se venia. */
$("#btn-modo-reserva").addEventListener("click", () => {
  st.modo = "reservar"; st.hasta = null; pintarCalendario();
});
$("#btn-limpiar-sel").addEventListener("click", () => {
  st.modo = "ver"; st.hasta = null; pintarCalendario();
});

/* Que hay tomado en las fechas marcadas, sin tener que buscar nada. El panel se
   usa con el cliente esperando en el chat: la pregunta que sigue a "no queda"
   es siempre "y hasta cuando esta tomada", y esa respuesta tiene que estar a la
   vista, no a un toque de distancia.

   Con un solo dia marcado se mira esa noche; con el rango cerrado, cualquier
   noche del rango (`hasta` es exclusivo: quien se va esa manana no estorba). */
function pintarOcupadas() {
  const caja = $("#ocupadas-sel");
  const fin  = st.hasta || sumarDias(st.desde, 1);
  const choques = st.bloqueos.filter((b) => st.desde < b.hasta && fin > b.desde);

  if (!choques.length) {
    caja.hidden = false;
    caja.innerHTML = `<p class="ninguna">Las ${st.cabanas.length} cabañas libres` +
      `${st.hasta ? " en esas fechas" : st.modo === "ver" ? " ese dia" : " esa noche"}.</p>`;
    return;
  }

  /* Agrupadas por cabana y en el orden del calendario, no en el que vengan de
     la base: una cabana con dos reservas seguidas dentro del rango tiene que
     aparecer una sola vez, con las dos debajo. */
  const porCabana = st.cabanas
    .map((c) => ({ cab: c, reservas: choques.filter((b) => b.cabana_id === c.id) }))
    .filter((g) => g.reservas.length);

  caja.hidden = false;
  caja.innerHTML =
    `<p class="titulo-ocupadas">Ocupada${porCabana.length === 1 ? "" : "s"}` +
    `${st.hasta ? " en esas fechas" : st.modo === "ver" ? " ese dia" : " esa noche"}</p>` +
    porCabana.map((g) => `
      <div class="ocupada">
        <b>${esc(g.cab.nombre)}</b>
        ${g.reservas.map((b) => {
          const canal = b.canal || (b.origen === "airbnb" ? "airbnb" : null);
          const quien = b.tipo === "bloqueo"
            ? "Bloqueo" + (b.nota ? ` &middot; ${esc(b.nota)}` : "")
            : esc(b.nombre || "Reserva");
          /* Cada reserva es un boton: aqui esta el nombre y las fechas, y la
             siguiente pregunta ("cuantos venian", "que telefono dejo") tiene
             que resolverse tocandola, no abriendo la base de datos. */
          /* Entrada y salida, no solo la salida: con las dos fechas se ve de
             una si el choque tapa todo el rango o solo un par de noches, y si
             conviene ofrecer correr la reserva un dia. */
          /* Sin insignia hay que sangrar igual, o la linea de fechas queda
             corrida respecto al texto que tiene encima. */
          /* Una pendiente no esta vendida: es alguien a medio pagar y esas
             fechas pueden volver a quedar libres solas. Mostrarla igual que
             una confirmada te haria rechazar a otro cliente por una reserva
             que no existe. */
          return `<button type="button" class="reserva-mini" data-ficha="${b.id}">
            <span class="sub${canal ? "" : " sin-icono"}">${insignia(canal)}${quien}${avisoPendiente(b)}</span>
            <span class="sub fechas">Entra ${fechaCorta(b.desde)}
              &middot; sale ${fechaCorta(b.hasta)}</span>
            <span class="flecha">&rsaquo;</span>
          </button>`;
        }).join("")}
      </div>`).join("");
}


/* ------------------------------------------- Acciones del calendario ------ */
$("#grilla-dias").addEventListener("click", (e) => {
  const btn = e.target.closest(".dia");
  if (!btn || btn.classList.contains("vacio") || btn.classList.contains("pasado")) return;
  tocarDia(btn.dataset.f);
});

/* La cabecera de cada dia de la semana hace lo mismo que un cuadrito del mes:
   una sola funcion para las dos vistas, o acabarian comportandose distinto. */
$("#lista-semana").addEventListener("click", (e) => {
  const btn = e.target.closest(".tl-dia");
  if (btn && !btn.closest(".pasado")) tocarDia(btn.dataset.f);
});

function tocarDia(f) {
  /* Cualquier dia se puede tocar, tambien uno lleno. Antes se rechazaban con un
     aviso, y era el peor momento para negarse: un dia lleno es justo el que hay
     que abrir para ver quien lo tiene y hasta cuando. */

  if (st.modo === "ver") {
    /* Mirando: cada toque cambia el dia que se esta revisando, y volver a tocar
       el mismo lo cierra. No se acumula nada ni se empieza ninguna reserva. */
    st.desde = st.desde === f ? null : f;
    st.hasta = null;
  } else {
    if (!st.desde || st.hasta) { st.desde = f; st.hasta = null; }
    else if (f <= st.desde)    { st.desde = f; }
    else                       { st.hasta = f; }
  }

  pintarCalendario();
}

/* Un solo camino para abrir una reserva: desde las ocupadas del dia o desde la
   lista del mes, la ficha es la misma. Dos fichas distintas para el mismo dato
   terminan diciendo cosas distintas. */
$("#ocupadas-sel").addEventListener("click", (e) => {
  const id = e.target.closest("[data-ficha]")?.dataset.ficha;
  if (id) verReserva(id);
});

$("#mes-antes").addEventListener("click",   () => mover(-1));
$("#mes-despues").addEventListener("click", () => mover(1));
/* Las dos vistas se mueven de mes. La linea de tiempo dibuja el mes entero y se
   recorre en horizontal, asi que avanzar de semana con las flechas seria mover
   dos veces la misma cosa. */
async function mover(n) {
  const f = new Date(st.anio, st.mes + n, 1);
  st.anio = f.getFullYear(); st.mes = f.getMonth();
  st.semanaIni = lunesDe(iso(st.anio, st.mes, 1));
  st.desde = st.hasta = null; st.modo = "ver";
  await cargarBloqueos(); pintarCalendario();
}

$("#sel-cabana").addEventListener("change", async (e) => {
  st.cabanaSel = e.target.value;
  st.desde = st.hasta = null; st.modo = "ver";
  await cargarBloqueos(); pintarCalendario();
});

/* ----------------------------------------------- Ventana de reserva ------- */
/* Dos pasos, uno a la vez:
     1. que cabanas hay libres en esas fechas
     2. los datos: personas, cliente y por donde llego                        */
const modal = $("#modal");

function abrirModal(titulo, sub, html) {
  $("#modal-titulo").textContent = titulo;
  $("#modal-sub").textContent    = sub;
  $("#modal-cuerpo").innerHTML   = html;
  modal.classList.remove("cerrando");
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

/* La hoja SALE por donde entro. Antes subia desde abajo al abrir y desaparecia
   de golpe al cerrar, y esa asimetria es lo que hace que una ventana se sienta
   como un cartel y no como un objeto: si algo se va de otra forma que como
   vino, se pierde de dónde estaba.

   El `hidden` no se puede animar, asi que se marca `cerrando`, se espera a que
   la animacion termine y recien ahi se oculta. Con movimiento reducido no hay
   animacion que esperar y el `animationend` nunca llega: de ahi el plazo de
   seguridad. */
let cerrandoEn = null;
function cerrarModal() {
  if (modal.hidden || modal.classList.contains("cerrando")) return;
  modal.classList.add("cerrando");

  const ocultar = () => {
    clearTimeout(cerrandoEn);
    modal.hidden = true;
    modal.classList.remove("cerrando");
    document.body.style.overflow = "";
  };
  modal.addEventListener("animationend", ocultar, { once: true });
  cerrandoEn = setTimeout(ocultar, 320);

  st.eleccion = null; st.canal = null;
  st.nueva = null; st.paso = 0;
}
$("#modal-cerrar").addEventListener("click", cerrarModal);
modal.addEventListener("click", (e) => { if (e.target === modal) cerrarModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) cerrarModal(); });

/* Paso 1: buscar. Sin pedir personas todavia; primero se ve que hay. */
async function buscar() {
  if (!st.desde || !st.hasta) return;
  const rango = `${fechaCorta(st.desde)} a ${fechaCorta(st.hasta)} - ${nochesEntre(st.desde, st.hasta)} noche(s)`;
  abrirModal("Disponibilidad", rango, '<p class="lista-vacia">Buscando...</p>');

  try {
    const filas = await api("rpc/buscar_disponibilidad", {
      method: "POST",
      body: JSON.stringify({ p_entrada: st.desde, p_salida: st.hasta, p_adultos: null }),
    });
    // El segundo filtro de `arrienda`. La funcion de la base ya excluye la
    // cabana Host, pero un solo filtro es un olvido esperando a pasar y aqui
    // el fallo seria arrendar la casa donde vive el dueno. `!== false` para
    // que una base antigua, que todavia no devuelva el campo, no se quede sin
    // ninguna cabana.
    const libres = filas.filter((f) => f.libre && f.arrienda !== false &&
      (st.cabanaSel === TODAS || f.cabana_id === st.cabanaSel));

    if (!libres.length) {
      $("#modal-cuerpo").innerHTML =
        '<div class="aviso error">No queda ninguna cabana libre en esas fechas.</div>' +
        '<button type="button" class="secundario ancho" data-cerrar>Elegir otras fechas</button>';
      return;
    }

    $("#modal-cuerpo").innerHTML =
      `<p class="lista-vacia" style="text-align:left;padding:0 0 var(--e3)">
         ${libres.length} cabana${libres.length === 1 ? "" : "s"} disponible${libres.length === 1 ? "" : "s"}. Elige una.
       </p>` +
      libres.map((f) => `
        <button type="button" class="opcion-cabana" data-elegir="${f.cabana_id}">
          <span>${esc(f.nombre)}<br><span class="cap">Hasta ${f.capacidad_max} personas</span></span>
          <span class="flecha">&rsaquo;</span>
        </button>`).join("");
  } catch (err) {
    $("#modal-cuerpo").innerHTML = `<div class="aviso error">${esc(err.message)}</div>`;
  }
}
$("#btn-buscar-disp").addEventListener("click", buscar);

$("#modal-cuerpo").addEventListener("click", (e) => {
  if (e.target.closest("[data-cerrar]")) { cerrarModal(); return; }
  if (accionReserva(e)) return;
  const elegir = e.target.closest("[data-elegir]")?.dataset.elegir;
  if (elegir) pasoDatos(elegir);
});

/* Las acciones de una reserva se resuelven en un solo sitio: los mismos botones
   aparecen en la ficha y desplegados en la seccion de hoy, y con un manejador
   por contenedor uno acababa haciendo menos cosas que el otro. */
const ACCIONES = "[data-ver],[data-editar],[data-eliminar],[data-borrar]," +
  "[data-marcar-pago],[data-deshacer-pago],[data-comprobante]";
function accionReserva(e) {
  const d = e.target.closest(ACCIONES)?.dataset;
  if (!d) return false;
  if (d.ver)          verReserva(d.ver);
  if (d.editar)       editarReserva(d.editar);
  if (d.eliminar)     confirmarEliminar(d.eliminar);   // pregunta primero
  if (d.borrar)       eliminarReserva(d.borrar);       // ya confirmado
  if (d.marcarPago)   registrarPago(d.id, Number(d.marcarPago));
  if (d.deshacerPago) deshacerPago(d.id, Number(d.deshacerPago));
  if (d.comprobante)  abrirComprobante(d.comprobante, d.id);
  return true;
}

/* --------------------------------------------- Alta de reserva por pasos -- */
/* Una pregunta por pantalla, en el orden en que llega la conversacion de
   WhatsApp: primero cuantos vienen (de ahi sale el precio, que es lo que el
   cliente pregunta), despues quien es, y al final si ya transfirio.

   El formulario entero de una sola vez pedia ocho datos a la vez para una tarea
   que en la cabeza son tres preguntas cortas. Los valores viven en `st.nueva` y
   no en el DOM: cada paso repinta el cuerpo de la ventana y borraria lo
   escrito. */
/* ---------------------------------------------------------------- Tinaja -- */
/* Hay UNA sola tinaja para las tres cabañas y el turno dura dos horas, asi que
   el turno necesita FECHA ademas de hora: una estadia de tres noches no dice
   por si sola que noche se usa. Las noches se ofrecen como lista y no como un
   campo de fecha libre porque solo se puede usar durante la estadia, y un
   selector abierto invita a elegir un dia en que no hay nadie. */
function campoTurnoTinaja(pre, fecha, hora, desde, hasta) {
  const noches = [];
  for (let f = desde; f < hasta; f = sumarDias(f, 1)) noches.push(f);
  const elegida = noches.includes(fecha) ? fecha : noches[0];
  return `
    <div class="fila">
      <div class="campo">
        <label for="${pre}-tinaja-fecha">Noche</label>
        <select id="${pre}-tinaja-fecha">
          ${noches.map((f) => `<option value="${f}"${f === elegida ? " selected" : ""}>${fechaLarga(f)}</option>`).join("")}
        </select>
      </div>
      <div class="campo">
        <label for="${pre}-tinaja-hora">Empieza</label>
        <input type="time" id="${pre}-tinaja-hora" step="1800" value="${(hora || "19:00").slice(0, 5)}">
      </div>
    </div>`;
}

/* Aviso, no bloqueo: la tinaja se comparte y a veces se acomoda hablando con
   los dos grupos. Lo que el panel tiene que hacer es que nadie se entere
   despues, no decidir por el. */
async function avisarChoqueTinaja(pre, excluirId) {
  const caja = $(`#${pre}-tinaja-aviso`);
  const fecha = $(`#${pre}-tinaja-fecha`)?.value;
  const hora  = $(`#${pre}-tinaja-hora`)?.value;
  if (!caja || !fecha || !hora) return;
  try {
    const r = await api("rpc/tinaja_libre", { method: "POST", body: JSON.stringify({
      p_fecha: fecha, p_hora: hora, p_excluir: excluirId || null })});
    if (!$(`#${pre}-tinaja-aviso`)) return;
    if (r?.libre) {
      caja.innerHTML = `<p class="tinaja-ok">Tinaja libre a esa hora.</p>`;
      return;
    }
    const c = r?.choques?.[0];
    caja.innerHTML = `<div class="aviso error">
      <b>La tinaja ya está tomada a esa hora.</b><br>
      ${c ? `${esc(nombreCabana(c.cabana))} la tiene de ${String(c.desde).slice(0, 5)}
             a ${String(c.hasta).slice(0, 5)}${c.nombre ? ` (${esc(c.nombre)})` : ""}.` : ""}
      <br>Hay una sola: hay que correr un turno o avisarle a los dos.
    </div>`;
  } catch (err) { /* si falla la consulta no se inventa un veredicto */ }
}

const PASOS = [
  { n: 1, titulo: "¿Cuántos vienen?" },
  { n: 2, titulo: "¿Quién reserva?" },
  { n: 3, titulo: "¿Ya pagó el anticipo?" },
];

function pasoDatos(cabanaId) {
  st.eleccion = cabanaId;
  st.nueva = {
    adultos: 2, ninos: 0, mascotas: 0,
    tinaja: false, tinajaFecha: st.desde, tinajaHora: "19:00",
    nombre: "", telefono: "", canal: null, nota: "",
    anticipo: false, monto: null, fecha: hoyISO(), foto: null,
    montoTocado: false, sugerido: null,
  };
  irAPaso(1);
}

const cabanaElegida = () => st.cabanas.find((c) => c.id === st.eleccion);

function irAPaso(n) {
  const cab = cabanaElegida();
  const paso = PASOS[n - 1];
  st.paso = n;
  abrirModal(paso.titulo,
    `${cab.nombre} · ${fechaCorta(st.desde)} a ${fechaCorta(st.hasta)}`,
    `<div class="pasos" aria-label="Paso ${n} de ${PASOS.length}">
       ${PASOS.map((p) => `<span class="${p.n <= n ? "hecho" : ""}"></span>`).join("")}
     </div>` + cuerpoPaso(n, cab));
  conectarPaso(n, cab);
}

function cuerpoPaso(n, cab) {
  const d = st.nueva;

  if (n === 1) return `
    <div class="fila">
      <div class="campo">
        <label for="res-adultos">Adultos</label>
        <input type="number" id="res-adultos" inputmode="numeric" min="1" value="${d.adultos}">
      </div>
      <div class="campo">
        <label for="res-ninos">Niños (hasta ${st.reglas?.edad_nino_max ?? 11})</label>
        <input type="number" id="res-ninos" inputmode="numeric" min="0" value="${d.ninos}">
      </div>
      <!-- Las mascotas se anotan pero no cuentan: ni cobran ni ocupan cama. Van
           en la misma fila porque se preguntan de corrido, en la misma frase. -->
      <div class="campo">
        <label for="res-mascotas">Mascotas</label>
        <input type="number" id="res-mascotas" inputmode="numeric" min="0" value="${d.mascotas}">
      </div>
    </div>
    <!-- La tinaja va en este paso y no en el de los extras porque CAMBIA EL
         PRECIO, y el precio se muestra aquí. Ponerla más adelante dejaría este
         paso mostrando una cifra que después no cuadra. -->
    <label style="margin-top:var(--e2);display:block">Tinaja</label>
    <div class="segmentado" id="res-tinaja">
      <button type="button" data-tinaja="no" aria-selected="${String(!d.tinaja)}">Sin tinaja</button>
      <button type="button" data-tinaja="si" aria-selected="${String(d.tinaja)}">Con tinaja</button>
    </div>
    <div id="res-tinaja-caja" ${d.tinaja ? "" : "hidden"}>
      ${campoTurnoTinaja("res", d.tinajaFecha, d.tinajaHora, st.desde, st.hasta)}
      <div id="res-tinaja-aviso"></div>
    </div>
    <div class="aviso info" id="res-precio"></div>
    <div class="fila" style="margin-top:var(--e4)">
      <button type="button" class="secundario" id="paso-atras">Volver</button>
      <button type="button" id="paso-siguiente">Siguiente</button>
    </div>
    <!-- El bloqueo por mantencion sale por aqui: ya se eligio cabaña y fechas,
         que es todo lo que necesita, y asi no arrastra los tres pasos de una
         reserva que no tiene cliente. -->
    <button type="button" class="secundario ancho" id="btn-solo-bloquear"
            style="margin-top:var(--e2);font-weight:500">
      Solo bloquear la fecha (mantención, uso propio)
    </button>`;

  if (n === 2) return `
    <div class="campo">
      <label for="res-nombre">Nombre de quien reserva</label>
      <input type="text" id="res-nombre" autocomplete="name"
             placeholder="Nombre y apellido" value="${esc(d.nombre)}">
    </div>
    <div class="campo">
      <label for="res-telefono">Teléfono</label>
      <input type="tel" id="res-telefono" inputmode="tel"
             placeholder="+56 9 ..." value="${esc(d.telefono)}">
    </div>
    <label>¿Por dónde llegó?</label>
    <div class="canales" id="res-canales">
      ${CANALES_A_MANO.map((c) => `<button type="button" class="canal" data-canal="${c.id}"
          aria-pressed="${String(c.id === d.canal)}">${insignia(c.id)}<span>${c.nombre}</span></button>`).join("")}
    </div>
    <div class="fila" style="margin-top:var(--e4)">
      <button type="button" class="secundario" id="paso-atras">Atrás</button>
      <button type="button" id="paso-siguiente">Siguiente</button>
    </div>`;

  return `
    <div class="segmentado" id="res-anticipo">
      <button type="button" data-anticipo="no" aria-selected="${String(!d.anticipo)}">Todavía no</button>
      <button type="button" data-anticipo="si" aria-selected="${String(d.anticipo)}">Ya pagó</button>
    </div>
    <div id="res-pago-caja" ${d.anticipo ? "" : "hidden"}>
      <div class="fila">
        <div class="campo">
          <label for="res-pago-monto">Monto</label>
          <input type="number" id="res-pago-monto" inputmode="numeric" step="1000"
                 value="${d.monto ?? d.sugerido ?? ""}">
        </div>
        <div class="campo">
          <label for="res-pago-fecha">Fecha</label>
          <input type="date" id="res-pago-fecha" value="${d.fecha}">
        </div>
      </div>
      <button type="button" class="secundario ancho" id="res-pago-elegir"
              style="font-weight:500">Foto del comprobante</button>
      <p class="lista-vacia" id="res-pago-foto-nombre"
         style="padding:var(--e2) 0 0;text-align:left">${d.foto
           ? `${esc(d.foto.name)} — ${Math.round(d.foto.size / 1024)} KB`
           : "Opcional. Se guarda achicada."}</p>
      <input type="file" accept="image/*" id="res-pago-foto" hidden>
    </div>
    <div class="campo" style="margin-top:var(--e4)">
      <label for="res-nota">Nota (privada)</label>
      <input type="text" id="res-nota" placeholder="Opcional" value="${esc(d.nota)}">
    </div>
    <div class="resumen-alta">
      <div class="linea-detalle"><span>${esc(cab.nombre)}</span>
        <b>${fechaCorta(st.desde)} a ${fechaCorta(st.hasta)}</b></div>
      <div class="linea-detalle"><span>${textoHuespedes(d)}</span>
        <b>${esc(d.nombre)}</b></div>
      ${d.tinaja ? `<div class="linea-detalle"><span>Tinaja</span>
        <b>${fechaCorta(d.tinajaFecha)} &middot; ${d.tinajaHora}</b></div>` : ""}
    </div>
    <div class="fila" style="margin-top:var(--e4)">
      <button type="button" class="secundario" id="paso-atras">Atrás</button>
      <button type="button" id="btn-guardar-reserva">Guardar reserva</button>
    </div>`;
}

function conectarPaso(n, cab) {
  const d = st.nueva;
  $("#paso-atras").addEventListener("click", () => {
    guardarPaso(n);
    if (n === 1) buscar(); else irAPaso(n - 1);
  });

  if (n === 1) {
    const recalcular = () => cotizarEnFicha(cab);
    $("#res-adultos").addEventListener("input", recalcular);
    $("#res-ninos").addEventListener("input", recalcular);
    /* Las mascotas no recalculan nada: no cobran ni ocupan cama. */
    $("#res-mascotas").addEventListener("input", () => { d.mascotas = Number($("#res-mascotas").value) || 0; });

    $("#res-tinaja").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tinaja]");
      if (!b) return;
      d.tinaja = b.dataset.tinaja === "si";
      $("#res-tinaja").querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("#res-tinaja-caja").hidden = !d.tinaja;
      recalcular();
      if (d.tinaja) avisarChoqueTinaja("res");
    });
    ["#res-tinaja-fecha", "#res-tinaja-hora"].forEach((s) =>
      $(s)?.addEventListener("change", () => { guardarPaso(1); avisarChoqueTinaja("res"); }));

    recalcular();
    if (d.tinaja) avisarChoqueTinaja("res");
    $("#paso-siguiente").addEventListener("click", () => {
      guardarPaso(1);
      if (st.nueva.adultos < 1) { avisar("Indica al menos un adulto.", "error"); return; }
      if (st.nueva.adultos + st.nueva.ninos > cab.capacidad_max) {
        avisar(`${cab.nombre} admite hasta ${cab.capacidad_max} personas.`, "error"); return;
      }
      irAPaso(2);
    });
    $("#btn-solo-bloquear").addEventListener("click", () => guardar("bloqueo"));
  }

  if (n === 2) {
    $("#res-canales").addEventListener("click", (e) => {
      const b = e.target.closest(".canal");
      if (!b) return;
      d.canal = b.dataset.canal;
      $("#res-canales").querySelectorAll(".canal")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    $("#paso-siguiente").addEventListener("click", () => {
      guardarPaso(2);
      /* Nombre y canal se exigen aqui y no al guardar: avisar de un dato que
         falta dos pasos mas adelante obliga a volver a buscarlo. */
      if (!d.nombre) { avisar("Falta el nombre de quien reserva.", "error"); return; }
      if (!d.canal)  { avisar("Marca por donde llegó la reserva.", "error"); return; }
      irAPaso(3);
    });
  }

  if (n === 3) {
    $("#res-anticipo").addEventListener("click", (e) => {
      const b = e.target.closest("[data-anticipo]");
      if (!b) return;
      d.anticipo = b.dataset.anticipo === "si";
      $("#res-anticipo").querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("#res-pago-caja").hidden = !d.anticipo;
      if (d.anticipo && !$("#res-pago-monto").value && d.sugerido)
        $("#res-pago-monto").value = d.sugerido;
    });
    $("#res-pago-monto").addEventListener("input", () => { d.montoTocado = true; });
    $("#res-pago-elegir").addEventListener("click", () => $("#res-pago-foto").click());
    $("#res-pago-foto").addEventListener("change", (e) => {
      d.foto = e.target.files[0] || null;
      $("#res-pago-foto-nombre").textContent = d.foto
        ? `${d.foto.name} — ${Math.round(d.foto.size / 1024)} KB`
        : "Opcional. Se guarda achicada.";
    });
    $("#btn-guardar-reserva").addEventListener("click", () => {
      guardarPaso(3);
      guardar("reserva");
    });
  }
}

/* Lo escrito se recoge ANTES de repintar, en los dos sentidos: quien retrocede
   a corregir un telefono no puede perder lo que ya puso mas adelante. */
function guardarPaso(n) {
  const d = st.nueva;
  if (n === 1) {
    d.adultos  = Number($("#res-adultos")?.value)  || 0;
    d.ninos    = Number($("#res-ninos")?.value)    || 0;
    d.mascotas = Number($("#res-mascotas")?.value) || 0;
    d.tinajaFecha = $("#res-tinaja-fecha")?.value || d.tinajaFecha;
    d.tinajaHora  = $("#res-tinaja-hora")?.value  || d.tinajaHora;
  }
  if (n === 2) {
    d.nombre   = $("#res-nombre")?.value.trim()   ?? d.nombre;
    d.telefono = $("#res-telefono")?.value.trim() ?? d.telefono;
  }
  if (n === 3) {
    d.monto = Number($("#res-pago-monto")?.value) || null;
    d.fecha = $("#res-pago-fecha")?.value || d.fecha;
    d.nota  = $("#res-nota")?.value.trim() ?? d.nota;
  }
}

/* ------------------------------------------------- Ficha de una reserva ---- */
/* Toda la reserva en una ficha, y desde ahi se edita. Antes el unico dato
   completo estaba en la base: en el panel se veia el nombre y las fechas, y
   para saber cuantos venian o que telefono dejaron habia que abrir Supabase. */
const buscarReserva = (id) =>
  /* Se busca en los dos: la seccion de hoy trae sus propias filas y con el
     calendario en otro mes no estan en `st.bloqueos`. */
  st.bloqueos.find((x) => x.id === id) || st.hoy.find((x) => x.id === id);

/* El detalle se arma una sola vez y lo usan los dos sitios donde aparece: la
   ficha en ventana y el desplegable de hoy. Si fueran dos plantillas, un dato
   nuevo se agregaria en una y faltaria en la otra. */
function detalleReserva(b, idPrecio, opciones = {}) {
  const esBloqueo = b.tipo === "bloqueo";
  const canal = b.canal || (b.origen === "airbnb" ? "airbnb" : null);
  const personas = (b.adultos || 0) + (b.ninos || 0);
  const fila = (k, v) => v ? `<div class="linea-detalle"><span>${k}</span><span>${v}</span></div>` : "";
  const faltante = "<span style='color:var(--tx-3)'>sin registrar</span>";

  return `<div id="${idPrecio}"></div>
    ${fila("Entra", fechaLarga(b.desde) +
       (!esBloqueo && st.reglas ? ` &middot; ${hhmm(st.reglas.check_in)}` : ""))}
    ${fila("Sale",  fechaLarga(b.hasta) +
       (!esBloqueo && st.reglas ? ` &middot; ${hhmm(st.reglas.check_out)}` : ""))}
    ${opciones.sinCabana ? "" : fila("Cabaña", esc(nombreCabana(b.cabana_id)))}
    ${esBloqueo ? "" : fila("Personas", textoHuespedes(b) || faltante)}
    ${esBloqueo ? "" : fila("Tinaja", !b.tinaja ? ""
       : b.tinaja_fecha
         ? `${fechaCorta(b.tinaja_fecha)} &middot; ${hhmm(b.tinaja_hora)} — ${horaFin(b.tinaja_hora)}`
           /* La tinaja no se enciende sola: llega un aviso al telefono y la
              enciende una persona. Aqui se dice a que hora avisa, que es la
              hora a la que hay que estar disponible — no "se enciende sola",
              que haria dejar de mirarlo. */
           + (el.hayTinaja
              ? `<br><span style="color:var(--tx-3);font-size:12px">aviso para encenderla a las ${
                   horaMenos(b.tinaja_hora, st.reglas?.tinaja_antes_min ?? 720)}</span>`
              : "")
         /* Cobrada pero sin turno: no se deja en blanco, que un vacio no se
            distingue de un "no lleva tinaja". */
         : "<span style='color:var(--tx-3)'>sin turno — vuelve a guardarla</span>")}
    ${esBloqueo ? "" : fila("Telefono", b.telefono
       ? `<a href="tel:${esc(b.telefono.replace(/\s/g, ""))}">${esc(b.telefono)}</a>`
       : faltante)}
    ${esBloqueo ? "" : fila("Llego por", canal
       ? `${insignia(canal)}${CANALES.find((c) => c.id === canal)?.nombre || canal}`
       : faltante)}
    ${opciones.sinNota ? "" : fila("Nota", b.nota ? esc(b.nota) : "")}
    ${esBloqueo || opciones.sinPagos ? "" : bloquePagos(b)}`;
}

/* ------------------------------------------------------------------ Pagos -- */
/* Se cobra en dos mitades: 50% al reservar y 50% en la cabaña. La caja se llena
   a la mitad con el primero y se completa con el segundo, y el color se
   mantiene — sin parpadear. Un parpadeo dice "esto necesita algo de ti ahora";
   un pago recibido no necesita nada, solo hay que poder verlo de un vistazo. */
const pagosDe = (b) => [
  { n: 1, at: b.pago1_at, monto: b.pago1_monto, ruta: b.pago1_comprobante, etiqueta: "Anticipo" },
  { n: 2, at: b.pago2_at, monto: b.pago2_monto, ruta: b.pago2_comprobante, etiqueta: "Saldo" },
];
const mitadesPagadas = (b) => pagosDe(b).filter((p) => p.at).length;

function bloquePagos(b) {
  const pagos = pagosDe(b);
  const hechas = pagos.filter((p) => p.at).length;
  const total  = pagos.reduce((s, p) => s + (p.monto || 0), 0);

  return `
    <p class="titulo-ocupadas" style="margin-top:var(--e4)">Pagos</p>
    <div class="barra-pagos p${hechas}">
      ${pagos.map((p) => `<div class="mitad ${p.at ? "pagada" : ""}">
        <span class="etiqueta">${p.etiqueta}</span>
        <span class="valor">${p.at ? clp(p.monto || 0) : "pendiente"}</span>
      </div>`).join("")}
    </div>
    ${hechas === 2
      ? `<p class="pagado-todo">Pagado completo &middot; ${clp(total)}</p>`
      : ""}
    ${pagos.map((p) => `
      <div class="pago-fila">
        <div class="pago-quien">
          <b>${p.etiqueta}</b>
          <span>${p.at ? `${fechaCorta(p.at)} &middot; ${clp(p.monto || 0)}` : "sin registrar"}</span>
        </div>
        <div class="pago-acciones">
          ${p.ruta
            ? `<button type="button" class="chip" data-comprobante="${esc(p.ruta)}"
                       data-id="${b.id}">Ver foto</button>`
            : ""}
          ${p.at
            ? `<button type="button" class="chip suave" data-deshacer-pago="${p.n}" data-id="${b.id}">Deshacer</button>`
            : `<button type="button" class="chip marcar" data-marcar-pago="${p.n}" data-id="${b.id}"
                       ${p.n === 2 && !pagos[0].at ? "disabled title='Primero el anticipo'" : ""}>Marcar pagado</button>`}
        </div>
      </div>`).join("")}`;
}

function verReserva(id) {
  const b = buscarReserva(id);
  if (!b) return;
  const esBloqueo = b.tipo === "bloqueo";
  const personas = (b.adultos || 0) + (b.ninos || 0);

  abrirModal(
    esBloqueo ? "Bloqueo" : (b.nombre || "Reserva"),
    /* El subtitulo se pinta como texto plano: aqui va el caracter, no la
       entidad, o se lee "&middot;" literal. */
    `${nombreCabana(b.cabana_id)} · ${nochesEntre(b.desde, b.hasta)} noche(s)`,
    detalleReserva(b, "ficha-precio") +
    (b.origen === "airbnb"
       ? `<div class="aviso info" style="margin-top:var(--e4)">Esta reserva la manda Airbnb.
            Editarla aqui no la cambia alla y descuadraria los dos calendarios.</div>
          <button type="button" class="secundario ancho" data-cerrar>Cerrar</button>`
       : `<div class="fila" style="margin-top:var(--e4)">
            <button type="button" class="secundario" data-cerrar>Cerrar</button>
            <button type="button" data-editar="${b.id}">Editar</button>
          </div>
          <button type="button" class="peligro ancho" data-eliminar="${b.id}"
                  style="margin-top:var(--e2)">Eliminar</button>`));

  /* El total se pide despues de pintar: la ficha tiene que abrirse al instante
     aunque la red de la montana tarde. */
  if (!esBloqueo && personas) cotizarFicha(b, "#ficha-precio");
}

async function cotizarFicha(b, sel) {
  if (!$(sel)) return;
  try {
    const c = await api("rpc/cotizar", { method: "POST", body: JSON.stringify({
      p_cabana: b.cabana_id, p_entrada: b.desde, p_salida: b.hasta,
      p_adultos: b.adultos || 1, p_ninos: b.ninos || 0, p_tinaja: !!b.tinaja })});
    /* Se vuelve a buscar el nodo: entre la peticion y la respuesta el usuario
       pudo cerrar la ficha o plegar la fila. */
    const caja = $(sel);
    if (!c.ok || !caja) return;
    caja.className = "aviso ok";
    caja.innerHTML =
      `<b style="font-size:17px">${clp(c.total)}</b> por ${c.noches} noche(s)` +
      `<br><span style="opacity:.85">Anticipo ${clp(c.anticipo)} &middot; saldo ${clp(c.saldo)} en la cabana</span>`;
  } catch (err) { /* el precio es un extra: si falla, la ficha sigue sirviendo */ }
}

const hhmm = (t) => (t || "").slice(0, 5);
/* Cuando termina el turno de tinaja. Se calcula, no se guarda: guardar el fin
   ademas del inicio permite que los dos se contradigan. */
const horaFin = (t) => {
  const h = (t || "").slice(0, 5).split(":").map(Number);
  if (h.length < 2 || Number.isNaN(h[0])) return "";
  const min = h[0] * 60 + h[1] + (st.reglas?.tinaja_horas ?? 2) * 60;
  return `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
};

/* A que hora se enciende sola, contando el preencendido. Mismo cuidado que
   arriba con las vueltas del reloj: restarle dos horas a un turno de la manana
   cruza la medianoche hacia atras, y sin el modulo saldria una hora negativa. */
const horaMenos = (t, minutos) => {
  const h = (t || "").slice(0, 5).split(":").map(Number);
  if (h.length < 2 || Number.isNaN(h[0])) return "";
  const min = ((h[0] * 60 + h[1] - minutos) % 1440 + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
};

/* Editar. Las fechas tambien, porque "me corro un dia" es la peticion mas comun
   que llega por WhatsApp; el choque lo verifica la base excluyendo esta misma
   reserva, no un calculo aparte en el navegador. */
function editarReserva(id) {
  /* Se busca en los dos: la seccion de hoy trae sus propias filas y con el
     calendario en otro mes no estan en `st.bloqueos`. */
  const b = st.bloqueos.find((x) => x.id === id) || st.hoy.find((x) => x.id === id);
  if (!b) return;
  const esBloqueo = b.tipo === "bloqueo";
  st.canal = b.canal || null;

  abrirModal("Editar", `${nombreCabana(b.cabana_id)} · ${fechaCorta(b.desde)} a ${fechaCorta(b.hasta)}`, `
    <div class="fila">
      <div class="campo">
        <label for="ed-desde">Entrada</label>
        <input type="date" id="ed-desde" value="${b.desde}">
      </div>
      <div class="campo">
        <label for="ed-hasta">Salida</label>
        <input type="date" id="ed-hasta" value="${b.hasta}">
      </div>
    </div>
    ${esBloqueo ? "" : `
    <div class="fila">
      <div class="campo">
        <label for="ed-adultos">Adultos</label>
        <input type="number" id="ed-adultos" inputmode="numeric" min="1" value="${b.adultos || 2}">
      </div>
      <div class="campo">
        <label for="ed-ninos">Niños (hasta ${(st.reglas?.edad_nino_max ?? 11)})</label>
        <input type="number" id="ed-ninos" inputmode="numeric" min="0" value="${b.ninos || 0}">
      </div>
      <div class="campo">
        <label for="ed-mascotas">Mascotas</label>
        <input type="number" id="ed-mascotas" inputmode="numeric" min="0" value="${b.mascotas || 0}">
      </div>
    </div>

    <label>Tinaja</label>
    <div class="segmentado" id="ed-tinaja">
      <button type="button" data-tinaja="no" aria-selected="${String(!b.tinaja)}">Sin tinaja</button>
      <button type="button" data-tinaja="si" aria-selected="${String(!!b.tinaja)}">Con tinaja</button>
    </div>
    <div id="ed-tinaja-caja" ${b.tinaja ? "" : "hidden"}>
      ${campoTurnoTinaja("ed", b.tinaja_fecha, hhmm(b.tinaja_hora), b.desde, b.hasta)}
      <div id="ed-tinaja-aviso"></div>
    </div>

    <div class="campo" style="margin-top:var(--e3)">
      <label for="ed-nombre">Nombre de quien reserva</label>
      <input type="text" id="ed-nombre" autocomplete="name" value="${esc(b.nombre || "")}">
    </div>
    <div class="campo">
      <label for="ed-telefono">Telefono</label>
      <input type="tel" id="ed-telefono" inputmode="tel" value="${esc(b.telefono || "")}">
    </div>
    <label>Por donde llego?</label>
    <div class="canales" id="ed-canales">
      ${(st.canal === "web" ? CANALES : CANALES_A_MANO).map((c) => `<button type="button" class="canal" data-canal="${c.id}"
          aria-pressed="${String(c.id === st.canal)}">${insignia(c.id)}<span>${c.nombre}</span></button>`).join("")}
    </div>`}
    <div class="campo" style="margin-top:var(--e3)">
      <label for="ed-nota">Nota (privada)</label>
      <input type="text" id="ed-nota" placeholder="Opcional" value="${esc(b.nota || "")}">
    </div>
    <div class="fila">
      <button type="button" class="secundario" data-ver="${b.id}">Volver</button>
      <button type="button" id="btn-guardar-edicion">Guardar cambios</button>
    </div>`);

  if (!esBloqueo) {
    $("#ed-canales").addEventListener("click", (e) => {
      const x = e.target.closest(".canal");
      if (!x) return;
      st.canal = x.dataset.canal;
      $("#ed-canales").querySelectorAll(".canal")
        .forEach((y) => y.setAttribute("aria-pressed", String(y === x)));
    });

    $("#ed-tinaja").addEventListener("click", (e) => {
      const x = e.target.closest("[data-tinaja]");
      if (!x) return;
      const con = x.dataset.tinaja === "si";
      $("#ed-tinaja").querySelectorAll("button")
        .forEach((y) => y.setAttribute("aria-selected", String(y === x)));
      $("#ed-tinaja-caja").hidden = !con;
      if (con) avisarChoqueTinaja("ed", b.id);
    });
    /* Se excluye la propia reserva del choque: si no, al reabrir su turno se
       avisaria de que choca consigo misma. */
    ["#ed-tinaja-fecha", "#ed-tinaja-hora"].forEach((s) =>
      $(s)?.addEventListener("change", () => avisarChoqueTinaja("ed", b.id)));
    if (b.tinaja) avisarChoqueTinaja("ed", b.id);
  }
  $("#btn-guardar-edicion").addEventListener("click", () => guardarEdicion(b));
}

async function guardarEdicion(b) {
  const esBloqueo = b.tipo === "bloqueo";
  const desde = $("#ed-desde").value, hasta = $("#ed-hasta").value;
  const nombre = esBloqueo ? null : $("#ed-nombre").value.trim();

  if (!desde || !hasta || hasta <= desde) {
    avisar("La salida tiene que ser posterior a la entrada.", "error"); return;
  }
  if (!esBloqueo) {
    if (!nombre)   { avisar("Falta el nombre de quien reserva.", "error"); return; }
    if (!st.canal) { avisar("Marca por donde llego la reserva.", "error"); return; }
  }

  const btn = $("#btn-guardar-edicion");
  btn.disabled = true; btn.textContent = "Guardando...";

  try {
    if (desde !== b.desde || hasta !== b.hasta) {
      const libre = await api("rpc/disponible", { method: "POST", body: JSON.stringify({
        p_cabana: b.cabana_id, p_entrada: desde, p_salida: hasta, p_excluir: b.id })});
      if (!libre) {
        avisar("Esas fechas chocan con otra reserva de la misma cabana.", "error");
        btn.disabled = false; btn.textContent = "Guardar cambios"; return;
      }
    }

    const cambios = esBloqueo
      ? { desde, hasta, nota: $("#ed-nota").value.trim() || null }
      : (() => {
          const conTinaja = $("#ed-tinaja [data-tinaja='si']")?.getAttribute("aria-selected") === "true";
          return { desde, hasta, nombre,
            telefono: $("#ed-telefono").value.trim() || null,
            adultos:  Number($("#ed-adultos").value)  || 1,
            ninos:    Number($("#ed-ninos").value)    || 0,
            mascotas: Number($("#ed-mascotas").value) || 0,
            tinaja:       conTinaja,
            tinaja_fecha: conTinaja ? $("#ed-tinaja-fecha").value : null,
            tinaja_hora:  conTinaja ? $("#ed-tinaja-hora").value  : null,
            canal:    st.canal,
            nota:     $("#ed-nota").value.trim() || null };
        })();

    await api(`bloqueos?id=eq.${b.id}`, { method: "PATCH", body: JSON.stringify(cambios) });
    cerrarModal();
    await Promise.all([cargarBloqueos(), cargarHoy()]);
    pintarCalendario(); pintarHoy();
    avisar("Cambios guardados.", "ok");
  } catch (err) {
    avisar(err.message, "error");
    btn.disabled = false; btn.textContent = "Guardar cambios";
  }
}

/* Un paso intermedio antes de borrar. El boton vive al final de una ficha que
   se abre de pasada, en un telefono y muchas veces al dia: sin preguntar, un
   toque mal dado hace desaparecer una reserva con su telefono y sus datos, y no
   hay papelera de donde sacarla.

   La confirmacion repite QUE se va a borrar, no solo pregunta "seguro": el
   error tipico no es apretar sin querer, es apretar en la reserva equivocada. */
function confirmarEliminar(id) {
  const b = buscarReserva(id);
  if (!b) return;
  const esBloqueo = b.tipo === "bloqueo";

  abrirModal(esBloqueo ? "¿Eliminar el bloqueo?" : "¿Eliminar la reserva?",
    `${nombreCabana(b.cabana_id)} · ${fechaCorta(b.desde)} a ${fechaCorta(b.hasta)}`, `
    <div class="aviso error">
      ${esBloqueo ? "Se va a liberar ese rango de fechas."
        : `Se va a borrar <b>${esc(b.nombre || "esta reserva")}</b> y a liberar esas
           fechas. El telefono y los datos del cliente se pierden.`}
      <br>No se puede deshacer.
    </div>
    <div class="fila">
      <button type="button" class="secundario" data-ver="${b.id}">No, volver</button>
      <button type="button" class="peligro" data-borrar="${b.id}">Si, eliminar</button>
    </div>`);
}

/* Adonde volver despues de tocar un pago. Si la reserva estaba desplegada en la
   seccion de hoy, esa ya se repinto sola: abrir la ficha encima seria una
   ventana de mas para ver lo que ya esta en pantalla. */
function volverTrasPago(id) {
  if (st.hoyAbierta === id) cerrarModal(); else verReserva(id);
}

/* Registrar un pago: monto, fecha y foto del comprobante. El monto viene
   propuesto por `cotizar()` —la mitad que corresponde— pero se puede corregir:
   en la practica se transfiere un numero redondo y el resto se ajusta. */
async function registrarPago(id, n) {
  const b = buscarReserva(id);
  if (!b) return;
  let foto = null;

  abrirModal(n === 1 ? "Registrar anticipo" : "Registrar saldo",
    `${b.nombre || "Reserva"} · ${nombreCabana(b.cabana_id)}`, `
    <div class="fila">
      <div class="campo">
        <label for="pg-monto">Monto</label>
        <input type="number" id="pg-monto" inputmode="numeric" step="1000" placeholder="Calculando...">
      </div>
      <div class="campo">
        <label for="pg-fecha">Fecha</label>
        <input type="date" id="pg-fecha" value="${hoyISO()}">
      </div>
    </div>
    <label>Comprobante de transferencia</label>
    <button type="button" class="secundario ancho" id="pg-elegir"
            style="margin-top:var(--e2);font-weight:500">Elegir o sacar foto</button>
    <p class="lista-vacia" id="pg-nombre-foto"
       style="padding:var(--e2) 0 0;text-align:left">Opcional. Se guarda achicada.</p>
    <input type="file" accept="image/*" id="pg-foto" hidden>
    <div class="fila" style="margin-top:var(--e4)">
      <button type="button" class="secundario" data-ver="${b.id}">Volver</button>
      <button type="button" id="pg-guardar">Guardar pago</button>
    </div>`);

  /* El monto se propone con la misma funcion que cotiza el bot, no con una
     division en el navegador: el porcentaje de anticipo es una regla del
     negocio y vive en la base. */
  api("rpc/cotizar", { method: "POST", body: JSON.stringify({
    p_cabana: b.cabana_id, p_entrada: b.desde, p_salida: b.hasta,
    p_adultos: b.adultos || 1, p_ninos: b.ninos || 0, p_tinaja: !!b.tinaja })})
    .then((c) => {
      const campo = $("#pg-monto");
      if (!campo || !c?.ok) return;
      campo.value = n === 1 ? c.anticipo : c.saldo;
      campo.placeholder = "";
    })
    .catch(() => { const campo = $("#pg-monto"); if (campo) campo.placeholder = ""; });

  $("#pg-elegir").addEventListener("click", () => $("#pg-foto").click());
  $("#pg-foto").addEventListener("change", (e) => {
    foto = e.target.files[0] || null;
    $("#pg-nombre-foto").textContent = foto
      ? `${foto.name} — ${Math.round(foto.size / 1024)} KB`
      : "Opcional. Se guarda achicada.";
  });

  $("#pg-guardar").addEventListener("click", async () => {
    const monto = Number($("#pg-monto").value) || 0;
    const fecha = $("#pg-fecha").value;
    if (!fecha)   { avisar("Falta la fecha del pago.", "error"); return; }
    if (monto < 1) { avisar("Indica el monto pagado.", "error"); return; }

    const btn = $("#pg-guardar");
    btn.disabled = true; btn.textContent = foto ? "Subiendo foto..." : "Guardando...";
    try {
      const cambios = { [`pago${n}_at`]: fecha, [`pago${n}_monto`]: monto };
      if (foto) cambios[`pago${n}_comprobante`] = await subirComprobante(foto, b.id, n);
      await api(`bloqueos?id=eq.${b.id}`, { method: "PATCH", body: JSON.stringify(cambios) });
      await Promise.all([cargarBloqueos(), cargarHoy()]);
      pintarCalendario(); pintarHoy();
      volverTrasPago(b.id);
      avisar(n === 1 ? "Anticipo registrado." : "Pago completo.", "ok");
    } catch (err) {
      avisar(err.message, "error");
      btn.disabled = false; btn.textContent = "Guardar pago";
    }
  });
}

/* Deshacer no borra la foto del bucket: si el pago se marcó por error, el
   comprobante sigue siendo la prueba de lo que pasó. Ocupa unos KB. */
async function deshacerPago(id, n) {
  try {
    await api(`bloqueos?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      [`pago${n}_at`]: null, [`pago${n}_monto`]: null })});
    await Promise.all([cargarBloqueos(), cargarHoy()]);
    pintarCalendario(); pintarHoy();
    volverTrasPago(id);
    avisar("Pago desmarcado.", "ok");
  } catch (err) { avisar(err.message, "error"); }
}

async function abrirComprobante(ruta, id) {
  try {
    const url = await urlComprobante(ruta);
    abrirModal("Comprobante", "", `<img class="comprobante" src="${url}" alt="Comprobante">
      <button type="button" class="secundario ancho" style="margin-top:var(--e3)"
              ${id ? `data-ver="${id}"` : "data-cerrar"}>Volver</button>`);
  } catch (err) { avisar(err.message, "error"); }
}

async function eliminarReserva(id) {
  const btn = $("[data-borrar]");
  if (btn) { btn.disabled = true; btn.textContent = "Eliminando..."; }
  try {
    await api(`bloqueos?id=eq.${id}`, { method: "DELETE" });
    cerrarModal();
    await Promise.all([cargarBloqueos(), cargarHoy()]);
    pintarCalendario(); pintarHoy();
    avisar("Eliminado.", "ok");
  } catch (err) {
    avisar(err.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Si, eliminar"; }
  }
}

/* El precio se muestra mientras se escribe, y lo calcula la base, no el
   navegador: es la misma funcion que usara el bot de WhatsApp. Dos copias de
   la formula divergirian, y el panel diria un precio y WhatsApp otro. */
async function cotizarEnFicha(cab) {
  const caja = $("#res-precio");
  if (!caja) return;
  const adultos = Number($("#res-adultos")?.value) || 0;
  const ninos   = Number($("#res-ninos")?.value)   || 0;
  if (adultos < 1) { caja.className = "aviso info"; caja.textContent = "Indica al menos un adulto."; return; }
  if (adultos + ninos > cab.capacidad_max) {
    caja.className = "aviso error";
    caja.textContent = `${cab.nombre} admite hasta ${cab.capacidad_max} personas.`;
    return;
  }
  try {
    const c = await api("rpc/cotizar", { method: "POST", body: JSON.stringify({
      p_cabana: cab.id, p_entrada: st.desde, p_salida: st.hasta,
      p_adultos: adultos, p_ninos: ninos, p_tinaja: !!st.nueva?.tinaja })});
    if (!c.ok) { caja.className = "aviso error"; caja.textContent = motivo(c); return; }
    caja.className = "aviso ok";
    caja.innerHTML = `<b style="font-size:17px">${clp(c.total)}</b> por ${c.noches} noche(s)` +
      `<br><span style="opacity:.85">Anticipo ${clp(c.anticipo)} &middot; saldo ${clp(c.saldo)} en la cabana</span>` +
      (c.tinaja ? `<br><span style="opacity:.85">Incluye tinaja ${clp(c.precio_tinaja)}</span>` : "") +
      (ninos ? `<br><span style="opacity:.7;font-size:12.5px">${ninos} menor${ninos === 1 ? "" : "es"}` +
               ` de ${(c.edad_nino_max || 11) + 1} sin recargo</span>` : "");

    /* El anticipo sigue a las personas: si el campo no se toco a mano, se
       actualiza solo cuando cambia el precio. */
    if (st.nueva) {
      st.nueva.sugerido = c.anticipo;
      if (!st.nueva.montoTocado) st.nueva.monto = c.anticipo;
    }
  } catch (err) { caja.className = "aviso error"; caja.textContent = err.message; }
}

const motivo = (c) => ({
  bajo_minimo_noches: `El minimo son ${c.minimo_noches} noches y pediste ${c.noches}.`,
  excede_capacidad:   `Esa cabana admite hasta ${c.capacidad_max} personas.`,
  fechas_invalidas:   "La salida tiene que ser posterior a la entrada.",
  personas_invalidas: "Indica al menos una persona.",
  cabana_no_encontrada: "Cabana no encontrada.",
  sin_tarifa_para_fecha: `No hay tarifa cargada para el ${c.fecha}.`,
}[c.motivo] || "No se pudo cotizar.");

async function guardar(tipo) {
  const cabana = st.eleccion;
  const d = st.nueva || {};
  const esReserva = tipo === "reserva";

  /* El anticipo, si ya lo pagaron. Se valida antes de escribir nada: guardar la
     reserva y que despues falle el pago dejaria una reserva a medio registrar y
     habria que acordarse de completarla. */
  const conAnticipo = esReserva && d.anticipo;
  const montoAnt = conAnticipo ? d.monto || 0 : 0;
  const fechaAnt = conAnticipo ? d.fecha : null;
  if (conAnticipo && (montoAnt < 1 || !fechaAnt)) {
    avisar("Falta el monto o la fecha del anticipo.", "error"); return;
  }

  const btn = esReserva ? $("#btn-guardar-reserva") : $("#btn-solo-bloquear");
  const texto = btn.textContent;
  btn.disabled = true;
  btn.textContent = d.foto ? "Subiendo comprobante..." : "Guardando...";

  try {
    /* `return=representation` para recuperar el id: la foto del comprobante se
       guarda en una carpeta con el id de la reserva, que hasta aqui no existe. */
    const [fila] = await api("bloqueos", { method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        cabana_id: cabana, desde: st.desde, hasta: st.hasta, origen: "manual", tipo,
        canal:    esReserva ? d.canal : null,
        nombre:   esReserva ? d.nombre : null,
        telefono: esReserva ? (d.telefono || null) : null,
        adultos:  esReserva ? (d.adultos || null) : null,
        ninos:    esReserva ? (d.ninos || 0) : 0,
        mascotas: esReserva ? (d.mascotas || 0) : 0,
        tinaja:       esReserva ? !!d.tinaja : false,
        tinaja_fecha: esReserva && d.tinaja ? d.tinajaFecha : null,
        tinaja_hora:  esReserva && d.tinaja ? d.tinajaHora  : null,
        nota:     d.nota || null,
        pago1_at:    conAnticipo ? fechaAnt : null,
        pago1_monto: conAnticipo ? montoAnt : null,
      })});

    /* La foto va en un segundo paso, y si falla no se pierde la reserva: se
       avisa y se puede adjuntar despues desde la ficha. */
    if (conAnticipo && d.foto && fila?.id) {
      try {
        const ruta = await subirComprobante(d.foto, fila.id, 1);
        await api(`bloqueos?id=eq.${fila.id}`, { method: "PATCH",
          body: JSON.stringify({ pago1_comprobante: ruta }) });
      } catch (err) {
        avisar("La reserva se guardo, pero el comprobante no subio.", "error");
      }
    }

    const nombreCab = nombreCabana(cabana);
    cerrarModal();
    st.desde = st.hasta = null; st.modo = "ver";
    await Promise.all([cargarBloqueos(), cargarHoy()]);
    pintarCalendario(); pintarHoy();
    avisar(esReserva
      ? `Reserva de ${d.nombre} guardada en ${nombreCab}.` +
        (conAnticipo ? ` Anticipo ${clp(montoAnt)} registrado.` : "")
      : `${nombreCab} bloqueada.`, "ok");
  } catch (err) {
    avisar(err.message, "error");
    btn.disabled = false; btn.textContent = texto;
  }
}

/* --------------------------------------------------------------- Tarifas -- */
function pintarTarifas() {
  $("#precio-base").value        = st.tarifaBase?.precio_base ?? "";
  $("#persona-extra").value      = st.reglas?.precio_persona_extra ?? "";
  $("#min-noches").value         = st.reglas?.minimo_noches ?? "";
  $("#anticipo").value           = st.reglas?.porcentaje_anticipo ?? "";
  $("#personas-incluidas").value = st.reglas?.personas_incluidas ?? "";
  $("#check-in").value           = (st.reglas?.check_in  || "16:00").slice(0, 5);
  $("#check-out").value          = (st.reglas?.check_out || "11:00").slice(0, 5);
  $("#edad-nino").value          = st.reglas?.edad_nino_max ?? 11;
  $("#precio-tinaja").value      = st.reglas?.precio_tinaja ?? 25000;
  $("#tinaja-horas").value       = st.reglas?.tinaja_horas ?? 2;
  $("#lbl-incluidas").textContent = st.reglas?.personas_incluidas ?? 5;
}

$("#btn-guardar-precio").addEventListener("click", async () => {
  try {
    await api(`tarifas?id=eq.${st.tarifaBase.id}`, { method: "PATCH",
      body: JSON.stringify({ precio_base: Number($("#precio-base").value) }) });
    await api("reglas?id=eq.1", { method: "PATCH", body: JSON.stringify({
      precio_persona_extra: Number($("#persona-extra").value),
      actualizado_at: new Date().toISOString() }) });
    await cargarBase(); pintarTarifas();
    avisarEn("#aviso-tarifas", "Precio guardado. El bot ya cotiza con este valor.", "ok");
  } catch (err) { avisarEn("#aviso-tarifas", err.message, "error"); }
});

$("#btn-guardar-reglas").addEventListener("click", async () => {
  try {
    await api("reglas?id=eq.1", { method: "PATCH", body: JSON.stringify({
      minimo_noches:       Number($("#min-noches").value),
      porcentaje_anticipo: Number($("#anticipo").value),
      personas_incluidas:  Number($("#personas-incluidas").value),
      edad_nino_max:       Number($("#edad-nino").value),
      precio_tinaja:       Number($("#precio-tinaja").value),
      tinaja_horas:        Number($("#tinaja-horas").value) || 2,
      check_in:            $("#check-in").value,
      check_out:           $("#check-out").value,
      actualizado_at:      new Date().toISOString() }) });
    await cargarBase(); pintarTarifas();
    avisarEn("#aviso-tarifas", "Reglas guardadas.", "ok");
  } catch (err) { avisarEn("#aviso-tarifas", err.message, "error"); }
});

/* ------------------------------------------------------------- Cotizador -- */
$("#btn-cotizar").addEventListener("click", async () => {
  const caja = $("#resultado-cotizacion");
  const entrada = $("#cot-entrada").value, salida = $("#cot-salida").value;
  if (!entrada || !salida) { caja.innerHTML = '<div class="aviso error">Faltan las fechas.</div>'; return; }

  try {
    const cabana = $("#cot-cabana").value;
    const [cot, libre] = await Promise.all([
      api("rpc/cotizar", { method: "POST", body: JSON.stringify({
        p_cabana: cabana, p_entrada: entrada, p_salida: salida,
        p_adultos: Number($("#cot-adultos").value),
        p_ninos:   Number($("#cot-ninos").value) || 0 })}),
      api("rpc/disponible", { method: "POST", body: JSON.stringify({
        p_cabana: cabana, p_entrada: entrada, p_salida: salida })}),
    ]);

    if (!cot.ok) { caja.innerHTML = `<div class="aviso error">${motivo(cot)}</div>`; return; }

    caja.innerHTML = `
      ${libre ? '<div class="aviso ok">Fechas libres.</div>'
              : '<div class="aviso error">Hay una reserva en ese rango.</div>'}
      <div class="tarjeta">
        <h2>${esc(cot.cabana)} &middot; ${cot.noches} noche(s) &middot; ${cot.personas} personas</h2>
        <div class="total">${clp(cot.total)}</div>
        <div style="margin-top:var(--e4)">
          ${cot.ninos ? `<div class="linea-detalle"><span>Sin recargo</span>
            <b>${cot.ninos} menor${cot.ninos === 1 ? "" : "es"} de ${(cot.edad_nino_max || 11) + 1}</b></div>` : ""}
          <div class="linea-detalle"><span>Anticipo online</span><b>${clp(cot.anticipo)}</b></div>
          <div class="linea-detalle"><span>Saldo en la cabana</span><b>${clp(cot.saldo)}</b></div>
          <div class="linea-detalle"><span>Check-in / check-out</span>
            <b>${cot.check_in.slice(0,5)} &middot; ${cot.check_out.slice(0,5)}</b></div>
        </div>
      </div>
      <div class="tarjeta">
        <h2>Noche por noche</h2>
        ${cot.detalle.map((d) => `<div class="linea-detalle">
            <span>${fechaCorta(d.fecha)}</span><b>${clp(d.noche)}</b></div>`).join("")}
      </div>`;
  } catch (err) { caja.innerHTML = `<div class="aviso error">${esc(err.message)}</div>`; }
});

/* ---------------------------------------------------------------- Avisos -- */
function avisarEn(sel, texto, tipo) {
  const c = $(sel);
  c.innerHTML = `<div class="aviso ${tipo}">${esc(texto)}</div>`;
  setTimeout(() => { c.innerHTML = ""; }, 4000);
}
function avisar(texto, tipo) {
  let c = $("#aviso-flotante");
  if (!c) {
    c = document.createElement("div");
    c.id = "aviso-flotante";
    c.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(var(--toque) + 12px);z-index:60";
    document.body.appendChild(c);
  }
  c.innerHTML = `<div class="aviso ${tipo}" style="box-shadow:var(--sombra)">${esc(texto)}</div>`;
  setTimeout(() => { c.innerHTML = ""; }, 3200);
}


/* ============================================================================
   Huespedes  ·  la app del huesped vista desde este lado
   ============================================================================
   La app de bienvenida (welcome.valleaventura-chile.com) escribe aqui: pellet,
   turnos de tinaja, averias y mensajes. Esta vista es donde eso se ve y se
   responde.

   El enlace de la app se manda por WhatsApp desde aqui. Se genera una sola vez
   por reserva y es idempotente: reenviarlo NO invalida el que el huesped ya
   tiene abierto, asi que se puede reenviar sin miedo si dice que lo perdio. */

const HU_APP_URL = "https://welcome.valleaventura-chile.com";

const HU_ETIQUETA = {
  pellet: "Pellet",
  tinaja: "Tinaja",
  falla:  "Averia",
  otro:   "Mensaje",
};

const HU_FALLA = {
  estufa: "Estufa", califont: "Califont", bano: "Bano", gas: "Gas",
  cocina: "Cocina", lavaplatos: "Lavaplatos", encimera: "Encimera",
  luz: "Luz", agua: "Agua", wifi: "WiFi",
};

const hu = { filtro: "pendientes", solicitudes: [], alojados: [], porLlegar: [], chat: null };

/* Cuanto hace que llego, en palabras. "hace 4 h" dice mas de un vistazo que
   una hora exacta cuando lo que importa es si lleva esperando mucho. */
function huHace(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1)  return "recien";
  if (min < 60) return "hace " + min + " min";
  const h = Math.round(min / 60);
  if (h < 24)   return "hace " + h + " h";
  const d = Math.round(h / 24);
  return "hace " + d + (d === 1 ? " dia" : " dias");
}

async function huCargar() {
  const hoy = hoyISO();
  /* `pago1_at` y los montos hacen falta para poder decirle al huesped cuanto
     abono y cuanto le queda. Sin la fecha no se cuenta como pagado: el monto
     puede estar anotado antes de marcarlo. */
  const CAMPOS = "id,cabana_id,nombre,telefono,desde,hasta,token,adultos,ninos,tinaja,"
               + "pago1_at,pago1_monto,pago2_at,pago2_monto,confirmacion_enviada_at";
  /* Los que llegan en los proximos 30 dias. Mas alla no sirve de nada tenerlos
     delante todos los dias. */
  const tope = sumarDias(hoy, 30);
  const [aloj, porLlegar, sol] = await Promise.all([
    api(`bloqueos?select=${CAMPOS}`
        + `&tipo=eq.reserva&estado=eq.confirmada&desde=lte.${hoy}&hasta=gt.${hoy}&order=cabana_id`),
    api(`bloqueos?select=${CAMPOS}`
        + `&tipo=eq.reserva&estado=eq.confirmada&desde=gt.${hoy}&desde=lte.${tope}&order=desde`),
    api("solicitudes_con_foto?select=*&order=creado_at.desc&limit=120"),
  ]);
  hu.alojados = aloj || [];
  hu.porLlegar = porLlegar || [];
  hu.solicitudes = sol || [];
  huBadge();
}

/* Cerrada es cerrada, se haya concedido o negado. Un turno de tinaja
   rechazado ya no espera nada de nadie: si siguiera contando como pendiente,
   el numero rojo no bajaria nunca y dejaria de significar algo. */
const HU_CERRADA = (x) => x.estado === "resuelta" || x.estado === "rechazada";

/* El numero rojo de la pestania. Sin esto habria que entrar a mirar. */
function huBadge() {
  const n = hu.solicitudes.filter((x) => !HU_CERRADA(x)).length;
  const b = $("#hu-badge");
  if (!b) return;
  b.hidden = n === 0;
  b.textContent = n > 9 ? "9+" : String(n);
}

async function pintarHuespedes() {
  await huCargar();

  /* ── Alojados ahora y Llegan pronto ──
     Misma tarjeta para los dos, porque es el mismo huesped en dos momentos.
     Cambia el subtitulo —uno sale, el otro llega— y que el enlace de la app
     solo se ofrece a quien ya esta dentro: mandarlo tres semanas antes es
     regalar un enlace que va a estar perdido en el chat cuando haga falta. */
  const tarjeta = (b, yaLlego) => {
    const cab = st.cabanas.find((c) => c.id === b.cabana_id);
    const avisado = !!b.confirmacion_enviada_at;
    return `
      <div class="hu-card" data-huesped="${b.id}">
        <div class="hu-card-top">
          <div>
            <b>${esc(b.nombre || "Sin nombre")}</b>
            <div class="hu-card-sub">${esc(cab ? cab.nombre : b.cabana_id)}
              &middot; ${yaLlego ? "sale " + fechaCorta(b.hasta) : "llega " + fechaCorta(b.desde)}</div>
          </div>
          ${yaLlego
            ? `<span class="hu-pill ${b.token ? "ok" : ""}">${b.token ? "app enviada" : "sin app"}</span>`
            : `<span class="hu-pill ${avisado ? "ok" : ""}">${avisado ? "confirmada" : "sin confirmar"}</span>`}
        </div>
        <div class="hu-card-acciones">
          <!-- Sigue pulsable despues de enviada: un WhatsApp se puede no haber
               ido, o el huesped puede pedir que se lo repitan. Lo que cambia es
               que se ve que ya se hizo, para no mandarlo dos veces sin querer. -->
          <button type="button" class="hu-btn-confirmar${avisado ? " hecho" : ""}" data-confirmar="${b.id}">
            ${avisado ? "Confirmacion enviada &middot; reenviar" : "Confirmar reserva"}
          </button>
          ${yaLlego ? `<button type="button" class="hu-btn-wa" data-enviar="${b.id}">
            Enviar app por WhatsApp
          </button>` : ""}
          <button type="button" class="hu-btn-chat" data-chat="${b.id}">Mensajes</button>
        </div>
      </div>`;
  };

  const caja = $("#hu-alojados");
  caja.innerHTML = hu.alojados.length
    ? hu.alojados.map((b) => tarjeta(b, true)).join("")
    : '<p class="lista-vacia">No hay nadie alojado hoy.</p>';

  const cajaLlegan = $("#hu-porllegar");
  cajaLlegan.innerHTML = hu.porLlegar.length
    ? hu.porLlegar.map((b) => tarjeta(b, false)).join("")
    : '<p class="lista-vacia">Nadie llega en los proximos 30 dias.</p>';

  /* ── Solicitudes ── */
  const lista = hu.filtro === "pendientes"
    ? hu.solicitudes.filter((x) => !HU_CERRADA(x))
    : hu.solicitudes;

  const cajaS = $("#hu-solicitudes");
  if (!lista.length) {
    cajaS.innerHTML = '<p class="lista-vacia">'
      + (hu.filtro === "pendientes" ? "Nada pendiente. Todo al dia." : "Aun no hay solicitudes.")
      + "</p>";
    return;
  }

  cajaS.innerHTML = lista.map((x) => {
    const b = hu.alojados.find((a) => a.id === x.bloqueo_id);
    const cab = b && st.cabanas.find((c) => c.id === b.cabana_id);
    const quien = b ? `${esc(b.nombre || "")} &middot; ${esc(cab ? cab.nombre : b.cabana_id)}` : "";
    let detalle = "";
    if (x.tipo === "tinaja") {
      detalle = `${fechaCorta(x.tinaja_fecha)} a las ${String(x.tinaja_hora).slice(0, 5)}`;
    } else if (x.tipo === "falla") {
      detalle = (HU_FALLA[x.asunto] || x.asunto || "") + (x.detalle ? ": " + esc(x.detalle) : "");
    } else if (x.detalle) {
      detalle = esc(x.detalle);
    }
    return `
      <div class="hu-sol ${HU_CERRADA(x) ? "hecha" : ""} tipo-${x.tipo}">
        <div class="hu-sol-main">
          <div class="hu-sol-head">
            <span class="hu-sol-tipo">${HU_ETIQUETA[x.tipo] || x.tipo}</span>
            <span class="hu-sol-hace">${huHace(x.creado_at)}</span>
          </div>
          ${quien   ? `<div class="hu-sol-quien">${quien}</div>` : ""}
          ${detalle ? `<div class="hu-sol-detalle">${detalle}</div>` : ""}
          ${x.tiene_foto ? `<button type="button" class="hu-sol-foto" data-foto="${x.id}">Ver la foto</button>` : ""}
        </div>
        ${x.estado === "resuelta"
          ? '<span class="hu-sol-ok">Listo</span>'
          : x.estado === "rechazada"
          /* Dicho tal cual, y no como un "listo" mas: al revisar el dia hay que
             poder ver de un vistazo a quien se le nego un turno, que es quien
             probablemente espera que le ofrezcan otra hora. */
          ? '<span class="hu-sol-nok">Rechazada</span>'
          : x.tipo === "tinaja"
            /* La tinaja no es "hecho" o "no hecho": es un turno que hay que
               conceder o negar, y hasta que se aprueba no existe en la agenda.
               Aprobar la escribe en `bloqueos` y avisa al huesped por el chat. */
            ? `<div class="hu-sol-tinaja">
                 <button type="button" class="hu-sol-si" data-tinaja-si="${x.id}">Aprobar</button>
                 <button type="button" class="hu-sol-no" data-tinaja-no="${x.id}">Rechazar</button>
               </div>`
            /* Dos pasos y no uno: "en camino" le aparece al huesped en la app y
               deja de preguntar si alguien lo vio. Ya vista, solo queda cerrar. */
            : `<div class="hu-sol-tinaja">
                 ${x.estado === "nueva"
                   ? `<button type="button" class="hu-sol-no" data-encamino="${x.id}">En camino</button>`
                   : ""}
                 <button type="button" class="hu-sol-btn" data-resolver="${x.id}">Marcar hecho</button>
               </div>`}
      </div>`;
  }).join("");
}

/* Genera (o recupera) el enlace y abre WhatsApp con el mensaje escrito.
   No se manda solo: se abre WhatsApp para que Jose lo revise y lo envie. */
/* El mensaje de confirmacion. Lo pide Jose para mandarlo apenas entra una
   reserva: el cliente acaba de pagar por internet a un desconocido y lo que
   calma esa duda no es un correo automatico, es una persona escribiendo.

   El total lo calcula `cotizar()`, no el panel: es la misma funcion que cobro,
   asi que el numero del mensaje es exactamente el que se le prometio. Si
   fallara, se manda igual sin las cifras — un mensaje sin montos sirve; uno con
   montos inventados, no. */
async function huConfirmarReserva(id) {
  const b = [...hu.alojados, ...hu.porLlegar].find((x) => x.id === id);
  if (!b) return;
  if (!b.telefono) { alert("Esa reserva no tiene telefono guardado."); return; }

  const cab = st.cabanas.find((c) => c.id === b.cabana_id);
  const nombre = (b.nombre || "").split(" ")[0];
  const noches = nochesEntre(b.desde, b.hasta);
  const abonado = pagado(b);

  let c = null;
  try {
    c = await api("rpc/cotizar", { method: "POST", body: JSON.stringify({
      p_cabana: b.cabana_id, p_entrada: b.desde, p_salida: b.hasta,
      p_adultos: b.adultos || 1, p_ninos: b.ninos || 0, p_tinaja: !!b.tinaja })});
  } catch { /* se manda sin cifras */ }

  const personas = [
    `${b.adultos || 1} adulto${(b.adultos || 1) === 1 ? "" : "s"}`,
    b.ninos ? `${b.ninos} niño${b.ninos === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" y ");

  const l = [
    `¡Hola ${nombre}! Te habla el equipo de Valle Aventura para confirmar tu reserva.`,
    "",
    `${cab ? cab.nombre : "Cabaña"}`,
    `Llegada: ${fechaCorta(b.desde)}${c?.check_in ? " desde las " + hhmm(c.check_in) : ""}`,
    `Salida: ${fechaCorta(b.hasta)}${c?.check_out ? " hasta las " + hhmm(c.check_out) : ""}`,
    `${noches} noche${noches === 1 ? "" : "s"} · ${personas}`,
  ];

  if (c?.ok) {
    const falta = Math.max(0, c.total - abonado);
    l.push("", `Total: ${clp(c.total)}`,
           `Abono recibido: ${clp(abonado)}`,
           `Queda por pagar al llegar: ${clp(falta)}`);
  } else if (abonado) {
    l.push("", `Abono recibido: ${clp(abonado)}`);
  }

  /* Corto a proposito. Aqui el cliente solo necesita saber que va a recibir
     algo y cuando; el detalle de para que sirve la app va en el mensaje que
     lleva el enlace, cuando ya lo puede abrir. Explicarlo dos veces hace que no
     se lea ninguna.

     Y en una sola linea: WhatsApp ajusta solo, y partir la frase a mano deja el
     texto en escalera en cuanto cambia el ancho de la pantalla. */
  l.push("",
    "El día antes de tu llegada te enviamos por aquí el acceso a nuestra app, con toda la información de tu estadía.",
    "",
    "Cualquier cosa, escríbenos por aquí. ¡Te esperamos!");

  const texto = l.join("\n");
  const fono = String(b.telefono).replace(/[^0-9]/g, "");
  window.open(`https://wa.me/${fono}?text=${encodeURIComponent(texto)}`, "_blank");

  /* Se anota DESPUES de abrir WhatsApp y sin bloquear: si la marca fallara,
     lo peor que pasa es que el boton siga diciendo "confirmar" y se mande dos
     veces. Al reves -marcar antes y que WhatsApp no se abra- el panel diria
     que ya se aviso a alguien que no recibio nada, y eso no se descubre hasta
     que el huesped llega sin saber nada. */
  const ahora = new Date().toISOString();
  b.confirmacion_enviada_at = ahora;
  pintarHuespedes();
  api(`bloqueos?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ confirmacion_enviada_at: ahora }),
  }).catch(() => {
    b.confirmacion_enviada_at = null;
    avisar("Se abrio WhatsApp pero no se pudo anotar el aviso.", "error");
    pintarHuespedes();
  });
}

async function huEnviarApp(id) {
  const b = hu.alojados.find((a) => a.id === id);
  if (!b) return;
  if (!b.telefono) { alert("Esa reserva no tiene telefono guardado."); return; }

  try {
    const token = await api("rpc/generar_acceso", {
      method: "POST",
      body: JSON.stringify({ p_bloqueo: id }),
    });
    b.token = token;

    const cab = st.cabanas.find((c) => c.id === b.cabana_id);
    const nombre = (b.nombre || "").split(" ")[0];
    const texto = [
      `¡Hola ${nombre}! Te dejo el acceso a nuestra app de bienvenida.`,
      "",
      `Ahí encuentras qué hacer en el valle, los senderos, dónde comer,`,
      `y puedes pedirnos pellet, reservar la tinaja o avisarnos si algo falla.`,
      "",
      `${HU_APP_URL}/?r=${token}`,
      "",
      `Es tu enlace personal para ${cab ? cab.nombre : "tu cabaña"}. Cualquier cosa, escríbenos por ahí.`,
    ].join("\n");

    // Solo digitos: wa.me rechaza el + y los espacios.
    const fono = String(b.telefono).replace(/[^0-9]/g, "");
    window.open(`https://wa.me/${fono}?text=${encodeURIComponent(texto)}`, "_blank");
    pintarHuespedes();
  } catch (e) {
    alert("No se pudo generar el enlace: " + e.message);
  }
}

/* Aprobar escribe el turno en la agenda; rechazar no toca nada. Las dos avisan
   al huesped por la conversacion, porque no tiene por que estar mirando la
   pantalla cuando Jose decide. */
async function huResolverTinaja(id, aprobar) {
  if (!aprobar && !confirm("Rechazar este turno de tinaja?")) return;
  try {
    await api("rpc/resolver_tinaja", {
      method: "POST",
      body: JSON.stringify({ p_solicitud: id, p_aprobar: aprobar }),
    });
    pintarHuespedes();
  } catch (e) {
    alert(e.message);
  }
}

/* La foto se pide solo cuando Jose la quiere ver. Van en base64 y traerlas
   todas de golpe en el listado seria arrastrar megas para pintar texto. */
async function huVerFoto(id, boton) {
  const caja = boton.parentElement;
  const ya = caja.querySelector(".hu-foto-vista");
  if (ya) { ya.remove(); boton.textContent = "Ver la foto"; return; }
  boton.textContent = "Cargando\u2026";
  try {
    const r = await api(`solicitud_fotos?select=datos&solicitud_id=eq.${id}`);
    const d = r && r[0] && r[0].datos;
    if (!d) { boton.textContent = "No se pudo cargar"; return; }
    const img = document.createElement("img");
    img.className = "hu-foto-vista";
    img.src = d;
    img.alt = "Foto de la falla";
    caja.appendChild(img);
    boton.textContent = "Ocultar la foto";
  } catch (e) {
    boton.textContent = "No se pudo cargar";
  }
}

/* "En camino": el huesped lo ve al momento en su app. */
async function huEnCamino(id) {
  try {
    await api(`solicitudes?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "vista", visto_at: new Date().toISOString() }),
    });
    const s = hu.solicitudes.find((x) => x.id === id);
    if (s) { s.estado = "vista"; }
    pintarHuespedes();
  } catch (e) {
    alert(e.message);
  }
}

async function huResolver(id) {
  try {
    await api(`solicitudes?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ estado: "resuelta", resuelto_at: new Date().toISOString() }),
    });
    pintarHuespedes();
  } catch (e) { alert("No se pudo marcar: " + e.message); }
}

/* ── Conversacion ── */
async function huAbrirChat(id) {
  const b = hu.alojados.find((a) => a.id === id);
  if (!b) return;
  hu.chat = id;
  const cab = st.cabanas.find((c) => c.id === b.cabana_id);
  abrirModal(esc(b.nombre || "Huesped"), esc(cab ? cab.nombre : b.cabana_id),
             '<p class="lista-vacia">Cargando...</p>');
  huPintarChat();
}

async function huPintarChat() {
  const id = hu.chat;
  if (!id) return;
  let msgs = [];
  try {
    msgs = await api(`mensajes?bloqueo_id=eq.${id}&order=creado_at&select=*`);
    // Lo que escribio el huesped queda leido en cuanto Jose abre la conversacion.
    const nuevos = msgs.filter((m) => m.de === "huesped" && !m.leido);
    if (nuevos.length) {
      await api(`mensajes?bloqueo_id=eq.${id}&de=eq.huesped&leido=is.false`, {
        method: "PATCH", body: JSON.stringify({ leido: true }),
      });
    }
  } catch (e) { /* se pinta vacio */ }

  const cuerpo = $("#modal-cuerpo");
  if (!cuerpo) return;
  cuerpo.innerHTML = `
    <div class="hu-chat">
      ${msgs.length ? msgs.map((m) => `
        <div class="hu-msg ${m.de === "host" ? "host" : "huesped"}">
          <div class="hu-msg-txt">${esc(m.texto)}</div>
          <div class="hu-msg-hora">${huHace(m.creado_at)}</div>
        </div>`).join("")
        : '<p class="lista-vacia">Aun no hay mensajes.</p>'}
    </div>
    <div class="hu-chat-bar">
      <input id="hu-chat-input" type="text" placeholder="Escribe tu respuesta..." autocomplete="off">
      <button type="button" id="hu-chat-send">Enviar</button>
    </div>`;

  const cont = cuerpo.querySelector(".hu-chat");
  if (cont) cont.scrollTop = cont.scrollHeight;

  const enviar = async () => {
    const inp = $("#hu-chat-input");
    const v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    try {
      await api("mensajes", {
        method: "POST",
        body: JSON.stringify({ bloqueo_id: id, de: "host", texto: v }),
      });
      huPintarChat();
    } catch (e) { alert("No se pudo enviar: " + e.message); }
  };
  $("#hu-chat-send").addEventListener("click", enviar);
  $("#hu-chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") enviar(); });
}

/* ── Eventos de la vista ── */
document.addEventListener("click", (e) => {
  const conf = e.target.closest("[data-confirmar]");
  if (conf) { huConfirmarReserva(conf.dataset.confirmar); return; }

  const env = e.target.closest("[data-enviar]");
  if (env) { huEnviarApp(env.dataset.enviar); return; }
  const tsi = e.target.closest("[data-tinaja-si]");
  if (tsi) { huResolverTinaja(tsi.dataset.tinajaSi, true); return; }
  const tno = e.target.closest("[data-tinaja-no]");
  if (tno) { huResolverTinaja(tno.dataset.tinajaNo, false); return; }
  const enc = e.target.closest("[data-encamino]");
  if (enc) { huEnCamino(enc.dataset.encamino); return; }
  const fot = e.target.closest("[data-foto]");
  if (fot) { huVerFoto(fot.dataset.foto, fot); return; }
  const res = e.target.closest("[data-resolver]");
  if (res) { huResolver(res.dataset.resolver); return; }
  const cha = e.target.closest("[data-chat]");
  if (cha) { huAbrirChat(cha.dataset.chat); return; }
  const fil = e.target.closest("#hu-filtros button");
  if (fil) {
    hu.filtro = fil.dataset.filtro;
    document.querySelectorAll("#hu-filtros button")
      .forEach((x) => x.setAttribute("aria-selected", String(x === fil)));
    pintarHuespedes();
  }
});


/* ============================================================================
   Avisos al telefono
   ============================================================================
   El panel pide permiso, registra este dispositivo en la base y a partir de
   ahi la Edge Function `avisos` le manda las notificaciones.

   Cada dispositivo se registra por separado: Jose, su papa y Javiera reciben
   los mismos avisos en sus propios telefonos sin pisarse. */

const VAPID_PUBLICA = "BOOBabMlwesyBFQKK-PjtuoVwaceAeIWYbf6vfw7iLNsXExXQCVs8ASzw-xRcHdvBEB72DsevGsw27znNvk-cEY";

/* La clave publica viaja como bytes, no como texto. */
function claveABytes(base64) {
  const relleno = "=".repeat((4 - (base64.length % 4)) % 4);
  const limpia = (base64 + relleno).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(limpia);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* Un nombre reconocible para saber que telefono es cual en la base. */
function nombreDispositivo() {
  const ua = navigator.userAgent;
  const so = /iPhone|iPad/.test(ua) ? "iPhone"
           : /Android/.test(ua) ? "Android"
           : /Mac/.test(ua) ? "Mac"
           : /Windows/.test(ua) ? "Windows" : "Dispositivo";
  const quien = (sesion && sesion.user && sesion.user.email || "").split("@")[0];
  return quien ? so + " de " + quien : so;
}

async function avisosEstado() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "no-soportado";
  if (!window.isSecureContext) return "sin-https";
  if (Notification.permission === "denied") return "bloqueado";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub ? "activo" : "inactivo";
}

async function avisosActivar() {
  const estado = await avisosEstado();

  if (estado === "no-soportado") {
    alert("Este navegador no admite notificaciones."); return;
  }
  if (estado === "sin-https") {
    alert("Las notificaciones necesitan https. Abre el panel en panel.valleaventura-chile.com."); return;
  }
  if (estado === "bloqueado") {
    alert("Bloqueaste las notificaciones para este sitio. Hay que permitirlas en los ajustes del navegador."); return;
  }

  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") return;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      // Obligatorio en todos los navegadores: no se puede recibir un push
      // silencioso, siempre hay que mostrar algo. Nos viene bien.
      userVisibleOnly: true,
      applicationServerKey: claveABytes(VAPID_PUBLICA),
    });
  }

  const j = sub.toJSON();
  try {
    /* `on_conflict` sobre el endpoint: si este telefono ya estaba registrado se
       actualiza en vez de duplicarse. Reinstalar la app genera un endpoint
       nuevo, asi que el viejo se desactiva solo al primer fallo de envio. */
    await api("push_dispositivos?on_conflict=endpoint", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        endpoint: j.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
        etiqueta: nombreDispositivo(),
        activo: true,
        fallos: 0,
      }),
    });
    await pintarAvisos();
    alert("Listo. Este telefono ya recibe los avisos.");
  } catch (e) {
    alert("No se pudo registrar: " + e.message);
  }
}

async function avisosDesactivar() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) {
    try {
      await api("push_dispositivos?endpoint=eq." + encodeURIComponent(sub.endpoint), {
        method: "PATCH", body: JSON.stringify({ activo: false }),
      });
    } catch (e) { /* da igual: lo importante es cancelar del lado del navegador */ }
    await sub.unsubscribe();
  }
  await pintarAvisos();
}

/* Que categorias quiere recibir. */
async function avisosCategoria(cat, activa) {
  try {
    await api("avisos_config?categoria=eq." + cat, {
      method: "PATCH", body: JSON.stringify({ activa }),
    });
  } catch (e) { alert("No se pudo guardar: " + e.message); }
}

const CATEGORIAS = [
  { id: "huesped",   nombre: "Lo que pide el huesped", detalle: "Averias, pellet, tinaja y mensajes" },
  { id: "reservas",  nombre: "Reservas",               detalle: "Nuevas, modificadas y canceladas" },
  { id: "pagos",     nombre: "Pagos",                  detalle: "Abonos recibidos y rechazados" },
  { id: "tinaja",    nombre: "Tinaja",                 detalle: "El dia antes y una hora antes" },
  { id: "operacion", nombre: "El dia a dia",           detalle: "Llegadas, salidas, aseo y pellet" },
  { id: "precios",   nombre: "Control",                detalle: "Cambios de precio y accesos" },
  /* Se puede apagar como cualquier otra, pero apagarla apaga TAMBIEN el aviso
     de que una alarma esta sonando. Por eso el detalle lo dice: no es una
     categoria mas, y quien la apague tiene que saber que renuncia a eso. */
  { id: "alarmas",   nombre: "Alarmas",                detalle: "Armar, desarmar y — sobre todo — cuando salta una" },
];

async function pintarAvisos() {
  const caja = $("#vista-avisos");
  if (!caja) return;

  const estado = await avisosEstado();
  let cfg = [];
  try { cfg = await api("avisos_config?select=*"); } catch (e) { cfg = []; }

  const explica = {
    "no-soportado": "Este navegador no admite notificaciones.",
    "sin-https":    "Abre el panel en panel.valleaventura-chile.com para poder activarlas.",
    "bloqueado":    "Las bloqueaste para este sitio. Hay que permitirlas en los ajustes del navegador.",
    "inactivo":     "Este telefono todavia no recibe avisos.",
    "activo":       "Este telefono recibe los avisos.",
  }[estado];

  caja.innerHTML = `
    <h2 class="titulo-seccion">Avisos a este telefono</h2>
    <div class="av-estado ${estado}">
      <div>
        <b>${estado === "activo" ? "Activados" : "Desactivados"}</b>
        <div class="av-sub">${explica}</div>
      </div>
      ${estado === "activo"
        ? '<button type="button" class="secundario" id="av-off">Desactivar</button>'
        : (estado === "inactivo"
            ? '<button type="button" id="av-on">Activar</button>'
            : "")}
    </div>

    <h2 class="titulo-seccion" style="margin-top:26px">Que quiero recibir</h2>
    <div class="av-cats">
      ${CATEGORIAS.map((c) => {
        const f = cfg.find((x) => x.categoria === c.id);
        const on = !f || f.activa;
        return `
          <label class="av-cat">
            <span>
              <b>${esc(c.nombre)}</b>
              <span class="av-sub">${esc(c.detalle)}</span>
            </span>
            <input type="checkbox" data-cat="${c.id}" ${on ? "checked" : ""}>
          </label>`;
      }).join("")}
    </div>
    <p class="av-nota">No hay horario de silencio: todos los avisos llegan cuando ocurren.</p>`;

  const on = $("#av-on"); if (on) on.addEventListener("click", avisosActivar);
  const off = $("#av-off"); if (off) off.addEventListener("click", avisosDesactivar);
  caja.querySelectorAll("[data-cat]").forEach((i) =>
    i.addEventListener("change", () => avisosCategoria(i.dataset.cat, i.checked)));

  /* Los ajustes de eWeLink se pintan al final de esta misma pantalla: es la
     pestaña de ajustes aunque se llame Avisos, y abrir un septimo destino para
     algo que se toca dos veces en la vida no lo vale. */
  await elAjustes(caja);
}

/* El service worker avisa a que pestania ir cuando se toca una notificacion. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.tipo === "ir") {
      const b = document.querySelector(`nav.tabs button[data-vista="${e.data.destino}"]`);
      if (b) b.click();
    }
  });
}

/* ============================================================================
   eWeLink — las luces y el timer de la tinaja
   ============================================================================
   El panel NO habla con eWeLink: habla con la Edge Function, que es la unica
   que tiene la clave. Aqui no hay ni un token de CoolKit, y no puede haberlo:
   esto es HTML estatico y cualquiera lee su codigo fuente.

   Y NO se muestra si una luz esta encendida o apagada. No es un olvido: el
   huesped la apaga desde el interruptor de la pared cuando quiere, y entonces
   lo que dijera esta pantalla seria mentira hasta la siguiente consulta. Dos
   botones que hacen lo que dicen valen mas que un estado que se queda viejo
   solo. Es la misma regla por la que el service worker no cachea datos. */

const EL_FN = `${SUPABASE_URL}/functions/v1/ewelink`;
const el = { estado: null, hayTinaja: false };

async function elLlamar(ruta, cuerpo) {
  const r = await fetch(`${EL_FN}/${ruta}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${sesion?.access_token || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpo || {}),
  });
  const d = await r.json().catch(() => null);
  /* El mensaje viene de la funcion y ya esta escrito para leerse ("no hay
     aparato etiquetado para eso"), asi que se propaga tal cual. */
  if (!r.ok) throw new Error(d?.error || `Error ${r.status}`);
  return d;
}

/* El puente con `luces.js`.
 *
 * Todo este archivo vive dentro de una funcion anonima, asi que nada de aqui es
 * global — y `luces.js` es otro archivo. Se le pasan las cuatro cosas que
 * necesita, por nombre y a proposito, en vez de sacar el panel entero al ambito
 * global: asi la superficie compartida se ve de un vistazo y no crece sola.
 *
 * Sin esto el mapa se pintaba pero el panel de abajo salia vacio: `esc` no
 * existia para el, la excepcion cortaba el resto y ni siquiera se llegaba a
 * leer que luces estaban encendidas. */
window.VA_PANEL = { esc, avisar, api, elLlamar };

async function elCargarEstado() {
  try {
    el.estado = await api("rpc/ewelink_estado", { method: "POST", body: "{}" });
    const t = await api("dispositivos?tipo=eq.tinaja&activo=is.true&select=id&limit=1");
    el.hayTinaja = !!(t && t.length);
  } catch (e) { el.estado = null; el.hayTinaja = false; }
}

/* Las horas de las ordenes vienen de la base en UTC. Cortar la cadena daria
   las 21:00 para un turno de las 17:00 de la tarde; hay que convertirlas. */
const horaLocal = (iso) =>
  new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
const diaLocal = (iso) =>
  new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "short" });

/* La pantalla de las luces. Una tarjeta por cabaña, con lo que hace falta saber
   antes de tocar el boton: cuantas luces tiene, si hay alguien dentro, y si
   alguna no esta respondiendo. */
async function pintarLuces() {
  const caja = $("#vista-luces");
  if (!caja) return;
  await elCargarEstado();

  if (!el.estado?.conectado) {
    LZ.refs = null;
    caja.innerHTML = `<h2 class="titulo-seccion">Luces</h2>
      <div class="tarjeta"><p class="lista-vacia">
        eWeLink no esta conectado. Ve a <b>Avisos</b> y toca <b>Conectar</b>.
      </p></div>`;
    return;
  }

  /* El mapa va en su propio contenedor y la tinaja debajo, fuera de el: el mapa
     es el diseno tal cual y no se le mete nada dentro. La tinaja no es una luz
     ni sale en el plano, pero hay noches que se usa sin turno y el boton tiene
     que estar en alguna parte. */
  if (!caja.querySelector("#lz-host")) {
    caja.innerHTML = '<div id="lz-host"></div>';
    LZ.refs = null;
  }

  if (!LZ.refs) lzMontar(caja.querySelector("#lz-host"));
  try {
    await lzCargarEstado();
  } catch (e) {
    avisar("No se pudo leer el estado de las luces: " + e.message, "error");
  }
  lzMedir();
  lzPintar();


}



document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-luz]");
  if (!b) return;
  const cab = b.dataset.luz;
  const acc = b.dataset.acc;
  const esTinaja = cab === "__tinaja";

  /* Apagarle la luz a una cabaña con gente dentro pregunta antes, y la pregunta
     dice a quien. El error tipico no es apretar sin querer: es apretar en la
     cabaña equivocada — el mismo motivo por el que el boton de Quitar salio de
     cada fila y se fue dentro de la ficha. */
  if (acc === "off" && b.closest(".luz-tarjeta")?.classList.contains("ocupada")
      && !confirm(`Hay huespedes en ${nombreCabana(cab)}. ¿Apagar sus luces igual?`)) return;

  const antes = b.textContent;
  b.disabled = true;
  b.textContent = "...";
  try {
    await elLlamar("accion",
      esTinaja ? { rol: "tinaja", accion: acc } : { cabana: cab, accion: acc });
    avisar(esTinaja
      ? `Tinaja ${acc === "on" ? "encendida" : "apagada"}.`
      : `${nombreCabana(cab)}: luces ${acc === "on" ? "encendidas" : "apagadas"}.`, "ok");
  } catch (err) {
    avisar(err.message, "error");
  }
  b.disabled = false;
  b.textContent = antes;
});

/* Conectar la cuenta y decir que es cada aparato. Vive dentro de Avisos —que en
   realidad es la pestaña de ajustes— y no en un destino propio: esto se toca
   dos veces en la vida, el dia que se instala y el dia que se cambia un
   aparato. */
async function elAjustes(caja) {
  await elCargarEstado();
  const s = el.estado || {};
  let aparatos = [];
  if (s.conectado) {
    try { aparatos = await api("dispositivos?select=*&order=nombre"); } catch (e) { aparatos = []; }
  }

  const cabanasComoOpciones = (sel) => st.cabanas.map((c) =>
    `<option value="${c.id}"${c.id === sel ? " selected" : ""}>${esc(c.nombre)}</option>`).join("");

  caja.insertAdjacentHTML("beforeend", `
    <h2 class="titulo-seccion" style="margin-top:26px">Luces y tinaja</h2>
    <div class="av-estado ${s.conectado ? "activo" : "inactivo"}">
      <div>
        <b>${s.conectado ? "Conectado" : "Sin conectar"}</b>
        <div class="av-sub">${s.conectado
          ? `${esc(s.cuenta || "cuenta de eWeLink")} &middot; el permiso caduca en ${s.dias_permiso} dias`
          : "Las luces y el timer de la tinaja no funcionan hasta autorizar la cuenta."}</div>
      </div>
      <button type="button" class="${s.conectado ? "secundario" : ""}" id="el-conectar">
        ${s.conectado ? "Reautorizar" : "Conectar"}</button>
    </div>
    ${!s.conectado ? "" : `
      <div class="fila" style="margin-top:var(--e3)">
        <button type="button" class="secundario ancho" id="el-buscar">Buscar aparatos</button>
      </div>
      <div class="el-aparatos">
        ${aparatos.length ? aparatos.map((a) => `
          <div class="el-ap">
            <span class="el-ap-nombre">${esc(a.nombre)}
              ${/* La sala de eWeLink debajo del nombre. Sin ella hay dos
                    "Terraza" identicas en la lista y no hay forma de saber cual
                    es de que cabaña — ni de distinguir las de las cabañas de
                    las de la bodega y la veterinaria, que estan en la misma
                    cuenta y aqui no pintan nada. */ ""}
              ${a.sala ? `<span class="luz-nota">${esc(a.sala)}</span>` : ""}
              ${a.en_linea === false ? '<span class="luz-nota">no responde</span>' : ""}</span>
            <select data-ap-tipo="${esc(a.id)}" aria-label="Que es">
              <option value="otro"${a.tipo === "otro" ? " selected" : ""}>Sin usar</option>
              <option value="luz"${a.tipo === "luz" ? " selected" : ""}>Luz</option>
              <option value="tinaja"${a.tipo === "tinaja" ? " selected" : ""}>Tinaja</option>
            </select>
            <select data-ap-cabana="${esc(a.id)}" aria-label="De que cabaña"
                    ${a.tipo === "luz" ? "" : "disabled"}>
              <option value="">Cabaña...</option>
              ${cabanasComoOpciones(a.cabana_id)}
            </select>
          </div>`).join("")
        : '<p class="lista-vacia">Toca <b>Buscar aparatos</b> y salen los de tu cuenta de eWeLink, con el nombre que tienen alli.</p>'}
      </div>
      <p class="av-nota">La tinaja no se enciende sola. Al aprobar un turno se
        programa un aviso al telefono ${Math.round((st.reglas?.tinaja_antes_min ?? 720) / 60)} horas
        antes, que es lo que tarda en temperar, y la enciendes tu desde
        <b>Luces &rsaquo; Sala de Bombas</b>.</p>`}`);

  const con = $("#el-conectar");
  if (con) con.addEventListener("click", async () => {
    con.disabled = true;
    con.textContent = "Abriendo...";
    try {
      /* Dos pasos —pedir la direccion y luego ir— porque una navegacion del
         navegador no puede llevar la cabecera de sesion. La parte que exige
         estar identificado es esta llamada. */
      const { url } = await elLlamar("preparar");
      location.href = url;
    } catch (e) {
      avisar(e.message, "error");
      con.disabled = false;
      con.textContent = "Conectar";
    }
  });

  const bus = $("#el-buscar");
  if (bus) bus.addEventListener("click", async () => {
    bus.disabled = true;
    bus.textContent = "Buscando...";
    try {
      const r = await elLlamar("dispositivos");
      /* Si una de las dos nubes falla, la otra sigue trayendo aparatos y el
         listado "funciona". Ese es justo el fallo que se pasa por alto tres
         horas, asi que lo que salio mal se dice aqui y no en un registro. */
      if (r?.avisos?.length) avisar(r.avisos.join(" · "), "error");
      else avisar("Listado actualizado.", "ok");
      await pintarAvisos();
      return;
    } catch (e) { avisar(e.message, "error"); }
    bus.disabled = false;
    bus.textContent = "Buscar aparatos";
  });

  caja.querySelectorAll("[data-ap-tipo]").forEach((sel) =>
    sel.addEventListener("change", () => elGuardarAparato(sel.dataset.apTipo,
      sel.value === "luz" ? { tipo: "luz" } : { tipo: sel.value, cabana_id: null })));
  caja.querySelectorAll("[data-ap-cabana]").forEach((sel) =>
    sel.addEventListener("change", () =>
      elGuardarAparato(sel.dataset.apCabana, { cabana_id: sel.value || null })));
}

async function elGuardarAparato(id, campos) {
  try {
    await api(`dispositivos?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(campos) });
    el.estado = null;      // que la franja de luces se entere del cambio
    await pintarAvisos();
    pintarLuces();
  } catch (e) {
    /* El caso que mas va a salir: marcar una segunda tinaja. La base lo impide
       —hay una sola para las tres cabañas— y el mensaje lo dice. */
    avisar(e.message, "error");
  }
}

/* La vuelta de eWeLink trae el resultado en la direccion. Se lee, se dice y se
   limpia: si se quedara, recargar la pagina volveria a anunciar algo que ya
   paso. Mismo motivo por el que la app del huesped borra su token de la barra. */
(function () {
  const p = new URLSearchParams(location.search);
  const r = p.get("ewelink");
  if (!r) return;
  p.delete("ewelink");
  history.replaceState(null, "", location.pathname + (p.toString() ? `?${p}` : ""));
  setTimeout(() => avisar(
    r === "ok" ? "eWeLink conectado." : `No se pudo conectar eWeLink (${r}).`,
    r === "ok" ? "ok" : "error"), 900);
})();

/* -------------------------------------------------------------- Pestanas -- */
document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button")
      .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    ["calendario", "huespedes", "luces", "aseos", "finanzas", "tarifas", "avisos"].forEach((v) => {
      $(`#vista-${v}`).hidden = v !== b.dataset.vista;
    });
    /* En Luces se esconde la cabecera. Es la unica pantalla donde lo de
       alrededor no aporta: el precio base y el minimo de noches no ayudan a
       decidir que luz encender, y esos pixeles son terreno del mapa. Se marca
       ANTES de pintar para que el mapa se mida ya con su tamanio final. */
    document.body.classList.toggle("en-luces", b.dataset.vista === "luces");

    if (b.dataset.vista === "huespedes") pintarHuespedes();
    if (b.dataset.vista === "luces")     pintarLuces();
    if (b.dataset.vista === "avisos")    pintarAvisos();
    if (b.dataset.vista === "tarifas")  pintarTarifas();
    if (b.dataset.vista === "aseos")    pintarAseos();
    if (b.dataset.vista === "finanzas") pintarFinanzas();
    window.scrollTo(0, 0);
  });
});

/* -------------------------------------------------------------- Arranque -- */
function mostrarLogin() { $("#login").hidden = false; $("#app").hidden = true; }

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error"); err.hidden = true;
  const btn = e.target.querySelector("button");
  btn.disabled = true; btn.textContent = "Entrando...";
  try { await login($("#email").value.trim(), $("#clave").value); await iniciar(); }
  catch (ex) { err.textContent = ex.message; err.hidden = false; }
  btn.disabled = false; btn.textContent = "Entrar";
});

async function iniciar() {
  try {
    await cargarBase();

    const opciones = st.cabanas
      .map((c) => `<option value="${c.id}">${esc(c.nombre)} - hasta ${c.capacidad_max}</option>`).join("");
    /* El calendario abre en la vista de conjunto: la primera pregunta al abrir
       el panel casi siempre es "me queda algo?", no "esta libre Nevados?". */
    $("#sel-cabana").innerHTML =
      `<option value="${TODAS}">Las ${st.cabanas.length} cabanas</option>` + opciones;
    $("#cot-cabana").innerHTML = opciones;
    $("#sel-cabana").value = st.cabanaSel;

    const manana = sumarDias(hoyISO(), 1);
    $("#cot-entrada").value = manana;
    $("#cot-salida").value  = sumarDias(manana, st.reglas?.minimo_noches || 2);

    await Promise.all([cargarBloqueos(), cargarHoy()]);
    pintarCalendario();
    pintarHoy();
    pintarTarifas();
    /* Sin `await`: si la funcion de eWeLink tarda o esta caida, el panel tiene
       que abrir igual. Las luces son un extra; la agenda es el trabajo.
       Y solo el estado, no la pantalla: esa se pinta al entrar en su pestaña,
       igual que las demas. */
    elCargarEstado();

    $("#sub-header").textContent =
      `Base ${clp(st.tarifaBase.precio_base)} - minimo ${st.reglas.minimo_noches} noches`;

    $("#login").hidden = true; $("#app").hidden = false;
  } catch (err) {
    borrarSesion(); mostrarLogin();
    const e = $("#login-error"); e.textContent = err.message; e.hidden = false;
  }
}

if (sesion?.access_token) iniciar(); else mostrarLogin();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
