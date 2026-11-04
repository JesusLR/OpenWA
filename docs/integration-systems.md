# Sesiones separadas por sistema

La API `/api/integrations/sessions` permite crear, listar, iniciar, consultar el QR, cerrar y eliminar sesiones del sistema autenticado. Utiliza las mismas sesiones y motores que el panel `/sessions`.

## Credenciales

En el entorno de OpenWA configurar un objeto JSON con una clave aleatoria **diferente por sistema**. Generar cada clave con `openssl rand -hex 32` y guardarla como secreto.

```dotenv
INTEGRATION_SYSTEMS='{"de_viaje_en_viaje":"CLAVE_ALEATORIA_DE_64_CARACTERES","otro_sistema":"OTRA_CLAVE_ALEATORIA_DISTINTA_DE_64_CARACTERES"}'
```

El identificador admite entre 3 y 40 letras minúsculas, números o guiones bajos. Las claves requieren al menos 32 caracteres y no pueden repetirse entre sistemas. Una configuración ausente o inválida deshabilita estos endpoints (503), sin abrir acceso anónimo.

Estas claves **no son claves del API general ni API_MASTER_KEY**. El API general conserva sus permisos anteriores: las aplicaciones que necesiten aislamiento deben utilizar exclusivamente estas credenciales de integración, sin recibir claves generales sin restricciones de sesiones. Solo autentican la API de integraciones: no se deben entregar a otros sistemas claves administrativas del panel, pues estas conservan su visión global de administración. Tampoco se admiten estas credenciales en el API general ni en el socket de eventos.

## Contrato

Todas las llamadas requieren `Authorization: Bearer CLAVE_DEL_SISTEMA`.

| Método | Ruta                                   | Uso                                                                 |
| ------ | -------------------------------------- | ------------------------------------------------------------------- |
| GET    | /api/integrations/sessions             | `{sourceSystem, sessions: [...]}`; hasta 1000 sesiones propias      |
| POST   | /api/integrations/sessions             | Crear con `{ "name": "recepcion" }`; 3–50 letras, números o guiones |
| GET    | /api/integrations/sessions/{id}        | Estado de una sesión propia                                         |
| POST   | /api/integrations/sessions/{id}/start  | Iniciar y preparar la vinculación                                   |
| GET    | /api/integrations/sessions/{id}/qr     | `{qrCode, status}`; QR PNG o null mientras se prepara               |
| POST   | /api/integrations/sessions/{id}/logout | Desvincular WhatsApp                                                |
| DELETE | /api/integrations/sessions/{id}        | Eliminar sesión y sus credenciales de vinculación                   |

`sourceSystem` se asigna exclusivamente desde la credencial autenticada y se persiste en `sessions`. No se acepta como campo del cuerpo. Antes de cualquier operación sobre un id, el guard consulta simultáneamente id y origen; los ids ajenos y los anteriores sin origen responden 404. Los nombres tienen un prefijo por sistema para evitar conflictos entre aplicaciones. El panel administrativo muestra el origen de las sesiones.

Las sesiones anteriores permanecen intactas, sin asignarse a ningún sistema. No se transfieren ni se muestran automáticamente a los clientes de integración.

## Despliegue

Agregar INTEGRATION_SYSTEMS al archivo de entorno usado por el despliegue y reconstruir OpenWA. `docker-compose.yml` ya transmite esta variable al contenedor. El arranque aplica la migración aditiva `1786900000000-AddSessionSourceSystem` mediante el mecanismo existente del proyecto; no eliminar volúmenes ni recrear bases de datos. En desarrollo con sincronización SQLite también se agrega la nueva columna.

El servidor Laravel debe llamar esta API desde su backend. No colocar la credencial en JavaScript, HTML ni URLs del navegador. Para llamadas entre servidores públicos se recomienda configurar HTTPS o una red privada para transportar las credenciales y los QR.

## Envío de documentos PDF

`POST /api/integrations/sessions/{sessionId}/documents` utiliza la misma credencial y comprobación de origen. Admite `phone` (número internacional solo en dígitos), `base64` (contenido PDF), `filename` (nombre terminado en .pdf) y `caption` opcional. No acepta URLs ni destinos de grupos. La sesión debe estar conectada y el documento no puede superar 15 MiB.

Enviar `Idempotency-Key` con un identificador único por intento confirmado. El endpoint reutiliza el interceptor y almacenamiento de idempotencia de los envíos del API general. Repetir la misma solicitud devuelve el resultado anterior sin reenviar; cambiar su cuerpo con la misma clave se rechaza. No generar claves nuevas automáticamente después de un timeout: primero comprobar el chat.

El resultado `{id, status: "sent", timestamp}` indica aceptación por la sesión de WhatsApp, sin garantizar entrega o lectura. El envío utiliza MessageService, por lo que conserva el almacenamiento, los eventos y los límites de envío existentes. Las pruebas utilizan un servicio simulado y no envían documentos a teléfonos reales.
