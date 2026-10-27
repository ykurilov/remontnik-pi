---
'@ykurilov/remontnik-doctor': patch
---

`check-config`: закрытая папка отложенных сценариев рядом с `checks.eval.scenariosDir` больше не даёт ложной ошибки. Ошибка остаётся, только когда сценарий из `evalScope` лежит под закрытым путём вне `scenariosDir`.
