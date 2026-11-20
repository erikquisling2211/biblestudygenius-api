# Hebrew OT syntax trees (served to the Bible Study Genius app)

`<book>.json` files are compact conversions of the MACULA Hebrew "lowfat" syntax
trees (Westminster Leningrad Codex), made by `scripts/build-hebrew-syntax.js` in
the app repo (`biblegenius-build1`), from https://github.com/Clear-Bible/macula-hebrew
(commit 47db250).

Attribution (required, shown in the app): "MACULA Hebrew Linguistic Datasets,
available at https://github.com/Clear-Bible/macula-hebrew/" — © Biblica, Inc.,
CC BY 4.0. It includes the Westminster Hebrew Syntax (Groves Center, CC BY 4.0),
OpenScriptures Hebrew Bible morphology (CC BY 4.0) and Cherith English glosses
(CC BY 4.0). WLC text: copying unrestricted. SDBH data is not included.

Each file may carry `e2h`, a map from English (BSB) verse numbers to Hebrew verse
numbers where they differ. Jonah ships inside the app and isn't here.
