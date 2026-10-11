// Einzige Stelle, die Job-Typen registriert. API und Worker laden nur diese Datei,
// damit POST /jobs und der Worker dieselben Typen kennen (Bug #26).
import "./ping.js";
import "./media.js";
import "./cleanup.js";
import "./pinfinity/cleanup.js";
import "./pinfinity/publish-pin.js";
import "./pinfinity/send-publish-error-mail.js";
import "./pinfinity/reconcile-publish-jobs.js";
import "./pinfinity/cleanup-publish-events.js";
import "./pinfinity/refresh-pinterest-tokens.js";
