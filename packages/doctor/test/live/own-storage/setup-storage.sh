#!/bin/sh
# Своё хранилище Ремонтника на сервере — те же шаги, что в рецепте docs/security.md («Своё хранилище на сервере»).
# Запуск от root; рядом лежат git-update-hook и git-shell-remontnik-git из deploy/. Ключи (authorized_keys) — отдельно.
set -eu
here=$(dirname "$0")
home=${GIT_HOME:-/srv/git}
repo=$home/${REPO_NAME:-app}.git

# 1. Пользователь git: вход только в git-shell, его дом и всё в доме — у root.
grep -qx /usr/bin/git-shell /etc/shells || echo /usr/bin/git-shell >> /etc/shells
id git >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$home" --shell /usr/bin/git-shell git
install -d -o root -g root -m 755 "$home" "$home/.ssh" "$home/git-shell-commands"
install -o root -g root -m 755 "$here/git-shell-remontnik-git" "$home/git-shell-commands/remontnik-git"
printf '#!/bin/sh\necho "здесь только git: интерактивного входа нет" >&2\nexit 128\n' > "$home/git-shell-commands/no-interactive-login"
chmod 755 "$home/git-shell-commands/no-interactive-login"
touch "$home/.ssh/authorized_keys"
chown root:root "$home/.ssh/authorized_keys"
chmod 644 "$home/.ssh/authorized_keys"

# 2. Хранилище: config, HEAD и хук — у root; git пишет только объекты и ссылки.
git init --quiet --bare --initial-branch=main "$repo"
git -C "$repo" config receive.denyNonFastForwards true
git -C "$repo" config receive.denyDeletes true
install -o root -g root -m 755 "$here/git-update-hook" "$repo/hooks/update"
chown -R root:root "$repo"
chown -R git:git "$repo/objects" "$repo/refs"
# Замок HEAD.lock git ставит в самой папке хранилища: она группы git, но с битом sticky — чужие файлы git не тронет.
chgrp git "$repo"
chmod 1775 "$repo"
# Хранилище чужого владельца git без этого не откроет («dubious ownership»).
git config --system --add safe.directory "$repo"
