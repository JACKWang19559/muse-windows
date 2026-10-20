'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),esbuild=require('esbuild');
const {isCsvFile,csvDelimiter,parseCsv,csvPreview}=require('../renderer/file-csv.cjs');

test('CSV and TSV classification preserves the original lowercase-only TSV delimiter choice',()=>{
  for(const name of ['data.csv','data.CSV','data.tsv','data.TSV'])assert.equal(isCsvFile(name),true);
  for(const name of ['data.csv.txt','data.json',null])assert.equal(isCsvFile(name),false);
  assert.equal(csvDelimiter('data.tsv'),'\t');assert.equal(csvDelimiter('data.TSV'),',');assert.equal(csvDelimiter('data.csv'),',');
});

test('CSV preview parses quoted separators, doubled quotes and embedded CRLF',()=>{
  assert.deepEqual(parseCsv('name,note\r\n"a,b","said ""hello"""\r\n"two\r\nlines",x'),[['name','note'],['a,b','said "hello"'],['two\r\nlines','x']]);
});

test('CSV parser keeps permissive mid-field and unfinished quoting without Save-style validation',()=>{
  assert.deepEqual(parseCsv('x"y,z",q\n"unfinished'),[['xy,z','q'],['unfinished']]);
  assert.deepEqual(parseCsv('a"b"c,d'),[['abc','d']]);
});

test('CSV empty fields and trailing empty quotes follow the observed EOF rules',()=>{
  for(const [input,expected]of [['',[]],['\n',[['']]],['""',[]],[',""',[['','']]],['a,b\n""',[['a','b']]],['a,\n',[['a','']]]])assert.deepEqual(parseCsv(input),expected);
});

test('CSV parser preserves BOM, spaces, blank rows and quoted CR while ignoring external CR',()=>{
  assert.deepEqual(parseCsv('\ufeff a , b \r\n\r\n1,"x\ry"\r'),[['\ufeff a ',' b '],[''],['1','x\ry']]);
});

test('TSV preview treats a comma as data and tab as the selected separator',()=>{
  const text='a\tb\nc,d\t"x\ty"';assert.deepEqual(csvPreview(text,'rows.tsv').rows,[['c,d','x\ty']]);
  assert.deepEqual(csvPreview(text,'rows.TSV').headers,['a\tb']);
});

test('CSV first row fixes table headers while parser retains every ragged field',()=>{
  const view=csvPreview('a,b\none\ntwo,three,four\n','data.csv');
  assert.deepEqual(view.headers,['a','b']);assert.deepEqual(view.rows,[['one'],['two','three','four']]);assert.equal(view.totalRows,2);assert.equal(view.truncated,false);
});

test('CSV limit counts data rows separately and does not alter source or stop the parser early',()=>{
  const exactly='h\n'+Array.from({length:1000},(_,i)=>'row-'+i).join('\n');const more=exactly+'\nlast,"later,field"';
  assert.equal(csvPreview(exactly,'data.csv').truncated,false);const view=csvPreview(more,'data.csv');
  assert.equal(view.totalRows,1001);assert.equal(view.rows.length,1000);assert.equal(view.truncated,true);assert.deepEqual(parseCsv(more).at(-1),['last','later,field']);assert(more.endsWith('last,"later,field"'));
});

const build=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../renderer/CsvPreview.jsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','lucide-react']});
const component={exports:{}};vm.runInNewContext(build.outputFiles[0].text,{module:component,exports:component.exports,require});
const CsvPreview=component.exports.default;

test('actual CSV table escapes HTML/formulas and pads missing cells without rendering excess columns',()=>{
  const html=renderToStaticMarkup(React.createElement(CsvPreview,{name:'test.csv',text:'a,b\n"<img src=x onerror=run>",=SUM(A1)\nonly\na,b,HIDDEN_EXTRA_COLUMN'}));
  assert(html.includes('&lt;img'));assert(!html.includes('<img src=x'));assert(html.includes('=SUM(A1)'));assert(!html.includes('HIDDEN_EXTRA_COLUMN'));
  assert.equal((html.match(/<th\b/g)||[]).length,2);assert.equal((html.match(/<td\b/g)||[]).length,6);assert(html.includes('<td></td>'));assert(!html.includes('data-testid="csv-row-limit"'));
});

test('actual CSV table renders 1000 data rows plus headers with a visible limit note',()=>{
  const text='heading\n'+Array.from({length:1001},(_,i)=>'DATA_ROW_'+i).join('\n');
  const html=renderToStaticMarkup(React.createElement(CsvPreview,{name:'test.csv',text}));
  assert.equal((html.match(/<tr\b/g)||[]).length,1001);assert(html.includes('DATA_ROW_999'));assert(!html.includes('DATA_ROW_1000'));assert(html.includes('data-testid="csv-row-limit"'));
});

test('actual empty CSV view does not invent a header or data row',()=>{
  const html=renderToStaticMarkup(React.createElement(CsvPreview,{name:'test.csv',text:'""'}));assert(html.includes('data-testid="csv-empty"'));assert(!html.includes('<table'));
});
