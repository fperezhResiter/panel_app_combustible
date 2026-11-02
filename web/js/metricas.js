/* Cálculos compartidos, independientes de la presentación. */
(function (root) {
  'use strict';
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const sum = (rows, field) => {const values = rows.map(r => r[field]).filter(valid); return values.length ? values.reduce((a,b) => a+b,0) : null;};
  const metrics = (rows) => {
    const pairs = rows.filter(r => valid(r.km) && valid(r.galones) && r.galones > 0);
    const gallons = sum(pairs,'galones');
    return {n:rows.length, galones:sum(rows,'galones'), km:sum(rows,'km'),
      equipos:new Set(rows.map(r=>r.placa).filter(Boolean)).size,
      rendimiento:gallons > 0 ? sum(pairs,'km')/gallons : null,
      coberturaRendimiento:pairs.length,
      pendientes:rows.filter(r=>r.estado.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()==='pendiente').length,
      alertas:rows.filter(r=>r.alertas.length).length,
      total:sum(rows,'total'), conTotal:rows.filter(r=>valid(r.total)).length};
  };
  const group = (rows, field) => {
    const map=new Map(); rows.forEach(r=>{const k=r[field]||'Sin dato'; if(!map.has(k))map.set(k,[]); map.get(k).push(r);});
    return [...map].map(([name,items])=>({name,rows:items,...metrics(items)}));
  };
  const matches = (r, f, exclude='') => Object.entries(f).every(([k,v])=>{
    if(!v||k===exclude)return true;
    if(k==='mes')return (r.fecha ? r.fecha.slice(0,7) : 'sin-fecha')===v;
    if(k==='desde')return r.fecha && r.fecha>=v;
    if(k==='hasta')return r.fecha && r.fecha<=v;
    if(k==='fecha')return r.fecha===v;
    if(k==='buscar')return [r.placa,r.conductor,r.unidad,r.marca,r.division].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
    return (r[k]||'Sin dato')===v;
  });
  root.CombustibleMetrics={valid,sum,metrics,group,matches};
  if(typeof module!=='undefined')module.exports=root.CombustibleMetrics;
})(typeof window!=='undefined'?window:globalThis);
