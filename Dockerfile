FROM postgres:17-alpine

ENV POSTGRES_USER=postgres
ENV POSTGRES_PASSWORD=postgres
ENV POSTGRES_DB=workflows

COPY src/db/schema.sql /docker-entrypoint-initdb.d/

EXPOSE 5432
