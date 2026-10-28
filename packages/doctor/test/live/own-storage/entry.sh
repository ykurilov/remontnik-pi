#!/bin/sh
# Сервер хранилища живой проверки: ключи входа из окружения, sshd на переднем плане.
set -eu
printf '%s\n' "$AUTHORIZED_KEYS" > /srv/git/.ssh/authorized_keys
ssh-keygen -A >/dev/null
# sftp внутри sshd, мимо оболочки пользователя: так ключ без принудительной команды обошёл бы git-shell и хук.
sed -i 's|^Subsystem.*|Subsystem sftp internal-sftp|' /etc/ssh/sshd_config
mkdir -p /run/sshd
# VERBOSE: в журнале видно, какой ключ ушёл в принудительную команду, а какой — прямо в подсистему.
exec /usr/sbin/sshd -D -e -o LogLevel=VERBOSE
