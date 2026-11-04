# BotCamp slim computer: file viewing + small commands. No desktop, no browser.
# Rakazo reaches a computer only through exec (docker exec / pod exec), so the
# container needs a live PID 1 and a workspace; it does not need X11.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/rakazo

# Tencent mirror: the stock Debian host is slow from this region.
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g; s|security.debian.org|mirrors.cloud.tencent.com|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      file \
      jq \
      procps \
      busybox-static \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 rakazo \
    && useradd --uid 1000 --gid rakazo --create-home --shell /bin/bash rakazo

COPY start.sh /usr/local/bin/rakazo-computer-slim
RUN chmod 755 /usr/local/bin/rakazo-computer-slim

WORKDIR /home/rakazo
USER 1000:1000
EXPOSE 6080
CMD ["/usr/local/bin/rakazo-computer-slim"]
