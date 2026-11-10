# BotCamp slim computer: file viewing + small commands. No desktop, no browser.
# BotCamp reaches a computer only through exec (docker exec / pod exec), so the
# container needs a live PID 1 and a workspace; it does not need X11.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/botcamp

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
    && groupadd --gid 1000 botcamp \
    && useradd --uid 1000 --gid botcamp --create-home --shell /bin/bash botcamp

COPY start.sh /usr/local/bin/botcamp-computer-slim
RUN chmod 755 /usr/local/bin/botcamp-computer-slim

WORKDIR /home/botcamp
# Saved files can still name the previous home. The link stays on the image root.
RUN ln -sfn /home/botcamp /home/rakazo
USER 1000:1000
EXPOSE 6080
CMD ["/usr/local/bin/botcamp-computer-slim"]
