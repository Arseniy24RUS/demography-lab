# Просмотрщик из РУДН

Файлы `site/` скопированы побайтно из `Arseniy24RUS/RUDN` в редакции,
закреплённой в `upstream.json`. Они принадлежат авторскому проекту пользователя.
Не заменяйте их новой реализацией виртуальной прокрутки.

`node scripts/build-document-reader.mjs` проверяет эти копии и создаёт
`public/vendor/rudn-reader/` с сохранением относительных импортов. Только
сгенерированный `reader-registry.mjs` заменяется контрольными суммами
демографических данных. `public/data/reader/` — производные блоки, метаданные и
индексы; исходные `public/data/corpus/documents/` не изменяются.

Адаптер мастерской находится в `apps/web/src/lib/readerCorpus.ts`. React
передаёт в исходный ReaderController разметку канонических фрагментов.
Дополнительный worker bootstrap обеспечивает тот же SHA-256 на локальном
HTTP-origin без WebCrypto, затем загружает исходный поисковый worker.

Проверка воспроизводимости: `node scripts/build-document-reader.mjs --check`.
