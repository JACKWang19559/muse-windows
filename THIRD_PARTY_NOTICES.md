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

## Spreadsheet preview

The independently written spreadsheet integration uses the following public OSS
components. These versions are choices for Muse Windows, not assertions about the
versions or licenses of the original Muse program.

| Component | Version | License / use |
| --- | --- | --- |
| [ExcelJS](https://github.com/exceljs/exceljs) | 4.4.0 | MIT; the official browser distribution is copied unchanged to `build/spreadsheet-exceljs.cjs`, with its license in `build/ExcelJS-LICENSE.txt`. |
| [fast-formula-parser](https://github.com/LesterLyu/fast-formula-parser) | 1.0.19 | MIT; its included components retain their own notices. |
| [SheetJS SSF](https://github.com/SheetJS/ssf) | 0.11.2 | Apache-2.0. The formula-parser package also contains an older SSF-derived formatter with a SheetJS copyright header; retain that header as well. |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.12 | MIT. |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT option of its dual license. |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT. |

Formula dependencies include Chevrotain 7.1.2 and bessel 1.0.2 (Apache-2.0),
jStat 1.9.6, bahttext 1.1.0 and regexp-to-ast 0.5.0 (MIT). jStat declares its
license using the older `licenses` array and includes the original MIT license.
Other transitive components use ISC, BSD and Zlib terms as well as MIT and
Apache-2.0. In particular, pako declares **MIT AND Zlib**; choosing JSZip's MIT
option does not remove pako's notices.

ExcelJS's prebuilt browser file already embeds additional OSS components. Keep
its original legal comments, the copied ExcelJS license, and the legal comments
retained at the end of the compiled spreadsheet worker. A source-map package name
is not proof of that component's exact version or a replacement for its notice.
Keep all applicable dependency license, copyright and NOTICE files when
redistributing; this summary does not relicense all bundled code as MIT.

ExcelJS is a build-time dependency: the application and worker use the fixed
browser vendor file, rather than distributing ExcelJS's unused Node.js archive
and filesystem dependency graph. Do not package the entire development
`node_modules` directory. See [spreadsheet dependency notes](docs/spreadsheet-dependencies.md)
for the separate worker, runtime and development scopes.
