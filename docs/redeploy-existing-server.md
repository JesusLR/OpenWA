# Volver a desplegar el servidor existente

Esta configuración sirve API y dashboard juntos en el puerto 2886. Reutiliza
el contenedor PostgreSQL y la red `openwa-network` existentes. No levanta ni
recrea PostgreSQL. Requiere Docker Compose v2 y ejecutar desde `/var/www/OpenWA`.

## 1. Respaldar antes de actualizar

```bash
cd /var/www/OpenWA
mkdir -p backups
docker inspect openwa-api --format '{{json .Mounts}}'
docker inspect openwa-postgres --format '{{json .NetworkSettings.Networks}}'
docker exec openwa-postgres sh -c 'pg_dumpall -U "$POSTGRES_USER"' > backups/postgres-before-redeploy.sql
test -s backups/postgres-before-redeploy.sql
docker compose stop openwa-api
docker cp openwa-api:/app/data backups/api-data-before-redeploy
cp -n .env backups/env-before-redeploy 2>/dev/null || true
```

Comprueba que `pg_dumpall` terminó sin errores y conserva una copia del respaldo
fuera del servidor. `docker cp` debe terminar correctamente antes de continuar.
El campo `Name` del montaje cuyo `Destination` es `/app/data` es el volumen que
debes colocar en `OPENWA_DATA_VOLUME`. Si el montaje es `bind`, no continúes:
esta configuración requiere adaptar el montaje a la ruta existente.
Comprueba también que PostgreSQL pertenece a `openwa-network`.

## 2. Obtener los archivos y configurar

Publica primero los cambios de este repositorio. En el servidor:

```bash
git status --short
git pull --ff-only
cp -n .env.server.example .env.server
chmod 600 .env.server
nano .env.server
```

Si `git pull` informa cambios locales, consérvalos antes de continuar; no uses
`git reset --hard`. El pull actualiza la rama actualmente seleccionada.

Completa `OPENWA_DATA_VOLUME`, `DATABASE_NAME`, `DATABASE_USERNAME` y
`DATABASE_PASSWORD` con los valores existentes. No inventes una contraseña
nueva: debe coincidir con PostgreSQL. Copia a `.env.server` los ajustes que
necesites conservar del `.env` anterior, especialmente `API_KEY_PEPPER` si
estaba configurado. No publiques estos archivos ni los respaldos.

## 3. Validar, construir y arrancar

Usa siempre los dos archivos explícitos para evitar overrides antiguos:

```bash
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml config --quiet
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml build openwa-api
docker stop openwa-dashboard
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml up -d --force-recreate openwa-api
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml ps
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml logs --tail=100 openwa-api
curl -I http://127.0.0.1:2886/
```

Si el dashboard antiguo ya no existe, omite `docker stop openwa-dashboard`.
Abre `http://IP_DEL_SERVIDOR:2886` y comprueba que aparecen las sesiones y los
datos anteriores. Si usas un dominio, el proxy debe dirigir a este puerto.
El acceso público con HTTPS debe realizarse mediante tu proxy TLS.

No ejecutes `down -v`, `volume prune` ni `--remove-orphans`: conserva los
volúmenes, PostgreSQL y el dashboard anterior hasta comprobar el resultado.
El arranque puede aplicar migraciones: para volver a una versión anterior
puede ser necesario restaurar también la base de datos respaldada.

Para consultar la clave inicial, si el archivo aún existe:

```bash
docker compose --env-file .env.server -f docker-compose.yml -f docker-compose.server.yml exec openwa-api cat /app/data/.api-key
```
