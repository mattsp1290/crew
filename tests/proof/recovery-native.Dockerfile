# Compile the isolation launcher against the exact fixture userspace. The host
# runner is Ubuntu 24.04 (glibc 2.39); copying its binary into bookworm (2.36)
# otherwise fails in the ELF loader before Landlock or an SDK can start.
FROM node:24.22.3-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*
COPY member-launch.c /tmp/member-launch.c
RUN mkdir -p /opt/birbcrew-native \
    && cc -std=c11 -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now \
       /tmp/member-launch.c -o /opt/birbcrew-native/member-launch \
    && chmod 755 /opt/birbcrew-native/member-launch \
    && rm /tmp/member-launch.c
