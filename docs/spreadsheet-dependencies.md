# Spreadsheet dependencies

The XLSX integration is independently written for Muse Windows. It uses public
open-source packages; it does not include an extracted Muse worker or its private
application wrapper. The versions below are this project's choices, rather than
claims about the original app's exact dependencies.

| Component | Version | Responsibility | License |
| --- | --- | --- | --- |
| [ExcelJS](https://github.com/exceljs/exceljs) | 4.4.0 | Browser document-workbook parsing, cells, styles and merges | MIT |
| [fast-formula-parser](https://github.com/LesterLyu/fast-formula-parser) | 1.0.19 | Formula interpretation through application-supplied reference callbacks | MIT |
| [SSF](https://github.com/SheetJS/ssf) | 0.11.2 | Spreadsheet number-format codes | Apache-2.0 |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.12 | XML DOM parsing for the independent OOXML reader | MIT |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | ZIP parts and archive fallback | MIT option |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | Bounded archive admission support | MIT |

The packages have different roles. ExcelJS exposes a workbook model, but does not
calculate formulas or paint a spreadsheet UI. Its official documentation describes
the [browser document-workbook entry and formula-result limitation](https://github.com/exceljs/exceljs/blob/master/README.md).
The project's grid, chart model and SVG display, reference resolution, worker
protocol, thumbnails, cancellation and resource limits are separate application
code. Unsupported input must remain visible as an explicit error or limitation;
having these packages installed does not establish complete Excel compatibility.

## Distribution scopes

The browser worker's actual inputs are recorded by the build in
`build/spreadsheet-worker.json`. Its `sourceInputs` names files that esbuild used;
its `vendorSources` binds the upstream ExcelJS distribution, package metadata and
license. The manifest is a build provenance record, not an exhaustive list of
every library already embedded inside a prebuilt vendor file.

ExcelJS is installed as a development dependency. The build copies its official
`dist/exceljs.min.js` byte for byte into `build/spreadsheet-exceljs.cjs`, alongside
`build/ExcelJS-LICENSE.txt`. The parser used by Node.js and the browser worker
both refer to that fixed browser vendor. This retains the complete selected
document-workbook parser without requiring ExcelJS's separate Node.js archive and
filesystem packages in the runtime distribution.

Runtime `node_modules` is the dependency closure of the application's production
dependencies, including the installed platform-specific optional dependencies.
It is separate from the worker input inventory and from all packages installed
for development. A package in the lockfile or development directory is not, by
itself, evidence that its source was included in the worker or portable package.
Use the package script's runtime closure and final package inventory; do not copy
the entire development dependency tree into a release.

## Notices to retain

Keep the original license, copyright and applicable NOTICE files, together with
the legal comments in the unchanged vendor and compiled worker. The project's MIT
license applies to independently written project code; it does not replace the
terms of dependencies.

- fast-formula-parser includes Chevrotain 7.1.2 and bessel 1.0.2 under Apache-2.0,
  and jStat 1.9.6, bahttext 1.1.0 and regexp-to-ast 0.5.0 under MIT. jStat's older
  `licenses` array and its included MIT license both remain relevant.
- The formula-parser package also contains an SSF-derived formatter advertising
  version 0.10.3 and retaining the SheetJS copyright header. It is distinct from
  the separately selected SSF 0.11.2 package; keep both components' notices.
- JSZip offers MIT or GPL terms. This project chooses its MIT option. pako's
  declaration is **MIT AND Zlib**, so both parts and their notices remain.
- The prebuilt ExcelJS browser file contains other libraries, including XML,
  streams and browser compatibility components. Their ISC, BSD, MIT and other
  applicable notices are not replaced by the ExcelJS MIT summary. Package names
  in its upstream source map do not uniquely establish every embedded version.

The full installed runtime package metadata and original notice files are the
distribution evidence. This document summarizes their roles and must not be used
to infer missing grants, to call every dependency MIT, or to claim a complete
audit of every embedded third-party implementation. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
