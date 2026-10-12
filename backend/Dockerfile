FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
# python:3.11-slim; Dependabot updates the digest.

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --chown=app:app . .
RUN chown app:app /app
USER app

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--ws-max-size", "800000"]
