/* Verifica la jerarquía del resumen y los controles reales sin abrir un navegador. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'web/js/combustible.js'),'utf8');
const metrics=require(path.join(root,'web/js/metricas.js'));
const nodes={},listeners={};
let focused='';
const element=id=>nodes[id]??={textContent:'',innerHTML:'',attributes:{},handlers:{},
  setAttribute(name,value){this.attributes[name]=value;},
  addEventListener(name,handler){this.handlers[name]=handler;},
  focus(){focused=id;}};
const selected=[
  {zona:'Zona 1',region:'Región 1',unidad:'Unidad común',linea:'Línea A',placa:'PRUEBA-01',galones:10,km:20,estado:'Pendiente',alertas:[]},
  {zona:'Zona 1',region:'Región 1',unidad:'Unidad común',linea:'Línea B',placa:'PRUEBA-01',galones:15,km:30,estado:'Pendiente',alertas:[]},
  {zona:'Zona 1',region:'Región 2',unidad:'Otra unidad',linea:'Sin línea',placa:'PRUEBA-02',galones:20,km:40,estado:'Pendiente',alertas:[]},
  {zona:'Zona 2',region:'Región 2',unidad:'Unidad común',linea:'Línea A',placa:'PRUEBA-03',galones:25,km:50,estado:'Pendiente',alertas:[]}
];
const context={M:metrics,selected,viewMode:'zona',filters:{placa:'selección conservada'},
  $:element,fmt:value=>String(value??'—'),esc:String,labels:{zona:'Zona',region:'Región'},
  tab:'resumen',views:{resumen:{title:'Resumen'}},selectionPeriod:'Prueba',filterDescription:()=>'',window:{},
  document:{addEventListener(type,handler){listeners[type]=handler;}},
  updateSelection(){throw Error('La expansión no debe cambiar la selección');}};
vm.createContext(context);
vm.runInContext('let showSummaryLines=false;const expanded=new Set(),collapsedZones=new Set(),collapsedLineUnits=new Set(),expandedLines=new Set();',context);
vm.runInContext(source.slice(source.indexOf('  function aggregateCells('),source.indexOf('  function renderRecords(')),context);
vm.runInContext(source.slice(source.indexOf('  function pdfSnapshot('),source.indexOf('  async function exportPDF(')),context);
vm.runInContext(source.slice(source.indexOf("  $('expandir').addEventListener"),source.indexOf("  $('actualizar-bd').addEventListener")),context);
vm.runInContext(source.slice(source.indexOf("  document.addEventListener('click'"),source.indexOf("  document.addEventListener('keydown'")),context);
const evaluate=code=>vm.runInContext(code,context);
const click=id=>element(id).handlers.click();
const flatten=tree=>tree.flatMap(node=>[node,...flatten(node.children)]);
const markupRows=()=>nodes['resumen-body'].innerHTML.match(/<tr\b[\s\S]*?<\/tr>/g)||[];
const rowMarkup=node=>markupRows().find(row=>row.includes('id="row-'+node.key+'"'));
const isHidden=node=>/\shidden>/.test(rowMarkup(node));
function toggle(node){
  const id='toggle-'+node.key;
  listeners.click({target:{closest:()=>({id,dataset:{summaryBranch:node.type,summaryKey:node.key}})}});
  assert.equal(focused,id);
}
function verifyTotals(){
  const leaves=flatten(evaluate('summaryTree()')).filter(node=>node.type==='plate');
  assert.equal(leaves.reduce((sum,node)=>sum+node.rows.length,0),selected.length);
  assert.equal(leaves.reduce((sum,node)=>sum+metrics.metrics(node.rows).galones,0),70);
  assert.equal(context.filters.placa,'selección conservada');
  assert.equal(metrics.metrics(context.selected).galones,70);
  for(const row of markupRows())assert.equal((row.match(/<td\b/g)||[]).length,5);
}

evaluate('renderSummary()');
assert.equal(nodes['mostrar-linea'].textContent,'Mostrar línea');
assert.ok(!nodes['resumen-body'].innerHTML.includes('class="line-row"'));
assert.ok(flatten(evaluate('summaryTree()')).filter(node=>node.type==='plate').every(isHidden));
verifyTotals();

click('mostrar-linea');
assert.equal(nodes['mostrar-linea'].textContent,'Ocultar línea');
assert.equal(nodes['mostrar-linea'].attributes['aria-pressed'],'true');
assert.equal(focused,'mostrar-linea');
let tree=evaluate('summaryTree()');
assert.ok(flatten(tree).filter(node=>node.type==='line').every(node=>!isHidden(node)));
assert.ok(flatten(tree).filter(node=>node.type==='plate').every(isHidden));
assert.ok(nodes['resumen-columna'].textContent.includes('Línea'));
verifyTotals();

// Homonymous lines in different units/zones need independent keys and expansion.
const lines=flatten(tree).filter(node=>node.type==='line'&&node.name==='Línea A');
assert.equal(lines.length,2);
assert.notEqual(lines[0].key,lines[1].key);
toggle(lines[0]);
assert.ok(lines[0].children.every(node=>!isHidden(node)));
assert.ok(lines[1].children.every(isHidden));
const zone=tree[0];
toggle(zone);
assert.ok(flatten(zone.children).every(isHidden));
toggle(zone);
assert.ok(lines[0].children.every(node=>!isHidden(node)));
assert.ok(lines[1].children.every(isHidden));
verifyTotals();

click('expandir');
assert.equal(nodes['expandir'].textContent,'Contraer todo');
assert.ok(evaluate('summaryBranches().every(isOpen)'));
assert.ok(flatten(evaluate('summaryTree()')).every(node=>!isHidden(node)));
verifyTotals();
const expandedTable=nodes['resumen-body'].innerHTML;

// Hiding lines restores the original unit expansion; showing them restores the line layout.
click('mostrar-linea');
assert.ok(flatten(evaluate('summaryTree()')).filter(node=>node.type==='plate').every(isHidden));
assert.ok(!nodes['resumen-body'].innerHTML.includes('class="line-row"'));
click('mostrar-linea');
assert.equal(nodes['resumen-body'].innerHTML,expandedTable);
click('expandir');
assert.equal(nodes['expandir'].textContent,'Expandir todo');
assert.ok(flatten(evaluate('summaryTree()')).filter(node=>node.type!=='zone').every(isHidden));
verifyTotals();

// PDF follows the selected hierarchy and includes collapsed branches.
for(const mode of ['zona','region']){
  context.viewMode=mode;
  evaluate('renderSummary()');
  const report=evaluate('pdfSnapshot()'),table=report.blocks[0];
  assert.equal(table.headers.length,5);
  assert.ok(table.headers[0].includes('Línea'));
  assert.ok(table.rows.some(row=>row.kind==='line'));
  assert.equal(table.rows.length,flatten(evaluate('summaryTree()')).length+1);
  assert.ok(table.rows.every(row=>row.values.length===5));
  verifyTotals();
}
context.viewMode='zona';
evaluate('renderSummary()');
assert.ok(flatten(evaluate('summaryTree()')).filter(node=>node.type!=='zone').every(isHidden));
click('mostrar-linea');
assert.ok(!evaluate('pdfSnapshot()').blocks[0].rows.some(row=>row.kind==='line'));
context.selected=[];
evaluate('renderSummary()');
assert.ok(nodes['resumen-body'].innerHTML.includes('colspan="5"'));
assert.equal(nodes['expandir'].disabled,true);
console.log('Resumen: agrupación por línea, controles, expansión independiente, totales, foco, ambos modos y PDF correctos.');
