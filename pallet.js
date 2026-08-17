/* Pallet de sacos de pellet, en CSS 3D. Los estilos van en pallet.css.
   Se carga antes que app.js, que lo llama al pintar Finanzas. */

/* Mosaico de una camada: [x, y, ancho, alto] en % de la huella,
   orientación ('h' tumbado a lo ancho, 'v' girado 90°) y si toca el
   borde izquierdo (pinta su cara lateral). El orden es el orden de
   llenado: primero la franja delantera, que es la que se ve */
const MOSAICO_X = [
  [ 0,   60, 50,   40, 'h', 1],  // pareja delante
  [50,   60, 50,   40, 'h', 0],
  [ 0,    0, 33.4, 60, 'v', 1],  // trío detrás, girado 90°
  [33.3,  0, 33.4, 60, 'v', 0],
  [66.6,  0, 33.4, 60, 'v', 0],
];
const MOSAICO_Y = [               // el mismo patrón rotado 180°
  [ 0,   40, 33.4, 60, 'v', 1],
  [33.3, 40, 33.4, 60, 'v', 0],
  [66.6, 40, 33.4, 60, 'v', 0],
  [ 0,    0, 50,   40, 'h', 1],
  [50,    0, 50,   40, 'h', 0],
];

/**
 * Devuelve el HTML del pallet como string, listo para innerHTML.
 * @param {number} sacos      sacos que quedan (el exceso se dibuja como lleno)
 * @param {number} capacidad  sacos del pallet lleno (70 por defecto)
 */
function palletHTML(sacos, capacidad = 70) {
  const SACOS_POR_CAMADA = 5; // si cambia, cambiar también los mosaicos

  const cap = Math.max(1, Math.round(capacidad) || 1);
  const reales = Math.max(0, Math.round(sacos) || 0);
  // se dibuja como mucho el pallet lleno; el aria-label sí dice la cifra real
  const n = Math.min(reales, cap);

  // fija el grosor de camada para que el pallet lleno mida siempre lo mismo
  const camadasTotales = Math.ceil(cap / SACOS_POR_CAMADA);
  let llenas = Math.floor(n / SACOS_POR_CAMADA);
  let sueltos = n % SACOS_POR_CAMADA;
  // la camada superior se dibuja SIEMPRE saco a saco: es la única cuya
  // tapa se ve, y ahí las esquinas redondeadas tienen que ser reales.
  // Las de abajo quedan como losas baratas que solo pintan costados
  if (n > 0 && sueltos === 0) { llenas -= 1; sueltos = SACOS_POR_CAMADA; }

  let camadas = '';
  for (let i = 0; i < llenas; i++) {
    // la orientación alterna por camada: traba de albañil, no columna
    camadas += `<div class="pl-camada pl-camada--llena ${i % 2 ? 'pl-camada--y' : 'pl-camada--x'}" style="--i:${i}"></div>`;
  }
  if (sueltos > 0) {
    // la camada incompleta se redondea hacia arriba y se llena hueco a
    // hueco del mosaico: agregar o quitar UN saco se ve
    const mos = llenas % 2 ? MOSAICO_Y : MOSAICO_X;
    let hs = '';
    for (let s = 0; s < sueltos; s++) {
      const [x, y, w, h, o, b] = mos[s];
      hs += `<div class="pl-saco pl-saco--${o}${b ? ' pl-saco--borde' : ''}" style="--sx:${x};--sy:${y};--sw:${w};--sh:${h}"></div>`;
    }
    camadas += `<div class="pl-camada pl-camada--suelta" style="--i:${llenas}">${hs}</div>`;
  }

  let tablas = '';
  for (let t = 0; t < 5; t++) tablas += `<div class="pl-tabla" style="--t:${t}"></div>`;

  // Alto de la pila EN Z (em), para que la caja no reserve sitio para sacos
  // que no están: con altura fija, un pallet a medias dejaba un hueco en
  // blanco arriba del tamaño exacto de lo ya gastado.
  // Se pasa en crudo. El CSS lo convierte a píxeles de pantalla con los
  // factores medidos en el navegador, no con el coseno del rotateX: la
  // perspectiva amplifica y el coseno se queda corto (0.53 frente a 0.84).
  const altoCamada = Math.min(0.55, 7.7 / camadasTotales);
  const usadas = llenas + (sueltos > 0 ? 1 : 0);
  const pila = +(usadas * altoCamada).toFixed(3);

  // la información vive en el aria-label del contenedor; todo lo de
  // dentro es decorativo y va bajo un único aria-hidden
  return `
<div class="pl-pallet" role="img" style="--pl-pila:${pila}em" aria-label="Quedan ${reales} de ${cap} sacos de pellet en el pallet">
  <div class="pl-vista" aria-hidden="true">
    <div class="pl-escena" style="--pl-camadas:${camadasTotales}">
      <div class="pl-sombra"></div>
      <div class="pl-base">
        <div class="pl-faldon pl-faldon--frente"></div>
        <div class="pl-faldon pl-faldon--lado"></div>
        ${tablas}
      </div>
      <div class="pl-pila">${camadas}</div>
    </div>
  </div>
</div>`;
}
