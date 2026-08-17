/* Envío de avisos al teléfono — Supabase Edge Function.
 *
 * Lee la cola `avisos` y manda una notificación push a cada dispositivo
 * registrado. Se llama por cron cada minuto.
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
 *   supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:...
 */

const SB_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
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

  let ok = 0, fallos = 0;
  for (const aviso of (avisos ?? [])) {
    let alguno = false;
    for (const d of disps) {
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
    if (alguno) {
      ok++;
      await api(`avisos?id=eq.${aviso.id}`, {
        method: 'PATCH', body: JSON.stringify({ enviado_at: new Date().toISOString() }),
      });
    }
  }

  return new Response(JSON.stringify({ enviados: ok, fallos, dispositivos: disps.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
});
