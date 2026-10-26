FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# Same digest as backend/Dockerfile. The job uses the Python standard library only.

WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --chown=app:app auth_export.py vault_backup.py ./
USER app
CMD ["python", "vault_backup.py"]
