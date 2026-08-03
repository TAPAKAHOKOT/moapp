FROM litestream/litestream:0.5.15 AS litestream

FROM alpine:3.22

RUN apk add --no-cache sqlite
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY verify-backup.sh /usr/local/bin/verify-backup
RUN chmod 0555 /usr/local/bin/verify-backup

ENTRYPOINT ["/usr/local/bin/verify-backup"]
