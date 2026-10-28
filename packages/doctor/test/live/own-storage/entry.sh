#!/bin/sh
# Сервер хранилища живой проверки: ключи входа из окружения, sshd на переднем плане.
set -eu
printf '%s\n' "$AUTHORIZED_KEYS" > /srv/git/.ssh/authorized_keys
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
