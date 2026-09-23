# Bot de WhatsApp Business – Librería / Colegio Nadino

## Flujo
Cliente escribe → **Colegio Nadino | Librería** → **Impresión | Consulta**
- Consulta → el bot se calla y espera al personal.
- Impresión → **Blanco y negro** (A4/Oficio/A3 → simple/doble faz → 1/2/Otro)
  o **Color** (A4/Oficio → común/fotográfico/autoadhesivo → simple/doble faz → 1/2/Otro)
- Al final envía el resumen y "Aguardá a que el personal se comunique…".

Después de un pedido o consulta el bot queda en silencio `HANDOFF_HOURS` horas para
que conteste una persona. El cliente puede escribir `menu` para volver a empezar.

## 1. Configurar Meta (WhatsApp Cloud API)
1. https://developers.facebook.com → Crear app → tipo *Business* → agregar producto **WhatsApp**.
2. En *WhatsApp > Configuración de la API* agregá tu número y copiá el **Phone number ID**.
3. Generá un **token permanente**: Meta Business Suite → Configuración del negocio →
   Usuarios del sistema → crear (admin) → asignar la app → Generar token con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`.
4. Copiá la **clave secreta de la app** (Configuración > Básica) → `APP_SECRET`.

## 2. Desplegar en Dokploy
1. Subí esta carpeta a un repo (GitHub/GitLab).
2. Dokploy → Project → **Create Service > Application** → conectá el repo.
3. Build Type: **Dockerfile**.
4. En **Environment** pegá las variables de `.env.example` con tus valores.
5. En **Domains** agregá p. ej. `bot.tudominio.com`, puerto **3000**, HTTPS activado (Let's Encrypt).
   El DNS del dominio debe apuntar a la IP del VPS.
6. Deploy. Probá que `https://bot.tudominio.com/` responda `ok`.

## 3. Conectar el webhook
Meta → WhatsApp → Configuración → Webhook:
- URL: `https://bot.tudominio.com/webhook`
- Token de verificación: el mismo `VERIFY_TOKEN`
- Suscribirse al campo **messages**.

## Notas
- Las sesiones están en memoria: al redeployar se reinician los menús en curso (no afecta nada más).
- Pedidos y consultas quedan registrados en los **Logs** de la app en Dokploy (`[PEDIDO]`, `[CONSULTA]`).
- Para editar textos u opciones, modificá el objeto `FLOW` en `src/index.js`.
  Límites de WhatsApp: máx. 3 botones por mensaje y 20 caracteres por botón.
