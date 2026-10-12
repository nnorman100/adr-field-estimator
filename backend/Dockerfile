FROM python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce
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
