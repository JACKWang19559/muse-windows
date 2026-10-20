# Third-party components

Muse Windows source is MIT licensed. Bundled dependencies retain their own licenses.
Their original notices and license files are included in `node_modules` in the
portable distribution, together with applicable comments in the compiled bundles.

The Word preview uses [docx-preview 0.4.1](https://github.com/VolodymyrBaydalka/docxjs)
(copyright Volodymyr Baydalka), under Apache License 2.0, and
[JSZip 3.10.1](https://github.com/Stuk/jszip), under the MIT option of its dual license.
The isolated preview, message protocol, ZIP admission checks and file integration
are independently written for this project. No extracted Muse program code is
included.

Other runtime components include React/React DOM (MIT), Lucide (ISC), DOMPurify
(Apache-2.0 OR MPL-2.0), marked (MIT), parse5 (MIT), fflate (MIT), esbuild (MIT),
pdf-parse and PDF.js (Apache-2.0). PDF.js also includes fonts and image/color
decoders with their own notices; retain the dependency license files when
redistributing the portable application. Electron/Chromium license files are
included alongside the application executable.
