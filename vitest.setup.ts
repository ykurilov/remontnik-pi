import { fileURLToPath } from 'node:url'

// Временные репозитории тестов — из своего шаблона, без автообслуживания git. Иначе git после commit, fetch и приёма
// push уходит в фон (`git maintenance --detach`) и порой упаковывает объекты уже после выхода команды: уборка папки
// теста ловит ENOTEMPTY. Шаблон доходит и до `receive-pack` в origin: `-c` и GIT_CONFIG_* git для него сбрасывает.
process.env.GIT_TEMPLATE_DIR = fileURLToPath(new URL('./scripts/test-git-template/', import.meta.url))
