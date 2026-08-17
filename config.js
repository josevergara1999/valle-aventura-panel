/* Conexión real a Supabase — proyecto "Valle Aventura".
 *
 * La clave de aquí es la ANÓNIMA (anon / publishable). Está pensada para vivir
 * en el navegador: no da acceso a nada que las políticas de la base no
 * permitan. El panel escribe porque hay una sesión iniciada detrás, no por
 * esta clave.
 *
 * NUNCA pongas aquí la `sb_secret_` / service_role. Esa se salta todos los
 * permisos, y cualquiera que abra el panel puede leerla del código fuente de
 * la página: sería entregar la base entera.
 *
 * El simulador con un año de datos de prueba sigue en `config.simulador.js`.
 * Para volver a él, renombra los dos archivos.
 */
window.CONFIG = {
  SUPABASE_URL: "https://wxxlqszadprwizporhbg.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_2AuGtg42OxMoFDm7t3TbKA_ukrx_wDM",
};
