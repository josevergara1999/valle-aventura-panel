# Panel — Valle Aventura

Reservas, precios, disponibilidad, aseos y pellet de las tres cabañas.
En `panel.valleaventura-chile.com`.

**Exige iniciar sesión.** Que este repositorio sea público no expone nada: los
datos los protege Supabase con RLS y permisos por columna, no el alojamiento.
Aquí no vive ninguna credencial — solo la clave *publicable*, que está pensada
para viajar en el navegador y por sí sola no puede leer datos de huéspedes.

## Quién entra

José, su papá y Javiera, cada uno con su usuario en Supabase Auth.

## Por qué está alojado y no se abre desde un archivo

Dos cosas lo exigen:

- **Las notificaciones push** necesitan HTTPS y un dominio de verdad. Servido
  desde la red local no llegan.
- **Instalarlo en el teléfono** como app requiere lo mismo.

## Estructura

| | |
|---|---|
| `index.html` | la app entera, una sola página |
| `app.js` | toda la lógica |
| `config.js` | a qué proyecto de Supabase apunta |
| `tokens.css` | los colores; el resto de CSS los usa |
| `sw.js` | para que se instale y abra con mala señal |

El service worker **no cachea datos**: precios y reservas se piden siempre a la
red. Un precio viejo servido desde caché es peor que un error.
