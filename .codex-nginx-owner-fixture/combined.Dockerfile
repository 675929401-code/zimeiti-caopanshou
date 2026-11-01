# All three source images are pinned by Linux amd64 manifest SHA.
FROM python@sha256:e8e689ab6825e34adf0c1e516d1aded0b8aa9ec16e47441fa998a8d4d48ffacb AS py
FROM node@sha256:01393fe5a51489b63da0ab51aa8e0a7ff9990132917cf20cfc3d46f5e36c0e48 AS node
FROM nginx@sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c
COPY --from=py /usr/local /usr/local
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so* /usr/lib/
COPY --from=node /usr/lib/libgcc_s.so.1 /usr/lib/
