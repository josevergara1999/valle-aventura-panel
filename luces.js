/* ============================================================================
   El mapa del complejo
   ============================================================================
   Port del diseño que hizo José en Claude Design. Los estilos, las posiciones
   de los edificios, las zonas del plano y las máscaras van TAL CUAL: eso es el
   diseño y no se toca. Lo que cambia es el motor.

   POR QUÉ NO ES UNA COPIA
   -----------------------
   El original corre sobre React y el runtime de Claude Design (`sc-for`,
   `DCLogic`, `support.js`). El panel es JavaScript a secas y sin compilación —
   se abre y funciona, que es lo que lo hace usable con mala señal. Así que la
   plantilla se monta una vez a mano y después solo se parchean los `style`.

   Y se parchean, no se vuelve a pintar: si se reescribiera el HTML en cada
   toque, las transiciones (`transition: opacity .6s`) empezarían de cero cada
   vez y las luces aparecerían de golpe en vez de encenderse. Cambiar el
   `cssText` de un elemento que ya existe sí dispara la transición.

   LO QUE SÍ CAMBIA DEL DISEÑO, Y POR QUÉ
   --------------------------------------
   En el diseño, tocar un ambiente lo enciende al instante y se guarda en el
   navegador. Aquí hay un aparato de verdad al otro lado:

   · El estado se PREGUNTA a eWeLink, no se recuerda. El huésped apaga desde el
     interruptor de la pared cuando quiere, y un plano que dice "encendido"
     sobre una luz apagada es peor que no tener plano.
   · Un interruptor tiene tres estados, no dos: apagado, MANDANDO, encendido.
     Mientras manda no miente: el plano no se enciende hasta que el aparato
     confirma.
   · Si no responde, el interruptor se queda donde estaba y lo dice. Sin señal y
     apagado no son lo mismo.
   ========================================================================== */

const LZ = {
  props: {
    velocidad: 1, zoomNivel: 6.5, zoomAncho: 118, brillo: 1.3, azulPiscina: 60,
    contadores: true, verTechos: false, verNombres: true,
  },
  /* Posiciones tal como quedaron en el diseño. En porcentaje del plano, que es
     lo que hace que el mapa aguante cualquier ancho de teléfono. */
  pos: {
    bod:  { x: 1,    y: 12,   t: 27.5 },
    c1:   { x: 47,   y: 6,    t: 18   },
    c2:   { x: 19,   y: 20,   t: 18   },
    c3:   { x: 72,   y: 23,   t: 18   },
    c4:   { x: 21.5, y: 35.5, t: 18   },
    pool: { x: 58,   y: 35,   t: 40   },
    pump: { x: 83,   y: 46.5, t: 14   },
  },
  edificios: [
    { id: 'bod',  name: 'Bodega',         bodega: true, w: 17,   h: 12.75 },
    { id: 'c1',   name: 'Nevados',                      w: 11.5, h: 14.75 },
    { id: 'c2',   name: 'Host',                         w: 11.5, h: 14.75, rot: -90 },
    { id: 'c3',   name: 'Shangri-La',                   w: 11.5, h: 14.75, rot: 90 },
    { id: 'c4',   name: 'El Chueco',                    w: 11.5, h: 14.75, rot: -90 },
    { id: 'pool', name: 'Piscina',        pool: true,   w: 25,   h: 14.2 },
    { id: 'pump', name: 'Sala de Bombas', pump: true,   w: 6.5,  h: 9.75 },
  ],
  st: { sel: 'c1', open: false, luces: {}, fuera: new Set(), pend: {}, uz: 1, ux: 0, uy: 0, gest: false, pa: 0.62, pw: 400, listo: false },
  refs: null,
};

/* Los iconos del panel, dibujados aquí y no traídos de una librería: son un
   trazo cada uno y el panel se usa donde la señal se cae. */
const LZ_IC = {
  terraza: 'M12 3a8 8 0 0 1 8 8H4a8 8 0 0 1 8-8zm0 8v8c0 1.5 1.2 2.5 2.6 2.5',
  cocina:  'M4 10h16v2a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6zM8 7V5m4 2V4m4 3V5',
  living:  'M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3M4 11a2 2 0 0 0 0 4h16a2 2 0 0 0 0-4M5 15v3m14-3v3',
  bodega:  'M3 8l9-5 9 5v10l-9 5-9-5zM3 8l9 5 9-5M12 13v10',
  rayo:    'M12 3L7 10h3l-4 6h5v4h2v-4h5l-4-6h3z',
  bano:    'M7 7a5 5 0 0 1 10 0v2M5 10h14M8 13v1m4-1v1m4-1v1m-8 3v1m4-1v1m4-1v1',
  agua:    'M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
  bomba:   'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
  caja:    'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 7v4',
  puente:  'M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3',
};

/* Los grupos del panel de abajo, con el ORDEN de canales de cada cabaña. No es
   el mismo en todas —en Host el Canal 1 de la trasera es tt2, en Shangri-La la
   cocina va al revés— y está así porque el diseño miró los interruptores de
   verdad. Cambiar esto por "que quede simétrico" enciende la luz equivocada. */
const LZ_GRUPOS = {
  c1: [
    { name: 'Terraza Cabaña 3', icon: LZ_IC.terraza, ch: [['farol1','Canal1'],['terraza','Canal2'],['living','Canal3']] },
    { name: 'T Trasera',        icon: LZ_IC.terraza, ch: [['tt1','Canal1'],['tt2','Canal2'],['tt3','Canal3']] },
    { name: 'Cocina',           icon: LZ_IC.cocina,  ch: [['cocina','Canal1'],['comedor','Canal2']] },
    { name: 'Pasillo',          icon: LZ_IC.living,  ch: [['pasillo','Canal1']] },
  ],
  c2: [
    { name: 'Terraza',   icon: LZ_IC.terraza, ch: [['farol1','Canal1'],['terraza','Canal2'],['living','Canal3']] },
    { name: 'T Trasera', icon: LZ_IC.terraza, ch: [['tt2','Canal1'],['tt1','Canal2'],['tt3','Canal3']] },
    { name: 'Cocina',    icon: LZ_IC.cocina,  ch: [['cocina','Canal1'],['comedor','Canal2']] },
    { name: 'Pasillo',   icon: LZ_IC.living,  ch: [['pasillo','Canal1']] },
  ],
  c3: [
    { name: 'Terraza',   icon: LZ_IC.terraza, ch: [['terraza','Canal1'],['farol1','Canal2'],['living','Canal3']] },
    { name: 'T Trasera', icon: LZ_IC.terraza, ch: [['tt1','Canal1'],['tt2','Canal2'],['tt3','Canal3']] },
    { name: 'Cocina',    icon: LZ_IC.cocina,  ch: [['comedor','Canal1'],['cocina','Canal2']] },
    { name: 'Pasillo',   icon: LZ_IC.living,  ch: [['pasillo','Canal1']] },
  ],
  c4: [
    { name: 'Dispositivo0fc85d', icon: LZ_IC.caja,   ch: [['farol1','Canal1'],['terraza','Canal2'],['living','Canal3']] },
    /* El Bridge es un puente RF, no una luz. Sale en la lista y sale muerto:
       esconderlo haría que algún día alguien lo buscara. */
    { name: 'Bridge', icon: LZ_IC.puente, off: true, ch: [] },
  ],
  bod: [
    { name: 'Entrada',    icon: LZ_IC.bodega, ch: [['bodega','Canal1']] },
    { name: 'T trasera',  icon: LZ_IC.rayo,   ch: [['exterior','Canal1'],['bano','Canal2']] },
    { name: 'Lavanderia', icon: LZ_IC.bano,   ch: [['lavanderia','Canal1']] },
  ],
  pool: [{ name: 'Luces Piscina', icon: LZ_IC.agua, ch: [['piscina','Canal1']] }],
  pump: [
    { name: 'Bomba  Piscina', icon: LZ_IC.bomba, ch: [['bombas','Canal1']] },
    /* En la cuenta de eWeLink no hay ninguna segunda bomba. Se deja a la vista
       y desconectada en vez de borrarla del diseño: el día que se instale, es
       una fila en la base y no un despliegue. */
    { name: 'Bomba 2', icon: LZ_IC.bomba, off: true, ch: [] },
  ],
};

const lzGrupos = (b) => LZ_GRUPOS[b.id] || [];
const lzAmbientes = (b) => {
  const vistos = new Set(), out = [];
  lzGrupos(b).forEach((g) => g.ch.forEach(([k]) => { if (!vistos.has(k)) { vistos.add(k); out.push(k); } }));
  return out;
};

/* Las zonas del plano de una cabaña: dónde cae cada ambiente sobre la planta.
   Coordenadas del diseño, en porcentaje de la imagen del plano. */
function lzZonas(b) {
  const base = [
    { k:'dorm1', x:5.5, y:7, w:25.5, h:17.5 }, { k:'bano2', x:31.5, y:7, w:11, h:16 },
    { k:'dorm2', x:42, y:7, w:28, h:25 }, { k:'bano1', x:6, y:33, w:17, h:9 },
    { k:'principal', x:5.5, y:45, w:25, h:27 }, { k:'comedor', x:41, y:33, w:25, h:17 },
    { k:'cocina', x:66.5, y:35.5, w:15, h:20 }, { k:'living', x:38, y:53, w:29, h:26 },
    { k:'terraza', x:6, y:80.5, w:78, h:15, glow:true },
    { k:'entrada', x:38, y:78.5, w:29, h:6, glow:true },
    { k:'pasillo', x:24, y:28.5, w:16, h:16 }, { k:'alrededores', ring:true },
  ];
  if (b.id === 'c1' || b.id === 'c2' || b.id === 'c3') {
    return base.concat([
      { k:'tt1', x:70.5, y:14.5, w:12, h:8, glow:true },
      { k:'tt2', x:4, y:1, w:92, h:5.5 },
      { k:'tt2', x:4.5, y:1.5, w:7, h:6, glow:true },
      { k:'tt2', x:34, y:1.5, w:7, h:6, glow:true },
      { k:'tt2', x:63.5, y:1.5, w:7, h:6, glow:true },
      { k:'tt3', x:70.5, y:22.5, w:12, h:9.5, glow:true },
      { k:'farol1', x:69, y:58, w:25, h:26 },
      { k:'terraza', x:3, y:72, w:36, h:15, glow:true },
    ]);
  }
  if (b.id === 'c4') {
    return base.concat([
      { k:'farol1', x:69, y:58, w:25, h:26 },
      { k:'terraza', x:3, y:72, w:36, h:15, glow:true },
    ]);
  }
  return base;
}

/* Bodega, piscina y bombas no tienen plano de cabaña: tienen su propia imagen y
   unas manchas de luz colocadas encima con máscaras radiales. */
function lzDefs(b) {
  if (b.bodega) return [
    { k:'bodega', img:'luces/bodega-on2.png', tap:'left:5%;top:3%;width:53%;height:51%;', spots:[
      {x:31,y:10,rx:33,ry:10,boost:1.25},{x:31,y:33,rx:33,ry:27,boost:1.2}] },
    { k:'exterior', img:'luces/bodega-on2.png', tap:'left:0%;top:8%;width:5%;height:48%;', spots:[
      {x:5.5,y:17,rx:8,ry:11,boost:1.35},{x:5.5,y:35,rx:8,ry:11,boost:1.35},
      {x:5.5,y:52,rx:8,ry:11,boost:1.35},{x:30,y:57,rx:12,ry:8,boost:1.35},
      {x:43,y:57,rx:12,ry:8,boost:1.35}] },
    { k:'lavanderia', img:'luces/bodega-on2.png', tap:'left:59%;top:3%;width:39%;height:72%;', spots:[
      {x:74,y:9,rx:18,ry:8},{x:76,y:31,rx:20,ry:9},{x:78,y:50,rx:20,ry:22}] },
    { k:'bano', img:'luces/bodega-on2.png', tap:'left:59%;top:76%;width:39%;height:21%;', spots:[
      {x:72,y:87,rx:18,ry:10},{x:84,y:86,rx:8,ry:9}] },
  ];
  if (b.pool) return [
    { k:'piscina', base:'luces/pool-on.png', overlay:'luces/pool-azul-soft.png',
      tap:'left:0;top:0;width:100%;height:100%;', spots:[] },
  ];
  return [
    { k:'bombas', img:'luces/sala-on.png', tap:'left:6%;top:6%;width:88%;height:32%;', spots:[
      {x:31,y:17,rx:20,ry:15},{x:49,y:17,rx:20,ry:15},{x:68,y:18,rx:21,ry:16}] },
    { k:'bomba2', img:'luces/sala-on.png', tap:'left:50%;top:37%;width:32%;height:14%;', spots:[
      {x:63,y:45,rx:20,ry:12},{x:70,y:65,rx:15,ry:13}] },
  ];
}

/* ── Los valores que dependen del estado ──────────────────────────────────── */
function lzValores() {
  const P = LZ.props, S = LZ.st;
  const g = P.brillo, azul = P.azulPiscina / 100, Z = P.zoomNivel, v = P.velocidad;
  const techos = P.verTechos, nombres = P.verNombres, contar = P.contadores;

  const BS = LZ.edificios.map((b) => {
    const p = LZ.pos[b.id], w = p.t;
    return Object.assign({}, b, { x: p.x, y: p.y, w, h: b.h * (w / b.w) });
  });
  const selB = BS.find((b) => b.id === S.sel) || BS[1];
  const encendida = (id, k) => !!(S.luces[id] && S.luces[id][k]);
  const cuenta = (b) => lzAmbientes(b).filter((k) => encendida(b.id, k)).length;
  const total = BS.reduce((a, b) => a + cuenta(b), 0);

  const planos = {};
  BS.forEach((b) => {
    const activo = S.open && S.sel === b.id;
    const esEstructura = b.pool || b.pump || b.bodega;
    const fade = `opacity:${activo || (!techos && !esEstructura) ? 1 : 0};transition:opacity .35s;`;
    const rooms = [];

    if (esEstructura) {
      lzDefs(b).forEach((d) => {
        const on = encendida(b.id, d.k);
        if (d.base) rooms.push({
          fill: `position:absolute;inset:0;pointer-events:none;background-image:url('${d.base}');background-size:100% 100%;opacity:${on?1:0};transition:opacity ${b.pool?'1.1s':'0.5s'} ease;`,
          box: 'position:absolute;inset:0;z-index:1;border:none;padding:0;pointer-events:none;background:transparent;', k: null });
        if (d.overlay) rooms.push({
          fill: `position:absolute;inset:0;pointer-events:none;background-image:url('${d.overlay}');background-size:100% 100%;opacity:${on?azul.toFixed(2):0};transition:opacity 1.1s ease;`,
          box: 'position:absolute;inset:0;z-index:1;border:none;padding:0;pointer-events:none;background:transparent;', k: null });
        d.spots.forEach((s, i) => rooms.push({
          fill: `position:absolute;inset:0;pointer-events:none;background-image:url('${d.img}');background-size:100% 100%;${s.boost?`filter:brightness(${s.boost}) saturate(1.15);`:''}-webkit-mask-image:radial-gradient(ellipse ${s.rx}% ${s.ry}% at ${s.x}% ${s.y}%, black 28%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0.3) 78%, transparent 100%);mask-image:radial-gradient(ellipse ${s.rx}% ${s.ry}% at ${s.x}% ${s.y}%, black 28%, rgba(0,0,0,0.7) 55%, rgba(0,0,0,0.3) 78%, transparent 100%);opacity:${on?1:0};transition:opacity .55s ease ${(on ? 0.15 + i*0.4 : 0).toFixed(2)}s;`,
          box: 'position:absolute;inset:0;z-index:2;border:none;padding:0;pointer-events:none;background:transparent;', k: null }));
        rooms.push({ fill: 'display:none;', k: d.k,
          box: `position:absolute;${d.tap}z-index:3;border:none;padding:0;cursor:pointer;pointer-events:${activo?'auto':'none'};background:transparent;` });
      });
      planos[b.id] = { wrap: 'position:absolute;inset:0;z-index:1;filter:drop-shadow(0 1.5px 3px rgba(30,30,30,0.28));opacity:1;', rooms };
      return;
    }

    const rot = b.rot || 0;
    const mios = lzAmbientes(b);
    lzZonas(b).forEach((z) => {
      const on = encendida(b.id, z.k);
      if (!z.ring && mios.indexOf(z.k) < 0) { rooms.push({ fill:'display:none;', box:'display:none;', k:null }); return; }
      if (z.ring) { rooms.push({ fill:'display:none;', k:null,
        box: `position:absolute;left:5%;top:6%;width:80.5%;height:73%;z-index:1;border:none;padding:0;border-radius:8%;pointer-events:none;background:transparent;box-shadow:${on ? `0 0 60px 30px rgba(244,187,102,${(0.32*g).toFixed(2)})` : 'none'};transition:box-shadow .4s;` }); return; }
      rooms.push({
        k: z.k,
        fill: z.pure ? 'display:none;' : `position:absolute;inset:-12%;border-radius:4px;pointer-events:none;background-image:url('luces/plano-on.png');background-size:${(10000/(z.w*1.24)).toFixed(2)}% ${(10000/(z.h*1.24)).toFixed(2)}%;background-position:${((z.x-z.w*0.12)/(100-z.w*1.24)*100).toFixed(3)}% ${((z.y-z.h*0.12)/(100-z.h*1.24)*100).toFixed(3)}%;${z.glow?'filter:brightness(1.35) saturate(1.15);':''}-webkit-mask-image:radial-gradient(ellipse 90% 90% at 50% 50%, black 10%, rgba(0,0,0,0.78) 32%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.26) 74%, rgba(0,0,0,0.09) 89%, transparent 100%);mask-image:radial-gradient(ellipse 90% 90% at 50% 50%, black 10%, rgba(0,0,0,0.78) 32%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.26) 74%, rgba(0,0,0,0.09) 89%, transparent 100%);opacity:${on?1:0};transition:opacity .6s;`,
        box: `position:absolute;left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%;z-index:2;border:none;padding:0;border-radius:4px;cursor:pointer;pointer-events:${activo?'auto':'none'};background:${on && z.glow ? `radial-gradient(ellipse at center, rgba(255,206,130,${(0.4*g).toFixed(2)}) 0%, rgba(255,206,130,${(0.22*g).toFixed(2)}) 38%, rgba(255,206,130,${(0.09*g).toFixed(2)}) 62%, rgba(255,206,130,0) 85%)` : 'transparent'};transition:box-shadow .4s, background .5s;`,
      });
    });
    planos[b.id] = {
      wrap: `position:absolute;left:50%;top:50%;width:480px;aspect-ratio:1054/1492;z-index:1;transform-origin:45% 42.5%;transform:translate(-45%,-42.5%) rotate(${rot}deg) scale(${((1.37 * S.pw * b.h / 100) / 679).toFixed(4)});${fade}`,
      rooms,
    };
  });

  const AMB = '84,168,196';
  const edificios = BS.map((b) => {
    const c = cuenta(b);
    const esPP = !!b.pool || !!b.pump;
    const techo = b.bodega
      ? 'linear-gradient(180deg,#899094 0%,#7B8187 52%,#666C71 100%)'
      : 'linear-gradient(180deg,#1E5568 0%,#164452 52%,#0F323E 100%)';
    const forma = (b.bodega || esPP) ? '' : 'clip-path:polygon(0 0, 81.4% 0, 81.4% 22%, 100% 22%, 100% 70%, 79% 70%, 79% 100%, 38% 100%, 38% 90.5%, 0 90.5%);';
    const halo = c ? `drop-shadow(0 0 ${Math.round(10*g)}px rgba(${AMB},${(0.55*g).toFixed(2)})) ` : '';
    return {
      id: b.id, name: b.name, badge: String(c),
      box: `position:absolute;left:${b.x}%;top:${b.y}%;width:${b.w}%;aspect-ratio:${(b.w/b.h).toFixed(3)};z-index:${S.open && S.sel===b.id ? 5 : 2};opacity:${S.open && S.sel!==b.id ? 0 : 1};transition:opacity .35s;`,
      planWrap: planos[b.id].wrap, rooms: planos[b.id].rooms,
      tapFx: `position:absolute;inset:-12% 0 -22% 0;z-index:4;background:none;border:none;padding:0;cursor:pointer;pointer-events:${S.open?'none':'auto'};`,
      grupo: `position:absolute;inset:0;z-index:3;pointer-events:none;transform:rotate(${b.rot||0}deg);opacity:${(S.open && S.sel===b.id) || esPP || b.bodega || !techos ? 0 : 1};transition:opacity .4s ease ${S.open ? '.35s' : '0s'};`,
      techo: (esPP || b.bodega)
        ? `position:absolute;inset:0;background:url('${b.pool ? (c ? 'luces/pool-on.png' : 'luces/pool-gris.png') : b.pump ? (c ? 'luces/sala-on.png' : 'luces/sala-gris.png') : (c ? 'luces/bodega-on2.png' : 'luces/bodega-gris2.png')}') center/100% 100% no-repeat;transition:filter .3s;filter:${halo}drop-shadow(0 2px 4px rgba(30,30,30,0.25));`
        : `position:absolute;inset:0;border-radius:2px;background:${techo};${forma}transition:filter .3s;filter:${halo}drop-shadow(0 2px 4px rgba(30,30,30,0.3));`,
      label: (b.bodega
        ? 'position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);'
        : b.pump ? 'position:absolute;right:calc(100% + 6px);top:50%;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl;'
        : b.pool ? 'position:absolute;top:calc(100% + 7px);left:50%;transform:translateX(-50%);'
        : `position:absolute;top:calc(100% + ${b.rot ? 12 : 34}%);left:50%;transform:translateX(-50%);`)
        + `display:${nombres?'block':'none'};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#565B54;white-space:nowrap;font-weight:600;opacity:${S.open?0:1};transition:opacity .25s;`,
      badgeFx: `position:absolute;top:-9px;right:-9px;z-index:3;min-width:19px;height:19px;border-radius:10px;background:#17414F;color:#F7F6F0;font-size:11px;font-weight:700;display:${c && contar ? 'flex' : 'none'};align-items:center;justify-content:center;padding:0 5px;box-shadow:0 2px 8px rgba(23,65,79,0.4);opacity:${S.open?0:1};transition:opacity .25s;`,
    };
  });

  /* El encuadre al abrir un edificio: cuánto hay que mover y ampliar el plano
     para que quepa entre la barra de arriba y el panel de abajo. */
  const ph = S.pw / (S.pa || 0.62);
  const panelTop = 0.46 * ph;
  const disponible = Math.max(110, panelTop - 74 - 18);
  const esEstructura = !!(selB.pool || selB.pump || selB.bodega);
  const fw = esEstructura ? selB.w : selB.w / 0.805;
  const fh = esEstructura ? selB.h : selB.h / 0.73;
  const rot = (!esEstructura && selB.rot) || 0;
  const dw = rot ? fh : fw, dh = rot ? fw : fh;
  /* Cuánto se amplía al tocar un edificio. Tres topes y manda el más pequeño:
     lo que cabe de alto sin meterse debajo del panel, lo que cabe de ancho, y
     el tope duro de `zoomNivel`.

     `zoomAncho` es el porcentaje del mapa que puede llegar a ocupar el edificio.
     El diseño traía 92 y se quedaba corto: en un teléfono el plano salía a media
     pantalla y había que hacer pinza para leer los ambientes, que es justo lo
     que la vista con zoom viene a evitar. Es el número a tocar si se quiere más
     o menos grande — no hay que entender el resto de la cuenta para moverlo.

     Se llama `escala` y no `esc` a propósito: `esc` es la función que escapa
     HTML, y tenerlas con el mismo nombre es una trampa esperando. */
  const escala = Math.min(disponible / (S.pw * dh / 100),
                          P.zoomAncho / dw,
                          selB.w < 10 ? 99 : Z);
  const cyT = ((74 + panelTop) / 2) / ph * 100;
  let ox = esEstructura ? 0 : 0.055 * fw, oy = esEstructura ? 0 : 0.085 * fh;
  if (rot === 90) { const t = ox; ox = -oy; oy = t; }
  else if (rot === -90) { const t = ox; ox = oy; oy = -t; }
  const cx = selB.x + selB.w/2 + ox, cy = selB.y + selB.h * (S.pa||0.62) / 2 + oy * (S.pa||0.62);
  const dur = (0.8/v).toFixed(2), dl = (0.25/v).toFixed(2);

  const planeFx = S.open
    ? `transform:translate(${(50-cx).toFixed(2)}%, ${(cyT-cy).toFixed(2)}%) scale(${escala.toFixed(2)});transform-origin:${cx}% ${cy}%;transition:transform ${dur}s cubic-bezier(.55,.06,.28,.99);cursor:default;`
    : `transform:translate(${S.ux.toFixed(1)}px, ${S.uy.toFixed(1)}px) scale(${S.uz.toFixed(3)});transform-origin:50% 50%;transition:${S.gest ? 'none' : `transform ${dur}s cubic-bezier(.55,.06,.28,.99)`};cursor:grab;`;

  const grupos = lzGrupos(selB).map((gp) => {
    const nOn = gp.ch.filter(([k]) => encendida(selB.id, k)).length;
    const alguna = nOn > 0;
    return {
      name: gp.name, icon: gp.icon,
      sub: gp.off ? 'Desconectado'
         : (alguna ? `${nOn} de ${gp.ch.length} encendida${nOn===1?'':'s'}` : 'Apagado'),
      chip: `width:34px;height:34px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;transition:background .25s,color .25s;background:${alguna?'rgba(23,65,79,0.10)':'#E7E6DD'};color:${alguna?'#17414F':'#8A8D86'};`,
      channels: gp.ch.map(([k, etiqueta]) => {
        const on = encendida(selB.id, k);
        const mandando = !!LZ.st.pend[`${selB.id}:${k}`];
        const sinSenal = LZ.st.fuera.has(`${selB.id}:${k}`);
        return {
          zona: selB.id, clave: k,
          /* Mientras manda, el interruptor se queda a medio camino. No salta al
             otro lado hasta que el aparato contesta: prometer y desdecirse es
             lo que hace que dejes de creerle a la pantalla. */
          label: sinSenal ? 'sin señal' : etiqueta,
          track: `width:42px;height:24px;border-radius:999px;position:relative;transition:background .25s;opacity:${sinSenal?0.45:1};background:${mandando ? '#A9B3B7' : (on ? '#17414F' : '#D6D5CC')};`,
          knob: `position:absolute;top:2px;left:${mandando ? '11px' : (on ? '20px' : '2px')};width:20px;height:20px;border-radius:50%;transition:left .25s,background .25s;background:#FFFFFF;box-shadow:0 1px 3px rgba(28,28,30,0.25);`,
          lbl: `font-size:10.5px;font-weight:600;text-align:center;transition:color .25s;color:${sinSenal ? '#B0453C' : (on ? '#17414F' : '#8A8D86')};`,
        };
      }),
    };
  });

  const sel = cuenta(selB);
  return {
    edificios, planeFx, grupos, total: String(total),
    selName: selB.name,
    selSub: sel ? `${sel} de ${lzAmbientes(selB).length} luces encendidas` : 'Todas las luces apagadas',
    selOffFx: `display:${sel?'inline-flex':'none'};align-items:center;background:transparent;border:none;border-left:1px solid rgba(28,28,30,0.12);color:#17414F;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;`,
    masterFx: `display:${total && !S.open ? 'inline-flex' : 'none'};position:absolute;top:10px;right:10px;z-index:6;align-items:center;gap:6px;background:#17414F;color:#F7F6F0;border:none;border-radius:999px;padding:9px 14px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(23,65,79,0.3);`,
    barraFx: `position:absolute;left:10px;right:10px;top:10px;z-index:8;display:flex;align-items:center;background:rgba(244,243,236,0.92);backdrop-filter:blur(8px);border:1px solid #DAD9D0;border-radius:12px;padding:4px 6px;box-shadow:0 4px 14px rgba(28,28,30,0.10);opacity:${S.open?1:0};pointer-events:${S.open?'auto':'none'};transform:translateY(${S.open?0:-8}px);transition:opacity .35s ease ${S.open?dl:0}s, transform .35s ease ${S.open?dl:0}s;`,
    panelFx: `position:absolute;left:0;right:0;bottom:0;top:46%;z-index:7;display:flex;flex-direction:column;gap:10px;padding:14px 12px calc(14px + env(safe-area-inset-bottom));overflow-y:auto;background:linear-gradient(180deg, rgba(236,235,228,0.94), rgba(236,235,228,0.99));backdrop-filter:blur(10px);border-radius:18px 18px 0 0;border-top:1px solid #DAD9D0;opacity:${S.open?1:0};pointer-events:${S.open?'auto':'none'};transform:translateY(${S.open?0:24}px);transition:opacity .35s ease ${S.open?dl:0}s, transform .4s ease ${S.open?dl:0}s;`,
  };
}

/* ── Montaje ──────────────────────────────────────────────────────────────
   Se construye UNA vez. A partir de ahí solo se cambian los `style`, que es lo
   que deja que las transiciones del diseño funcionen: reescribir el HTML las
   reiniciaría y las luces aparecerían de golpe en vez de encenderse. */
function lzMontar(caja) {
  const imgDe = (b) => b.pool ? 'luces/pool-gris.png'
                     : b.pump ? 'luces/sala-gris.png'
                     : b.bodega ? 'luces/bodega-gris2.png'
                     : 'luces/plano-gris.png';

  const v = lzValores();
  const edificiosHTML = v.edificios.map((e, i) => {
    const b = LZ.edificios[i];
    return `<div data-ed="${e.id}" style="${e.box}">
      <div data-plan style="${e.planWrap}">
        <img src="${imgDe(b)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover">
        ${e.rooms.map((r, j) => `<button type="button" data-room="${e.id}" data-k="${r.k || ''}" data-j="${j}"
            style="${r.box}"><div style="${r.fill}"></div></button>`).join('')}
      </div>
      <div data-grupo style="${e.grupo}"><div data-techo style="${e.techo}"></div></div>
      <button type="button" data-tap="${e.id}" style="${e.tapFx}" aria-label="${e.name}"></button>
      <div data-label style="${e.label}">${e.name}</div>
      <div data-badge style="${e.badgeFx}">${e.badge}</div>
    </div>`;
  }).join('');

  caja.innerHTML = `
    <div class="lz-todo">
      <div class="lz-marco" id="lz-marco">
        <button type="button" id="lz-master" style="${v.masterFx}">Apagar todo · <span id="lz-total">${v.total}</span></button>
        <div id="lz-plano" style="position:absolute;inset:0;touch-action:none;${v.planeFx}">
          <div style="position:absolute;inset:-150%;background-color:#FFFFFF;background-image:radial-gradient(circle, rgba(20,61,74,0.16) 1px, transparent 1.4px);background-size:18px 18px"></div>
          <div style="position:absolute;inset:3%;border:1.2px dashed #B7BBAE;border-radius:8px"></div>
          <div style="position:absolute;left:0;right:0;bottom:0;height:5.5%;background:#E9E7E1;border-top:1px dashed #C2C0B8">
            <div style="position:absolute;left:0;right:0;top:48%;border-top:2px dashed #D2D0C8"></div>
            <div style="position:absolute;right:2.5%;top:12%;font-size:8px;letter-spacing:0.3em;color:#A5A399;font-weight:600">RUTA</div>
          </div>
          <div style="position:absolute;top:4.5%;right:4.5%;display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid #7B8187"></div>
            <div style="font-size:10px;font-weight:700;color:#7B8187">N</div>
          </div>
          <div style="position:absolute;left:4.5%;bottom:8%;display:flex;align-items:center;gap:6px">
            <div style="width:15%;min-width:52px;height:1.5px;background:#9A9E96"></div>
            <div style="font-size:9px;color:#7B8187;font-weight:600">100 m</div>
          </div>
          ${edificiosHTML}
        </div>
        <div id="lz-barra" style="${v.barraFx}">
          <button type="button" id="lz-back" style="display:inline-flex;align-items:center;background:transparent;border:none;border-right:1px solid rgba(28,28,30,0.12);color:#17414F;padding:8px 12px;font-size:12.5px;font-weight:700;cursor:pointer">&larr; Mapa</button>
          <div style="flex:1;text-align:center;min-width:0;padding:0 4px">
            <div id="lz-selname" style="font-size:13px;font-weight:700;color:#1C1C1E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.selName}</div>
            <div id="lz-selsub" style="font-size:10px;color:#6A6E67;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.selSub}</div>
          </div>
          <button type="button" id="lz-selof" style="${v.selOffFx}">Apagar</button>
        </div>
        <div id="lz-panel" style="${v.panelFx}"></div>
      </div>
    </div>`;

  LZ.refs = {
    caja,
    marco:  caja.querySelector('#lz-marco'),
    plano:  caja.querySelector('#lz-plano'),
    master: caja.querySelector('#lz-master'),
    total:  caja.querySelector('#lz-total'),
    barra:  caja.querySelector('#lz-barra'),
    panel:  caja.querySelector('#lz-panel'),
    selname: caja.querySelector('#lz-selname'),
    selsub:  caja.querySelector('#lz-selsub'),
    selof:   caja.querySelector('#lz-selof'),
    eds: v.edificios.map((e) => {
      const raiz = caja.querySelector(`[data-ed="${e.id}"]`);
      return {
        id: e.id, raiz,
        plan:  raiz.querySelector('[data-plan]'),
        grupo: raiz.querySelector('[data-grupo]'),
        techo: raiz.querySelector('[data-techo]'),
        tap:   raiz.querySelector('[data-tap]'),
        label: raiz.querySelector('[data-label]'),
        badge: raiz.querySelector('[data-badge]'),
        rooms: [...raiz.querySelectorAll('[data-room]')],
      };
    }),
  };

  lzMedir();
  lzGestos();
  lzPintarPanel();
}

function lzMedir() {
  const p = LZ.refs && LZ.refs.plano;
  if (p && p.offsetHeight > 0) {
    LZ.st.pa = p.offsetWidth / p.offsetHeight;
    LZ.st.pw = p.offsetWidth;
  }
}

/* ── Parcheo ─────────────────────────────────────────────────────────────── */
function lzPintar() {
  if (!LZ.refs) return;
  const v = lzValores(), R = LZ.refs;

  R.plano.style.cssText = `position:absolute;inset:0;touch-action:none;${v.planeFx}`;
  R.master.style.cssText = v.masterFx;
  R.total.textContent = v.total;
  R.barra.style.cssText = v.barraFx;
  R.panel.style.cssText = v.panelFx;
  R.selname.textContent = v.selName;
  R.selsub.textContent = v.selSub;
  R.selof.style.cssText = v.selOffFx;

  v.edificios.forEach((e, i) => {
    const r = R.eds[i];
    r.raiz.style.cssText  = e.box;
    r.plan.style.cssText  = e.planWrap;
    r.grupo.style.cssText = e.grupo;
    r.techo.style.cssText = e.techo;
    r.tap.style.cssText   = e.tapFx;
    r.label.style.cssText = e.label;
    r.badge.style.cssText = e.badgeFx;
    r.badge.textContent   = e.badge;
    e.rooms.forEach((room, j) => {
      const el = r.rooms[j];
      if (!el) return;
      el.style.cssText = room.box;
      el.dataset.k = room.k || '';
      el.firstElementChild.style.cssText = room.fill;
    });
  });

  lzPintarPanel(v);
}

/* El panel de abajo sí se vuelve a escribir entero: cambia cuando cambias de
   edificio, y ahí no hay ninguna transición que preservar. */
function lzPintarPanel(v) {
  if (!LZ.refs) return;
  v = v || lzValores();
  LZ.refs.panel.innerHTML = v.grupos.map((gp) => `
    <div style="background:#F4F3EC;border:1px solid #DAD9D0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:12px;flex:none">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="${gp.chip}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${gp.icon}"></path></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700;color:#1C1C1E">${VA_PANEL.esc(gp.name)}</div>
          <div style="font-size:10.5px;color:#6A6E67">${gp.sub}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        ${gp.channels.map((ch) => `
          <button type="button" data-ch="${ch.zona}" data-ck="${ch.clave}"
                  style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;background:none;border:none;padding:4px 0;cursor:pointer">
            <div style="${ch.track}"><div style="${ch.knob}"></div></div>
            <div style="${ch.lbl}">${ch.label}</div>
          </button>`).join('')}
      </div>
    </div>`).join('');
}

/* ── Gestos ───────────────────────────────────────────────────────────────
   Arrastrar y pellizcar sobre el mapa. Van a mano y no con una librería: son
   sesenta líneas y una dependencia se paga en la montaña. */
function lzGestos() {
  const mp = LZ.refs.marco;
  if (!mp || mp._lz) return;
  mp._lz = true;
  const ptrs = new Map();
  let base = null, movido = false, tg = null;

  const encajar = (ux, uy, uz) => {
    const w = mp.offsetWidth || 400, h = mp.offsetHeight || 600;
    const mx = (uz-1)*w/2 + w*0.5, my = (uz-1)*h/2 + h*0.5;
    return { ux: Math.max(-mx, Math.min(mx, ux)), uy: Math.max(-my, Math.min(my, uy)), uz };
  };
  const aplicar = (o) => { Object.assign(LZ.st, o); lzPintar(); };

  mp.addEventListener('wheel', (e) => {
    if (LZ.st.open) return;
    e.preventDefault();
    const r = mp.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width/2, cy = e.clientY - r.top - r.height/2;
    const z = LZ.st.uz, nz = Math.min(6, Math.max(1, z * Math.exp(-e.deltaY * 0.0016)));
    clearTimeout(tg);
    tg = setTimeout(() => aplicar({ gest: false }), 180);
    aplicar(Object.assign({ gest: true },
      encajar(cx - (cx - LZ.st.ux) * nz/z, cy - (cy - LZ.st.uy) * nz/z, nz)));
  }, { passive: false });

  mp.addEventListener('pointerdown', (e) => {
    if (LZ.st.open) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    base = { ux: LZ.st.ux, uy: LZ.st.uy, uz: LZ.st.uz, ps: [...ptrs.values()].map((p) => ({ ...p })) };
    movido = false;
  });

  window.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || LZ.st.open || !base) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...ptrs.values()], r = mp.getBoundingClientRect();
    if (ps.length === 1 && base.ps.length === 1) {
      const dx = ps[0].x - base.ps[0].x, dy = ps[0].y - base.ps[0].y;
      if (Math.abs(dx) + Math.abs(dy) > 6) movido = true;
      if (movido) aplicar(Object.assign({ gest: true }, encajar(base.ux + dx, base.uy + dy, base.uz)));
    } else if (ps.length >= 2 && base.ps.length >= 2) {
      movido = true;
      const d0 = Math.hypot(base.ps[0].x-base.ps[1].x, base.ps[0].y-base.ps[1].y) || 1;
      const d1 = Math.hypot(ps[0].x-ps[1].x, ps[0].y-ps[1].y);
      const nz = Math.min(6, Math.max(1, base.uz * d1/d0));
      const m0x = (base.ps[0].x+base.ps[1].x)/2 - r.left - r.width/2;
      const m0y = (base.ps[0].y+base.ps[1].y)/2 - r.top - r.height/2;
      const mx = (ps[0].x+ps[1].x)/2 - r.left - r.width/2;
      const my = (ps[0].y+ps[1].y)/2 - r.top - r.height/2;
      aplicar(Object.assign({ gest: true },
        encajar(mx - (m0x - base.ux) * nz/base.uz, my - (m0y - base.uy) * nz/base.uz, nz)));
    }
  });

  const soltar = (e) => {
    if (!ptrs.delete(e.pointerId)) return;
    const ps = [...ptrs.values()];
    base = ps.length ? { ux: LZ.st.ux, uy: LZ.st.uy, uz: LZ.st.uz, ps: ps.map((p) => ({ ...p })) } : null;
    if (!ps.length) aplicar({ gest: false });
  };
  window.addEventListener('pointerup', soltar);
  window.addEventListener('pointercancel', soltar);

  /* Arrastrar el mapa no debe encender nada. Se cancela el clic que sigue a un
     arrastre, en fase de captura para llegar antes que los botones. */
  mp.addEventListener('click', (e) => {
    if (movido) { e.stopPropagation(); e.preventDefault(); movido = false; }
  }, true);

  window.addEventListener('resize', () => { lzMedir(); lzPintar(); });
}

/* ── Los aparatos ────────────────────────────────────────────────────────── */
async function lzCargarEstado() {
  try {
    const d = await VA_PANEL.elLlamar('estado');
    const luces = {};
    LZ.edificios.forEach((b) => { luces[b.id] = {}; });
    Object.keys(d.luces || {}).forEach((k) => {
      const [zona, clave] = k.split(':');
      if (luces[zona]) luces[zona][clave] = !!d.luces[k];
    });
    LZ.st.luces = luces;
    LZ.st.fuera = new Set(d.fuera || []);
    LZ.st.listo = true;
  } catch (e) {
    LZ.st.listo = false;
    throw e;
  }
}

/* Encender o apagar un ambiente.
 *
 * NO es optimista. El plano no se enciende hasta que el aparato confirma, y
 * mientras tanto el interruptor se queda a medio camino. Un segundo de espera
 * honesta vale más que una luz que aparece y se desdice: en cuanto la pantalla
 * miente una vez, hay que ir a mirar por la ventana igual. */
async function lzToggle(zona, clave) {
  const k = `${zona}:${clave}`;
  if (LZ.st.pend[k]) return;
  if (LZ.st.fuera.has(k)) { VA_PANEL.avisar('Ese aparato no responde.', 'error'); return; }

  const actual = !!(LZ.st.luces[zona] && LZ.st.luces[zona][clave]);
  LZ.st.pend[k] = true;
  lzPintar();
  try {
    await VA_PANEL.elLlamar('accion', { zona, clave, accion: actual ? 'off' : 'on' });
    if (!LZ.st.luces[zona]) LZ.st.luces[zona] = {};
    LZ.st.luces[zona][clave] = !actual;
  } catch (e) {
    VA_PANEL.avisar(e.message, 'error');
    /* Si falló puede que el aparato se haya quedado a medias, así que no se
       supone nada: se vuelve a preguntar. */
    try { await lzCargarEstado(); } catch (e2) { /* ya está avisado */ }
  }
  delete LZ.st.pend[k];
  lzPintar();
}

async function lzVarios(pares, accion) {
  const utiles = pares.filter(([z, c]) => !LZ.st.fuera.has(`${z}:${c}`));
  if (!utiles.length) return;
  utiles.forEach(([z, c]) => { LZ.st.pend[`${z}:${c}`] = true; });
  lzPintar();
  const fallos = [];
  for (const [z, c] of utiles) {
    try {
      await VA_PANEL.elLlamar('accion', { zona: z, clave: c, accion });
      if (!LZ.st.luces[z]) LZ.st.luces[z] = {};
      LZ.st.luces[z][c] = accion === 'on';
    } catch (e) { fallos.push(`${z}:${c}`); }
  }
  utiles.forEach(([z, c]) => { delete LZ.st.pend[`${z}:${c}`]; });
  if (fallos.length) VA_PANEL.avisar(`${fallos.length} no respondieron.`, 'error');
  lzPintar();
}

/* ── Toques ──────────────────────────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  if (!LZ.refs || !LZ.refs.caja.contains(e.target)) return;

  const tap = e.target.closest('[data-tap]');
  if (tap) {
    Object.assign(LZ.st, { sel: tap.dataset.tap, open: true, uz: 1, ux: 0, uy: 0 });
    lzPintar();
    return;
  }
  const room = e.target.closest('[data-room]');
  if (room && room.dataset.k) { lzToggle(room.dataset.room, room.dataset.k); return; }

  const ch = e.target.closest('[data-ch]');
  if (ch) { lzToggle(ch.dataset.ch, ch.dataset.ck); return; }

  if (e.target.closest('#lz-back')) { LZ.st.open = false; lzPintar(); return; }

  if (e.target.closest('#lz-selof')) {
    const b = LZ.edificios.find((x) => x.id === LZ.st.sel);
    lzVarios(lzAmbientes(b).filter((k) => LZ.st.luces[b.id] && LZ.st.luces[b.id][k]).map((k) => [b.id, k]), 'off');
    return;
  }
  if (e.target.closest('#lz-master')) {
    const todos = [];
    LZ.edificios.forEach((b) => lzAmbientes(b).forEach((k) => {
      if (LZ.st.luces[b.id] && LZ.st.luces[b.id][k]) todos.push([b.id, k]);
    }));
    if (todos.length && confirm(`Apagar ${todos.length} luces del complejo?`)) lzVarios(todos, 'off');
  }
});

