FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq c-icap libc-icap-mod-virus-scan netcat-openbsd && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /var/run/c-icap /var/log/c-icap && \
    chmod 777 /var/run/c-icap /var/log/c-icap
EXPOSE 1344
