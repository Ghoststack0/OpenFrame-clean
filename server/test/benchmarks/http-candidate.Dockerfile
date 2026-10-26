ARG BASE_IMAGE=immich-perf:local
FROM ${BASE_IMAGE}
ARG SOURCE_REVISION
ARG SOURCE_SHA256
COPY current-server/dist /usr/src/app/server/dist
LABEL org.opencontainers.image.title="OpenFrame disposable HTTP benchmark" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="openframe-benchmark-20261026" \
      openframe.server-source-sha256="${SOURCE_SHA256}"
ENV IMMICH_SOURCE_REF=openframe-benchmark IMMICH_SOURCE_COMMIT=${SOURCE_REVISION} IMMICH_SOURCE_URL="" IMMICH_BUILD_IMAGE=openframe-benchmark
