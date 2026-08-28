/* La barra de abajo: burbuja que viaja, muesca recortada y riel lateral.
 *
 * Seis columnas. La pestaña activa NO se pinta: su icono se desvanece y sube, y
 * en su lugar aterriza una burbuja que viaja por la barra llevándoselo, dentro
 * de una muesca abierta en el borde superior. La sexta abre un riel vertical
 * con lo que no cabe.
 *
 * Todo en PORCENTAJE del ancho, nunca en píxeles fijos: la barra mide distinto
 * en cada teléfono y los centros tienen que caer donde caiga la columna.
 *
 * No usa framework. El panel es DOM directo, así que donde la referencia decía
 * "dale una key distinta para que la animación se repita", aquí se reemplaza el
 * nodo del icono a mano — que es lo mismo por dentro.
 */
(function () {
  'use strict';

  /* Si algo aqui dentro se cae, `nav.innerHTML = ''` ya habria dejado la barra
     vacia y el panel sin forma de cambiar de pantalla —desde un telefono, sin
     manera de arreglarlo—. Asi que todo va envuelto: si falla, se repone una
     barra de texto sin gracia pero que funciona. */
  try {
    construir();
  } catch (err) {
    try {
      console.error('[menu] no se pudo montar la barra:', err);
      barraDeEmergencia();
    } catch (_) {}
  }

  function barraDeEmergencia() {
    const nav = document.querySelector('nav.tabs');
    if (!nav) return;
    nav.innerHTML = '';
    nav.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:70;display:flex;' +
      'background:#143D4A;padding-bottom:env(safe-area-inset-bottom,0px)';
    [['calendario','Agenda'],['huespedes','Gente'],['aseos','Aseos'],
     ['cotizaciones','Cotiza'],['luces','Luces'],['finanzas','Plata'],
     ['tarifas','Precios'],['avisos','Avisos']].forEach(function (par) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = par[1];
      b.style.cssText = 'flex:1;min-height:52px;background:none;border:0;color:#F2F1EC;' +
        'font:600 10px/1.2 system-ui;cursor:pointer';
      b.addEventListener('click', function () { if (window.VA_IR) window.VA_IR(par[0]); });
      nav.appendChild(b);
    });
  }

  function construir() {

  /* Las cinco de cada día, y la sexta que abre el resto. */
  const BARRA = [
    { v: 'calendario',   t: 'Agenda',  i: 'calendario' },
    { v: 'huespedes',    t: 'Gente',   i: 'gente' },
    { v: 'aseos',        t: 'Aseos',   i: 'aseo' },
    { v: 'cotizaciones', t: 'Cotiza',  i: 'ticket' },
    { v: 'luces',        t: 'Luces',   i: 'bombilla' },
    { v: '__mas',        t: 'Mas',     i: 'mas' },
  ];

  /* Lo que vive en el riel, agrupado. El nombre del grupo va en la etiqueta
     flotante: en 60 px de ancho no cabe escrito. */
  const RIEL = [
    { v: 'finanzas', t: 'Finanzas', g: 'Dinero',  i: 'billete' },
    { v: 'tarifas',  t: 'Precios',  g: 'Dinero',  i: 'etiqueta' },
    { sep: true },
    { v: 'avisos',   t: 'Avisos',   g: 'Ajustes', i: 'campana' },
  ];

  const N = BARRA.length;
  const centro = (i) => (100 / N) * (i + 0.5);   // 8.333, 25, 41.667...

  /* Iconos de línea, del set de Lucide. Sin relleno y sin emojis. */
  const P = {
    calendario: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    gente:      '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/><path d="M22 20v-1.5a4 4 0 0 0-3-3.85"/><path d="M16 3.6a4 4 0 0 1 0 7.750"/>',
    aseo:       '<path d="M9 3.5h6v4H9zM10 7.5v3M14 7.5v3"/><rect x="6" y="10.5" width="12" height="10" rx="2"/><path d="M12 14v3"/>',
    ticket:     '<path d="M3 9.5V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5Z"/><path d="M13 5v3M13 11v2M13 16v3"/>',
    bombilla:   '<path d="M9 18h6M10 21.5h4"/><path d="M12 2.5a6.5 6.5 0 0 0-4 11.6V18h8v-3.9a6.5 6.5 0 0 0-4-11.6Z"/>',
    mas:        '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    billete:    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    etiqueta:   '<path d="M20.5 13.3 13.3 20.5a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12V4.5A1.5 1.5 0 0 1 4.5 3H12a2 2 0 0 1 1.4.6l7.1 7.1a2 2 0 0 1 0 2.6Z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    campana:    '<path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  };
  const svg = (n) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || '') + '</svg>';

  const nav = document.querySelector('nav.tabs');
  if (!nav) return;

  /* TRAMPA 7: `position:fixed` se rompe si CUALQUIER ancestro tiene
     `transform`, `filter` o `will-change` — pasa a medirse contra ese ancestro
     en vez de contra la ventana, y la barra se va a media pantalla. Colgandola
     del <body> no hay ancestro que pueda hacerlo. */
  if (nav.parentNode !== document.body) document.body.appendChild(nav);

  /* ---- Construir la barra ---- */
  nav.innerHTML = '';
  const muesca = document.createElement('div');
  muesca.className = 'tabs-muesca';
  /* El relleno lleva la Z (es una figura cerrada); el borde iria sin ella. */
  muesca.innerHTML = '<svg viewBox="0 0 110 34" preserveAspectRatio="none">' +
    '<path d="M0 0 C 30 0, 24 29, 55 29 C 86 29, 80 0, 110 0 Z"/></svg>';
  nav.appendChild(muesca);

  const burbuja = document.createElement('div');
  burbuja.className = 'tabs-burbuja';
  nav.appendChild(burbuja);

  const botones = BARRA.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === 0));
    b.dataset.vista = s.v;
    b.dataset.idx = i;
    b.innerHTML = svg(s.i) + '<span>' + s.t + '</span>';
    nav.appendChild(b);
    return b;
  });

  /* El contador de solicitudes vuelve a su sitio, sobre Gente. */
  const badge = document.getElementById('hu-badge');
  if (badge) botones[1].appendChild(badge);

  /* TRAMPA 2: el gesto vive en un ref, no en estado. Si se leyera de algo que
     se repinta, `pointerup` veria el valor de antes del repintado —vacio— y el
     toque se perderia entero, justo despues de cambiar de pantalla, que es
     cuando el arbol se rehace y tarda. Aqui son variables sueltas: se leen al
     instante. */
  let activo = 0;
  let arrastrando = false;
  let idxGesto = 0;

  function colocar(i, animarIcono) {
    const c = centro(i);
    burbuja.style.left = 'calc(' + c + '% - (var(--burbuja) / 2))';
    muesca.style.left  = 'calc(' + c + '% - (var(--muesca-ancho) / 2))';
    if (animarIcono) {
      /* Se reemplaza el nodo para que `bubblePop` vuelva a correr. Reusandolo,
         la burbuja llega muda. */
      burbuja.innerHTML = svg(BARRA[i].i);
      burbuja.classList.remove('pop');
      void burbuja.offsetWidth;
      burbuja.classList.add('pop');
    }
  }

  function marcar(i) {
    botones.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
  }

  /* La burbuja aterriza y RECIEN ENTONCES cambia la pantalla. */
  function ir(i, desdeGesto) {
    if (i === activo && !desdeGesto) return abrirSiEsMas(i);
    activo = i;
    marcar(i);
    colocar(i, true);
    const v = BARRA[i].v;
    /* Tocando se espera a que el viaje se vea; arrastrando no hace falta,
       ya se vio con el dedo puesto. */
    const espera = desdeGesto ? 0 : 220;
    setTimeout(() => {
      if (v === '__mas') abrirRiel();
      else if (window.VA_IR) window.VA_IR(v);
    }, espera);
  }
  function abrirSiEsMas(i) { if (BARRA[i].v === '__mas') abrirRiel(); }

  /* ---- Gestos de la barra ---- */
  /* TRAMPA 5: la burbuja tambien se puede agarrar, que es donde la mano va
     primero. Pero como se mueve con el dedo, su propio rectangulo no sirve de
     regla: se mide siempre contra la barra. */
  function idxDesdeX(clientX) {
    const r = nav.getBoundingClientRect();
    const p = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(N - 1, Math.floor(p * N)));
  }

  function empezar(e) {
    if (e.button != null && e.button !== 0) return;
    arrastrando = true;
    idxGesto = idxDesdeX(e.clientX);
    colocar(idxGesto, idxGesto !== activo);
    marcar(idxGesto);
    try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function mover(e) {
    if (!arrastrando) return;
    const i = idxDesdeX(e.clientX);
    if (i !== idxGesto) { idxGesto = i; colocar(i, true); marcar(i); }
  }
  function soltar() {
    if (!arrastrando) return;
    arrastrando = false;
    /* TRAMPA 3: no se limpia nada antes de navegar. Si se limpiara, la burbuja
       volveria un instante a la pestaña vieja —la pantalla aun no cambio— y se
       veria rebotar. */
    ir(idxGesto, true);
  }

  nav.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target === burbuja || burbuja.contains(e.target)) empezar(e);
  });
  nav.addEventListener('pointermove', mover);
  nav.addEventListener('pointerup', soltar);
  nav.addEventListener('pointercancel', () => { arrastrando = false; });
  botones.forEach((b, i) => b.addEventListener('click', (e) => { e.preventDefault(); if (!arrastrando) ir(i); }));

  /* ---- El riel ---- */
  let riel = null, velo = null, tag = null, rielIdx = 0;

  function entradas() { return RIEL.filter((r) => !r.sep); }

  function abrirRiel() {
    if (riel) return;
    burbuja.classList.add('lanzar');

    velo = document.createElement('div');
    velo.className = 'riel-velo';
    velo.addEventListener('click', cerrarRiel);
    document.body.appendChild(velo);

    riel = document.createElement('div');
    riel.className = 'riel';
    /* El alto de fila sale del alto de la ventana, con un minimo: con muchas
       entradas un alto fijo se sale por arriba en un telefono chico. */
    const alto = Math.max(38, Math.min(56, Math.round(window.innerHeight * 0.062)));
    riel.style.setProperty('--fila', alto + 'px');

    const rm = document.createElement('div');
    rm.className = 'riel-muesca';
    rm.innerHTML = '<svg viewBox="0 0 34 110" preserveAspectRatio="none">' +
      '<path class="base" d="M0 0 C 0 30, 29 24, 29 55 C 29 86, 0 80, 0 110 Z"/>' +
      '<path class="velo" d="M0 0 C 0 30, 29 24, 29 55 C 29 86, 0 80, 0 110 Z"/></svg>';
    riel.appendChild(rm);

    const rb = document.createElement('div');
    rb.className = 'riel-burbuja';
    riel.appendChild(rb);

    RIEL.forEach((r) => {
      const d = document.createElement('div');
      if (r.sep) { d.className = 'riel-sep'; }
      else { d.className = 'riel-fila'; d.style.height = alto + 'px'; d.innerHTML = svg(r.i); }
      riel.appendChild(d);
    });
    document.body.appendChild(riel);

    tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'riel-tag';
    document.body.appendChild(tag);

    rielIdx = 0;
    pintarRiel(rb, rm);

    /* Solo se arrastra. Tocar un icono suelto mueve la burbuja pero no entra:
       con iconos solos, entrar de un toque es entrar a ciegas. La etiqueta ES
       el boton de entrar. */
    let dr = false;
    const filas = Array.prototype.slice.call(riel.querySelectorAll('.riel-fila'));
    const idxDesdeY = (y) => {
      let mejor = 0, dist = Infinity;
      filas.forEach((f, k) => {
        const r = f.getBoundingClientRect();
        const d = Math.abs(y - (r.top + r.height / 2));
        if (d < dist) { dist = d; mejor = k; }
      });
      return mejor;
    };
    riel.addEventListener('pointerdown', (e) => {
      dr = true; rielIdx = idxDesdeY(e.clientY); pintarRiel(rb, rm);
      try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    });
    riel.addEventListener('pointermove', (e) => {
      if (!dr) return;
      const i = idxDesdeY(e.clientY);
      if (i !== rielIdx) { rielIdx = i; pintarRiel(rb, rm); }
    });
    riel.addEventListener('pointerup', () => { dr = false; });
    riel.addEventListener('pointercancel', () => { dr = false; });
    tag.addEventListener('click', () => {
      const e = entradas()[rielIdx];
      cerrarRiel();
      if (e && window.VA_IR) window.VA_IR(e.v);
    });
    document.addEventListener('keydown', escRiel);
  }

  function pintarRiel(rb, rm) {
    const filas = Array.prototype.slice.call(riel.querySelectorAll('.riel-fila'));
    const f = filas[rielIdx]; if (!f) return;
    const rr = riel.getBoundingClientRect(), fr = f.getBoundingClientRect();
    const y = fr.top - rr.top + fr.height / 2;
    rb.style.top = (y - 21) + 'px';
    rm.style.top = (y - 42) + 'px';
    rb.innerHTML = svg(entradas()[rielIdx].i);
    const e = entradas()[rielIdx];
    tag.innerHTML = '<small>' + e.g + '</small>' + e.t;
    tag.style.top = (fr.top + fr.height / 2 - 21) + 'px';
  }

  function escRiel(e) { if (e.key === 'Escape') cerrarRiel(); }

  function cerrarRiel() {
    document.removeEventListener('keydown', escRiel);
    [riel, velo, tag].forEach((n) => { if (n && n.parentNode) n.parentNode.removeChild(n); });
    riel = velo = tag = null;
    burbuja.classList.remove('lanzar');
    /* Si sales del riel sin elegir, la burbuja se queda sobre la sexta: es de
       donde saliste. */
    colocar(activo, true);
  }

  /* Arranque: la primera, ya pintada. */
  colocar(0, true);
  marcar(0);
  }
})();
