/* Interfaz local: una misma selección alimenta gráficos, indicadores y exportación. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const M = window.CombustibleMetrics;
  const fuelLabel = value => String(value ?? '').replace(/\bGalones\b/g,'Litros').replace(/\bgalones\b/g,'litros').replace(/\bgal\b/g,'L');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (value, decimals=0) => value === null || value === undefined ? '—' : new Intl.NumberFormat('es-CL',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}).format(value);
  const dateLabel = value => value ? new Intl.DateTimeFormat('es-CL',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z')) : 'Sin fecha';
  const monthLabel = value => value === 'sin-fecha' ? 'Sin fecha' : new Intl.DateTimeFormat('es-CL',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(value+'-01T12:00:00Z'));
  let data = window.COMBUSTIBLE_DATA;
  let rows = [], selected = [], filters = {}, page=0, tab='inicio', token='';
  let selectionPeriod='Preparando indicadores…';
  let pdfBusy=false;
  let configuration=null, configurationMode='zona', configurationBusy=false, updateBusy=false;
  let configurationError='';
  const views={
    inicio:{title:'Paneles de seguimiento',description:'Selecciona la vista que quieres consultar.'},
    resumen:{title:'Resumen de combustible'},
    consumo:{title:'Consumo y evolución'},
    rendimiento:{title:'Rendimiento de equipos'},
    estados:{title:'Estado de abastecimientos'},
    registros:{title:'Registro de abastecimientos'},
    fuentes:{title:'Fuentes y criterios',description:'Archivos publicados, criterios de cálculo y calidad de la publicación completa.'},
    configuraciones:{title:'Configuraciones',description:'Selecciona qué zonas, regiones y unidades se mostrarán en cada modo.'}
  };
  let viewMode='zona';
  let sort = {field:'rendimiento',desc:true};
  const expanded = new Set(), collapsedZones = new Set();
  let showSummaryLines=false;
  const collapsedLineUnits=new Set(), expandedLines=new Set();
  const fields=['mes','zona','region','unidad','linea','tipo_unidad','placa','estado','tipo_abast','tipo_equipo','fuente'];
  const labels={mes:'Mes',zona:'Zona',region:'Región',unidad:'Unidad',linea:'Línea',tipo_unidad:'Tipo unidad',placa:'Placa',estado:'Estado',tipo_abast:'Abastecimiento',tipo_equipo:'Tipo equipo',fuente:'Fuente',desde:'Desde',hasta:'Hasta',fecha:'Fecha',buscar:'Búsqueda'};
  const defaults={mes:'Todos los meses',zona:'Todas las zonas',region:'Todas las regiones',unidad:'Todas las unidades',linea:'Todas las líneas',tipo_unidad:'Todos los tipos',placa:'Todas las placas',estado:'Todos los estados',tipo_abast:'Todos los abastecimientos',tipo_equipo:'Todos los equipos',fuente:'Todas las fuentes'};
  const drillChain=()=>[viewMode,'unidad',...(viewMode==='zona'?['linea']:[]),'placa'];
  const filterChain=()=>['mes',...drillChain().slice(0,-1),'tipo_unidad','placa'];
  const palette=['#0E81C5','#2E9E6B','#8b72b5','#D98A1E','#4e9f9c','#7C8998'];
  const color = name => {let h=0;for(const c of name)h=(h*31+c.charCodeAt(0))>>>0;return palette[h%palette.length];};
  const statusColor = name => ({pendiente:'#D98A1E',cerrado:'#2E9E6B',cerrada:'#2E9E6B',aprobado:'#2E9E6B','sin respuesta':'#C43C39',rechazado:'#C43C39','en revisión':'#0E81C5','sin estado':'#7C8998'}[name.toLowerCase()]||color(name));
  const pill = name => `<span class="status-pill" style="color:${statusColor(name)};background:${statusColor(name)}17">${esc(name)}</span>`;
  const safeURL = raw => {try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}};
  const notice = (message='',error=false) => {$('estado').textContent=message;$('estado').classList.toggle('error',error);};
  const filterDescription = () => `Modo: ${labels[viewMode]} · `+(Object.entries(filters).filter(([,v])=>v).map(([k,v])=>`${labels[k]||k}: ${v}`).join(' · ')||'Todos los registros');

  function setMode(mode){
    if(!['zona','region'].includes(mode)||mode===viewMode)return;
    delete filters[viewMode];
    if(mode==='region')delete filters.linea;
    viewMode=mode;hideTooltip();notice();updateSelection();
  }

  function renderMode(){
    document.body.dataset.agrupacion=viewMode;
    document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===viewMode)));
    $('campo-zona').hidden=viewMode!=='zona';$('campo-region').hidden=viewMode!=='region';
    $('campo-linea').hidden=viewMode!=='zona';
  }

  function refreshOptions() {
    const hierarchy=filterChain();
    for(const field of fields){
      if((['zona','region'].includes(field)&&field!==viewMode)||(field==='linea'&&viewMode==='region'))continue;
      const index=hierarchy.indexOf(field);
      const parentFilters=Object.fromEntries(hierarchy.slice(0,index<0?hierarchy.length:index).map(f=>[f,filters[f]]));
      const candidates=rows.filter(r=>M.matches(r,parentFilters));
      let values=[...new Set(candidates.map(r=>field==='mes'?(r.fecha?r.fecha.slice(0,7):'sin-fecha'):(r[field]||'Sin dato')))];
      values.sort((a,b)=>field==='mes'?b.localeCompare(a):a.localeCompare(b,'es',{numeric:true}));
      if(filters[field]&&!values.includes(filters[field]))delete filters[field];
      $("f-"+field).innerHTML=`<option value="">${defaults[field]}</option>`+values.map(v=>`<option value="${esc(v)}">${esc(field==='mes'?monthLabel(v):v)}</option>`).join('');
      $("f-"+field).value=filters[field]||'';
    }
    for(const field of ['desde','hasta','buscar'])$('f-'+field).value=filters[field]||'';
  }

  function updateSelection(){
    const visibleIDs=data.visibilidad?.[viewMode];
    const allowed=visibleIDs?new Set(visibleIDs):null;
    rows=data.registros.filter(r=>!allowed||allowed.has(r.id)).map(r=>({...r,region:r.region||'Sin región'}));
    refreshOptions();
    if(filters.desde&&filters.hasta&&filters.desde>filters.hasta){selected=[];page=0;render();notice('La fecha Desde debe ser anterior o igual a Hasta.',true);return;}
    selected=rows.filter(r=>M.matches(r,filters)); page=0;
    render();
  }

  function render(){
    renderMode();
    const total=M.metrics(selected);
    $('k-registros').textContent=fmt(total.n);
    $('k-galones').textContent=fmt(total.galones,2);
    $('k-equipos').textContent=fmt(total.equipos);
    $('k-rendimiento').textContent=fmt(total.rendimiento,2);
    $('k-pendientes').textContent=fmt(total.pendientes);
    $('k-alertas').textContent=fmt(total.alertas);
    $('k-rendimiento').title=`${total.coberturaRendimiento} de ${total.n} registros con ambos valores válidos`;
    const dates=selected.map(r=>r.fecha).filter(Boolean).sort();
    selectionPeriod=dates.length?`${dateLabel(dates[0])}${dates.at(-1)!==dates[0]?' — '+dateLabel(dates.at(-1)):''} · ${fmt(selected.length)} abastecimientos en la selección`:`${fmt(selected.length)} registros · sin período disponible`;
    const active=Object.entries(filters).filter(([,v])=>v);
    $('seleccion').textContent=active.length?`${active.length} filtro${active.length>1?'s':''} activo${active.length>1?'s':''}`:'Todos los registros';
    $('seleccion').title=filterDescription();
    $('descargar-csv').disabled=!selected.length;
    $('descargar-pdf').disabled=pdfBusy||!selected.length;
    $('estados-summary').innerHTML=`<span><strong>${fmt(total.n)}</strong> abastecimientos</span><span><strong>${fmt(total.pendientes)}</strong> pendientes</span><span><strong>${fmt(total.alertas)}</strong> registros con observaciones</span>`;
    if(!selected.length)notice('No hay registros para esta selección. Ajusta los filtros o pulsa Limpiar.');
    else if($('estado').textContent.startsWith('No hay registros'))notice();
    renderConsumption();renderHistory();renderEfficiency();renderStatuses();renderRanking();renderSummary();renderRecords();renderSources();renderView();renderConfiguration();
  }

  function markAttributes(items, description, extra=''){
    return `data-mark="true" tabindex="0" role="button" aria-label="${esc(description)}" data-ids="${esc(items.map(r=>r.id).join(' '))}" data-tip="${esc(description)}" ${extra}`;
  }
  function svgShell(width,height,body,label){return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="${esc(label)}">${body}</svg>`;}
  function countLabelY(valueY,candidates,bottom,pointY){
    return candidates.find(y=>y>=15&&y<=bottom-8&&Math.abs(y-valueY)>=19&&(y<=pointY-10||y>=pointY+17));
  }
  function gridLines(width,height,max,left=45,right=20){
    let body='';for(let i=0;i<=4;i++){const y=height-35-i*(height-60)/4;body+=`<line x1="${left}" x2="${width-right}" y1="${y}" y2="${y}" stroke="#edf1f5"/><text x="${left-8}" y="${y+3}" text-anchor="end" class="axis-label">${fmt(max*i/4,max<5?1:0)}</text>`;}return body;
  }
  function splitLabel(label,limit=15){
    const words=label.split(' ');let lines=[''];for(const word of words){const i=lines.length-1;if(lines[i]&&lines[i].length+word.length+1>limit)lines.push(word);else lines[i]+=(lines[i]?' ':'')+word;}return lines;
  }
  function drillField(){
    if(!filters[viewMode])return viewMode;
    if(!filters.unidad)return 'unidad';
    if(viewMode==='zona'&&!filters.linea)return 'linea';
    return 'placa';
  }
  function renderConsumption(){
    const field=drillField();const groups=M.group(selected,field).sort((a,b)=>(b.galones??-1)-(a.galones??-1));
    $('nivel').textContent=`Por ${labels[field].toLowerCase()}${filters.unidad?' · '+filters.unidad:filters[viewMode]?' · '+filters[viewMode]:''}`;
    if(!groups.length){$('grafico-consumo').innerHTML='<p class="empty-chart">Sin datos para graficar</p>';return;}
    const width=Math.max(650,groups.length*115+80),height=265,left=45,right=45,bottom=height-55;
    const max=Math.max(1,...groups.map(g=>g.galones??0))*1.18, maxN=Math.ceil(Math.max(1,...groups.map(g=>g.n))/4)*4;
    const step=(width-left-right)/groups.length;
    let body=gridLines(width,height-20,max,left,right),points=[],marks='';
    for(let i=0;i<=4;i++){const y=bottom-i*(height-80)/4;body+=`<text x="${width-right+10}" y="${y+3}" class="axis-label">${fmt(maxN*i/4)}</text>`;}
    groups.forEach((g,i)=>{
      const x=left+(i+.5)*step,bh=(g.galones??0)/max*(height-80),y=bottom-bh,ny=bottom-g.n/maxN*(height-80);
      const lines=splitLabel(g.name);
      const valueY=[y-10,y+18,ny-20,ny+22,15,bottom-8].find(labelY=>labelY>=15&&labelY<=bottom-8&&Math.abs(labelY-ny)>=18);
      const countY=countLabelY(valueY,[ny-12,ny+18,valueY-22,valueY+22,15,bottom-8],bottom,ny);
      const tip=`${g.name} · ${fmt(g.galones,2)} L · ${g.n} abastecimientos · ${fmt(g.rendimiento,2)} km/L`;
      marks+=`<g ${markAttributes(g.rows,tip,`data-action="drill" data-field="${field}" data-value="${esc(g.name)}"`)}><title>${esc(tip)}</title><rect class="hit" x="${x-step*.45}" y="12" width="${step*.9}" height="${height-17}"/><rect class="bar" x="${x-step*.26}" y="${y}" width="${step*.52}" height="${Math.max(bh,g.galones===null?0:1)}" rx="3" fill="#69B7E8"/><text class="value-label" x="${x}" y="${valueY}" text-anchor="middle">${fmt(g.galones,1)}</text>${lines.slice(0,3).map((s,j)=>`<text x="${x}" y="${bottom+17+j*12}" text-anchor="middle" class="axis-label">${esc(s)}</text>`).join('')}<circle cx="${x}" cy="${ny}" r="4" fill="#073762"/><text x="${x}" y="${countY}" text-anchor="middle" class="count-label">N.º ${fmt(g.n)}</text></g>`;
      points.push(`${x},${ny}`);
    });
    // Decorative line ignores pointer events so the full bar and point hit area stays usable.
    body+=`<polyline points="${points.join(' ')}" fill="none" stroke="#073762" stroke-width="2" pointer-events="none"/>`+marks;
    $('grafico-consumo').innerHTML=svgShell(width,height,body,'Consumo en litros y cantidad de abastecimientos por '+labels[field]);
  }

  function historyGroups(){
    const dated=selected.filter(r=>r.fecha);
    const days=M.group(dated,'fecha').sort((a,b)=>a.name.localeCompare(b.name));
    if(days.length<=90)return days.map(g=>({...g,period:'fecha'}));
    const groups=new Map();dated.forEach(r=>{const m=r.fecha.slice(0,7);if(!groups.has(m))groups.set(m,[]);groups.get(m).push(r);});
    return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([name,items])=>({name,rows:items,...M.metrics(items),period:'mes'}));
  }
  function renderHistory(){
    const groups=historyGroups();
    if(!groups.length){$('grafico-historial').innerHTML='<p class="empty-chart">Sin fechas válidas en la selección</p>';return;}
    const width=Math.max(390,groups.length*48+65),height=215,left=42,right=20,bottom=height-35;
    const max=Math.max(1,...groups.map(g=>g.galones??0))*1.2,maxN=Math.max(1,...groups.map(g=>g.n));
    const step=(width-left-right)/groups.length;let body=gridLines(width,height,max,left,right),line='';
    groups.forEach((g,i)=>{
      const x=left+(i+.5)*step,y=bottom-(g.galones??0)/max*(height-60),bar=g.n/maxN*36;
      const previous=groups[i-1],gap=previous&&g.period==='fecha'&&(new Date(g.name)-new Date(previous.name)>86400000);
      line+=(i===0||gap?'M':'L')+x+','+y+' ';
      const label=g.period==='mes'?g.name.slice(5)+'/'+g.name.slice(2,4):g.name.slice(8)+'/'+g.name.slice(5,7);
      const tip=`${g.period==='mes'?monthLabel(g.name):dateLabel(g.name)} · ${fmt(g.galones,2)} L · ${g.n} registros · ${fmt(g.rendimiento,2)} km/L`;
      const valueY=Math.max(15,y-10),countY=countLabelY(valueY,[bottom-8,bottom-30,bottom-52,bottom-74],bottom,y);
      body+=`<g ${markAttributes(g.rows,tip,`data-action="period" data-field="${g.period}" data-value="${g.name}"`)}><title>${esc(tip)}</title><rect class="hit" x="${x-step*.45}" y="5" width="${step*.9}" height="${height-5}"/><rect x="${x-8}" y="${bottom-bar}" width="16" height="${bar}" fill="#dce5ee" rx="2"/><text x="${x}" y="${countY}" text-anchor="middle" class="count-label">${g.n}</text><circle cx="${x}" cy="${y}" r="4" fill="#0E81C5"/><text class="value-label" x="${x}" y="${valueY}" text-anchor="middle">${fmt(g.galones,0)}</text><text x="${x}" y="${bottom+20}" text-anchor="middle" class="axis-label">${label}</text></g>`;
    });
    body=`<path d="${line}" fill="none" stroke="#0E81C5" stroke-width="2" pointer-events="none"/>`+body;
    $('grafico-historial').innerHTML=svgShell(width,height,body,'Historial de consumo y registros')+(groups.length===1?'<p class="single-day">La selección contiene un solo día; no hay tendencia temporal todavía.</p>':groups[0].period==='mes'?'<p class="single-day">Más de 90 días con registros: vista agregada por mes.</p>':'');
  }

  function renderEfficiency(){
    const valid=selected.filter(r=>r.fecha&&r.rendimiento!==null).sort((a,b)=>(a.fecha+a.hora).localeCompare(b.fecha+b.hora));
    const visible=valid.slice(-60);
    if(!visible.length){$('grafico-rendimiento').innerHTML='<p class="empty-chart">Sin pares válidos de KM y litros</p>';return;}
    const width=Math.max(620,visible.length*66+70),height=215,left=45,right=20,bottom=height-50;
    const max=Math.max(1,...visible.map(r=>r.rendimiento))*1.22,step=(width-left-right)/visible.length;
    let body=gridLines(width,height-15,max,left,right);
    visible.forEach((r,i)=>{
      const x=left+(i+.5)*step,y=bottom-r.rendimiento/max*(height-75);
      const tip=`${r.placa||'Sin placa'} · ${dateLabel(r.fecha)} ${r.hora} · ${fmt(r.rendimiento,2)} km/L · ${fmt(r.galones,2)} L`;
      body+=`<g ${markAttributes([r],tip,`data-action="point" data-value="${esc(r.placa)}" data-date="${r.fecha}"`)}><title>${esc(tip)}</title><rect class="hit" x="${x-step*.46}" y="8" width="${step*.92}" height="${height-12}"/><line x1="${x}" x2="${x}" y1="${y}" y2="${bottom}" stroke="#edf1f5"/><circle cx="${x}" cy="${y}" r="5" fill="#2E9E6B"/><text x="${x}" y="${Math.max(13,y-12)}" class="value-label" text-anchor="middle">${fmt(r.rendimiento,2)}</text><text x="${x}" y="${bottom+20}" text-anchor="middle">${esc(r.placa||'Sin placa')}</text><text x="${x}" y="${bottom+33}" text-anchor="middle" class="axis-label">${r.fecha.slice(8)}/${r.fecha.slice(5,7)}</text></g>`;
    });
    $('grafico-rendimiento').innerHTML=svgShell(width,height,body,'Rendimiento individual por fecha y placa')+(valid.length>60?`<p class="single-day">Últimos 60 de ${fmt(valid.length)} registros válidos de la selección. El total incluye todos.</p>`:'');
  }

  function renderStatuses(){
    const groups=M.group(selected,'estado').sort((a,b)=>b.n-a.n);
    if(!groups.length){$('grafico-estados').innerHTML='<p class="muted">Sin registros</p>';return;}
    const segment=(g,legend)=>`<button type="button" data-state="${esc(g.name)}" data-tip="${esc(g.name)}: ${g.n} (${fmt(g.n/selected.length*100,1)} %)" ${legend?'':`style="flex:${g.n};background:${statusColor(g.name)}"`} aria-label="Filtrar ${esc(g.name)}: ${g.n} registros">${legend?`<i class="dot" style="background:${statusColor(g.name)}"></i>${esc(g.name)} <strong>${g.n}</strong> (${fmt(g.n/selected.length*100,1)} %)`:(g.n/selected.length>.08?g.n:'')}</button>`;
    $('grafico-estados').innerHTML=`<div class="status-bar">${groups.map(g=>segment(g,false)).join('')}</div><div class="status-legend">${groups.map(g=>segment(g,true)).join('')}</div>`;
  }

  function renderRanking(){
    const groups=M.group(selected.filter(r=>r.placa),'placa');
    groups.sort((a,b)=>{const x=sort.field==='placa'?a.name:a[sort.field],y=sort.field==='placa'?b.name:b[sort.field];if(x===null)return 1;if(y===null)return -1;const cmp=typeof x==='string'?x.localeCompare(y,'es'):x-y;return sort.desc?-cmp:cmp;});
    $('ranking-count').textContent=fmt(groups.length)+' equipos';
    $('ranking-body').innerHTML=groups.length?groups.map(g=>{
      const types=[...new Set(g.rows.map(r=>r.tipo_equipo))].join(', ');
      return `<tr data-ranking="true" data-ids="${g.rows.map(r=>r.id).join(' ')}"><td><button class="plate-button" type="button" data-plate="${esc(g.name)}">${esc(g.name)}</button></td><td>${esc(types)}</td><td>${g.n}</td><td><strong>${fmt(g.rendimiento,2)}</strong></td><td>${fmt(g.galones,2)}</td></tr>`;
    }).join(''):'<tr><td colspan="5">Sin equipos en la selección</td></tr>';
    const total=M.metrics(selected);
    $('ranking-total').innerHTML=`<tr><td>Total selección</td><td></td><td>${fmt(total.n)}</td><td>${fmt(total.rendimiento,2)}</td><td>${fmt(total.galones,2)}</td></tr>`;
    document.querySelectorAll('[data-sort]').forEach(b=>{const base={placa:'Placa',n:'N.º',rendimiento:'km/L',galones:'Litros'}[b.dataset.sort];b.textContent=base+(sort.field===b.dataset.sort?(sort.desc?' ↓':' ↑'):'');});
  }

  function aggregateCells(items){const m=M.metrics(items);return `<td>${fmt(m.n)}</td><td>${fmt(m.galones,2)}</td><td>${fmt(m.km,0)}</td><td>${fmt(m.rendimiento,2)}</td>`;}
  const branchKey = path => encodeURIComponent(JSON.stringify([viewMode,...path]));
  const summaryPath=()=>`${labels[viewMode]} / Unidad / ${showSummaryLines?'Línea / ':''}Placa`;
  function summaryTree(){
    const levels=[{field:viewMode,type:'zone'},{field:'unidad',type:'unit'},...(showSummaryLines?[{field:'linea',type:'line'}]:[]),{field:'placa',type:'plate'}];
    function group(items,depth=0,path=[]){
      const level=levels[depth];
      return M.group(items,level.field).sort((a,b)=>a.name.localeCompare(b.name,'es',{numeric:true})).map(item=>{
        const current=[...path,item.name];
        return {name:item.name,rows:item.rows,key:branchKey(current),type:level.type,
          children:depth+1<levels.length?group(item.rows,depth+1,current):[]};
      });
    }
    return group(selected);
  }
  function summaryBranches(nodes=summaryTree()){return nodes.flatMap(node=>node.children.length?[node,...summaryBranches(node.children)]:[]);}
  function isOpen(branch){
    if(branch.type==='zone')return !collapsedZones.has(branch.key);
    if(branch.type==='line')return expandedLines.has(branch.key);
    return showSummaryLines?!collapsedLineUnits.has(branch.key):expanded.has(branch.key);
  }
  function setSummaryOpen(branch,open){
    const collapsed=branch.type==='zone'||(branch.type==='unit'&&showSummaryLines);
    const state=branch.type==='zone'?collapsedZones:branch.type==='line'?expandedLines:showSummaryLines?collapsedLineUnits:expanded;
    if(collapsed?!open:open)state.add(branch.key);else state.delete(branch.key);
  }
  function renderSummary(restoreFocus=''){
    $('resumen-titulo').textContent=showSummaryLines?`Resumen por ${labels[viewMode].toLowerCase()}, unidad y línea`:`Resumen por ${labels[viewMode].toLowerCase()} y unidad`;
    $('resumen-columna').textContent=summaryPath();
    $('resumen-scroll').setAttribute('aria-label',summaryPath());
    $('resumen-ayuda').textContent=showSummaryLines?'Expande una línea para ver sus equipos.':'Expande una unidad para ver sus equipos.';
    $('mostrar-linea').textContent=showSummaryLines?'Ocultar línea':'Mostrar línea';
    $('mostrar-linea').setAttribute('aria-pressed',String(showSummaryLines));
    const tree=summaryTree();
    let html='';
    const descendants=node=>node.children.flatMap(child=>['row-'+child.key,...descendants(child)]);
    function draw(nodes,visible=true){
      nodes.forEach(node=>{
        const branch=node.children.length>0,open=branch&&isOpen(node);
        const classes={zone:'group-row',unit:'unit-row',line:'line-row',plate:showSummaryLines?'plate-row line-plate-row':'plate-row'};
        const label=branch?`<button class="group-toggle" type="button" id="toggle-${node.key}" data-summary-branch="${node.type}" data-summary-key="${node.key}" aria-expanded="${open}" aria-controls="${descendants(node).join(' ')}"><span>${open?'▾':'▸'}</span>${esc(node.name)}</button>`:esc(node.name);
        html+=`<tr class="${classes[node.type]}" id="row-${node.key}" ${visible?'':'hidden'}><td>${label}</td>${aggregateCells(node.rows)}</tr>`;
        draw(node.children,visible&&open);
      });
    }
    draw(tree);
    $('resumen-body').innerHTML=html||'<tr><td colspan="5">Sin registros</td></tr>';
    $('resumen-total').innerHTML=`<tr><td>Total general</td>${aggregateCells(selected)}</tr>`;
    const branches=summaryBranches(tree),all=branches.length>0&&branches.every(isOpen);
    $('expandir').textContent=all?'Contraer todo':'Expandir todo';$('expandir').setAttribute('aria-expanded',String(all));$('expandir').disabled=!branches.length;
    if(restoreFocus)$(restoreFocus)?.focus({preventScroll:true});
  }

  function renderRecords(){
    const m=M.metrics(selected),start=page*25,visible=selected.slice(start,start+25);
    $('registros-count').textContent=fmt(selected.length)+' registros';
    $('registro-summary').innerHTML=`<span><strong>${fmt(m.n)}</strong> abastecimientos</span><span><strong>${fmt(m.galones,2)}</strong> litros</span><span><strong>${fmt(m.rendimiento,2)}</strong> km/L</span><span>Importe registrado: <strong>${m.conTotal?'S/. '+fmt(m.total,2):'—'}</strong> (${m.conTotal}/${m.n} con total)</span>`;
    $('registros-body').innerHTML=visible.length?visible.map(r=>`<tr><td>${esc(dateLabel(r.fecha))}<small>${esc(r.hora||'Sin hora')}</small></td><td><strong>${esc(r.placa||'Sin placa')}</strong><small>${esc(r.marca)} · ${esc(r.tipo_unidad)}</small></td><td class="conductor">${esc(r.conductor||'—')}</td><td>${esc(r.unidad)}</td><td>${fmt(M.valid(r.km)?r.km:null)}</td><td>${fmt(M.valid(r.galones)?r.galones:null,2)}</td><td>${fmt(r.rendimiento,2)}</td><td>${esc(r.tipo_abast||'—')}</td><td>${pill(r.estado)}${r.alertas.length?'<small class="error-inline">Con observaciones</small>':''}</td><td><button type="button" data-detail="${r.id}">Ver detalle</button></td></tr>`).join(''):'<tr><td colspan="10">Sin registros para estos filtros</td></tr>';
    $('pagina-info').textContent=selected.length?`${start+1}–${Math.min(start+25,selected.length)} de ${fmt(selected.length)} registros`:'0 registros';
    $('pagina-anterior').disabled=page===0;$('pagina-siguiente').disabled=start+25>=selected.length;
  }

  function renderSources(){
    $('fuentes-meta').textContent=`${data.muestra?'Muestra inicial':'Publicación de archivos'} · ${fmt(data.registros.length)} registros únicos`;
    $('fuentes-body').innerHTML=data.archivos.map(f=>`<tr><td>${esc(f.archivo)}</td><td>${fmt(f.filas)}</td><td>${f.faltantes.length?esc(f.faltantes.map(fuelLabel).join(', ')):'Ninguna'}</td></tr>`).join('');
    $('duplicados-info').textContent=`${fmt(data.duplicados)} filas idénticas consolidadas. Si coincide fecha, hora y placa con valores distintos, se conservan ambas y se señala el conflicto.`;
    const master=data.maestro_equipos?.meta;
    $('maestro-card').hidden=!master?.archivo;
    $('maestro-info').innerHTML=master?.archivo?`<p><strong>${esc(master.archivo)}</strong> · ${esc(master.hoja)} · ${fmt(master.filas)} filas leídas · ${fmt(master.patentes)} patentes importadas.</p><p>${fmt(master.registros_asociados)} abastecimientos asociados · ${fmt(master.registros_sin_asociacion)} sin asociación (${fmt(master.patentes_sin_asociacion)} patentes). Las ${fmt(master.sin_patente)} filas sin patente no se cruzan con abastecimientos.</p><p>Tipo de equipo = TIPO DECLARADO de la primera fila de cada patente. Se conserva la procedencia y los tipos encontrados. En préstamos prevalece el CECO préstamo del registro.</p>`:'';
    const alerts=Object.entries(data.alertas);
    $('calidad').innerHTML=alerts.length?alerts.map(([label,n])=>`<div class="quality-item"><span>${esc(fuelLabel(label))}</span><b>${fmt(n)} registros</b></div>`).join(''):'<p>No se detectaron observaciones en las validaciones descritas.</p>';
    const withoutRegion=data.registros.filter(r=>!r.region||r.region==='Sin región').length,withoutZone=data.registros.filter(r=>r.zona==='SIN ZONA').length;
    $('asociaciones').innerHTML=`<p>${fmt(withoutZone)} registros sin zona · ${fmt(withoutRegion)} sin región. Las asociaciones ausentes o ambiguas conservan sus registros e importes en estos grupos.</p><p class="muted">Catálogos: config/cecos_zonas.json y config/cecos_regiones.json. El maestro aporta zona, línea, CECO activo fijo y tipo declarado por patente. En préstamos prevalece la unidad de destino. Las regiones se resuelven con los catálogos.</p>${(data.catalogo_observaciones||[]).length?`<ul>${data.catalogo_observaciones.map(note=>`<li>${esc(note)}</li>`).join('')}</ul>`:''}`;
  }

  function showDetail(id){
    const record=rows.find(r=>r.id===id);if(!record)return;
    const master=record.maestro_equipo;
    const masterFields=master?[['Maestro de equipos',master.origen],['CECO activo fijo del maestro',master.ceco],['Zona / línea del maestro',`${master.zona||'Sin zona'} / ${master.linea||'Sin línea'}`],['Tipo declarado de la primera fila',`${master.tipo_equipo||'Sin dato'} · fila ${master.fila_tipo}`],['Tipos declarados encontrados',(master.variantes?.tipo_equipo||[]).join(' / ')]]:[['Maestro de equipos','Sin asociación por patente']];
    const masterDetail=masterFields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value||'—')}</dd></div>`).join('');
    $('detalle-titulo').textContent=`${record.placa||'Sin placa'} · ${dateLabel(record.fecha)}`;
    $('detalle-contenido').innerHTML=`<dl class="detalle-fields">${data.columnas.map(label=>{
      const value=record.original[label];const url=['GPS','Fotos'].includes(label)?safeURL(value):null;
      return `<div><dt>${esc(fuelLabel(label))}</dt><dd>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label==='GPS'?'Abrir ubicación ↗':'Abrir respaldo ↗'}</a>`:esc(value||'—')}</dd></div>`;
    }).join('')}<div><dt>Unidad atribuida</dt><dd>${esc(record.unidad)}</dd></div><div><dt>Criterio de atribución</dt><dd>${record.atribucion_prestamo?'CECO préstamo de este registro':record.atribucion_maestro?'CECO activo fijo del maestro, asociado por patente':'CECO original del registro'}</dd></div><div><dt>Rendimiento calculado (km/L)</dt><dd>${fmt(record.rendimiento,2)}</dd></div><div><dt>Zona / Región / Línea de negocio</dt><dd>${esc(record.zona)} / ${esc(record.region)} / ${esc(record.linea)}</dd></div><div><dt>Código de unidad</dt><dd>${esc(record.ceco||'Sin código confirmado')}</dd></div><div><dt>Tipo de equipo</dt><dd>${esc(record.tipo_equipo)}</dd></div>${masterDetail}</dl>${record.fotos.toLowerCase()==='sí'?'<p class="muted">La fuente indica que existen fotos; no contiene un enlace al respaldo.</p>':''}${record.alertas.length?`<div class="detalle-alertas"><strong>Observaciones del registro</strong><ul>${record.alertas.map(a=>`<li>${esc(fuelLabel(a))}</li>`).join('')}</ul></div>`:''}<p class="detalle-origen">Origen: ${esc(record.origenes.join(' · '))}</p>`;
    $('detalle-dialog').showModal();
  }

  function renderView(){
    const home=tab==='inicio',hasFilters=!['inicio','fuentes','configuraciones'].includes(tab);
    document.body.dataset.vista=tab;
    document.querySelector('main').classList.toggle('portal',home);
    $('intro-vista').classList.toggle('portal-intro',home);
    $('contexto-vista').textContent=home?'GESTIÓN DE COMBUSTIBLE':'OPERACIÓN Y EFICIENCIA DE FLOTA';
    $('filtros').hidden=!hasFilters;
    $('modos-agrupacion').hidden=!hasFilters;
    $('seleccion').hidden=!hasFilters;
    $('volver-inicio').textContent=home?'Inicio':'Volver al inicio';
    document.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==tab);
    document.querySelectorAll('[data-tab]').forEach(el=>{if(el.dataset.tab===tab)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    $('titulo-vista').textContent=views[tab].title;
    $('periodo').textContent=views[tab].description||selectionPeriod;
    document.title=`${home?'Combustible':views[tab].title} · Resiter Driver`;
    $('navegacion-graficos').hidden=!['consumo','rendimiento','estados'].includes(tab);
    $('quitar-seleccion').hidden=!filters.fecha&&!filters.placa;
    $('nivel-anterior').hidden=!drillChain().some(f=>filters[f]);
    const field=drillField();
    $('chart-context').textContent=tab==='rendimiento'?'Selecciona una fecha y placa en el gráfico o una placa en la tabla para explorar sus registros.':tab==='estados'?'Selecciona nuevamente un estado para quitar su filtro. Los filtros se comparten con las demás vistas.':(field==='placa'?'Selecciona una placa para ver su consumo.':`Selecciona ${field==='region'?'una región':field==='zona'?'una zona':field==='unidad'?'una unidad':'una línea'} para explorar el siguiente nivel.`);
  }

  function setTab(name,focus=false){
    tab=Object.hasOwn(views,name)?name:'inicio';
    if(tab==='configuraciones'&&!token)tab='inicio';
    hideTooltip();renderView();
    if(focus){window.scrollTo({top:0,behavior:'instant'});$('titulo-vista').focus({preventScroll:true});}
  }

  function setHighlight(ids){
    const active=new Set(ids);
    document.querySelectorAll('[data-mark],[data-ranking]').forEach(el=>{
      const match=(el.dataset.ids||'').split(' ').some(id=>active.has(id));
      el.classList.toggle('dimmed',active.size>0&&!match);el.classList.toggle('active',active.size>0&&match);
    });
  }
  function showTooltip(el,event){
    const rect=el.getBoundingClientRect();const text=el.dataset.tip;if(!text)return;
    $('tooltip').textContent=text;$('tooltip').hidden=false;
    const x=event?.clientX??rect.x+rect.width/2,y=event?.clientY??rect.y;
    $('tooltip').style.left=Math.max(8,Math.min(x+14,innerWidth-$('tooltip').offsetWidth-10))+'px';
    $('tooltip').style.top=Math.max(8,Math.min(y+16,innerHeight-$('tooltip').offsetHeight-10))+'px';
  }
  function hideTooltip(){$('tooltip').hidden=true;setHighlight([]);document.querySelector('.status-bar')?.classList.remove('has-hover');document.querySelectorAll('[data-state].active').forEach(el=>el.classList.remove('active'));}
  function hoverStart(el,event){
    if(el.dataset.mark)setHighlight(el.dataset.ids.split(' '));
    if(el.dataset.state){document.querySelector('.status-bar')?.classList.add('has-hover');document.querySelectorAll('[data-state]').forEach(e=>e.classList.toggle('active',e.dataset.state===el.dataset.state));setHighlight(selected.filter(r=>r.estado===el.dataset.state).map(r=>r.id));}
    showTooltip(el,event);
  }
  function activateMark(el){
    hideTooltip();
    if(el.dataset.action==='drill'){
      const f=el.dataset.field;filters[f]=filters[f]===el.dataset.value?'':el.dataset.value;
      const chain=drillChain();chain.slice(chain.indexOf(f)+1).forEach(k=>delete filters[k]);delete filters.fecha;
    }else if(el.dataset.action==='period'){
      const f=el.dataset.field;filters[f]=filters[f]===el.dataset.value?'':el.dataset.value;
    }else if(el.dataset.action==='point'){
      if(filters.placa===el.dataset.value&&filters.fecha===el.dataset.date){delete filters.placa;delete filters.fecha;}
      else{filters.placa=el.dataset.value;filters.fecha=el.dataset.date;}
    }
    updateSelection();
  }

  function pdfSnapshot(){
    const total=M.metrics(selected),blocks=[];
    const metricValues=items=>{const m=M.metrics(items);return [fmt(m.n),fmt(m.galones,2),fmt(m.km),fmt(m.rendimiento,2),...(tab==='resumen'?[]:[fmt(m.pendientes)])];};
    const headers=['Abastecimientos','Litros','KM recorridos','km/L',...(tab==='resumen'?[]:['Pendientes'])];
    const table=(title,head,items,widths,textColumns=[])=>blocks.push({type:'table',title,headers:head,rows:items,widths,textColumns});
    const chart=(id,title,note)=>blocks.push(...window.CombustiblePDF.figures($(id).querySelector('svg'),title,note));
    const totalRow={values:['Total selección',...metricValues(selected)],kind:'total'};
    if(tab==='resumen'){
      const items=[];
      function addRows(nodes){
        for(const node of nodes){
          items.push({values:[node.type==='line'?'Línea: '+node.name:node.name,...metricValues(node.rows)],kind:{zone:'group',unit:'unit',line:'line',plate:'normal'}[node.type]});
          addRows(node.children);
        }
      }
      addRows(summaryTree());
      table(`Resumen por ${summaryPath().toLowerCase()}`,[summaryPath(),...headers],[...items,totalRow],[2.7,1.2,1.2,1.2,1]);
    }else if(tab==='consumo'){
      chart('grafico-consumo','Consumo de combustible',`${$('nivel').textContent}. Barras: litros (eje izquierdo). Línea y etiquetas N.º: abastecimientos (eje derecho).`);
      const groups=M.group(selected,drillField()).sort((a,b)=>(b.galones??-1)-(a.galones??-1));
      table('Consumo por '+labels[drillField()].toLowerCase(),[labels[drillField()],...headers],[...groups.map(g=>[g.name,...metricValues(g.rows)]),totalRow],[2.7,1.2,1.2,1.2,1,1]);
      chart('grafico-historial','Historial de abastecimientos','Línea azul y cifras superiores: consumo en litros. Barras grises y cifras inferiores: cantidad de registros por período.');
      table('Historial por período',['Período',...headers],historyGroups().map(g=>[g.period==='mes'?monthLabel(g.name):dateLabel(g.name),...metricValues(g.rows)]),[2,1.2,1.2,1.2,1,1]);
    }else if(tab==='rendimiento'){
      chart('grafico-rendimiento','Rendimiento por fecha y placa','KM / litros del registro. Solo KM >= 0 y litros > 0. '+($('grafico-rendimiento').querySelector('.single-day')?.textContent||''));
      const groups=M.group(selected.filter(r=>r.placa),'placa');
      groups.sort((a,b)=>{const x=sort.field==='placa'?a.name:a[sort.field],y=sort.field==='placa'?b.name:b[sort.field];if(x===null)return 1;if(y===null)return -1;const cmp=typeof x==='string'?x.localeCompare(y,'es'):x-y;return sort.desc?-cmp:cmp;});
      table('Rendimiento ponderado por equipo',['Placa','Tipo de equipo',...headers],groups.map(g=>[g.name,[...new Set(g.rows.map(r=>r.tipo_equipo))].join(', '),...metricValues(g.rows)]),[1.2,2.2,1.2,1.2,1.2,1,1],[1]);
    }else if(tab==='estados'){
      const groups=M.group(selected,'estado').sort((a,b)=>b.n-a.n);
      blocks.push({type:'distribution',title:'Distribución de estados',items:groups.map(g=>({name:g.name,count:g.n,color:statusColor(g.name)}))});
      table('Estado de abastecimientos',['Estado','Registros','Porcentaje','Litros','km/L'],groups.map(g=>[g.name,fmt(g.n),fmt(g.n/total.n*100,1)+' %',fmt(g.galones,2),fmt(g.rendimiento,2)]),[2.5,1,1,1.3,1]);
    }else if(tab==='registros'){
      table('Todos los abastecimientos filtrados',['Fecha / hora','Placa','Unidad','Conductor','KM recorridos','Litros','km/L','Estado'],selected.map(r=>[`${dateLabel(r.fecha)} ${r.hora||''}`,r.placa||'Sin placa',r.unidad,r.conductor||'—',fmt(M.valid(r.km)?r.km:null),fmt(M.valid(r.galones)?r.galones:null,2),fmt(r.rendimiento,2),r.estado]),[1.8,1.1,2,2.4,1,1,0.9,1.2],[1,2,3,7]);
    }
    return {title:views[tab].title,period:selectionPeriod,publication:$('publicacion').textContent,filters:filterDescription(),scope:`${fmt(total.n)} registros filtrados, incluidas las filas contraídas.`,indicators:[`${fmt(total.n)} abastecimientos`,`${fmt(total.galones,2)} litros`,`${fmt(total.equipos)} equipos`,`${fmt(total.rendimiento,2)} km/L`,`${fmt(total.pendientes)} con validación pendiente`,`${fmt(total.alertas)} con observaciones`],blocks};
  }

  async function exportPDF(){
    if(pdfBusy||!selected.length)return;
    const button=$('descargar-pdf');pdfBusy=true;button.disabled=true;button.textContent='Generando PDF…';
    try{
      if(!window.CombustiblePDF)throw new Error('No se cargó el exportador PDF. Recarga el panel.');
      hideTooltip();
      const report=pdfSnapshot(),filename=`combustible_${tab}_${data.hasta||'sin-fecha'}${data.muestra?'_muestra':''}.pdf`;
      notice('Preparando el informe PDF de la selección…');
      const bytes=await window.CombustiblePDF.create(report),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      notice(`PDF generado: ${report.title} · ${report.scope}`);
    }catch(error){notice(`No se pudo generar el PDF: ${error.message}`,true);}
    finally{pdfBusy=false;button.disabled=!selected.length;button.textContent='Descargar PDF';}
  }

  function exportCSV(){
    const extra=['Unidad','Código de unidad','Zona','Región','Línea de negocio','Tipo de equipo','Rendimiento calculado (km/L)','Observaciones','Archivo / hoja / fila','Filtros aplicados','Maestro / hoja / filas','CECO activo fijo (maestro)','Fila del tipo declarado'];
    const quote=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    const table=[data.columnas.map(fuelLabel).concat(extra),...selected.map(r=>data.columnas.map(c=>r.original[c]).concat([r.unidad,r.ceco,r.zona,r.region,r.linea,r.tipo_equipo,r.rendimiento===null?'':String(r.rendimiento).replace('.',','),r.alertas.map(fuelLabel).join(' | '),r.origenes.join(' | '),filterDescription(),r.maestro_equipo?.origen||'',r.maestro_equipo?.ceco||'',r.maestro_equipo?.fila_tipo??'']))];
    const blob=new Blob(['\ufeff'+table.map(row=>row.map(quote).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=`combustible_${data.hasta||'sin-fecha'}${data.muestra?'_muestra':''}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    notice(`CSV descargado: ${fmt(selected.length)} registros filtrados, incluidas las filas contraídas.`);
  }

  function acceptData(payload){
    data=payload;rows=data.registros.map(r=>({...r,region:r.region||'Sin región'}));$('aviso-muestra').hidden=!data.muestra;
    const published=new Intl.DateTimeFormat('es-CL',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Santiago'}).format(new Date(data.publicado));
    $('publicacion').textContent=`Última publicación: ${published} (Chile) · ${data.muestra?'Muestra inicial':data.archivos.length+' archivo(s) fuente'} · ${fmt(rows.length)} registros`;
    updateSelection();
  }

  function renderConfiguration(){
    if(!token)return;
    const focused=document.activeElement?.id;
    const busy=configurationBusy||updateBusy;
    document.querySelectorAll('[data-config-mode]').forEach(button=>{
      button.setAttribute('aria-pressed',String(button.dataset.configMode===configurationMode));
      button.disabled=busy;
    });
    $('recargar-configuracion').disabled=busy;
    $('actualizar-bd').disabled=busy;
    $('configuracion-grupos').setAttribute('aria-busy',String(busy));
    const status=$('configuracion-estado');
    status.classList.toggle('error',Boolean(configurationError));
    status.classList.toggle('pendiente',!configurationError&&Boolean(configuration?.pendiente));
    status.textContent=configurationError||(updateBusy?'Actualizando la publicación con las selecciones guardadas…':configurationBusy?'Guardando selección en la BD…':!configuration?'Carga la configuración para seleccionar los grupos y unidades.':configuration.pendiente?'Selecciones guardadas en la BD · Hay cambios pendientes. Pulsa Actualizar BD para aplicarlos a los paneles.':'Selecciones guardadas en la BD · La publicación tiene la configuración actual.');
    if(!configuration)return;
    const groups=configuration.catalogo[configurationMode];
    const checkbox=(id,kind,item,label,disabled=false)=>`<label class="configuracion-casilla" for="${id}"><input id="${id}" type="checkbox" data-config-kind="${kind}" data-config-id="${esc(item.id)}" ${item.mostrar?'checked':''} ${busy||disabled?'disabled':''} aria-label="${esc(label)}"><span>${esc(item.nombre)}</span><b class="configuracion-si-no">${item.mostrar?'Sí':'No'}</b></label>`;
    $('configuracion-grupos').innerHTML=groups.length?groups.map((group,g)=>{
      const count=group.mostrar?group.unidades.filter(unit=>unit.mostrar).length:0;
      return `<article class="tarjeta configuracion-grupo ${group.mostrar?'':'grupo-oculto'}"><div class="configuracion-grupo-titulo">${checkbox('config-grupo-'+g,'grupos',group,`Mostrar ${group.nombre}`)}<p>${fmt(count)} de ${fmt(group.unidades.length)} unidades para mostrar</p></div><ul>${group.unidades.map((unit,u)=>`<li>${checkbox(`config-unidad-${g}-${u}`,'unidades',unit,`Mostrar ${unit.nombre} en ${group.nombre}`,!group.mostrar)}<small>${esc(unit.ceco?'Código '+unit.ceco:'Sin código confirmado')} · ${fmt(unit.registros)} registro(s)${group.mostrar?'':' · Grupo oculto'}</small></li>`).join('')}</ul></article>`;
    }).join(''):'<p class="muted">No hay grupos ni unidades disponibles.</p>';
    if(focused?.startsWith('config-'))$(focused)?.focus({preventScroll:true});
  }

  async function loadConfiguration(){
    const response=await fetch('/api/configuracion',{cache:'no-store'});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'No se pudo cargar la configuración.');
    configuration=result;configurationError='';renderConfiguration();
  }

  async function saveConfiguration(input){
    if(!configuration||configurationBusy||updateBusy)return renderConfiguration();
    const change={revision:configuration.revision,modo:configurationMode,tipo:input.dataset.configKind,id:input.dataset.configId,mostrar:input.checked};
    const focusID=input.id;
    configurationBusy=true;configurationError='';renderConfiguration();
    try{
      const response=await fetch('/api/configuracion',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Token':token},body:JSON.stringify(change)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'No se pudo guardar la selección.');
      configuration=result;
    }catch(error){configurationError=`No se guardó el cambio: ${error.message} Usa Recargar configuración para volver a intentar.`;}
    finally{configurationBusy=false;renderConfiguration();$(focusID)?.focus({preventScroll:true});}
  }

  async function setupServer(){
    if(!['http:','https:'].includes(location.protocol))return;
    try{
      const response=await fetch('/api/estado',{cache:'no-store'});if(!response.ok)return;
      const state=await response.json();if(state.modo!=='local'||!state.token)return;
      token=state.token;$('modo').textContent='Modo interactivo';$('actualizar-bd').hidden=false;
      document.querySelectorAll('[data-interactive]').forEach(el=>el.hidden=false);
      document.querySelector('.fuentes-grid').classList.add('interactivo');
      if(location.hash==='#configuraciones')setTab('configuraciones');
      try{await loadConfiguration();}catch(error){configurationError=error.message;renderConfiguration();}
    }catch{/* Static consultation remains available without a local server. */}
  }

  document.addEventListener('change',e=>{
    if(e.target.dataset.configKind){saveConfiguration(e.target);return;}
    const field=e.target.dataset.filter;if(!field)return;
    filters[field]=e.target.value;delete filters.fecha;notice();
    const chain=filterChain();if(chain.includes(field))chain.slice(chain.indexOf(field)+1).forEach(k=>delete filters[k]);
    updateSelection();
  });
  let searchTimer;
  $('f-buscar').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{filters.buscar=$('f-buscar').value;updateSelection();},180);});
  $('filtros').addEventListener('submit',e=>{e.preventDefault();updateSelection();});
  $('limpiar').addEventListener('click',()=>{filters={};notice();updateSelection();});
  $('mas-filtros').addEventListener('click',()=>{const open=$('filtros-extra').hidden;$('filtros-extra').hidden=!open;$('mas-filtros').setAttribute('aria-expanded',String(open));$('mas-filtros').textContent=open?'− Menos filtros':'+ Más filtros';});
  $('descargar-csv').addEventListener('click',exportCSV);
  $('descargar-pdf').addEventListener('click',exportPDF);
  document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.mode)));
  document.querySelectorAll('[data-config-mode]').forEach(button=>button.addEventListener('click',()=>{configurationMode=button.dataset.configMode;renderConfiguration();}));
  $('recargar-configuracion').addEventListener('click',async()=>{
    configurationBusy=true;renderConfiguration();
    try{await loadConfiguration();}catch(error){configurationError=error.message;}
    finally{configurationBusy=false;renderConfiguration();}
  });
  $('cerrar-detalle').addEventListener('click',()=>$('detalle-dialog').close());
  $('detalle-dialog').addEventListener('click',e=>{if(e.target===$('detalle-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  $('pagina-anterior').addEventListener('click',()=>{page=Math.max(0,page-1);renderRecords();});
  $('pagina-siguiente').addEventListener('click',()=>{if((page+1)*25<selected.length)page++;renderRecords();});
  $('quitar-seleccion').addEventListener('click',()=>{delete filters.fecha;delete filters.placa;updateSelection();});
  $('nivel-anterior').addEventListener('click',()=>{for(const f of [...drillChain()].reverse())if(filters[f]){delete filters[f];break;}delete filters.fecha;updateSelection();});
  $('expandir').addEventListener('click',()=>{const branches=summaryBranches(),close=branches.every(isOpen);branches.forEach(branch=>setSummaryOpen(branch,!close));renderSummary('expandir');});
  $('mostrar-linea').addEventListener('click',()=>{showSummaryLines=!showSummaryLines;renderSummary('mostrar-linea');});
  $('actualizar-bd').addEventListener('click',async()=>{
    if(configurationBusy||updateBusy)return;
    const button=$('actualizar-bd');updateBusy=true;renderConfiguration();button.textContent='Actualizando…';notice('Leyendo archivos de Fuentes y preparando la nueva publicación…');
    try{
      const response=await fetch('/api/actualizar',{method:'POST',headers:{'X-Panel-Token':token}});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'No se pudo actualizar');
      acceptData(result);notice(`Publicación actualizada: ${fmt(rows.length)} registros visibles en modo ${labels[viewMode].toLowerCase()} y ${result.duplicados} duplicados consolidados.`);
      try{await loadConfiguration();}catch(error){configurationError=`Publicación actualizada. No se pudo recargar la configuración: ${error.message}`;}
    }
    catch(error){notice(error.message,true);}finally{updateBusy=false;renderConfiguration();button.textContent='↻ Actualizar BD';}
  });
  document.addEventListener('click',e=>{
    const target=e.target.closest('[data-mark],[data-detail],[data-plate],[data-summary-branch],[data-state],[data-sort]');if(!target)return;
    if(target.dataset.mark)return activateMark(target);
    if(target.dataset.detail)return showDetail(target.dataset.detail);
    if(target.dataset.plate){filters.placa=filters.placa===target.dataset.plate?'':target.dataset.plate;return updateSelection();}
    if(target.dataset.summaryBranch){const branch={type:target.dataset.summaryBranch,key:target.dataset.summaryKey};setSummaryOpen(branch,!isOpen(branch));return renderSummary(target.id);}
    if(target.dataset.state){filters.estado=filters.estado===target.dataset.state?'':target.dataset.state;hideTooltip();return updateSelection();}
    if(target.dataset.sort){const field=target.dataset.sort;sort={field,desc:sort.field===field?!sort.desc:field!=='placa'};renderRanking();}
  });
  document.addEventListener('keydown',e=>{const mark=e.target.closest('[data-mark]');if(mark&&['Enter',' '].includes(e.key)){e.preventDefault();activateMark(mark);}});
  document.addEventListener('pointerover',e=>{const el=e.target.closest('[data-mark],[data-state]');if(el&&!el.contains(e.relatedTarget))hoverStart(el,e);});
  document.addEventListener('pointermove',e=>{const el=e.target.closest('[data-mark],[data-state]');if(el)showTooltip(el,e);});
  document.addEventListener('pointerout',e=>{const el=e.target.closest('[data-mark],[data-state]');if(el&&!el.contains(e.relatedTarget))hideTooltip();});
  document.addEventListener('focusin',e=>{const el=e.target.closest('[data-mark],[data-state]');if(el)hoverStart(el);});
  document.addEventListener('focusout',e=>{if(e.target.closest('[data-mark],[data-state]'))hideTooltip();});
  window.addEventListener('hashchange',()=>setTab(location.hash.slice(1),true));
  setTab(location.hash.slice(1));
  if(!data||!Array.isArray(data.registros)){notice('No se encontró una publicación disponible. Verifica que la carpeta del panel esté completa y vuelve a abrir Panel.html.',true);return;}
  acceptData(data);setupServer();
})();
