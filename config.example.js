/* Copia este archivo como `config.js` en la misma carpeta y rellena los dos
   valores. Están en Supabase → Project Settings → API.

   ⚠️ La clave que va aquí es la ANÓNIMA (`anon` / `publishable`). Está pensada
   para vivir en el navegador: no da acceso a nada que las políticas de la base
   no permitan.

   NUNCA pongas aquí la `service_role`. Esa clave se salta todos los permisos, y
   cualquiera que abra el panel puede leerla desde el código fuente de la
   página. Sería entregar la base de datos entera. */

window.CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU_CLAVE_ANONIMA",
};
