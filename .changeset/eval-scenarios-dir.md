---
"@ykurilov/remontnik-core": patch
"@ykurilov/remontnik-doctor": patch
---

Папка сценариев eval задаётся в `checks.eval.scenariosDir` (по умолчанию `eval/scenarios`): закрытые пути узнают закрытые сценарии и в нестандартной папке. `check-config` предупреждает, если папки нет, и считает ошибкой закрытый путь сценариев вне неё.
