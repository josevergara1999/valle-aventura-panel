/* Envío de avisos al teléfono — Supabase Edge Function.
 *
 * Lee la cola `avisos` y manda una notificación push a los dispositivos que
 * toquen. Se llama por cron cada minuto.
 *
 * QUÉ SIGNIFICA "LOS QUE TOQUEN"
 * ------------------------------
 * Hasta el 30-ago-2026 era "todos". Desde que existe la app de Atlas, cada
 * aviso va solo a las suscripciones de la app a la que pertenece — ver
 * `destinatarios()` más abajo y `db/push-por-app.sql`.
 *
 * POR QUÉ ESTÁ ESCRITO A MANO Y NO CON UNA LIBRERÍA
 * ------------------------------------------------
 * `web-push`, la librería habitual, depende de APIs de Node que en Deno no
 * están completas. Todo lo que hace falta —ECDH, HKDF, AES-GCM y firma
 * ES256— existe en Web Crypto, que sí está. Son cien líneas y no arrastra
 * dependencias que puedan romperse en un despliegue.
 *
 * EL CIFRADO ES OBLIGATORIO, NO OPCIONAL
 * --------------------------------------
 * Los servidores de Google y Apple reenvían el aviso, así que el contenido
 * pasa por ellos. Web Push (RFC 8291) obliga a cifrarlo de punta a punta con
 * claves que solo conocen este servidor y el teléfono: ni Google ni Apple
 * pueden leer que la cabaña Nevados se quedó sin agua caliente.
 *
 * DESPLIEGUE
 *   supabase secrets set VA_SERVICE_KEY=sb_secret_...
 *   supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:...
 */

const SB_URL  = Deno.env.get('SUPABASE_URL') ?? '';

/* POR QUE NO SE USA SOLO SUPABASE_SERVICE_ROLE_KEY
 * -----------------------------------------------
 * Este proyecto usa el sistema nuevo de claves (sb_publishable_ / sb_secret_).
 * En esos proyectos SUPABASE_SERVICE_ROLE_KEY llega vacia, porque pertenece al
 * sistema antiguo de claves JWT. Y como Supabase reserva el prefijo SUPABASE_,
 * tampoco se puede definir a mano.
 *
 * El resultado era silencioso y por eso costo verlo: sin clave, las lecturas a
 * la base devolvian 401, la respuesta no era un array, y la funcion salia por
 * el atajo de "no hay ningun telefono suscrito" con dispositivos: 0. Tres
 * iPhone registrados y activos, y ni un aviso enviado nunca.
 *
 * Se lee VA_SERVICE_KEY, que si se puede definir, y se deja la antigua como
 * respaldo por si algun dia se reactivan las claves JWT.
 */
const SB_KEY  = Deno.env.get('VA_SERVICE_KEY')
             ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
             ?? '';
const VAPID_PUB  = Deno.env.get('VAPID_PUBLIC') ?? '';
const VAPID_PRIV = Deno.env.get('VAPID_PRIVATE') ?? '';
const SUBJECT    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:reservasvalleaventura@gmail.com';

// ── base64url ──────────────────────────────────────────────────────────────
const b64d = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64e = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const une = (...arrs: Uint8Array[]): Uint8Array => {
  const t = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { t.set(a, o); o += a.length; }
  return t;
};

// ── HKDF (RFC 5869) ────────────────────────────────────────────────────────
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, largo: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, largo * 8),
  );
}

// ── El JWT que prueba que el aviso sale de nuestro servidor ────────────────
async function firmaVapid(endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const cab = b64e(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const cuerpo = b64e(new TextEncoder().encode(JSON.stringify({
    aud,
    // 12 horas. El máximo que acepta la norma son 24; con menos margen, un
    // reloj desajustado en el servidor tumbaría todos los envíos.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: SUBJECT,
  })));
  const sinFirmar = `${cab}.${cuerpo}`;

  const pub = b64d(VAPID_PUB);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64e(pub.slice(1, 33)),
    y: b64e(pub.slice(33, 65)),
    d: VAPID_PRIV,
    ext: true,
  };
  const clave = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const firma = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, clave, new TextEncoder().encode(sinFirmar),
  ));
  return `${sinFirmar}.${b64e(firma)}`;
}

// ── Cifrado del contenido (RFC 8291, aes128gcm) ────────────────────────────
async function cifrar(p256dh: string, auth: string, texto: string): Promise<Uint8Array> {
  const claveCliente = b64d(p256dh);
  const secreto = b64d(auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Par efímero: uno nuevo por envío, para que dos avisos no compartan clave.
  const efimero = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const pubEfimera = new Uint8Array(await crypto.subtle.exportKey('raw', efimero.publicKey));

  const pubCliente = await crypto.subtle.importKey(
    'raw', claveCliente, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const compartido = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: pubCliente }, efimero.privateKey, 256,
  ));

  const te = new TextEncoder();
  const infoIkm = une(te.encode('WebPush: info\0'), claveCliente, pubEfimera);
  const ikm = await hkdf(secreto, compartido, infoIkm, 32);

  const cek   = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const claveAes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // El 0x02 es el delimitador de último registro que exige la norma.
  const datos = une(te.encode(texto), new Uint8Array([0x02]));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, claveAes, datos,
  ));

  // Cabecera: salt(16) + tamaño de registro(4) + largo de la clave(1) + clave(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return une(salt, rs, new Uint8Array([pubEfimera.length]), pubEfimera, cifrado);
}

// ── Un envío ───────────────────────────────────────────────────────────────
async function enviar(disp: any, aviso: any): Promise<number> {
  const cuerpo = await cifrar(disp.p256dh, disp.auth, JSON.stringify({
    titulo: aviso.titulo,
    cuerpo: aviso.cuerpo,
    destino: aviso.destino,
    urgencia: aviso.urgencia,
    id: aviso.id,
  }));
  const jwt = await firmaVapid(disp.endpoint);

  const r = await fetch(disp.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // Los urgentes despiertan el teléfono; el resto puede esperar a que se
      // encienda la pantalla, que ahorra batería.
      'Urgency': aviso.urgencia === 'alta' ? 'high' : 'normal',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUB}`,
    },
    body: cuerpo,
  });
  return r.status;
}

// ── A quién le toca cada aviso ─────────────────────────────────────────────
/* Desde el 30-ago-2026 hay DOS apps instalables en el mismo dominio: el panel
 * (`/`) y Atlas (`/atlas/`). Cada una se instala aparte y crea su propia
 * suscripción, así que un mismo teléfono puede tener dos filas en
 * `push_dispositivos`. Mandarle el aviso a las dos lo haría sonar dos veces
 * por el mismo hecho, y ese es el camino más corto a que José silencie el
 * sistema entero y deje de enterarse también de lo que sí importa.
 *
 * El aviso YA dice a dónde va: `destino` es el campo con el que el service
 * worker decide qué pantalla abrir al tocarlo, y los dos únicos sitios que
 * escriben avisos de Atlas —el trigger `tg_aviso_reserva` y `valle_airbnb.py`—
 * ponen 'atlas'. Se reutiliza en vez de inventar un segundo campo para lo
 * mismo, que un día acabaría contradiciendo al primero. */
const appDelAviso = (aviso: any): string => (aviso?.destino === 'atlas' ? 'atlas' : 'panel');

/* EL RESPALDO NO ES UN ADORNO. Mientras la app de Atlas no esté instalada en
 * ningún teléfono, sus avisos tienen que seguir llegando por el panel, que es
 * como funcionaba hasta hoy: desplegar esto no puede dejar a José sin el aviso
 * de que entró una reserva de Airbnb. Y protege también el día que la
 * desinstale o le limpie los datos.
 *
 * Al revés NO se hace: un aviso del panel no cae en la app de Atlas si no hay
 * panel instalado. Esa pantalla responde dos preguntas sobre Atlas y nada más;
 * enseñarle ahí "Piden pellet · Cabaña Nevados" y que al tocarlo no lleve a
 * ninguna parte es peor que no enseñarlo. */
function destinatarios(disps: any[], app: string): any[] {
  const propios = disps.filter((d) => (d.app ?? 'panel') === app);
  if (propios.length) return propios;
  if (app === 'panel') return [];
  return disps.filter((d) => (d.app ?? 'panel') === 'panel');
}

// ── Acceso a la base ───────────────────────────────────────────────────────
const api = (ruta: string, opts: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${ruta}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });

Deno.serve(async (req) => {
  if (!VAPID_PUB || !VAPID_PRIV) {
    return new Response(JSON.stringify({ error: 'Faltan las claves VAPID' }), { status: 503 });
  }
  /* Sin clave de servicio no se puede leer nada, y callarselo fue justo lo que
     hizo que el fallo pasara desapercibido: la funcion respondia 200 con
     dispositivos: 0, indistinguible de "nadie se ha suscrito todavia". */
  if (!SB_KEY) {
    return new Response(JSON.stringify({
      error: 'Falta VA_SERVICE_KEY',
      comoArreglarlo: 'supabase secrets set VA_SERVICE_KEY=sb_secret_...',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  // Primero los recordatorios calculados (tinaja de mañana, check-out…)
  await api('rpc/avisos_programar', { method: 'POST', body: '{}' }).catch(() => {});

  const ahora = new Date().toISOString();
  const [avisos, disps] = await Promise.all([
    api(`avisos?select=*&enviado_at=is.null&enviar_at=lte.${ahora}&order=enviar_at&limit=40`).then((r) => r.json()),
    api('push_dispositivos?select=*&activo=is.true').then((r) => r.json()),
  ]);

  if (!Array.isArray(disps) || !disps.length) {
    return new Response(JSON.stringify({ avisos: avisos?.length ?? 0, dispositivos: 0 }), { status: 200 });
  }

  let ok = 0, fallos = 0, repetidos = 0, sinDestino = 0;
  for (const aviso of (avisos ?? [])) {
    /* A quien va ANTES de reservarlo. Si no hay ni un telefono al que mandarlo
       se deja pendiente sin tocar: reservarlo obligaria a devolverlo a la cola
       despues, y ese ida y vuelta por cada pasada del cron —una por minuto— no
       compra nada. Se queda en la cola y `avisos_caducar()` lo retira a las 6h,
       que es lo mismo que pasaba cuando no habia ningun dispositivo. */
    const aQuien = destinatarios(disps, appDelAviso(aviso));
    if (!aQuien.length) { sinDestino++; continue; }

    /* RESERVAR EL AVISO ANTES DE MANDARLO
     * ----------------------------------
     * Antes se marcaba enviado DESPUES de mandarlo, y en ese hueco cabia otra
     * pasada: el cron corre cada minuto, asi que si una tanda tarda mas de lo
     * normal la siguiente lee los mismos avisos pendientes y los vuelve a
     * mandar. Jose recibio cada aviso por duplicado.
     *
     * Ahora se marca PRIMERO, con la condicion de que siga sin marcar. El
     * filtro enviado_at=is.null viaja en la propia peticion, asi que la carrera
     * la resuelve la base: solo una pasada se lo lleva, y las demas reciben
     * cero filas y siguen de largo. */
    const reserva = await api(
      'avisos?id=eq.' + aviso.id + '&enviado_at=is.null',
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ enviado_at: new Date().toISOString() }),
      },
    );
    const reservadas = await reserva.json().catch(() => []);
    if (!Array.isArray(reservadas) || reservadas.length === 0) { repetidos++; continue; }

    let alguno = false;
    for (const d of aQuien) {
      try {
        const st = await enviar(d, aviso);
        if (st >= 200 && st < 300) {
          alguno = true;
          await api(`push_dispositivos?id=eq.${d.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ultimo_ok: new Date().toISOString(), fallos: 0 }),
          });
        } else if (st === 404 || st === 410) {
          /* El navegador tiró la suscripción: desinstaló la app o limpió los
             datos. Se desactiva en vez de reintentar para siempre. */
          await api(`push_dispositivos?id=eq.${d.id}`, {
            method: 'PATCH', body: JSON.stringify({ activo: false }),
          });
        } else {
          fallos++;
          await api(`push_dispositivos?id=eq.${d.id}`, {
            method: 'PATCH', body: JSON.stringify({ fallos: (d.fallos ?? 0) + 1 }),
          });
        }
      } catch (_) { fallos++; }
    }
    /* Se marca enviado si llegó AL MENOS a un teléfono. Si no llegó a ninguno
       se deja pendiente y el siguiente ciclo lo reintenta: es preferible un
       aviso repetido a uno perdido. */
    /* Si no llego a NINGUN telefono se devuelve a la cola, porque la reserva
       de arriba ya lo dio por enviado. Un aviso repetido molesta; uno perdido
       puede ser un huesped sin agua caliente al que nadie atiende. */
    if (alguno) {
      ok++;
    } else {
      await api('avisos?id=eq.' + aviso.id, {
        method: 'PATCH', body: JSON.stringify({ enviado_at: null }),
      });
    }
  }

  /* El desglose por app no es adorno: es lo unico que permite comprobar de un
     vistazo, tras desplegar, que el reparto quedo como se queria y que la app
     de Atlas ya cuenta como destino. */
  const porApp: Record<string, number> = {};
  for (const d of disps) porApp[d.app ?? 'panel'] = (porApp[d.app ?? 'panel'] ?? 0) + 1;

  return new Response(JSON.stringify({
    enviados: ok, fallos, repetidos, sinDestino,
    dispositivos: disps.length, porApp,
  }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
