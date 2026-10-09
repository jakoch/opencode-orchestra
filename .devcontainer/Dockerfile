FROM debian:trixie-slim

# ARG so the pin can be overridden per build:
#   docker build --build-arg OPENCODE_VERSION=1.18.35 ...
#ARG OPENCODE_VERSION=1.18.34

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NOWARNINGS=yes \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    TZ=Etc/UTC

RUN echo "Setup packages" && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        bash ca-certificates curl git locales ripgrep tzdata zsh && \
    echo "Setup locale and timezone" && \
    sed -i 's/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 && \
    ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime && \
    echo "${TZ}" > /etc/timezone && \
    echo "Cleanup apt cache" && \
    rm -rf /var/lib/apt/lists/*

# Pinned install of OpenCode.
# The installer unpacks to ~/.opencode/bin; we move it to /usr/local/bin.
# --version "${OPENCODE_VERSION}"
RUN echo "Installing OpenCode ${OPENCODE_VERSION}" && \
    curl -fsSL https://opencode.ai/v2/install | bash -s -- \
        --no-modify-path && \
    mv /root/.opencode/bin/opencode /usr/local/bin/opencode && \
    chmod 0755 /usr/local/bin/opencode && \
    rm -rf /root/.opencode && \
    opencode --version

CMD ["/bin/zsh", "-l"]
