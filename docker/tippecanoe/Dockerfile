FROM alpine:3.21 AS builder

RUN apk add --no-cache git g++ make sqlite-dev zlib-dev

RUN git clone --depth 1 https://github.com/felt/tippecanoe.git /src/tippecanoe
WORKDIR /src/tippecanoe
RUN make -j$(nproc) && make install PREFIX=/usr/local

FROM alpine:3.21

RUN apk add --no-cache sqlite-libs zlib libstdc++

COPY --from=builder /usr/local/bin/tippecanoe /usr/local/bin/
COPY --from=builder /usr/local/bin/tippecanoe-decode /usr/local/bin/
COPY --from=builder /usr/local/bin/tile-join /usr/local/bin/
COPY --from=builder /usr/local/bin/tippecanoe-enumerate /usr/local/bin/
COPY --from=builder /usr/local/bin/tippecanoe-overzoom /usr/local/bin/
COPY --from=builder /usr/local/bin/tippecanoe-json-tool /usr/local/bin/
