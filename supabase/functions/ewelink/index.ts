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

/* ══════════════════════════════════════════════════════════════════════════
   SmartLife (Tuya)
   ══════════════════════════════════════════════════════════════════════════
   Otra nube, otra forma de firmar, y desde el panel exactamente lo mismo: un
   interruptor. Por eso vive aquí dentro y no en una función aparte — quien
   decide a qué nube hablar es la columna `proveedor` del propio aparato, y así
   el mapa, el timer y el botón de apagar todo no se enteran de que hay dos.

   (La función se sigue llamando `ewelink` por historia. Renombrarla obligaría a
   rehacer el cron y el panel a cambio de nada; el nombre es el único sitio
   donde queda la mentira, y queda dicha aquí.)

   TRES DIFERENCIAS CON EWELINK QUE CUESTAN UNA TARDE SI NO SE SABEN
   ---------------------------------------------------------------
   · La firma va en HEXADECIMAL MAYÚSCULA, no en base64.
   · Lo que se firma incluye el hash del cuerpo y la ruta CON su query.
   · El token dura 2 horas, no 30 días. Se renueva casi en cada pasada. */

const TUYA_ID     = Deno.env.get('TUYA_ID')     ?? '';
const TUYA_SECRET = Deno.env.get('TUYA_SECRET') ?? '';

const tuyaHost = (region: string) => `https://openapi.tuya${region || 'us'}.com`;

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256(texto: string) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

async function tuyaFirma(str: string) {
  const k = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TUYA_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(str))).toUpperCase();
}

async function tuyaCabeceras(metodo: string, ruta: string, cuerpo: string, token: string) {
  const t = String(Date.now());
  const n = nonce(16);
  const aFirmar = `${metodo}\n${await sha256(cuerpo)}\n\n${ruta}`;
  return {
    client_id: TUYA_ID,
    sign: await tuyaFirma(TUYA_ID + token + t + n + aFirmar),
    t, nonce: n,
    sign_method: 'HMAC-SHA256',
    'Content-Type': 'application/json',
    ...(token ? { access_token: token } : {}),
  };
}

/* El token de Tuya dura dos horas. Se pide uno nuevo cuando quedan menos de
   cinco minutos en vez de refrescarlo: el endpoint de refresco añade un caso
   más que puede fallar y pedirlo entero cuesta lo mismo. */
async function tuyaToken(): Promise<{ at: string; region: string }> {
  const c = (await sb('smartlife_cuenta?id=eq.1&select=*'))?.[0] ?? null;
  const region = c?.region || 'us';
  if (c?.access_token && c.expira_at && new Date(c.expira_at).getTime() - Date.now() > 300000) {
    return { at: c.access_token, region };
  }
  if (!TUYA_ID || !TUYA_SECRET) throw new Error('Faltan las claves de SmartLife.');

  const ruta = '/v1.0/token?grant_type=1';
  const r = await fetch(tuyaHost(region) + ruta, {
    headers: await tuyaCabeceras('GET', ruta, '', ''),
  });
  const d = await r.json();
  if (!d.success) {
    console.error('tuya token:', JSON.stringify(d));
    throw new Error(`SmartLife (${d.code}): ${d.msg ?? 'no se pudo entrar'}`);
  }
  await sb('smartlife_cuenta?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({
      access_token: d.result.access_token,
      refresh_token: d.result.refresh_token,
      uid: d.result.uid ?? c?.uid ?? null,
      expira_at: new Date(Date.now() + (d.result.expire_time ?? 7200) * 1000).toISOString(),
      actualizado_at: new Date().toISOString(),
    }),
  });
  return { at: d.result.access_token, region };
}

/* Pedirle a Tuya los aparatos de la cuenta enlazada.
 *
 * Hay tres rutas posibles y cuál sirve depende de qué APIs tenga suscrito el
 * proyecto, así que se prueban en orden empezando por la de cuentas enlazadas
 * por QR, que es nuestro caso. Vive aquí y no dentro de una sola función porque
 * la usan dos —listar y leer estado— y tenerlo duplicado ya costó una ronda:
 * se arregló la ruta al listar y se quedó la vieja al leer, así que los
 * aparatos aparecían pero todos como "no responde". */
async function tuyaAparatos(): Promise<{ lista: unknown[]; fallos: string[] }> {
  const rutas: Array<[string, (r: unknown) => unknown[]]> = [
    ['/v1.0/iot-01/associated-users/devices?page_size=100',
      (r) => (r as { devices?: unknown[] })?.devices ?? []],
    ['/v1.3/iot-03/devices?page_size=100',
      (r) => (r as { list?: unknown[] })?.list ?? []],
  ];
  const c = (await sb('smartlife_cuenta?id=eq.1&select=uid'))?.[0];
  if (c?.uid) rutas.push([`/v1.0/users/${c.uid}/devices`, (r) => (r as unknown[]) ?? []]);

  const fallos: string[] = [];
  for (const [ruta, sacar] of rutas) {
    try {
      const lista = sacar(await tuya(ruta));
      if (lista.length) return { lista, fallos };
      fallos.push(`${ruta}: sin aparatos`);
    } catch (e) {
      fallos.push(`${ruta}: ${(e as Error).message}`);
    }
  }
  return { lista: [], fallos };
}

async function tuya(ruta: string, metodo = 'GET', cuerpo?: unknown) {
  const { at, region } = await tuyaToken();
  const txt = cuerpo ? JSON.stringify(cuerpo) : '';
  const r = await fetch(tuyaHost(region) + ruta, {
    method: metodo,
    headers: await tuyaCabeceras(metodo, ruta, txt, at),
    ...(txt ? { body: txt } : {}),
  });
  const d = await r.json();
  if (!d.success) throw new Error(`SmartLife ${d.code}: ${d.msg ?? ''}`);
  return d.result;
}

/* El formato del comando depende del modelo. Un interruptor de un canal acepta
   `switch`; uno de varios exige `switches` con el número de salida. Por eso se
   guarda el canal al etiquetar: sin él habría que adivinar por el nombre. */
const comando = (dev: { canal: number | null }, accion: string) =>
  dev.canal === null || dev.canal === undefined
    ? { switch: accion }
    : { switches: [{ switch: accion, outlet: dev.canal }] };

/* El comando va al APARATO, no a la fila. Una fila puede ser un canal suelto de
   un interruptor de tres, y eWeLink solo entiende el aparato entero mas el
   numero de salida. */
type Aparato = {
  id: string; device_id?: string | null; canal: number | null;
  proveedor?: string | null; codigo?: string | null;
};

const accionar = (dev: Aparato, accion: string) => {
  if (dev.proveedor === 'tuya') {
    const codigo = dev.codigo || 'switch_1';
    /* Una alarma no es un interruptor: no se "enciende", se ARMA. Su mando
       toma palabras (`arm` / `disarmed`), no un sí o un no. Encender y armar
       son la misma intención desde el panel, así que se traduce aquí y no se
       inventa una segunda acción que el resto del código tendría que conocer. */
    const valor = codigo === 'master_mode'
      ? (accion === 'sos' ? 'sos' : accion === 'on' ? 'arm' : 'disarmed')
      : accion === 'on';
    return tuya(`/v1.0/devices/${dev.device_id ?? dev.id}/commands`, 'POST',
      { commands: [{ code: codigo, value: valor }] });
  }
  return ewelink('/v2/device/thing/status', {
    method: 'POST',
    body: JSON.stringify({
      type: 1,
      id: dev.device_id ?? dev.id,
      params: comando(dev, accion),
    }),
  });
};

/* Lo que trae Tuya de cada aparato, convertido a filas de `dispositivos`.
   Se mira lo que el aparato DICE que sabe hacer en vez de deducirlo del modelo:
   los interruptores exponen `switch` o `switch_1..n`, y las alarmas
   `master_mode`. Un aparato que no expone ninguno de los dos —un sensor, una
   cámara— no se guarda: no hay nada que encender en él. */
function tuyaFilas(dev: {
  id: string; name?: string; online?: boolean;
  status?: Array<{ code: string; value: unknown }>;
}, ahora: string) {
  const filas = [];
  const estados = dev.status ?? [];
  const base = {
    device_id: dev.id, proveedor: 'tuya', sala: 'SmartLife',
    en_linea: dev.online === true, visto_at: ahora, uiid: null,
  };

  /* Ojo: aquí NO se escribe `tipo`. El guardado en bloque sobrescribe lo que
     lleve en el cuerpo, y `tipo` es lo que se etiqueta a mano — mandarlo en
     cada listado borraría el trabajo de etiquetar cada vez que se pulsa Buscar.
     Las alarmas se marcan aparte, después, y solo las que aún no lo estén. */
  const alarma = estados.find((s) => s.code === 'master_mode');
  if (alarma) {
    filas.push({ ...base, id: `tuya:${dev.id}`, canal: null, codigo: 'master_mode',
      nombre: dev.name ?? dev.id });
    return filas;
  }

  const llaves = estados.filter((s) =>
    /^switch(_\d+)?$/.test(s.code) && typeof s.value === 'boolean');
  if (!llaves.length) return filas;

  llaves.forEach((s, i) => {
    const solo = llaves.length === 1;
    filas.push({
      ...base,
      id: solo ? `tuya:${dev.id}` : `tuya:${dev.id}:${s.code}`,
      canal: solo ? null : i,
      codigo: s.code,
      nombre: solo ? (dev.name ?? dev.id) : `${dev.name ?? dev.id} - ${s.code.replace('switch_', 'Canal ')}`,
    });
  });
  return filas;
}

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
  /* Las salas de eWeLink son lo unico que distingue dos "Terraza": una es de la
     Cabaña 2 y otra de la Cabaña 4, y en una lista plana son la misma palabra
     dos veces. No se traducen a cabaña automaticamente —que "Cabaña 4" sea
     Nevados o El Chueco no lo puede adivinar nadie sin arriesgarse a encender
     la equivocada—, pero sirven para reconocerlas de un vistazo. */
  let salas: Record<string, string> = {};
  let hogares: Record<string, string> = {};
  try {
    const fam = await ewelink('/v2/family');
    for (const f of fam?.familyList ?? []) {
      hogares[f.id] = f.name;
      for (const r of f.roomList ?? []) salas[r.id] = r.name;
    }
    console.log('salas de eWeLink:', JSON.stringify(salas));
  } catch (e) {
    /* Sin salas la lista sigue sirviendo, solo cuesta mas leerla. No vale la
       pena tumbar el listado entero por esto. */
    console.error('familias:', (e as Error).message);
    salas = {};
    hogares = {};
  }

  const d = await ewelink('/v2/device/thing?num=0');
  const lista = (d?.thingList ?? [])
    .filter((t: { itemType: number }) => t.itemType === 1)
    .map((t: { itemData: Record<string, unknown> }) => t.itemData);

  const ahora = new Date().toISOString();
  const filas = [];
  /* Lo que salió mal sin llegar a tumbar el listado. Sube al panel en vez de
     quedarse en un registro: un fallo que no se ve es un fallo que se busca a
     ciegas tres horas después. */
  const avisos: string[] = [];

  for (const dev of lista) {
    /* El id de la sala NO viene suelto en el aparato: viaja dentro de `family`,
       junto al del hogar. Buscarlo en `dev.roomid` devuelve undefined y deja
       todas las salas en blanco, que es exactamente lo que pasaba.
       Se prueban las dos formas porque la documentacion no lo dice y lo unico
       que hay es la respuesta real; y si no hay sala, al menos queda el nombre
       del hogar, que ya distingue lo de las cabañas de lo de la veterinaria. */
    const fam = (dev.family ?? {}) as { roomid?: string; familyid?: string };
    const sala = salas[fam.roomid ?? ''] ??
                 salas[(dev.roomid as string) ?? ''] ??
                 hogares[fam.familyid ?? ''] ?? null;
    const uiid = (dev.extra as { uiid?: number } | undefined)?.uiid ?? null;
    const base = {
      device_id: dev.deviceid,
      proveedor: 'ewelink',
      codigo: null,
      sala,
      uiid,
      en_linea: dev.online === true,
      visto_at: ahora,
    };

    /* Los de varios canales traen `switches`; los de uno, `switch`. Cada canal
       va como su propia fila porque en la cabaña son cosas distintas: Canal1 la
       terraza y Canal3 una bomba. Etiquetar el aparato entero obligaria a
       encender la bomba para encender la terraza. */
    const params = (dev.params ?? {}) as { switches?: unknown[] };
    const canales = Array.isArray(params.switches) ? params.switches.length : 0;

    if (canales > 1) {
      for (let i = 0; i < canales; i++) {
        filas.push({
          ...base,
          id: `${dev.deviceid}:${i}`,
          canal: i,
          nombre: `${dev.name ?? dev.deviceid} - Canal ${i + 1}`,
        });
      }
    } else {
      filas.push({ ...base, id: dev.deviceid, canal: null, nombre: dev.name ?? dev.deviceid });
    }
  }

  /* De una sola vez y no fila a fila: son decenas de aparatos y una llamada por
     cada uno tarda lo suyo con la señal de la montaña.
     El `merge` solo toca las columnas que van en el cuerpo, asi que `tipo` y
     `cabana_id` —lo unico que se etiqueta a mano— sobreviven a volver a listar. */
  /* Y ahora los de SmartLife, a la misma lista. Si esa cuenta no está conectada
     todavía, se sigue: media lista es mejor que un error que deja al panel sin
     ninguna. */
  /* Tuya tiene tres formas de pedir "los aparatos de la cuenta enlazada" y cuál
     funciona depende de qué APIs tenga suscrito el proyecto. Se prueban en
     orden en vez de elegir una a ciegas: la primera es la pensada para cuentas
     enlazadas por QR, que es nuestro caso.

     Y si fallan las tres, el error SUBE. Antes se anotaba en un registro que no
     mira nadie y la función devolvía la lista de eWeLink como si todo hubiera
     ido bien — por eso los aparatos de SmartLife "no aparecían" sin que nada
     dijera por qué. */
  const { lista: listaTuya, fallos } = await tuyaAparatos();
  for (const dev of listaTuya) {
    filas.push(...tuyaFilas(dev as Parameters<typeof tuyaFilas>[0], ahora));
  }
  if (!listaTuya.length) avisos.push('SmartLife: ' + fallos.join(' | '));

  if (filas.length) {
    await sb('dispositivos?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(filas),
    });
  }
  /* Una alarma se reconoce sola por su mando, así que se marca aquí en vez de
     hacerte elegirlo en un desplegable.
     `activo=is.true` no sobra: es lo que distingue "todavía no lo he mirado" de
     "no lo quiero". Sin ese filtro, las alarmas de la veterinaria —apagadas a
     mano a propósito— se volvían a marcar solas en cada listado, porque desde
     aquí una exclusión deliberada y un aparato sin etiquetar se ven idénticos. */
  try {
    await sb('dispositivos?codigo=eq.master_mode&tipo=eq.otro&activo=is.true', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ tipo: 'alarma' }),
    });
  } catch (e) { console.error('marcar alarmas:', (e as Error).message); }

  const guardados = await sb('dispositivos?select=*&order=sala.asc.nullslast,nombre.asc');
  return { lista: guardados, avisos };
}

/* El estado real de cada ambiente del mapa.
 *
 * Se lee de eWeLink cada vez y NO se guarda en ninguna parte. El plano enseña
 * qué está encendido, y esa es justamente la información que no se puede
 * cachear: el huésped apaga desde el interruptor de la pared cuando quiere, y
 * un plano que dice "encendido" sobre una luz apagada es peor que no tener
 * plano.
 *
 * Es UNA llamada para todo: el listado de aparatos ya trae los `params` con el
 * on/off de cada canal, así que no hace falta preguntar aparato por aparato.
 *
 * Lo que no se sabe se dice: un aparato fuera de línea no vuelve como apagado,
 * vuelve en `fuera`. Apagado y sin señal no son lo mismo y la pantalla los
 * pinta distinto. */
async function estado() {
  const d = await ewelink('/v2/device/thing?num=0');
  const params: Record<string, Record<string, unknown>> = {};
  const enLinea: Record<string, boolean> = {};
  for (const t of d?.thingList ?? []) {
    if (t.itemType !== 1) continue;
    params[t.itemData.deviceid] = (t.itemData.params ?? {}) as Record<string, unknown>;
    enLinea[t.itemData.deviceid] = t.itemData.online === true;
  }

  /* Lo mismo del lado de SmartLife. Si esa cuenta falla se sigue: el estado de
     las luces de eWeLink no tiene por qué perderse porque otra nube esté caída,
     y lo que no se sepa sale como "sin señal", que es la verdad. */
  const tEstado: Record<string, Record<string, unknown>> = {};
  const tLinea: Record<string, boolean> = {};
  try {
    const { lista } = await tuyaAparatos();
    for (const d2 of lista) {
      const dev = d2 as { id: string; online?: boolean; status?: Array<{ code: string; value: unknown }> };
      const m: Record<string, unknown> = {};
      for (const s of (dev.status ?? [])) m[s.code] = s.value;
      tEstado[dev.id] = m;
      tLinea[dev.id] = dev.online === true;
    }
  } catch (e) { console.error('smartlife estado:', (e as Error).message); }

  const filas = await sb('dispositivos?zona=not.is.null&clave=not.is.null&activo=is.true'
                       + '&select=zona,clave,device_id,canal,proveedor,codigo');

  const luces: Record<string, boolean> = {};
  const fuera: string[] = [];
  const disparadas: string[] = [];
  for (const f of filas ?? []) {
    const k = `${f.zona}:${f.clave}`;

    if (f.proveedor === 'tuya') {
      const m = tEstado[f.device_id];
      if (!m || !tLinea[f.device_id]) { fuera.push(k); continue; }
      const v = m[f.codigo || 'switch_1'];
      /* Una alarma armada cuenta como "encendida" en el mapa. Cualquier modo
         que no sea `disarmed` —armada del todo o en casa— es vigilando. */
      luces[k] = f.codigo === 'master_mode' ? (v !== undefined && v !== 'disarmed') : v === true;
      /* Armada y DISPARADA no son lo mismo, y la diferencia es toda la que hay.
         La central lo publica aparte en `master_state`; si ese modelo no lo
         publica, la parte roja queda conectada y nunca se enciende sola — que
         es mejor que inventarse un salto de alarma. */
      if (f.codigo === 'master_mode') {
        const st = m['master_state'];
        if (st !== undefined && st !== 'normal' && st !== 'disarmed') disparadas.push(k);
      }
      continue;
    }

    const p = params[f.device_id];
    if (!p || !enLinea[f.device_id]) { fuera.push(k); continue; }
    const sw = p.switches as Array<{ switch?: string }> | undefined;
    const v = (f.canal === null || f.canal === undefined)
      ? p.switch
      : (Array.isArray(sw) ? sw[f.canal]?.switch : undefined);
    luces[k] = v === 'on';
  }
  return { luces, fuera, disparadas };
}

/* Encender o apagar ahora, desde el panel. A diferencia de /cron, esto SÍ
   recibe qué y a qué, y por eso exige sesión. */
async function accion(body: { dispositivo?: string; cabana?: string; rol?: string; accion: string }) {
  if (!['on', 'off', 'sos'].includes(body.accion)) throw new Error('Acción desconocida.');

  let filtro = '';
  if (body.dispositivo) filtro = `id=eq.${body.dispositivo}`;
  /* Un ambiente concreto del mapa: el Living de Nevados y no "las luces de
     Nevados". Es lo que pide el plano, donde se toca una habitación. */
  else if (body.zona && body.clave) {
    filtro = `zona=eq.${encodeURIComponent(body.zona)}&clave=eq.${encodeURIComponent(body.clave)}`;
  } else if (body.rol === 'tinaja') filtro = 'tipo=eq.tinaja';
  else if (body.zona) filtro = `zona=eq.${encodeURIComponent(body.zona)}`;
  else if (body.cabana) filtro = `cabana_id=eq.${body.cabana}&tipo=eq.luz`;
  else throw new Error('Falta decir qué aparato.');

  const devs = await sb(`dispositivos?${filtro}&activo=is.true&select=id,device_id,nombre,canal,proveedor,codigo`);
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
      const devs = await sb(`dispositivos?${filtro}&activo=is.true&select=id,device_id,nombre,canal,proveedor,codigo`);
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
  try {
    hecho.avisos = (await rpc('ewelink_revisar_caducidades', {}) ?? 0)
                 + (await rpc('smartlife_revisar_caducidad', {}) ?? 0);
  }
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
    if (ruta === 'estado')       return json(await estado());
    if (ruta === 'accion')       return json(await accion(await req.json()));

    return json({ error: 'Ruta desconocida.' }, 404);
  } catch (e) {
    /* El mensaje sube tal cual al panel a propósito: "eWeLink 401" o "no hay
       aparato etiquetado" dicen qué hacer, y un "error interno" no. */
    console.error(ruta, (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});
