/* eWeLink — el puente entre el panel y las luces.
 *
 * POR QUÉ EXISTE ESTA FUNCIÓN Y NO SE LLAMA A EWELINK DESDE EL PANEL
 * -----------------------------------------------------------------
 * El panel es HTML estático servido desde GitHub Pages: cualquiera abre el
 * código fuente de la página. La clave de la app de eWeLink y el token de la
 * cuenta no pueden estar ahí — con ellos se apagan las luces de las tres
 * cabañas desde cualquier sitio del mundo. Viven aquí, en secretos del
 * servidor, y el panel solo puede pedir cosas concretas.
 *
 * LAS RUTAS
 *   POST /preparar      → devuelve la URL de autorización (exige sesión)
 *   GET  /callback      → vuelta de eWeLink con el `code` (pública, con `state`)
 *   POST /dispositivos  → lista los aparatos y los guarda (exige sesión)
 *   POST /accion        → enciende o apaga ahora (exige sesión)
 *   POST /cron          → la pasada del reloj (sin sesión, y ver más abajo)
 *
 * POR QUÉ /cron PUEDE IR SIN SESIÓN
 * ---------------------------------
 * No recibe ningún parámetro. Lo único que hace es ejecutar las órdenes que YA
 * estaban programadas y cuya hora ya pasó. Lo peor que consigue un extraño
 * llamándola es que una orden salga unos segundos antes de lo que iba a salir
 * igual. El día que acepte "qué aparato" y "qué acción" desde fuera, deja de
 * ser cierto — y entonces hay que cerrarla. Es el mismo trato que ya tiene el
 * cron de los avisos.
 *
 * DESPLIEGUE
 *   supabase secrets set EWELINK_APPID=... EWELINK_SECRET=...
 *   supabase functions deploy ewelink --no-verify-jwt
 */

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';

/* La misma historia que en `avisos`: este proyecto usa el sistema nuevo de
 * claves (sb_publishable_ / sb_secret_), y ahí SUPABASE_SERVICE_ROLE_KEY llega
 * vacía porque pertenece al sistema antiguo de JWT. Como Supabase reserva el
 * prefijo SUPABASE_, tampoco se puede definir a mano. Se lee VA_SERVICE_KEY.
 *
 * Aquel fallo fue invisible durante semanas: sin clave, las lecturas devolvían
 * 401, la respuesta no era un array y la función salía por el atajo de "no hay
 * nada que hacer". Aquí sería igual de silencioso, así que si falta la clave
 * esto se cae de entrada en vez de fingir que no había órdenes. */
const SB_KEY = Deno.env.get('VA_SERVICE_KEY')
            ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
            ?? '';

const APPID  = Deno.env.get('EWELINK_APPID')  ?? '';
const SECRET = Deno.env.get('EWELINK_SECRET') ?? '';

const PANEL = 'https://panel.valleaventura-chile.com';
const REDIRECT = `${SB_URL}/functions/v1/ewelink/callback`;

/* Solo el panel puede llamar desde un navegador. No es la defensa principal
   —esa es la sesión— pero quita de en medio a cualquier página que intente
   usar la función desde el navegador de José con su sesión puesta. */
const CORS = {
  'Access-Control-Allow-Origin': PANEL,
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// ── Firma ──────────────────────────────────────────────────────────────────
/* eWeLink no usa una API key suelta: cada llamada de las que no llevan token va
   firmada con el secreto de la app. HMAC-SHA256 en base64, igual que el VAPID
   de los avisos — Web Crypto lo trae, no hace falta librería. */
async function firmar(mensaje: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const f = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(mensaje));
  return btoa(String.fromCharCode(...new Uint8Array(f)));
}

const nonce = (n = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

/* La región la elige eWeLink al autorizar y vuelve en el redirect. China va por
   .cn y el resto por .cc — llamar al gateway equivocado no da un error claro,
   da respuestas vacías. */
const gateway = (region: string) =>
  region === 'cn'
    ? 'https://cn-apia.coolkit.cn'
    : `https://${region || 'us'}-apia.coolkit.cc`;

// ── Base de datos ──────────────────────────────────────────────────────────
async function sb(ruta: string, opciones: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${ruta}`, {
    ...opciones,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opciones.headers || {}),
    },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

const rpc = (fn: string, args: unknown) =>
  sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const leerCuenta = async () =>
  (await sb('ewelink_cuenta?id=eq.1&select=*'))?.[0] ?? null;

const guardarCuenta = (campos: Record<string, unknown>) =>
  sb('ewelink_cuenta?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({ ...campos, actualizado_at: new Date().toISOString() }),
  });

/* Quién está llamando. Se comprueba contra Supabase Auth y no se confía en que
   la petición venga del panel: una cabecera se falsifica, un token no. */
async function usuarioValido(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: auth },
  });
  return r.ok;
}

// ── Llamadas a eWeLink ─────────────────────────────────────────────────────
/* Renueva el token si le queda poco. El access token dura 30 días y el de
   refresco 60: pasados los 60 sin renovar hay que volver a autorizar a mano.
   Por eso se mira en CADA pasada y no una vez al mes — es barato, y el fallo de
   no hacerlo llega dos meses tarde y sin avisar. */
async function tokenVivo(): Promise<{ at: string; region: string }> {
  const c = await leerCuenta();
  if (!c?.refresh_token) throw new Error('eWeLink todavía no está autorizado.');

  const quedan = c.access_expira_at
    ? (new Date(c.access_expira_at).getTime() - Date.now()) / 86400000
    : -1;
  if (quedan > 2) return { at: c.access_token, region: c.region };

  const g = gateway(c.region);
  const r = await fetch(`${g}/v2/user/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CK-Appid': APPID,
      'X-CK-Nonce': nonce(),
      Authorization: `Bearer ${c.access_token}`,
    },
    body: JSON.stringify({ rt: c.refresh_token }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`No se pudo renovar el permiso (${d.error}): ${d.msg ?? ''}`);

  const at = d.data?.at ?? d.data?.accessToken;
  const rt = d.data?.rt ?? d.data?.refreshToken;
  if (!at) throw new Error('La renovación no devolvió token nuevo.');

  await guardarCuenta({
    access_token: at,
    refresh_token: rt ?? c.refresh_token,
    access_expira_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    refresh_expira_at: new Date(Date.now() + 60 * 86400000).toISOString(),
  });
  return { at, region: c.region };
}

async function ewelink(ruta: string, opciones: RequestInit = {}) {
  const { at, region } = await tokenVivo();
  const r = await fetch(`${gateway(region)}${ruta}`, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      'X-CK-Appid': APPID,
      'X-CK-Nonce': nonce(),
      Authorization: `Bearer ${at}`,
      ...(opciones.headers || {}),
    },
  });
  const d = await r.json();
  if (d.error) throw new Error(`eWeLink ${d.error}: ${d.msg ?? ''}`);
  return d.data;
}

/* El formato del comando depende del modelo. Un interruptor de un canal acepta
   `switch`; uno de varios exige `switches` con el número de salida. Por eso se
   guarda el canal al etiquetar: sin él habría que adivinar por el nombre. */
const comando = (dev: { canal: number | null }, accion: string) =>
  dev.canal === null || dev.canal === undefined
    ? { switch: accion }
    : { switches: [{ switch: accion, outlet: dev.canal }] };

const accionar = (dev: { id: string; canal: number | null }, accion: string) =>
  ewelink('/v2/device/thing/status', {
    method: 'POST',
    body: JSON.stringify({ type: 1, id: dev.id, params: comando(dev, accion) }),
  });

// ── Las rutas ──────────────────────────────────────────────────────────────

/* Devuelve la URL a la que hay que mandar a José para que autorice.
 *
 * Se hace en dos pasos —el panel pide la URL y luego navega— porque una
 * navegación del navegador no puede llevar la cabecera de sesión. Así la parte
 * que exige estar identificado es esta llamada, y lo que viaja después es una
 * URL que ya no revela el secreto. */
async function preparar() {
  const seq = String(Date.now());
  const state = crypto.randomUUID();
  await guardarCuenta({ oauth_state: state, oauth_state_at: new Date().toISOString() });

  const p = new URLSearchParams({
    clientId: APPID,
    seq,
    authorization: await firmar(`${APPID}_${seq}`),
    redirectUrl: REDIRECT,
    grantType: 'authorization_code',
    state,
    nonce: nonce(),
  });
  return { url: `https://c2ccdn.coolkit.cc/oauth/index.html?${p}` };
}

/* La vuelta de eWeLink. Es pública por fuerza —la abre el navegador de José
   desde la página de CoolKit— así que lo que la protege es el `state`: si no
   coincide con el que guardamos al empezar, esta vuelta no la pedimos nosotros. */
async function callback(url: URL) {
  const volver = (msg: string) =>
    Response.redirect(`${PANEL}/?ewelink=${encodeURIComponent(msg)}`, 302);

  const code = url.searchParams.get('code');
  const region = url.searchParams.get('region') ?? 'us';
  const state = url.searchParams.get('state');
  if (!code) return volver('sin-codigo');

  const c = await leerCuenta();
  if (!state || state !== c?.oauth_state) return volver('state-no-coincide');
  /* El `code` de eWeLink vive 30 segundos. Un `state` de hace media hora es de
     otra sesión de autorización, no de esta. */
  const edad = Date.now() - new Date(c.oauth_state_at ?? 0).getTime();
  if (edad > 10 * 60 * 1000) return volver('autorizacion-caducada');

  const cuerpo = JSON.stringify({
    clientId: APPID,
    code,
    redirectUrl: REDIRECT,
    grantType: 'authorization_code',
  });
  const r = await fetch(`${gateway(region)}/v2/user/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CK-Appid': APPID,
      'X-CK-Nonce': nonce(),
      /* Este endpoint todavía no tiene token que enseñar, así que se firma el
         cuerpo entero con el secreto de la app. */
      Authorization: `Sign ${await firmar(cuerpo)}`,
    },
    body: cuerpo,
  });
  const d = await r.json();
  if (d.error) {
    console.error('eWeLink token:', JSON.stringify(d));
    return volver(`error-${d.error}`);
  }

  const at = d.data?.at ?? d.data?.accessToken;
  const rt = d.data?.rt ?? d.data?.refreshToken;
  if (!at) {
    console.error('Respuesta sin token:', JSON.stringify(d));
    return volver('sin-token');
  }

  await guardarCuenta({
    access_token: at,
    refresh_token: rt,
    region,
    cuenta: d.data?.user?.email ?? d.data?.user?.phoneNumber ?? null,
    /* eWeLink manda las caducidades en milisegundos; si algún día deja de
       hacerlo, los 30 y 60 días de su documentación son el respaldo. */
    access_expira_at: new Date(d.data?.atExpiredTime ?? Date.now() + 30 * 86400000).toISOString(),
    refresh_expira_at: new Date(d.data?.rtExpiredTime ?? Date.now() + 60 * 86400000).toISOString(),
    oauth_state: null,
    oauth_state_at: null,
  });
  return volver('ok');
}

/* Trae el listado de la cuenta y lo guarda. Es lo que evita tener que escribir
   a mano un inventario: eWeLink ya sabe cómo se llama cada aparato, lo único
   que falta es decir cuál es de qué cabaña, y eso se hace después en el panel.
   Etiquetar NO se pisa al volver a listar: el `merge` solo refresca nombre,
   modelo y si está en línea. */
async function dispositivos() {
  const d = await ewelink('/v2/device/thing?num=0');
  const lista = (d?.thingList ?? [])
    .filter((t: { itemType: number }) => t.itemType === 1)
    .map((t: { itemData: Record<string, unknown> }) => t.itemData);

  const ahora = new Date().toISOString();
  for (const dev of lista) {
    const fila = {
      id: dev.deviceid,
      nombre: dev.name ?? dev.deviceid,
      uiid: (dev.extra as { uiid?: number } | undefined)?.uiid ?? null,
      en_linea: dev.online === true,
      visto_at: ahora,
    };
    await sb('dispositivos?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(fila),
    });
  }
  return await sb('dispositivos?select=*&order=cabana_id.asc.nullsfirst,orden.asc,nombre.asc');
}

/* Encender o apagar ahora, desde el panel. A diferencia de /cron, esto SÍ
   recibe qué y a qué, y por eso exige sesión. */
async function accion(body: { dispositivo?: string; cabana?: string; rol?: string; accion: string }) {
  if (body.accion !== 'on' && body.accion !== 'off') throw new Error('Acción desconocida.');

  let filtro = '';
  if (body.dispositivo) filtro = `id=eq.${body.dispositivo}`;
  else if (body.rol === 'tinaja') filtro = 'tipo=eq.tinaja';
  else if (body.cabana) filtro = `cabana_id=eq.${body.cabana}&tipo=eq.luz`;
  else throw new Error('Falta decir qué aparato.');

  const devs = await sb(`dispositivos?${filtro}&activo=is.true&select=id,nombre,canal`);
  if (!devs?.length) throw new Error('No hay ningún aparato etiquetado para eso.');

  /* Una cabaña puede tener varias luces y se encienden todas. Si una falla, se
     dice cuál: "no se pudo" a secas obliga a ir a mirar las tres. */
  const fallos: string[] = [];
  for (const dev of devs) {
    try { await accionar(dev, body.accion); }
    catch (e) { fallos.push(`${dev.nombre}: ${(e as Error).message}`); }
  }
  if (fallos.length) throw new Error(fallos.join(' · '));
  return { ok: true, aparatos: devs.length };
}

/* La pasada del reloj. Ejecuta lo que ya tocaba y nada más.
 *
 * El resultado de cada orden lo cierra la base (`ewelink_orden_resultado`), que
 * es donde vive la regla de cuántos reintentos valen y qué se avisa cuando se
 * agotan. Aquí solo se intenta y se cuenta lo que pasó. */
async function cron() {
  const hecho = { ejecutadas: 0, fallidas: 0, avisos: 0 };

  const pendientes = await sb(
    `ewelink_ordenes?estado=eq.pendiente&momento=lte.${new Date().toISOString()}` +
    '&select=id,rol,cabana_id,accion&order=momento&limit=20',
  );

  for (const o of pendientes ?? []) {
    try {
      const filtro = o.rol === 'tinaja'
        ? 'tipo=eq.tinaja'
        : `cabana_id=eq.${o.cabana_id}&tipo=eq.luz`;
      const devs = await sb(`dispositivos?${filtro}&activo=is.true&select=id,nombre,canal`);
      if (!devs?.length) throw new Error('No hay aparato etiquetado para esta orden.');
      for (const dev of devs) await accionar(dev, o.accion);
      await rpc('ewelink_orden_resultado', { p_orden: o.id, p_ok: true });
      hecho.ejecutadas++;
    } catch (e) {
      await rpc('ewelink_orden_resultado', {
        p_orden: o.id, p_ok: false, p_error: (e as Error).message.slice(0, 500),
      });
      hecho.fallidas++;
    }
  }

  /* Los dos relojes que caducan en silencio. Se miran aquí y no en un cron
     aparte porque un job más es un job más que se puede olvidar de crear. */
  try { hecho.avisos = await rpc('ewelink_revisar_caducidades', {}) ?? 0; }
  catch (e) { console.error('caducidades:', (e as Error).message); }

  return hecho;
}

// ── Entrada ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const ruta = url.pathname.split('/').pop() ?? '';

  if (!SB_KEY) {
    console.error('Falta VA_SERVICE_KEY: sin ella no se lee ni se escribe nada.');
    return json({ error: 'La función no está configurada.' }, 500);
  }

  try {
    if (ruta === 'callback') return await callback(url);
    if (ruta === 'cron')     return json(await cron());

    if (!APPID || !SECRET) return json({ error: 'Faltan las claves de eWeLink.' }, 500);
    if (!await usuarioValido(req)) return json({ error: 'Hay que iniciar sesión.' }, 401);

    if (ruta === 'preparar')     return json(await preparar());
    if (ruta === 'dispositivos') return json(await dispositivos());
    if (ruta === 'accion')       return json(await accion(await req.json()));

    return json({ error: 'Ruta desconocida.' }, 404);
  } catch (e) {
    /* El mensaje sube tal cual al panel a propósito: "eWeLink 401" o "no hay
       aparato etiquetado" dicen qué hacer, y un "error interno" no. */
    console.error(ruta, (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});
